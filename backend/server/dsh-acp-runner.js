/**
 * DeepSeek Harness (dsh) ACP Runner
 * =================================
 *
 * Drives `dsh --profile acp` over its stdio JSON-RPC channel using the official
 * `@agentclientprotocol/sdk` client side (ACP = Agent Client Protocol). Its role
 * mirrors `qoder-runner.js`: spawn the CLI, normalize the provider's stream into
 * Lovdex messages, surface tool approvals as popups, and reap the child at the
 * end of a turn.
 *
 * Lifecycle contract (shared with every provider runtime):
 * - exactly ONE terminal `complete` per run (see `createCompleteMessage`);
 * - the run is keyed in `activeDshRuns` by the provider-native session id (or a
 *   fresh key for brand-new sessions), so `abortDshSession` can address it;
 * - tool approvals are keyed by the ACP request id and answered through
 *   `resolveDshToolApproval`.
 *
 * Exports mirror the qoder runner so `index.js` wiring is a copy of its rows:
 * - queryDsh(command, options, ws)          — the `spawnFns.dsh` entry
 * - abortDshSession(sessionId)              — cancel + dispose ladder
 * - isDshSessionActive(sessionId)           — session liveness probe
 * - getActiveDshSessions()                  — all live runs
 * - resolveDshToolApproval(requestId, p)    — human decision write-back
 * - getDshPendingApprovalsForSession(id)    — pending popups for replay
 * - runDshTurn(context, options, ws, entry) — the ACP-driving core (test seam)
 */

import { Readable, Writable } from 'node:stream';

import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  client,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import { spawn } from 'cross-spawn';

import { appConfig } from './modules/config/config.js';
import { decideAutoApproval } from './modules/permissions/auto-approve-policy.js';
import { DshSessionsProvider } from './modules/providers/list/dsh/dsh-sessions.provider.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';

const PROVIDER = 'dsh';

// Live runs keyed by the provider-native session id (or a fresh key until the
// ACP `session/new` response announces one). One entry per spawned child.
const activeDshRuns = new Map();

// Pending human tool approvals keyed by the ACP request id (see
// `permissionKey`). Removed once the human decides, the window expires, or the
// run ends; `resolveDshToolApproval` writes the decision back to the ACP peer.
const pendingDshApprovals = new Map();

// The normalizer is stateless beyond per-call assembly, so one instance serves
// every run (mirrors the qoder runner).
const dshSessions = new DshSessionsProvider();

function sendMessage(ws, data) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[dsh-runner] send failed', error?.message || error);
  }
}

/**
 * The bound for a pending popup before the runner auto-rejects. Precedence:
 * an explicit per-run `options.toolApprovalTimeoutMs` (tests/E2E), then the
 * configured `providers.dsh.toolApprovalTimeoutMs`, then 60s.
 */
function resolveApprovalTimeout(options) {
  const fromOptions = options?.toolApprovalTimeoutMs;
  if (typeof fromOptions === 'number' && Number.isFinite(fromOptions) && fromOptions >= 0) {
    return fromOptions;
  }
  const cfg = appConfig().get().providers?.dsh || {};
  const fromConfig = cfg.toolApprovalTimeoutMs;
  if (typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig >= 0) {
    return fromConfig;
  }
  return 60000;
}

/**
 * Chooses one of the ACP-offered option ids for a yes/no decision.
 *
 * ACP has no allowed/denied boolean — the client must name a concrete
 * `optionId` the agent offered. Allow prefers `allow_once` then `allow_always`;
 * deny prefers `reject_once` then `reject_always`. Returns null when nothing
 * matches, which the caller turns into a protocol-level `cancelled` outcome.
 */
function pickPermissionOption(offered, allow) {
  const wanted = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const match = offered.find((option) => option && option.kind === kind && typeof option.optionId === 'string');
    if (match) {
      return match.optionId;
    }
  }
  return null;
}

/** Builds the ACP permission response for a chosen option id (or cancellation). */
function buildPermissionResponse(optionId) {
  if (!optionId) {
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId } };
}

/** Best-effort answer to an ACP permission request; a torn-down connection is fine. */
async function respondToPermission(responder, result) {
  try {
    await responder.respond(result);
  } catch (error) {
    console.error('[dsh-runner] failed to answer permission request:', error?.message || error);
  }
}

/** The stable id a run is known by in messages/notifications. */
function finalSessionId(entry) {
  return entry.sessionId || entry.capturedSessionId || entry.key;
}

/**
 * Creates the shared per-run bookkeeping object.
 *
 * The terminal `complete` and the stopped/failed notification are both owned
 * here and individually guarded, because several paths can observe the end of a
 * run (the ACP turn resolving, the child's `close`, its `error`, or an abort) —
 * the exactly-one-terminal contract is enforced by these two flags, not by
 * hoping only one path fires.
 */
function createRunEntry({ ws, sessionId, key }) {
  const entry = {
    ws,
    // Provider-native session id supplied by the caller (a resume), or null.
    sessionId: sessionId || null,
    // App session id (never leaves the backend; carried for notifications).
    appSessionId: null,
    // The activeDshRuns map key. Starts as the caller id (or a fresh key) and
    // is re-keyed to the ACP session id for brand-new runs (see registerSession).
    key,
    // Every map key this run is registered under. A resume is keyed by the id
    // the caller sent AND the fresh id `session/new` returns (announced upward
    // via setSessionId), so abort/activity checks must answer for either.
    mapKeys: new Set([key]),
    capturedSessionId: null,
    acpSessionId: null,
    acpContext: null,
    connection: null,
    child: null,
    aborted: false,
    completeSent: false,
    terminalNotificationSent: false,
    sessionCreatedSent: false,
    sessionSummary: null,
    pendingRequestIds: new Set(),
    userId: ws?.userId ?? null,
  };

  entry.emitComplete = (opts = {}) => {
    if (entry.completeSent) {
      return;
    }
    entry.completeSent = true;
    const aborted = Boolean(entry.aborted || opts.aborted);
    const exitCode = aborted
      ? null
      : (typeof opts.exitCode === 'number' ? opts.exitCode : 1);
    sendMessage(ws, createCompleteMessage({
      provider: PROVIDER,
      sessionId: finalSessionId(entry),
      actualSessionId: entry.capturedSessionId || finalSessionId(entry),
      exitCode,
      aborted,
    }));
  };

  entry.notifyTerminal = (opts = {}) => {
    if (entry.terminalNotificationSent) {
      return;
    }
    entry.terminalNotificationSent = true;
    const notificationSessionId = entry.appSessionId || finalSessionId(entry);
    if (entry.aborted) {
      notifyRunStopped({
        userId: entry.userId,
        provider: PROVIDER,
        sessionId: notificationSessionId,
        sessionName: entry.sessionSummary,
        stopReason: 'aborted',
      });
      return;
    }
    if (typeof opts.exitCode === 'number' && opts.exitCode !== 0) {
      notifyRunFailed({
        userId: entry.userId,
        provider: PROVIDER,
        sessionId: notificationSessionId,
        sessionName: entry.sessionSummary,
        error: opts.error || `dsh exited with code ${opts.exitCode}`,
      });
      return;
    }
    notifyRunStopped({
      userId: entry.userId,
      provider: PROVIDER,
      sessionId: notificationSessionId,
      sessionName: entry.sessionSummary,
      stopReason: 'completed',
    });
  };

  return entry;
}

/**
 * Records the ACP session id and announces it once as `session_created`.
 *
 * Resume note: dsh's ACP does NOT support `session/load` (design §2.4), so every
 * run — including a "resume" — always issues `session/new` and receives a fresh
 * id. That new id is announced here for every run; the guard only stops a
 * duplicate announcement within a single run.
 */
function registerSession(entry, ws, acpSessionId) {
  if (!acpSessionId || entry.acpSessionId === acpSessionId) {
    return;
  }
  entry.acpSessionId = acpSessionId;
  entry.capturedSessionId = acpSessionId;

  // A brand-new run was keyed by a placeholder; re-key it to the announced id
  // so abort-by-provider-id addresses this run (mirrors qoder's registerSession).
  // A resume keeps its existing key and simply ALIASES the fresh id to the same
  // entry, so abort works no matter which id the gateway sends.
  if (!entry.sessionId && entry.key !== acpSessionId && activeDshRuns.get(entry.key) === entry) {
    activeDshRuns.delete(entry.key);
    entry.mapKeys.delete(entry.key);
    entry.key = acpSessionId;
  }
  activeDshRuns.set(acpSessionId, entry);
  entry.mapKeys.add(acpSessionId);

  if (typeof ws?.setSessionId === 'function') {
    try {
      ws.setSessionId(acpSessionId);
    } catch (error) {
      console.error('[dsh-runner] setSessionId failed', error?.message || error);
    }
  }

  if (!entry.sessionCreatedSent) {
    entry.sessionCreatedSent = true;
    sendMessage(ws, createNormalizedMessage({
      kind: 'session_created',
      newSessionId: acpSessionId,
      sessionId: acpSessionId,
      provider: PROVIDER,
    }));
  }
}

/**
 * The pending-approval key for one ACP request.
 *
 * The ACP request id is unique only per connection, and one process may run
 * several concurrent dsh sessions — so the key namespaces it with the run key.
 * The frontend receives this value as `requestId` and echoes it back through
 * `resolveDshToolApproval`, so the composite travels intact.
 */
function permissionKey(entry, requestId) {
  return `${finalSessionId(entry)}#${requestId}`;
}

/**
 * Cancels every still-pending approval owned by one run. Called on run
 * teardown so (a) the ACP peer is not left waiting and (b) the frontend popup
 * and any "等你批准" marker are cleared exactly once.
 */
function cancelPendingApprovals(entry, ws) {
  for (const requestId of Array.from(entry.pendingRequestIds)) {
    const pending = pendingDshApprovals.get(requestId);
    if (!pending) {
      continue;
    }
    pendingDshApprovals.delete(requestId);
    entry.pendingRequestIds.delete(requestId);
    // Resolve the awaiting handler so it answers the ACP peer with `cancelled`
    // rather than hanging; the message below is the frontend-facing counterpart.
    try {
      pending.resolve(null);
    } catch (error) {
      console.error('[dsh-runner] pending resolver threw', error?.message || error);
    }
    sendMessage(ws, createNormalizedMessage({
      kind: 'permission_cancelled',
      requestId,
      reason: 'run ended',
      sessionId: finalSessionId(entry),
      provider: PROVIDER,
    }));
  }
}

/**
 * The ACP-driving core of one turn.
 *
 * Split from process spawning on purpose: it takes a live `context` (a
 * `ClientContext` exposing `.request`/`.notify`/`.addDynamicHandler`) and runs
 * initialize → session/new → session/prompt, funnelling `session/update`
 * notifications through the provider normalizer and answering
 * `session/request_permission` prompts. Production reaches it via
 * `queryDsh` (spawned child); tests reach it with an in-process fake agent.
 *
 * Handlers are registered as dynamic handlers on the connection the instant we
 * enter — earlier than the first request — because a `ClientContext` is all we
 * have (the app that owns it is not visible from here) and registrations must
 * be live before any inbound message is processed.
 */
export async function runDshTurn(context, options = {}, ws, entry) {
  const run = entry || createRunEntry({
    ws,
    sessionId: options.sessionId ?? null,
    key: options.sessionId || `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  });
  run.ws = ws;
  run.acpContext = context;
  run.sessionSummary = options.sessionSummary ?? run.sessionSummary;
  run.appSessionId = options.appSessionId ?? run.appSessionId ?? null;

  const workingDir = options.cwd || options.projectPath || process.cwd();
  const promptText = typeof options.prompt === 'string'
    ? options.prompt
    : (typeof options.command === 'string' ? options.command : '');

  const onUpdate = (message) => {
    // ACP passes the whole `{ sessionId, update }` notification; the provider
    // facet turns it into zero or more normalized Lovdex messages.
    const normalized = dshSessions.normalizeMessage(message.params, finalSessionId(run));
    for (const msg of normalized) {
      sendMessage(ws, msg);
    }
  };

  const onPermission = async (message) => {
    const params = message.params || {};
    const responder = message.responder;
    const toolCall = params.toolCall || {};
    const toolName = typeof toolCall.title === 'string' && toolCall.title
      ? toolCall.title
      : 'UnknownTool';
    const input = toolCall.rawInput ?? {};
    const offered = Array.isArray(params.options) ? params.options : [];

    // Unattended auto-approval: decide ourselves and answer the peer directly.
    // Deliberately does NOT register a pending entry — that would leave a popup
    // nobody can answer and a timeout that always fires.
    if (options.autoApprove === true) {
      const decision = decideAutoApproval(toolName, input);
      const denied = decision.behavior === 'deny';
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_auto',
        toolName,
        autoApproveBehavior: decision.behavior,
        autoApproveReason: denied ? decision.reason : undefined,
        sessionId: finalSessionId(run),
        provider: PROVIDER,
      }));
      if (denied) {
        console.warn(`[dsh-runner] auto-denied ${toolName} during an unattended run: ${decision.reason}`);
      }
      await respondToPermission(responder, buildPermissionResponse(pickPermissionOption(offered, !denied)));
      return;
    }

    const requestId = permissionKey(run, responder.id);
    sendMessage(ws, createNormalizedMessage({
      kind: 'permission_request',
      requestId,
      toolName,
      input,
      sessionId: finalSessionId(run),
      provider: PROVIDER,
    }));

    const decision = await new Promise((resolve) => {
      const timeoutMs = resolveApprovalTimeout(options);
      let timer = null;
      if (timeoutMs > 0) {
        // Deliberately NOT unref'd: the wait for a human decision must hold the
        // event loop open (there is no spawned child to do it in the in-process
        // test seam). The timer is always cleared on resolve/cancel, so it can
        // never outlive the run.
        timer = setTimeout(() => {
          if (pendingDshApprovals.has(requestId)) {
            pendingDshApprovals.delete(requestId);
            run.pendingRequestIds.delete(requestId);
            resolve({ timedOut: true });
          }
        }, timeoutMs);
      }
      pendingDshApprovals.set(requestId, {
        owner: run,
        sessionId: finalSessionId(run),
        toolName,
        input,
        receivedAt: new Date(),
        resolve: (payload) => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve(payload);
        },
      });
      run.pendingRequestIds.add(requestId);
    });

    // Resolved with null: the run ended and cancelPendingApprovals already
    // emitted `permission_cancelled`, so just tell the peer we are cancelled.
    if (!decision) {
      await respondToPermission(responder, buildPermissionResponse(null));
      return;
    }

    if (decision.timedOut) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_cancelled',
        requestId,
        reason: 'timeout',
        sessionId: finalSessionId(run),
        provider: PROVIDER,
      }));
      await respondToPermission(responder, buildPermissionResponse(pickPermissionOption(offered, false)));
      return;
    }

    await respondToPermission(responder, buildPermissionResponse(
      pickPermissionOption(offered, Boolean(decision.allow)),
    ));
  };

  const registration = context.addDynamicHandler({
    handleMessage: async (message) => {
      if (message.kind === 'notification' && message.method === CLIENT_METHODS.session_update) {
        onUpdate(message);
        return { handled: true };
      }
      if (message.kind === 'request' && message.method === CLIENT_METHODS.session_request_permission) {
        await onPermission(message);
        return { handled: true };
      }
      return { handled: false, message };
    },
  });

  try {
    await context.request(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    // Resume is NOT supported: dsh's ACP lacks `session/load`, so we always
    // create a fresh session even when the caller supplied a provider id. The
    // app session key is reused (no DB translation needed here); see the module
    // header and the synchronizer facet for the rationale.
    const session = await context.request(AGENT_METHODS.session_new, {
      cwd: workingDir,
      mcpServers: [],
    });
    const acpSessionId = session && typeof session.sessionId === 'string' ? session.sessionId : null;
    registerSession(run, ws, acpSessionId);

    const response = await context.request(AGENT_METHODS.session_prompt, {
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    run.stopReason = response && response.stopReason;

    // The ACP turn resolved: emit the single terminal complete. Aborted runs
    // are completed by the abort path, so they must not emit their own.
    if (!run.aborted) {
      run.emitComplete({ exitCode: 0 });
      run.notifyTerminal({ exitCode: 0 });
    }
    return response;
  } catch (error) {
    // An abort tears the connection down and rejects the prompt; the abort path
    // owns the terminal complete, so stay silent here.
    if (!run.aborted) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: error?.message || String(error),
        sessionId: finalSessionId(run),
        provider: PROVIDER,
      }));
      run.emitComplete({ exitCode: 1 });
      run.notifyTerminal({ exitCode: 1, error });
    }
    return null;
  } finally {
    registration?.dispose();
    // The turn is over: no pending approval can be answered any more. This is
    // the primary cleanup for the direct-call (test) seam; in production the
    // child's `close` handler repeats it harmlessly (the set is already empty).
    cancelPendingApprovals(run, ws);
  }
}

/**
 * Spawns `dsh --profile acp`, wires its stdio into an ACP client, and runs one
 * turn. The `spawnFns.dsh` entry.
 */
export async function queryDsh(command, options = {}, ws) {
  const cfg = appConfig().get().providers?.dsh || {};
  const sessionId = options.sessionId ?? null;
  const key = sessionId || `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const workingDir = options.cwd || options.projectPath || process.cwd();

  const entry = createRunEntry({ ws, sessionId, key });
  entry.sessionSummary = options.sessionSummary ?? null;
  entry.appSessionId = options.appSessionId ?? null;
  activeDshRuns.set(key, entry);

  const turnOptions = {
    ...options,
    cwd: workingDir,
    prompt: options.prompt ?? options.command ?? command ?? '',
  };

  const child = spawn(command || cfg.binPath || 'dsh', ['--profile', 'acp'], {
    cwd: workingDir,
    env: {
      ...process.env,
      ...(cfg.dshHome ? { DSH_HOME: cfg.dshHome } : {}),
      ...(cfg.apiKey ? { DEEPSEEK_API_KEY: cfg.apiKey } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  entry.child = child;

  const forgetRun = () => {
    for (const key of entry.mapKeys) {
      if (activeDshRuns.get(key) === entry) {
        activeDshRuns.delete(key);
      }
    }
    entry.mapKeys.clear();
  };

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) {
      console.error('[dsh-runner]', text.trimEnd());
    }
  });

  child.on('error', (error) => {
    cancelPendingApprovals(entry, ws);
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      content: `Failed to start DeepSeek Harness: ${error.message}`,
      sessionId: finalSessionId(entry),
      provider: PROVIDER,
    }));
    if (!entry.aborted) {
      entry.emitComplete({ exitCode: 1 });
    }
    entry.notifyTerminal({ exitCode: 1, error });
    forgetRun();
  });

  child.on('close', (code) => {
    cancelPendingApprovals(entry, ws);
    if (!entry.aborted) {
      entry.emitComplete({ exitCode: typeof code === 'number' ? code : 1 });
    }
    entry.notifyTerminal({ exitCode: typeof code === 'number' ? code : 1 });
    forgetRun();
  });

  try {
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = client({ name: 'lovdex' }).connect(stream);
    entry.connection = connection;
    await runDshTurn(connection.agent, turnOptions, ws, entry);
  } catch (error) {
    // runDshTurn already surfaced the error and emitted the complete; nothing
    // further to report here.
    console.error('[dsh-runner] turn failed', error?.message || error);
  } finally {
    // End the child's stdin so `dsh --profile acp` sees EOF and exits; the
    // `close` handler then reaps the run (mirrors qoder's stdin.end on result).
    try {
      child.stdin?.end();
    } catch {
      // stdin already closed
    }
  }
}

/**
 * Cancels an active dsh run.
 *
 * Sends the ACP `session/cancel` notification if the connection is still live,
 * then escalates: stdin EOF → SIGTERM → SIGKILL. The abort-session handler
 * emits the terminal `complete` (aborted: true) on the run's behalf, so the run
 * loop's own completion is suppressed by the `aborted` guard.
 *
 * Returns true when a run was found, false otherwise.
 */
export function abortDshSession(sessionId) {
  const entry = activeDshRuns.get(sessionId);
  if (!entry) {
    return false;
  }

  entry.aborted = true;

  // Clear any pending popup immediately (the run can never be answered now);
  // the child's `close` handler would also do this, but abort should not wait.
  cancelPendingApprovals(entry, entry.ws);

  const context = entry.acpContext;
  if (context && typeof context.notify === 'function') {
    try {
      void context
        .notify(AGENT_METHODS.session_cancel, { sessionId: entry.acpSessionId })
        .catch(() => {});
    } catch {
      // connection already torn down
    }
  }

  const child = entry.child;
  if (child) {
    try {
      child.stdin?.end();
    } catch {
      // stdin already closed
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timer = setTimeout(() => {
      try {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      } catch {
        // already gone
      }
    }, 3000);
    timer.unref?.();
  }

  // Drop every map key (the caller id and/or the announced ACP id, whichever
  // this run was registered under) so a subsequent abort/activity check for
  // either id reports the run as gone.
  for (const key of entry.mapKeys) {
    if (activeDshRuns.get(key) === entry) {
      activeDshRuns.delete(key);
    }
  }
  entry.mapKeys.clear();
  return true;
}

export function isDshSessionActive(sessionId) {
  return activeDshRuns.has(sessionId);
}

export function getActiveDshSessions() {
  return Array.from(activeDshRuns.keys());
}

/**
 * Answers one pending dsh tool approval (arrives via `chat.permission-response`).
 *
 * `payload` carries `{ allow: boolean, message?: string, updatedInput?: unknown }`
 * — the same shape the qoder resolver accepts. Unknown request ids are a no-op
 * (already resolved, cancelled, or owned by another provider). Returns true when
 * a pending entry was found and resolved.
 */
export function resolveDshToolApproval(requestId, payload = {}) {
  const pending = pendingDshApprovals.get(requestId);
  if (!pending) {
    return false;
  }
  pendingDshApprovals.delete(requestId);
  pending.owner?.pendingRequestIds?.delete(requestId);
  try {
    pending.resolve(payload || {});
  } catch (error) {
    console.error('[dsh-runner] failed to resolve approval:', error?.message || error);
  }
  return true;
}

/**
 * Pending tool approvals for one session, mirroring the Claude/Qoder runtime's
 * `getPendingApprovalsForSession` so `chat.subscribe` can replay the popups
 * after a page refresh. Matched against both the provider-native id and the run
 * key, because either may be the id the caller knows the session by.
 */
export function getDshPendingApprovalsForSession(providerSessionId) {
  const pending = [];
  for (const [requestId, entry] of pendingDshApprovals.entries()) {
    const owner = entry.owner;
    const ids = [entry.sessionId, owner?.capturedSessionId, owner?.sessionId, owner?.key];
    if (ids.includes(providerSessionId)) {
      pending.push({
        requestId,
        toolName: entry.toolName,
        input: entry.input,
        context: entry.context,
        sessionId: entry.sessionId,
        receivedAt: entry.receivedAt,
      });
    }
  }
  return pending;
}
