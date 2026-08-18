import type { query } from '@anthropic-ai/claude-agent-sdk';
import { normalizeAgentEvent, terminalCompleteEvent } from '../../server/shared/agent-runtime/normalize.js';

/**
 * The minimal SDK surface the lite loop consumes. Tests inject a fake async
 * generator so the loop is exercised WITHOUT spawning the real claude
 * subprocess. The real `@anthropic-ai/claude-agent-sdk` `query` takes
 * `{ prompt, options }` and returns a `Query` (an AsyncGenerator); here we keep
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
   * real `query({ prompt, options })`. `typeof query` is accepted so callers
   * may pass the raw SDK export; the manager always drives it through the loose
   * {@link QuerySdkLike} shape.
   */
  querySdk?: QuerySdkLike | typeof query;
  /** Wired to the ws push bus by index.ts via setPushEmitter. */
  push: (topic: string, payload: unknown) => void;
  /** Optional out-of-band RPC error channel (unused by the happy path). */
  sendRpcError?: (id: string, error: string) => void;
  /** Approval wait timeout in ms; auto-denies past this. Default 120s. */
  approvalTimeoutMs?: number;
};

export type SessionStartParams = {
  appSessionId: string;
  providerSessionId: string | null;
  command: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  includePartialMessages?: boolean;
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
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
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
  controller: AbortController;
  /** requestIds this run is waiting on, so interrupt can cancel them. */
  approvalIds: Set<string>;
};

/**
 * Bridge the loose {@link QuerySdkLike} shape onto the real SDK `query`, which
 * takes `{ prompt, options }` and returns an async generator of SDK messages.
 */
const defaultQuerySdk: QuerySdkLike = async function* (command, options) {
  // Lazy dynamic import so tests never touch the real SDK (and its subprocess
  // spawn); this is an ESM package so `require` is unavailable at runtime.
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as { query: typeof query };
  const iterable = mod.query({ prompt: command, options: options as never }) as unknown as AsyncIterable<
    Record<string, unknown>
  >;
  for await (const event of iterable) yield event;
};

export function createAgentRunManager(deps: AgentRunManagerDeps) {
  const querySdk: QuerySdkLike = (deps.querySdk as QuerySdkLike) ?? defaultQuerySdk;
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

  async function start(params: SessionStartParams): Promise<{ providerSessionId: string }> {
    const { appSessionId } = params;
    if (runs.has(appSessionId)) {
      throw new Error(`session already running: ${appSessionId}`);
    }

    const controller = new AbortController();
    const run: ActiveRun = {
      appSessionId,
      aborted: false,
      controller,
      approvalIds: new Set(),
    };
    runs.set(appSessionId, run);

    let providerSessionId = params.providerSessionId ?? '';

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

    const sdkOptions: Record<string, unknown> = {
      cwd: params.cwd,
      sessionId: params.providerSessionId ?? undefined,
      resume: Boolean(params.providerSessionId),
      permissionMode: params.permissionMode ?? 'default',
      includePartialMessages: params.includePartialMessages ?? true,
      canUseTool,
      signal: controller.signal,
    };
    if (params.model !== undefined) sdkOptions.model = params.model;

    try {
      for await (const event of querySdk(params.command, sdkOptions)) {
        if (run.aborted) break;
        const sid = (event as Record<string, unknown>).session_id;
        if (typeof sid === 'string' && sid) providerSessionId = sid;
        deps.push(`session:${appSessionId}`, normalizeAgentEvent(event));
      }
    } finally {
      // Cancel any approvals still outstanding for this run (e.g. interrupt
      // mid-prompt) so their promises don't leak past teardown.
      for (const requestId of Array.from(run.approvalIds)) {
        settleApproval(requestId, { deny: true, message: 'run ended' });
      }
      runs.delete(appSessionId);
    }

    deps.push(`session:${appSessionId}`, terminalCompleteEvent(providerSessionId));
    return { providerSessionId };
  }

  /** Resolve a pending approval promise. Returns whether the request existed. */
  function respond(requestId: string, decision: unknown): boolean {
    return settleApproval(requestId, decision);
  }

  /** Abandon (auto-deny) a pending approval, e.g. on timeout externally. */
  function abandon(requestId: string): boolean {
    return settleApproval(requestId, { deny: true, message: 'abandoned' });
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
    for (const requestId of Array.from(run.approvalIds)) {
      settleApproval(requestId, { deny: true, message: 'interrupted' });
    }
    return true;
  }

  return { start, respond, abandon, interrupt };
}
