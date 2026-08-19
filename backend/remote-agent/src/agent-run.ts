import { randomUUID } from 'node:crypto';

import type { query } from '@anthropic-ai/claude-agent-sdk';
import { normalizeAgentEvent, terminalCompleteEvent } from '../../server/shared/agent-runtime/normalize.js';
import { createAllowlistedFs } from './fs.js';

/**
 * The minimal SDK surface the lite loop consumes. Tests inject a fake async
 * generator so the loop is exercised WITHOUT spawning the real claude
 * subprocess. The real `@anthropic-ai/claude-agent-sdk` `query` takes
 * `{ prompt, options }` and returns a `Query` (an async generator); here we keep
 * the surface loose — `(command, options) => AsyncIterable<record>` — because
 * the lite service only ever reads events out of it and hands options in. The
 * adapter that maps the loose shape onto the real `query({ prompt, options })`
 * call lives in {@link defaultQuerySdk}.
 */
export type QuerySdkLike = (
  command: string,
  options: Record<string, unknown>,
) => AsyncIterable<Record<string, unknown>>;

export type AgentRunManagerDeps = {
  /**
   * Injected SDK. Defaults to {@link defaultQuerySdk}, which bridges onto the
   * real `query({ prompt, options })`.
   */
  querySdk?: QuerySdkLike;
  /** Wired to the ws push bus by index.ts via setPushEmitter. */
  push: (topic: string, payload: unknown) => void;
  /** Approval wait timeout in ms; auto-denies past this. Default 120s. */
  approvalTimeoutMs?: number;
  /**
   * I4 review fix — allowlisted host roots (mirror of cfg.roots). When set,
   * `start()` rejects any `cwd` that is not an existing directory inside one
   * of these roots, so a misbehaving/malicious main server cannot make the
   * lite spawn claude outside the operator's declared surface.
   */
  roots?: string[];
};

export type SessionStartParams = {
  appSessionId: string;
  providerSessionId: string | null;
  command: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  includePartialMessages?: boolean;
  /**
   * Per-session provider configuration (API keys, model env, …), delivered from
   * main's `makeSessionStartParamsSchema` (which defaults it to `{}`). Merged
   * over `process.env` in the options handed to the SDK on this run only — never
   * written to the lite's own `process.env`.
   */
  configEnv?: Record<string, string>;
};

/**
 * The manager surface shared by every provider runner (claude today; codex /
 * opencode / qoder land in a later task). Cached per (provider, roots) in
 * rpc-dispatch so `session/interrupt` / `approval/respond` / `session/messages`
 * always reach the same instance that handled `session/start`.
 */
export type RunManager = {
  start(params: SessionStartParams): Promise<{ providerSessionId: string }>;
  respond(requestId: string, decision: unknown): boolean;
  whenDone(appSessionId: string): Promise<void>;
  interrupt(appSessionId: string): boolean;
  interruptAll(): number;
};

/** A tool-permission request object as surfaced by the SDK `canUseTool`. */
type ToolPermissionInput = {
  tool_use_id?: string;
  toolUseID?: string;
  name?: string;
  input?: Record<string, unknown>;
};

/**
 * Mirrors the SDK `PermissionResult`. `canUseTool` must resolve to one of
 * these shapes (or `null`). We build the minimal `allow` / `deny` variant; the
 * decision passed to {@link respond} may be either `{ allow: true }` /
 * `{ deny: true }` (the lite's own convention) or a full SDK `PermissionResult`
 * (passed through verbatim when it already carries a `behavior`).
 */
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

function fallbackId(): string {
  return randomUUID();
}

/**
 * Translate a decision from {@link respond} (or a timeout auto-deny) into an
 * SDK `PermissionResult`.
 */
function toPermissionResult(decision: unknown): PermissionResult {
  if (decision && typeof decision === 'object') {
    const d = decision as Record<string, unknown>;
    // Already an SDK-shaped result: pass its behavior through.
    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: d.updatedInput as Record<string, unknown> | undefined };
    if (d.behavior === 'deny') return { behavior: 'deny', message: typeof d.message === 'string' ? d.message : 'denied' };
    if (d.allow) return { behavior: 'allow' };
    if (d.deny) return { behavior: 'deny', message: typeof d.message === 'string' ? d.message : 'denied by operator' };
  }
  // Truthy scalar → allow; everything else → deny.
  if (decision) return { behavior: 'allow' };
  return { behavior: 'deny', message: 'denied' };
}

type PendingApproval = {
  appSessionId: string;
  resolve: (decision: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type ActiveRun = {
  appSessionId: string;
  aborted: boolean;
  /** Set once a provider session id has been observed (for early resolution). */
  establishedSid: boolean;
  controller: AbortController;
  /** requestIds this run is waiting on, so interrupt can cancel them. */
  approvalIds: Set<string>;
  done: Promise<void>;
  doneResolve: () => void;
};

/**
 * Bridge the loose {@link QuerySdkLike} shape onto the real SDK `query`, which
 * takes `{ prompt, options }` and returns an async generator of SDK messages.
 * Lazy dynamic import keeps the real SDK/subprocess out of the test path; this
 * is an ESM package so `require` is unavailable at runtime.
 */
const defaultQuerySdk: QuerySdkLike = async function* (command, options) {
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as { query: typeof query };
  const iterable = mod.query({ prompt: command, options: options as never }) as unknown as AsyncIterable<
    Record<string, unknown>
  >;
  for await (const event of iterable) yield event;
};

export function createAgentRunManager(deps: AgentRunManagerDeps) {
  const querySdk: QuerySdkLike = deps.querySdk ?? defaultQuerySdk;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? 120_000;

  const runs = new Map<string, ActiveRun>();
  const approvals = new Map<string, PendingApproval>();

  function settleApproval(requestId: string, decision: unknown): boolean {
    const pending = approvals.get(requestId);
    if (!pending) return false;
    approvals.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    const run = runs.get(pending.appSessionId);
    run?.approvalIds.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /** Settle every approval this run still owns (run teardown / interrupt). */
  function settleRunApprovals(appSessionId: string, message: string): void {
    const run = runs.get(appSessionId);
    if (!run) return;
    for (const requestId of Array.from(run.approvalIds)) {
      settleApproval(requestId, { deny: true, message });
    }
  }

  async function start(params: SessionStartParams): Promise<{ providerSessionId: string }> {
    const { appSessionId } = params;
    if (runs.has(appSessionId)) {
      throw new Error(`session already running: ${appSessionId}`);
    }

    // I4 review fix: the lite is a code-execution surface, so a `cwd` outside
    // the configured roots must never reach the SDK. Two rejection paths:
    //  - outside every root → `createAllowlistedFs().stat` throws (path escapes);
    //  - inside a root but missing/non-directory → the exists/isDirectory check.
    if (deps.roots && deps.roots.length > 0) {
      const rootedFs = createAllowlistedFs({ roots: deps.roots });
      const stat = await rootedFs.stat(params.cwd);
      if (!stat.exists || !stat.isDirectory) {
        throw new Error(`cwd outside allowed roots: ${params.cwd}`);
      }
    }

    // Resolve early: reuse the provided providerSessionId, else settle from the
    // first event that carries a session_id. `start()`'s returned promise must
    // NOT wait for the whole SDK loop — main's rpc waiter resolves provider
    // session mapping from it and aborts RPCs past ~60s.
    let settleEstablished: (id: string) => void = () => {};
    const established = new Promise<string>((r) => (settleEstablished = r));
    if (params.providerSessionId) {
      settleEstablished(params.providerSessionId);
    }

    let providerSessionId = params.providerSessionId ?? '';

    let doneResolve: () => void = () => {};
    const done = new Promise<void>((r) => (doneResolve = r));
    const run: ActiveRun = {
      appSessionId,
      aborted: false,
      establishedSid: Boolean(params.providerSessionId),
      controller: new AbortController(),
      approvalIds: new Set(),
      done,
      doneResolve,
    };
    runs.set(appSessionId, run);

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const opt = options as ToolPermissionInput & { toolUseID?: string };
      const requestId = opt.tool_use_id ?? opt.toolUseID ?? fallbackId();
      const approval = {
        tool_use_id: requestId,
        name: toolName,
        input,
      };

      const decision = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          if (approvals.delete(requestId)) {
            run.approvalIds.delete(requestId);
            // Notify listeners the prompt was auto-cancelled, then auto-deny.
            deps.push(`approval:${requestId}`, {
              appSessionId,
              approval: { ...approval, cancelled: true },
            });
            resolve({ deny: true, message: 'approval timed out' });
          }
        }, approvalTimeoutMs);
        approvals.set(requestId, { appSessionId, resolve, timer });
        run.approvalIds.add(requestId);
        deps.push(`approval:${requestId}`, { appSessionId, approval });
      });

      return toPermissionResult(decision);
    };

    // Mirror the local path (server/claude-sdk.js): `resume` carries the
    // provider session id STRING. Never set a bare boolean `resume` (the SDK
    // would spawn `claude --resume true`), and do NOT set `sessionId` — it is
    // mutually exclusive with `resume` in the SDK Options type.
    // Per-session provider config: merge over process.env (a bare env would
    // strip PATH and break the claude spawn driver). Scoped to THIS run's SDK
    // options — never written to the lite's process.env.
    const effectiveEnv = params.configEnv && Object.keys(params.configEnv).length > 0
      ? { ...process.env, ...params.configEnv }
      : undefined;

    const sdkOptions: Record<string, unknown> = {
      cwd: params.cwd,
      resume: params.providerSessionId ?? undefined,
      permissionMode: params.permissionMode ?? 'default',
      includePartialMessages: params.includePartialMessages ?? true,
      canUseTool,
      signal: run.controller.signal,
      // The esbuild bundle inlines the SDK's JS but NOT its optional native
      // binary (platform-specific .exe/.node). Without an explicit
      // pathToClaudeCodeExecutable the SDK fails to locate a claude binary at
      // runtime ("Native CLI binary for linux-x64 not found"). Mirror the local
      // path (server/claude-sdk.js): CLAUDE_CLI_PATH when customized, else the
      // PATH-resolvable `claude` (the remote host's claude sits in /usr/local/bin).
      pathToClaudeCodeExecutable:
        (effectiveEnv?.CLAUDE_CLI_PATH ?? process.env.CLAUDE_CLI_PATH ?? 'claude').trim() || 'claude',
      ...(effectiveEnv ? { env: effectiveEnv } : {}),
    };
    if (params.model !== undefined) sdkOptions.model = params.model;

    // Drive the SDK loop off the awaited rpc path so the rpc_res can return
    // early; the run keeps tracking here so `interrupt` / `respond` keep
    // working and the terminal complete is pushed exactly once.
    void (async () => {
      let runFailed = false;
      let runError = '';
      try {
        for await (const event of querySdk(params.command, sdkOptions)) {
          if (run.aborted) break;
          const eventRecord = event as Record<string, unknown>;
          const sid = eventRecord.session_id;
          if (typeof sid === 'string' && sid && !run.establishedSid) {
            run.establishedSid = true;
            providerSessionId = sid;
            settleEstablished(sid);
          }
          deps.push(`session:${appSessionId}`, normalizeAgentEvent(eventRecord));
        }
      } catch (err) {
        // Abort-induced throw (e.g. the SDK routing subprocess exitError into
        // the stream after an abort) is expected noise — mirror
        // server/claude-sdk.js. Genuine loop failures surface as a terminal
        // `complete` carrying exitCode 1 + the error message so main's routing
        // marks the session failed instead of a clean complete{exitCode:0}.
        if (!run.aborted) {
          runFailed = true;
          runError = err instanceof Error ? err.message : String(err);
          console.error(`[remote-agent] session ${appSessionId} failed:`, runError);
        }
      } finally {
        settleRunApprovals(appSessionId, 'run ended');
        run.doneResolve();
        runs.delete(appSessionId);
      }
      deps.push(
        `session:${appSessionId}`,
        terminalCompleteEvent(providerSessionId, runFailed ? { exitCode: 1, error: runError } : {}),
      );
      settleEstablished(providerSessionId); // safety: never leave `established` unsettled
    })();

    const resolvedProviderSessionId = await established;
    return { providerSessionId: resolvedProviderSessionId };
  }

  /** Resolve a pending approval promise. Returns whether the request existed. */
  function respond(requestId: string, decision: unknown): boolean {
    return settleApproval(requestId, decision);
  }

  /**
   * Resolves once the run for `appSessionId` has fully finished (its loop has
   * exited and the terminal complete has been pushed). Resolves immediately for
   * sessions with no active run.
   */
  function whenDone(appSessionId: string): Promise<void> {
    return runs.get(appSessionId)?.done ?? Promise.resolve();
  }

  /**
   * Signal a run to stop. Sets `aborted` (the loop breaks on the next event),
   * fires the AbortController's signal (in case the SDK honours it), and
   * releases any outstanding approval so the loop is not parked forever.
   * Returns false when no run is active for the session.
   */
  function interrupt(appSessionId: string): boolean {
    const run = runs.get(appSessionId);
    if (!run) return false;
    run.aborted = true;
    try {
      run.controller.abort();
    } catch {
      /* ignore */
    }
    settleRunApprovals(appSessionId, 'interrupted');
    return true;
  }

  /**
   * I2 review fix — interrupt EVERY active run (used when the ws connection is
   * dropped): a run left in the `runs` map would make a later re-send with the
   * same providerSessionId fail with `session already running`. Main's routing
   * relies on abortability to fail in-flight spawns fast. This is a lossy
   * shutdown — mid-turn state (conversation progress) is NOT adopted when a
   * retry spawns a fresh run; no transparent adopt in v1.
   *
   * Returns the number of runs interrupted.
   */
  function interruptAll(): number {
    const ids = Array.from(runs.keys());
    for (const id of ids) interrupt(id);
    return ids.length;
  }

  return { start, respond, whenDone, interrupt, interruptAll };
}

/**
 * Provider-named alias of {@link createAgentRunManager} — the claude runner.
 * The registry dispatches `provider === 'claude'` here.
 */
export const createClaudeRunManager = createAgentRunManager;