/**
 * Qoder CLI Integration
 * =====================
 *
 * Drives the `qodercli` binary in headless print mode (`qodercli -p -o
 * stream-json`), parsing its NDJSON event stream into normalized live messages.
 * This mirrors `opencode-runner.js`'s role for opencode: qoder has no official
 * SDK for interactive sessions, so the runner spawns the CLI, streams events
 * over the WebSocket, and reports the provider-native session id via
 * `session_created` when a brand-new session announces one.
 *
 * ## Usage
 *
 * - queryQoder(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortQoderSession(sessionId) - Cancel an active session
 * - isQoderSessionActive(sessionId) - Check if a session is running
 * - getActiveQoderSessions() - List all active sessions
 */

import { spawn } from 'cross-spawn';

import { normalizeImageDescriptors } from './shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { appConfig } from './modules/config/config.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { QoderSessionsProvider } from './modules/providers/list/qoder/qoder-sessions.provider.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from './shared/utils.js';

const activeQoderProcesses = new Map();
// Pending interactive tool approvals keyed by Qoder's control_request `request_id`
// (UUID-shaped). Populated when a `can_use_tool` control_request arrives and
// removed once the human decides (resolveQoderToolApproval), the CLI cancels
// (control_cancel), the window expires, or the run ends.
const pendingQoderApprovals = new Map();

const QODER_APPROVAL_TIMEOUT_MS =
  appConfig().get().providers.qoder.toolApprovalTimeoutMs ?? 55000;

// Session normalization lives on the provider facet; a single module-level
// instance is stateless beyond per-call message assembly.
const qoderSessions = new QoderSessionsProvider();

/**
 * Maps the UI permission mode onto Qoder's `--permission-mode` flag.
 *
 * Qoder exposes a single `--permission-mode` switch with snake_case values
 * (verified against `qodercli --help`):
 * - plan              → `plan`
 * - bypassPermissions → `bypass_permissions`
 * - acceptEdits       → `accept_edits`
 * - default           → nothing; the user's own Qoder config governs.
 *
 * Exported for tests only.
 */
export function resolveQoderPermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--permission-mode', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--permission-mode', 'bypass_permissions'], env: {} };
    case 'acceptEdits':
      return { args: ['--permission-mode', 'accept_edits'], env: {} };
    default:
      return { args: [], env: {} };
  }
}

/**
 * Reads the provider-native session id from a Qoder stream event.
 *
 * Qoder emits `session_id` (lowercase snake) on each NDJSON event, unlike
 * OpenCode's `sessionID`. The camelCase fallback keeps legacy transcript
 * variants working. Exported for tests only.
 */
export function readQoderSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.session_id || event.sessionId || null;
}

/**
 * Qoder accepts any of its fixed reasoning-effort values directly; there is no
 * model-catalog gate, so only the UI's `default` sentinel is filtered out.
 */
function resolveQoderEffort(effort) {
  return typeof effort === 'string' && effort !== 'default' ? effort : undefined;
}

/**
 * Whether a run should speak Qoder's stdio control protocol (interactive tool
 * approvals). Enabled whenever the permission mode can ask the human — default
 * (the user's own Qoder config governs, which still asks for e.g. Bash) and
 * accept_edits (edits auto-accept but shell still asks). `bypass_permissions`
 * and `plan` never need a human channel, so they keep the plain print mode.
 * Exported for tests only.
 */
export function isQoderInteractivePermissionMode(permissionMode) {
  return permissionMode !== 'bypassPermissions' && permissionMode !== 'plan';
}

/**
 * Builds the stdin NDJSON `control_response` answering a Qoder `can_use_tool`
 * permission request. The decision body uses the `behavior` shape Qoder's
 * permission parser accepts:
 *   { behavior: 'allow'|'deny', message?, updatedInput? }
 * An empty `updatedInput` is dropped so the CLI never runs the tool with `{}`.
 * Exported for tests only.
 */
export function buildQoderControlResponse(requestId = '', decision = {}) {
  const allow = Boolean(decision.allow);
  const response = allow
    ? { behavior: 'allow' }
    : {
        behavior: 'deny',
        message:
          typeof decision.message === 'string' && decision.message.trim()
            ? decision.message
            : 'User denied tool use',
      };

  const updatedInput = decision.updatedInput;
  const hasUsableInput =
    updatedInput !== undefined &&
    updatedInput !== null &&
    (typeof updatedInput !== 'object' || Object.keys(updatedInput).length > 0);
  if (allow && hasUsableInput) {
    response.updatedInput = updatedInput;
  }

  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/**
 * Recognizes a Qoder `can_use_tool` permission prompt in the stdout stream.
 * Qoder asks by emitting a `control_request` whose `request` carries
 * `{ subtype: 'can_use_tool', tool_name, input, ... }` plus a top-level
 * `request_id`; the host answers through stdin (see buildQoderControlResponse).
 * Returns null for any other event so callers can skip it. Exported for tests.
 */
export function parseQoderControlRequest(event) {
  if (!event || typeof event !== 'object' || event.type !== 'control_request') {
    return null;
  }
  const request = event.request && typeof event.request === 'object' ? event.request : null;
  if (!request || request.subtype !== 'can_use_tool') {
    return null;
  }
  const requestId = typeof event.request_id === 'string' && event.request_id.trim() ? event.request_id : null;
  if (!requestId) {
    return null;
  }
  return {
    requestId,
    toolName:
      (typeof request.tool_name === 'string' && request.tool_name.trim())
        ? request.tool_name
        : ((typeof request.display_name === 'string' && request.display_name.trim())
            ? request.display_name
            : 'UnknownTool'),
    input: request.input ?? request.args ?? {},
    description: typeof request.description === 'string' ? request.description : undefined,
  };
}

function registerQoderApproval({
  requestId,
  respond,
  sessionId,
  toolName,
  input,
  description,
  processKey,
  onExpire,
}) {
  const entry = {
    respond,
    _sessionId: sessionId,
    _toolName: toolName || 'UnknownTool',
    _input: input,
    _context: description,
    _processKey: processKey,
    receivedAt: new Date(),
    timeout: setTimeout(() => {
      pendingQoderApprovals.delete(requestId);
      onExpire?.(entry);
    }, QODER_APPROVAL_TIMEOUT_MS),
  };
  entry.timeout.unref?.();
  pendingQoderApprovals.set(requestId, entry);
}

function releaseQoderApproval(requestId) {
  const entry = pendingQoderApprovals.get(requestId);
  if (!entry) {
    return null;
  }
  pendingQoderApprovals.delete(requestId);
  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }
  return entry;
}

/**
 * Handles a human decision for one pending Qoder tool approval (arrives via
 * `chat.permission-response`). Writes the matching `control_response` to the
 * qodercli process stdin. Unknown requestIds are a no-op — already resolved,
 * cancelled, or owned by another provider.
 */
export function resolveQoderToolApproval(requestId, decision = {}) {
  const entry = pendingQoderApprovals.get(requestId);
  if (!entry) {
    return;
  }
  releaseQoderApproval(requestId);
  try {
    entry.respond(buildQoderControlResponse(requestId, decision || {}));
  } catch (error) {
    console.error('[qoder-runner] failed to write control_response:', error?.message || error);
  }
}

/**
 * Pending tool approvals for one session, mirroring the Claude runtime's
 * `getPendingApprovalsForSession` so `chat.subscribe` can replay them after a
 * page refresh.
 */
export function getQoderPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, entry] of pendingQoderApprovals.entries()) {
    if (entry._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: entry._toolName,
        input: entry._input,
        context: entry._context,
        sessionId,
        receivedAt: entry.receivedAt,
      });
    }
  }
  return pending;
}

/**
 * Assembles the full `qodercli` argument vector for a headless run.
 *
 * In interactive mode (`interactive: true`) the control protocol is enabled
 * (`--input-format stream-json` + `--permission-prompt-tool stdio`) so tool
 * approvals flow over stdin/stdout, and the prompt is delivered over stdin as a
 * `user` NDJSON message instead of a positional arg — Qoder only seeds the
 * query from the argument vector in plain print mode, and mixing a positional
 * prompt with stream-json input would double-seed it.
 *
 * Exported for tests only.
 */
export function buildQoderArgs({
  workingDir,
  providerSessionId,
  model,
  effort,
  permissionMode,
  mcpConfigPath,
  attachments,
  prompt,
  interactive,
}) {
  const args = ['-p', '-o', 'stream-json'];
  args.push('--cwd', workingDir);
  if (providerSessionId) {
    args.push('--resume', providerSessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  const resolvedEffort = resolveQoderEffort(effort);
  if (resolvedEffort) {
    args.push('--reasoning-effort', resolvedEffort);
  }
  const permissionOptions = resolveQoderPermissionOptions(permissionMode);
  args.push(...permissionOptions.args);
  if (interactive) {
    args.push('--input-format', 'stream-json');
    args.push('--permission-prompt-tool', 'stdio');
  }
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      args.push('--attachment', attachment);
    }
  }
  const trimmedPrompt = prompt && prompt.trim();
  if (trimmedPrompt && !interactive) {
    args.push(trimmedPrompt);
  }
  return args;
}

function sendMessage(ws, data) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[qoder-runner] send failed', error.message || error);
  }
}

export async function queryQoder(command, options = {}, ws) {
  return new Promise((resolve, reject) => {
    const {
      sessionId = null,
      projectPath,
      cwd = process.cwd(),
      model,
      effort,
      sessionSummary,
      images = [],
      files = [],
      permissionMode = 'default',
      mcpConfigPath,
    } = options;
    // Callers pass the provider-native session id (the chat gateway rewrites
    // options.sessionId from the session row's provider_session_id before
    // dispatch); the CLI resumes with that same id, no DB translation needed.
    const providerSessionId = sessionId;
    const workingDir = cwd || projectPath || process.cwd();
    // Process-map key: the app session id when the caller supplied one, so
    // abort-by-app-id always works.
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let qoderProcess = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    // A spawn failure fires BOTH the 'error' and 'close' handlers; this flag
    // dedupes the "Qoder CLI is not installed" hint so the user sees it once.
    let notInstalledSent = false;
    // Interactive (control-protocol) mode: the CLI speaks NDJSON on stdin and
    // emits `can_use_tool` approval requests we answer with control_responses.
    const interactive = isQoderInteractivePermissionMode(permissionMode);
    // In stream-json input mode the CLI keeps reading stdin until EOF, so after
    // the terminal `result` event we close stdin to let the process exit.
    let stdinEnded = false;

    /**
     * Writes one NDJSON frame to the qodercli stdin. Best-effort: a process in
     * teardown (aborted, crashed) returns false instead of throwing.
     */
    const writeNdjson = (message) => {
      if (!qoderProcess || !qoderProcess.stdin || qoderProcess.stdin.destroyed || qoderProcess.stdin.writableEnded) {
        return false;
      }
      try {
        qoderProcess.stdin.write(JSON.stringify(message) + '\n');
        return true;
      } catch (error) {
        console.error('[qoder-runner] failed writing to qoder stdin:', error?.message || error);
        return false;
      }
    };

    /**
     * Cancels every still-pending approval owned by this run. Called on process
     * exit/error so (a) the CLI is not left waiting and (b) the frontend popup
     * and task "等你批准" markers are cleared exactly once.
     */
    const cancelPendingApprovals = () => {
      for (const [requestId, entry] of Array.from(pendingQoderApprovals.entries())) {
        if (entry._processKey !== processKey) {
          continue;
        }
        releaseQoderApproval(requestId);
        sendMessage(ws, createNormalizedMessage({
          kind: 'permission_cancelled',
          requestId,
          reason: 'run ended',
          sessionId: sessionId || capturedSessionId || processKey,
          provider: 'qoder',
        }));
      }
    };

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'qoder',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'qoder',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Qoder CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && qoderProcess) {
        activeQoderProcesses.delete(processKey);
        activeQoderProcesses.set(capturedSessionId, qoderProcess);
      }
      if (qoderProcess) {
        qoderProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        sendMessage(ws, createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'qoder',
        }));
      }
    };

    const processQoderOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        sendMessage(ws, createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qoder',
        }));
        return;
      }

      try {
        registerSession(readQoderSessionId(response));

        // Interactive permission protocol: a `can_use_tool` control_request is
        // a pending tool approval. Surface it as a frontend `permission_request`
        // and register the answer channel; the human's decision arrives through
        // resolveQoderToolApproval → writeNdjson(control_response).
        if (response.type === 'control_request') {
          const parsed = parseQoderControlRequest(response);
          if (parsed) {
            const sid = capturedSessionId || sessionId || null;
            sendMessage(ws, createNormalizedMessage({
              kind: 'permission_request',
              requestId: parsed.requestId,
              toolName: parsed.toolName,
              input: parsed.input,
              context: parsed.description,
              sessionId: sid,
              provider: 'qoder',
            }));
            registerQoderApproval({
              requestId: parsed.requestId,
              respond: (message) => writeNdjson(message),
              sessionId: sid,
              toolName: parsed.toolName,
              input: parsed.input,
              description: parsed.description,
              processKey,
              onExpire: () => {
                // No human decision inside the window: deny so the CLI can
                // keep going, and clear the popup that was never answered.
                writeNdjson(buildQoderControlResponse(parsed.requestId, {
                  allow: false,
                  message: 'Permission request timed out',
                }));
                sendMessage(ws, createNormalizedMessage({
                  kind: 'permission_cancelled',
                  requestId: parsed.requestId,
                  reason: 'timeout',
                  sessionId: capturedSessionId || sessionId || null,
                  provider: 'qoder',
                }));
              },
            });
          }
          return; // control frames are protocol, not chat messages
        }

        // The CLI cancelled a request it already issued (interrupt, mode change,
        // recheck): drop the pending entry and hide the popup. No response is
        // written — the CLI will not wait for one.
        if (response.type === 'control_cancel_request' || response.type === 'control_cancel') {
          const rid = typeof response.request_id === 'string' ? response.request_id : null;
          if (rid && pendingQoderApprovals.has(rid)) {
            releaseQoderApproval(rid);
            sendMessage(ws, createNormalizedMessage({
              kind: 'permission_cancelled',
              requestId: rid,
              reason: 'cancelled',
              sessionId: capturedSessionId || sessionId || null,
              provider: 'qoder',
            }));
          }
          return;
        }

        // Qoder reports usage as credits on the terminal `result` event rather
        // than through a queryable database, so surface it inline as soon as it
        // arrives. `usage.input_tokens/output_tokens` are always 0.
        if (response.type === 'result') {
          // The turn is over (this is the terminal usage/status event). With
          // stream-json input the CLI would otherwise keep waiting on stdin for
          // the next message, so signal EOF to let it exit and reach `close`.
          if (interactive && !stdinEnded) {
            stdinEnded = true;
            setImmediate(() => {
              try {
                qoderProcess?.stdin?.end();
              } catch {
                // stdin already closed — the process is teardown.
              }
            });
          }
          const hasUsage = response.total_credits != null || response.total_cost_usd != null;
          if (hasUsage) {
            sendMessage(ws, createNormalizedMessage({
              kind: 'status',
              text: 'token_budget',
              tokenBudget: {
                credits: response.total_credits ?? 0,
                costUsd: response.total_cost_usd ?? 0,
                modelUsage: response.modelUsage,
                numTurns: response.num_turns,
                durationMs: response.duration_ms,
              },
              sessionId: capturedSessionId || sessionId || null,
              provider: 'qoder',
            }));
          }

          // Failed runs still emit a `result` event (subtype
          // `error_during_execution`); surface the CLI's error text so the
          // user sees why Qoder stopped.
          if (response.is_error || response.subtype === 'error_during_execution') {
            const errorText = response.errors?.[0] ?? response.result;
            if (errorText) {
              sendMessage(ws, createNormalizedMessage({
                kind: 'error',
                content: typeof errorText === 'string' ? errorText : JSON.stringify(errorText),
                sessionId: capturedSessionId || sessionId || null,
                provider: 'qoder',
              }));
            }
          }
        }

        const normalized = qoderSessions.normalizeMessage(response, capturedSessionId || sessionId || null);
        for (const msg of normalized) {
          sendMessage(ws, msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Qoder] Failed to process JSON output:', errorContent);
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qoder',
        }));
      }
    };

    // Qoder attaches files/images natively via `--attachment`, so the prompt
    // carries the raw text only (unlike OpenCode, which embeds
    // <files_input>/<images_input> tags because its CLI parses them).
    const attachmentPaths = [
      ...normalizeImageDescriptors(images).map((descriptor) => descriptor.path),
      ...normalizeImageDescriptors(files).map((descriptor) => descriptor.path),
    ];

    const args = buildQoderArgs({
      workingDir,
      providerSessionId,
      model,
      effort,
      permissionMode,
      mcpConfigPath,
      attachments: attachmentPaths,
      prompt: flattenPromptForWindowsShell(command?.trim() || ''),
      interactive,
    });

    const permissionOptions = resolveQoderPermissionOptions(permissionMode);

    qoderProcess = spawn('qodercli', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...permissionOptions.env },
    });

    activeQoderProcesses.set(processKey, qoderProcess);
    qoderProcess.sessionId = processKey;

    // Interactive mode delivers the initial prompt as a stdin `user` NDJSON
    // frame (mirroring Qoder's own synthetic-seed shape) and keeps stdin OPEN
    // so the CLI can receive `control_response` permission decisions. Plain
    // print mode keeps passing the prompt positionally and closes stdin.
    if (interactive) {
      const trimmedPrompt = command?.trim();
      if (trimmedPrompt) {
        writeNdjson({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: flattenPromptForWindowsShell(trimmedPrompt) }] },
          isSynthetic: true,
          isMeta: true,
        });
      }
    } else {
      qoderProcess.stdin.end();
    }

    qoderProcess.stdout.setEncoding('utf8');
    qoderProcess.stdout.on('data', (data) => {
      stdoutLineBuffer += data.toString();
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';

      completeLines.forEach((line) => {
        processQoderOutputLine(line.trim());
      });
    });

    qoderProcess.stderr.setEncoding('utf8');
    qoderProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      if (!stderrText.trim()) {
        return;
      }

      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: stderrText,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'qoder',
      }));
    });

    qoderProcess.on('close', async (code) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeQoderProcesses.delete(finalSessionId);
      activeQoderProcesses.delete(processKey);

      if (stdoutLineBuffer.trim()) {
        processQoderOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      // The run is over: no pending tool approval can ever be answered, so
      // clear them (and their popups) before the terminal complete.
      cancelPendingApprovals();

      // Terminal complete — skipped for aborted runs (abort-session
      // already sent the aborted complete on this run's behalf).
      if (!completeSent && !qoderProcess.aborted) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({ provider: 'qoder', sessionId: finalSessionId, exitCode: code }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      if (code === 127 || code === null) {
        const installed = await providerAuthService.isProviderInstalled('qoder');
        if (!installed && !notInstalledSent) {
          notInstalledSent = true;
          sendMessage(ws, createNormalizedMessage({
            kind: 'error',
            content: 'Qoder CLI is not installed. Install it with: npm i -g @qoder-ai/qodercli',
            sessionId: finalSessionId,
            provider: 'qoder',
          }));
        }
      }

      notifyTerminalState({ code });
      reject(new Error(code === null ? 'Qoder CLI process was terminated' : `Qoder CLI exited with code ${code}`));
    });

    qoderProcess.on('error', async (error) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeQoderProcesses.delete(finalSessionId);
      activeQoderProcesses.delete(processKey);

      cancelPendingApprovals();

      const installed = await providerAuthService.isProviderInstalled('qoder');
      if (!installed && !notInstalledSent) {
        notInstalledSent = true;
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: 'Qoder CLI is not installed. Install it with: npm i -g @qoder-ai/qodercli',
          sessionId: finalSessionId,
          provider: 'qoder',
        }));
      } else {
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: error.message,
          sessionId: finalSessionId,
          provider: 'qoder',
        }));
      }
      if (!completeSent && !qoderProcess.aborted) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({ provider: 'qoder', sessionId: finalSessionId, exitCode: 1 }));
      }
      notifyTerminalState({ error });
      reject(error);
    });
  });
}

/**
 * Aborts an active qoder run by killing its child process.
 * The abort-session handler emits the terminal `complete` (aborted: true)
 * on behalf of the run, so the close handler skips its own.
 */
export function abortQoderSession(sessionId) {
  const process = activeQoderProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.aborted = true;
  try {
    process.kill('SIGTERM');
  } catch {
    // already gone
  }
  activeQoderProcesses.delete(sessionId);
  return true;
}

export function isQoderSessionActive(sessionId) {
  return activeQoderProcesses.has(sessionId);
}

export function getActiveQoderSessions() {
  return Array.from(activeQoderProcesses.keys());
}