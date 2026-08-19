/**
 * Qoder run manager — remote-lite port of `backend/server/qoder-runner.js`'s
 * `queryQoder` and its stdio approval protocol.
 *
 * Spawns the `qodercli` binary headless (`-p -o stream-json`), parses its NDJSON
 * stdout, and pushes every normalized message the local runner would
 * `sendMessage(ws, x)` as `{ _remoteNorm: true, message: x }` on
 * `session:<appSessionId>`. The terminal marker `{ type: 'complete' }` is pushed
 * last so main's routing finish()es.
 *
 * Approval protocol (ported from the local runner): in interactive permission
 * modes the CLI emits `control_request` (`subtype: 'can_use_tool'`) frames; each
 * is surfaced via the remote-protocol `approval:<requestId>` topic
 * (`{ appSessionId, approval: { tool_use_id, name, input } }`), which is what
 * main routes to the frontend `permission_request` popup and back through
 * `approval/respond`. (The LOCAL runner additionally sent a `permission_request`
 * session message because it has no RPC forwarding layer; the lite must NOT —
 * main's `__remoteApproval` would double-fire the popup.) The human decision
 * arrives via `RunManager.respond` → the matching `control_response` NDJSON is
 * written to the qodercli stdin. A timeout auto-denies (and pushes a
 * `cancelled` marker so main clears the popup), mirroring the local
 * `QODER_APPROVAL_TIMEOUT_MS` expiry.
 *
 * Port adaptations vs the local file:
 * - `cross-spawn` → `node:child_process` spawn; no npm dependency added.
 * - the live-event normalizer is trimmed to stream shapes (qoder history
 *   branches — local-command tags, file-input parsing — are main-side RPC
 *   concerns, not live stream events).
 * - env merges `{ ...process.env, ...permissionOptions.env, ...configEnv }`
 *   (never bare configEnv — that would strip PATH).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

import type { RunManager, SessionStartParams } from '../agent-run.js';
import type { RunManagerDeps } from './registry.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  generateMessageId,
  isInternalContent,
  readObjectRecord,
  type LiteNormalizedMessage,
} from './lite-normalize.js';
import { buildRunEnv, createApprovalRegistry, makeCompleteMarker, makeRunRecord, validateRunCwd, type RunRecord } from './run-shared.js';

const PROVIDER = 'qoder';

/**
 * Maps the UI permission mode onto Qoder's `--permission-mode` flag — mirror of
 * the local `resolveQoderPermissionOptions` (switch at lines 56-67). Exported
 * for tests.
 */
export function resolveQoderPermissionOptions(permissionMode: string | undefined): {
  args: string[];
  env: Record<string, string>;
} {
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
 * Reads the provider-native session id from a Qoder stream event — mirror of
 * the local `readQoderSessionId`. Exported for tests.
 */
export function readQoderSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const record = event as Record<string, unknown>;
  return (typeof record.session_id === 'string' ? record.session_id : null)
    ?? (typeof record.sessionId === 'string' ? record.sessionId : null)
    ?? null;
}

/**
 * Whether a run should speak Qoder's stdio control protocol — mirror of the
 * local `isQoderInteractivePermissionMode`. Exported for tests.
 */
export function isQoderInteractivePermissionMode(permissionMode: string | undefined): boolean {
  return permissionMode !== 'bypassPermissions' && permissionMode !== 'plan';
}

/**
 * Builds the stdin NDJSON `control_response` answering a Qoder `can_use_tool`
 * request — mirror of the local `buildQoderControlResponse`. An empty
 * `updatedInput` is dropped so the CLI never runs the tool with `{}`.
 * Exported for tests.
 */
export function buildQoderControlResponse(
  requestId = '',
  decision: Record<string, unknown> = {},
): Record<string, unknown> {
  const allow = Boolean(decision.allow);
  const response: Record<string, unknown> = allow
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
    updatedInput !== undefined
    && updatedInput !== null
    && (typeof updatedInput !== 'object' || Object.keys(updatedInput as Record<string, unknown>).length > 0);
  if (allow && hasUsableInput) {
    response.updatedInput = updatedInput;
  }

  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

export type QoderControlRequest = {
  requestId: string;
  toolName: string;
  input: unknown;
  description?: string;
};

/**
 * Recognizes a Qoder `can_use_tool` permission prompt in the stdout stream —
 * mirror of the local `parseQoderControlRequest`. Returns null for any other
 * event so callers can skip it. Exported for tests.
 */
export function parseQoderControlRequest(event: unknown): QoderControlRequest | null {
  const record = readObjectRecord(event);
  if (!record || record.type !== 'control_request') {
    return null;
  }
  const request = readObjectRecord(record.request);
  if (!request || request.subtype !== 'can_use_tool') {
    return null;
  }
  const requestId = typeof record.request_id === 'string' && record.request_id.trim()
    ? record.request_id
    : null;
  if (!requestId) {
    return null;
  }
  const toolName =
    (typeof request.tool_name === 'string' && request.tool_name.trim())
      ? request.tool_name
      : ((typeof request.display_name === 'string' && request.display_name.trim())
          ? request.display_name
          : 'UnknownTool');
  return {
    requestId,
    toolName,
    input: request.input ?? request.args ?? {},
    description: typeof request.description === 'string' ? request.description : undefined,
  };
}

/**
 * Qoder accepts any of its fixed reasoning-effort values directly — mirror of
 * the local `resolveQoderEffort` (UI `default` sentinel filtered out).
 */
function resolveQoderEffort(effort: string | undefined): string | undefined {
  return typeof effort === 'string' && effort !== 'default' ? effort : undefined;
}

/**
 * Assembles the full `qodercli` argument vector — mirror of the local
 * `buildQoderArgs`: interactive modes enable the stdio control protocol and
 * deliver the prompt as a stdin `user` NDJSON frame (a positional prompt would
 * double-seed it). Exported for tests.
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
}: {
  workingDir: string;
  providerSessionId: string | null;
  model?: string | null;
  effort?: string;
  permissionMode?: string;
  mcpConfigPath?: string | null;
  attachments?: string[];
  prompt: string;
  interactive: boolean;
}): string[] {
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

/**
 * Live-event normalization mirror of `QoderSessionsProvider.normalizeMessage`
 * (`backend/server/modules/providers/list/qoder/qoder-sessions.provider.ts`),
 * trimmed to the branches the LIVE stream exercises (`content_block_delta` /
 * `content_block_stop` stream frames plus message/thinking/tool shapes).
 * History-only branches (local-command tag remapping, files-input stripping,
 * image base64 blocks) are main-side RPC concerns over `session/messages`, not
 * live-stream events.
 */
function normalizeQoderLiveEvent(rawValue: unknown, sessionId: string | null): LiteNormalizedMessage[] {
  const raw = readObjectRecord(rawValue);
  if (!raw) {
    return [];
  }

  if (raw.type === 'content_block_delta' && (raw.delta as Record<string, unknown> | undefined)?.text) {
    return [createNormalizedMessage({
      kind: 'stream_delta',
      content: (raw.delta as Record<string, unknown>).text as string,
      sessionId,
      provider: PROVIDER,
    })];
  }
  if (raw.type === 'content_block_stop') {
    return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
  }

  const messages: LiteNormalizedMessage[] = [];
  const ts = (raw.timestamp as string | undefined) || new Date().toISOString();
  const baseId = (raw.uuid as string | undefined) || generateMessageId(PROVIDER);

  if ((raw.message as Record<string, unknown> | undefined)?.role === 'user' && raw.message && raw.isMeta !== true) {
    const content = (raw.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === 'tool_result') {
          messages.push(createNormalizedMessage({
            id: `${baseId}_tr_${part.tool_use_id as string}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_result',
            toolId: part.tool_use_id as string,
            content: typeof part.content === 'string'
              ? (part.content as string)
              : (Array.isArray(part.content)
                  ? (part.content as Array<Record<string, unknown>>)
                      .map((contentPart) => contentPart?.text || '')
                      .join('\n')
                  : JSON.stringify(part.content)),
            isError: Boolean(part.is_error),
            subagentTools: raw.subagentTools,
            toolUseResult: raw.toolUseResult,
          }));
        } else if (part.type === 'text') {
          const text = (part.text as string) || '';
          if (text && !isInternalContent(text)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: text,
            }));
          }
        }
      }
    } else if (typeof content === 'string' && content && !isInternalContent(content)) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
      }));
    }
    return messages;
  }

  if (raw.type === 'thinking' && (raw.message as Record<string, unknown> | undefined)?.content) {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'thinking',
      content: (raw.message as Record<string, unknown>).content,
    }));
    return messages;
  }

  if (raw.type === 'tool_use' && raw.toolName) {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: raw.toolName as string,
      toolInput: raw.toolInput,
      toolId: (raw.toolCallId as string | undefined) || baseId,
    }));
    return messages;
  }

  if (raw.type === 'tool_result') {
    messages.push(createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp: ts,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: (raw.toolCallId as string | undefined) || '',
      content: (raw.output as string | undefined) || '',
      isError: false,
    }));
    return messages;
  }

  if ((raw.message as Record<string, unknown> | undefined)?.role === 'assistant' && raw.message) {
    const content = (raw.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      let partIndex = 0;
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === 'text' && part.text) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: part.text as string,
          }));
        } else if (part.type === 'tool_use') {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: part.name as string,
            toolInput: part.input,
            toolId: part.id as string,
          }));
        } else if (part.type === 'thinking' && part.thinking) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_${partIndex}`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: part.thinking as string,
          }));
        }
        partIndex += 1;
      }
    } else if (typeof content === 'string') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
      }));
    }
    return messages;
  }

  return messages;
}

export function createQoderRunManager(deps: RunManagerDeps): RunManager {
  const runs = new Map<string, RunRecord>();
  // Mirrors the local config default (`config.ts` providers.qoder.toolApprovalTimeoutMs
  // defaults to 60000), NOT the claude runner's 120s approval window.
  const approvals = createApprovalRegistry({ push: deps.push, approvalTimeoutMs: 60_000 });

  function pushNorm(appSessionId: string, message: unknown): void {
    deps.push(`session:${appSessionId}`, { _remoteNorm: true, message });
  }

  async function start(params: SessionStartParams): Promise<{ providerSessionId: string }> {
    const { appSessionId } = params;
    if (runs.has(appSessionId)) {
      throw new Error(`session already running: ${appSessionId}`);
    }
    await validateRunCwd(deps.roots, params.cwd);

    const { run, established, settleEstablished } = makeRunRecord(params);
    let providerSessionId = params.providerSessionId ?? '';
    let sessionCreatedSent = false;
    let completeSent = false;
    let stdinEnded = false;
    let notInstalledSent = false;
    runs.set(appSessionId, run);

    void (async () => {
      let runFailed = false;
      let runError = '';
      let qoderProcess: ChildProcess | null = null;
      let stdoutLineBuffer = '';
      const permissionMode = params.permissionMode ?? 'default';
      // Interactive (control-protocol) mode: the CLI speaks NDJSON on stdin and
      // emits `can_use_tool` approval requests we answer with control_responses.
      const interactive = isQoderInteractivePermissionMode(permissionMode);

      const sidFor = () => providerSessionId || null;

      /**
       * Writes one NDJSON frame to the qodercli stdin. Best-effort: a process in
       * teardown (aborted, crashed) returns false instead of throwing. Mirror of
       * the local `writeNdjson`.
       */
      const writeNdjson = (message: Record<string, unknown>): boolean => {
        const stdin = qoderProcess?.stdin as Writable | null | undefined;
        if (!stdin || stdin.destroyed || stdin.writableEnded) {
          return false;
        }
        try {
          stdin.write(`${JSON.stringify(message)}\n`);
          return true;
        } catch (error) {
          console.error('[qoder-runner] failed writing to qoder stdin:', (error as Error)?.message || error);
          return false;
        }
      };

      /**
       * Releases every still-pending approval owned by this run WITHOUT writing a
       * response (the CLI is exiting; it will not wait for one) and clears the
       * frontend popups — mirror of the local `cancelPendingApprovals`.
       */
      const cancelPendingApprovals = (reason: string): void => {
        for (const requestId of approvals.pendingFor(appSessionId)) {
          approvals.release(requestId);
          pushNorm(appSessionId, createNormalizedMessage({
            kind: 'permission_cancelled',
            requestId,
            reason,
            sessionId: sidFor(),
            provider: PROVIDER,
          }));
        }
      };

      const registerSession = (nextSessionId: string | null): void => {
        if (!nextSessionId || run.establishedSid) {
          return;
        }
        run.establishedSid = true;
        providerSessionId = nextSessionId;
        settleEstablished(nextSessionId);
        if (!sessionCreatedSent) {
          sessionCreatedSent = true;
          pushNorm(appSessionId, createNormalizedMessage({
            kind: 'session_created',
            newSessionId: nextSessionId,
            sessionId: nextSessionId,
            provider: PROVIDER,
          }));
        }
      };

      const processQoderOutputLine = (line: string): void => {
        if (!line || !line.trim()) {
          return;
        }

        let response: Record<string, unknown>;
        try {
          response = JSON.parse(line) as Record<string, unknown>;
        } catch {
          pushNorm(appSessionId, createNormalizedMessage({
            kind: 'stream_delta',
            content: line,
            sessionId: sidFor(),
            provider: PROVIDER,
          }));
          return;
        }

        try {
          registerSession(readQoderSessionId(response));

          // Interactive permission protocol: a `can_use_tool` control_request is
          // a pending tool approval. The remote surface for it is ONLY the
          // `approval:<requestId>` topic push — main's `__remoteApproval` handler
          // translates that into the frontend `permission_request` popup (the
          // LOCAL runner additionally sent a `permission_request` session message
          // because it has no RPC forwarding layer; mirroring that here would
          // double-fire the popup on the lite). The human decision arrives back
          // through `approval/respond`, writing the `control_response` NDJSON.
          if (response.type === 'control_request') {
            const parsed = parseQoderControlRequest(response);
            if (parsed) {
              const approval: { tool_use_id: string; name: string; input: unknown; context?: string } = {
                tool_use_id: parsed.requestId,
                name: parsed.toolName,
                input: parsed.input,
              };
              if (parsed.description !== undefined) {
                approval.context = parsed.description;
              }
              approvals.register(parsed.requestId, appSessionId, approval, {
                onAnswer: (decision) => {
                  writeNdjson(buildQoderControlResponse(
                    parsed.requestId,
                    readObjectRecord(decision) ?? {},
                  ));
                },
                onExpire: () => {
                  writeNdjson(buildQoderControlResponse(parsed.requestId, {
                    allow: false,
                    message: 'Permission request timed out',
                  }));
                  pushNorm(appSessionId, createNormalizedMessage({
                    kind: 'permission_cancelled',
                    requestId: parsed.requestId,
                    reason: 'timeout',
                    sessionId: sidFor(),
                    provider: PROVIDER,
                  }));
                },
              });
            }
            return; // control frames are protocol, not chat messages
          }

          // The CLI cancelled a request it already issued (interrupt, mode
          // change, recheck): drop the pending entry and hide the popup. No
          // response is written — the CLI will not wait for one.
          if (response.type === 'control_cancel_request' || response.type === 'control_cancel') {
            const rid = typeof response.request_id === 'string' ? response.request_id : null;
            if (rid && approvals.release(rid)) {
              pushNorm(appSessionId, createNormalizedMessage({
                kind: 'permission_cancelled',
                requestId: rid,
                reason: 'cancelled',
                sessionId: sidFor(),
                provider: PROVIDER,
              }));
            }
            return;
          }

          // Qoder reports usage as credits on the terminal `result` event.
          if (response.type === 'result') {
            // The turn is over; with stream-json input the CLI would otherwise
            // keep waiting on stdin for the next message, so signal EOF.
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
              pushNorm(appSessionId, createNormalizedMessage({
                kind: 'status',
                text: 'token_budget',
                tokenBudget: {
                  credits: response.total_credits ?? 0,
                  costUsd: response.total_cost_usd ?? 0,
                  modelUsage: response.modelUsage,
                  numTurns: response.num_turns,
                  durationMs: response.duration_ms,
                },
                sessionId: sidFor(),
                provider: PROVIDER,
              }));
            }

            // Failed runs still emit a `result` event — surface the CLI's error
            // text so the user sees why Qoder stopped.
            if (response.is_error || response.subtype === 'error_during_execution') {
              const errorText = (response.errors as unknown[] | undefined)?.[0] ?? response.result;
              if (errorText) {
                pushNorm(appSessionId, createNormalizedMessage({
                  kind: 'error',
                  content: typeof errorText === 'string' ? errorText : JSON.stringify(errorText),
                  sessionId: sidFor(),
                  provider: PROVIDER,
                }));
              }
            }
          }

          const normalized = normalizeQoderLiveEvent(response, sidFor());
          for (const msg of normalized) {
            pushNorm(appSessionId, msg);
          }
        } catch (error) {
          const errorContent = error instanceof Error ? error.message : String(error);
          console.error('[Qoder] Failed to process JSON output:', errorContent);
          pushNorm(appSessionId, createNormalizedMessage({
            kind: 'error',
            content: errorContent,
            sessionId: sidFor(),
            provider: PROVIDER,
          }));
        }
      };

      try {
        const args = buildQoderArgs({
          workingDir: params.cwd,
          providerSessionId,
          model: params.model ?? null,
          permissionMode,
          prompt: flattenPromptForWindowsShell(params.command?.trim() || ''),
          interactive,
        });
        const permissionOptions = resolveQoderPermissionOptions(permissionMode);

        qoderProcess = spawn('qodercli', args, {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildRunEnv(permissionOptions.env, params.configEnv),
        });
        run.child = qoderProcess;

        // Interactive mode delivers the initial prompt as a stdin `user` NDJSON
        // frame and keeps stdin OPEN for `control_response` decisions; plain
        // print mode passes the prompt positionally and closes stdin.
        if (interactive) {
          const trimmedPrompt = params.command?.trim();
          if (trimmedPrompt) {
            writeNdjson({
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: flattenPromptForWindowsShell(trimmedPrompt) }] },
              isSynthetic: true,
              isMeta: true,
            });
          }
        } else {
          qoderProcess.stdin?.end();
        }

        qoderProcess.stdout?.setEncoding('utf8');
        qoderProcess.stdout?.on('data', (data) => {
          stdoutLineBuffer += data.toString();
          const completeLines = stdoutLineBuffer.split(/\r?\n/);
          stdoutLineBuffer = completeLines.pop() || '';
          for (const line of completeLines) {
            processQoderOutputLine(line.trim());
          }
        });

        qoderProcess.stderr?.setEncoding('utf8');
        qoderProcess.stderr?.on('data', (data) => {
          const stderrText = data.toString();
          if (!stderrText.trim()) {
            return;
          }
          pushNorm(appSessionId, createNormalizedMessage({
            kind: 'error',
            content: stderrText,
            sessionId: sidFor(),
            provider: PROVIDER,
          }));
        });

        await new Promise<void>((resolveChild, rejectChild) => {
          qoderProcess?.on('close', (code) => {
            const finalSessionId = sidFor();

            if (stdoutLineBuffer.trim()) {
              processQoderOutputLine(stdoutLineBuffer.trim());
              stdoutLineBuffer = '';
            }

            // The run is over: no pending tool approval can ever be answered,
            // so clear them (and their popups) before the terminal complete.
            cancelPendingApprovals('run ended');

            // Terminal complete — skipped for aborted runs (the interrupt path
            // only pushes the terminal marker below).
            if (!completeSent && !run.aborted) {
              completeSent = true;
              pushNorm(appSessionId, createCompleteMessage({
                provider: PROVIDER,
                sessionId: finalSessionId,
                exitCode: code ?? 1,
              }));
            }

            if (code === 0) {
              resolveChild();
              return;
            }

            if (code === 127 || code === null) {
              if (!notInstalledSent) {
                notInstalledSent = true;
                pushNorm(appSessionId, createNormalizedMessage({
                  kind: 'error',
                  content: 'Qoder CLI is not installed. Install it with: npm i -g @qoder-ai/qodercli',
                  sessionId: finalSessionId,
                  provider: PROVIDER,
                }));
              }
            }

            rejectChild(new Error(
              code === null
                ? 'Qoder CLI process was terminated'
                : `Qoder CLI exited with code ${code}`,
            ));
          });

          qoderProcess?.on('error', (error) => {
            if (run.aborted) {
              resolveChild();
              return;
            }
            const finalSessionId = sidFor();
            cancelPendingApprovals('run ended');

            if (!notInstalledSent) {
              notInstalledSent = true;
              pushNorm(appSessionId, createNormalizedMessage({
                kind: 'error',
                content: `Qoder CLI is not installed. Install it with: npm i -g @qoder-ai/qodercli (${error.message})`,
                sessionId: finalSessionId,
                provider: PROVIDER,
              }));
            }
            if (!completeSent) {
              completeSent = true;
              pushNorm(appSessionId, createCompleteMessage({
                provider: PROVIDER,
                sessionId: finalSessionId,
                exitCode: 1,
              }));
            }
            rejectChild(error);
          });
        });
      } catch (err) {
        if (!run.aborted) {
          runFailed = true;
          runError = err instanceof Error ? err.message : String(err);
          console.error(`[qoder-runner] session ${appSessionId} failed:`, runError);
        }
      } finally {
        cancelPendingApprovals('run ended');
        run.doneResolve();
        runs.delete(appSessionId);
      }
      deps.push(`session:${appSessionId}`, makeCompleteMarker(!runFailed, runFailed ? runError : undefined));
      settleEstablished(providerSessionId);
    })();

    return { providerSessionId: await established };
  }

  function whenDone(appSessionId: string): Promise<void> {
    return runs.get(appSessionId)?.done ?? Promise.resolve();
  }

  function interrupt(appSessionId: string): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }
    run.aborted = true;
    // Pending approvals are released with a permission_cancelled push when the
    // child's close fires; the kill is what unblocks the CLI.
    try {
      run.controller.abort();
    } catch {
      /* ignore */
    }
    if (run.child) {
      try {
        run.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  function interruptAll(): number {
    const ids = Array.from(runs.keys());
    for (const id of ids) interrupt(id);
    return ids.length;
  }

  function respond(requestId: string, decision: unknown): boolean {
    return approvals.respond(requestId, decision);
  }

  return { start, respond, whenDone, interrupt, interruptAll };
}