import { makeSessionStartParamsSchema } from '@/shared/agent-runtime/protocol.js';
import { createNormalizedMessage } from '@/shared/utils.js';
import { addPushListener, removePushListener } from './remote-agent.server.js';
import type { PushEvent } from './remote-agent.server.js';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

/**
 * A provider spawn function (claude-sdk `queryClaudeSDK`, opencode/qoder
 * runners, ...). It streams writer-ready {@link NormalizedMessage} events to
 * `writer.send` and resolves when the run ends (its terminal `complete` was
 * emitted). See chat-websocket.service.ts `handleChatSend`.
 */
export type SpawnFn = (command: string, options: Record<string, unknown>, writer: unknown) => Promise<unknown>;

export type RemoteRoutingDeps = {
  /** Resolves a project path to the host id owning it, or null for local. */
  lookupHost: (projectPath: string | undefined) => string | null;
  registry: RemoteAgentsRegistry;
  /**
   * Raw SDK event (or synthetic) → writer-ready NormalizedMessage array.
   *
   * INJECTED so Task 6 stays unit-testable and freely composable. The lite
   * forwards RAW SDK events (snake `session_id`) over the push bus; main runs
   * the SAME pipeline as the local path before `writer.send`. The production
   * composition (transformMessage + sessionsService.normalizeMessage + the
   * synthetic `complete` → createCompleteMessage special-case) is wired in
   * Task 13 (index.js); it must NOT be hard-coded here.
   */
  normalizeEvent: (raw: Record<string, unknown>, sid: string | null) => unknown[];
};

/** A writer surface (WebSocketWriter): `send` + optional late `setSessionId`. */
type Writer = {
  send: (msg: unknown) => void;
  setSessionId?: (id: string) => void;
};

/** Pending approval mirrored locally so `getPendingApprovals` can rebuild it. */
type LocalApproval = { appSessionId: string; toolName: string; input: unknown };

/** Per-session push handler installed for the lifetime of one remote run. */
type SessionHandler = (event: Record<string, unknown>) => void;

/** Per-run state so the host-offline sweep can fail an in-flight spawn. */
type SessionState = {
  hostId: string;
  fail: (err: Error) => void;
};

/**
 * Wraps the local provider spawn/abort/approval hooks so runs whose project
 * lives on a remote lite host are routed over the ws rpc + push bus instead of
 * the in-process SDK. index.js (Task 13) passes the returned hooks around the
 * existing provider spawnFns/abortFns/resolveToolApproval.
 *
 * CONSTRUCT-ONCE RULE: create exactly ONE routing instance in Task 13 and share
 * its hooks across all providers. Two instances would double-subscribe the push
 * bus (every event normalized+forwarded twice) and split the approval mirror
 * (registry pendingApprovals keyed by requestId would map to whichever instance
 * saw the push last). `dispose()` unsubscribes it and clears its state.
 */
export function createRemoteRouting(deps: RemoteRoutingDeps): {
  wrapSpawn(localSpawn: SpawnFn): SpawnFn;
  wrapAbort(localAbort: (providerSessionId: string) => Promise<boolean>): (providerSessionId: string) => Promise<boolean>;
  wrapResolveToolApproval(localResolve: (requestId: string, payload: unknown) => void): (requestId: string, payload: unknown) => void;
  getPendingApprovals(providerSessionId: string): { requestId: string; toolName: string; input: unknown; sessionId: string }[];
  getPendingApprovalsForAppSession(appSessionId: string): { requestId: string; toolName: string; input: unknown; sessionId: string }[];
  dispose(): void;
} {
  const { registry, normalizeEvent } = deps;

  // Active per-session push handlers keyed by appSessionId. Installed BEFORE
  // the session/start rpc so an eager lite cannot race its first event ahead
  // of subscription.
  const sessionHandlers = new Map<string, SessionHandler>();
  // Per-run reject state so a host-offline sweep can fail in-flight spawns.
  const sessionStates = new Map<string, SessionState>();
  // Locally mirrored approvals keyed by requestId so getPendingApprovals can
  // rebuild the shape claude-sdk.js `getPendingApprovalsForSession` returns.
  const localApprovals = new Map<string, LocalApproval>();

  /** Clears the sessionHost entry + every mirrored approval for one session. */
  function sweepSessionState(appSessionId: string): void {
    registry.clearSessionHost(appSessionId);
    for (const [requestId, entry] of localApprovals) {
      if (entry.appSessionId !== appSessionId) continue;
      localApprovals.delete(requestId);
      // drop the registry mirror too (it keyed by requestId, so take it)
      registry.takePendingApproval(requestId);
    }
  }

  /** Fails the in-flight spawn for one session; no-op when already settled. */
  function failSession(appSessionId: string): void {
    const state = sessionStates.get(appSessionId);
    if (!state) return;
    state.fail(new Error(`remote host went offline: ${state.hostId}`));
  }

  // ONE push-bus subscription for the whole routing; demuxes by topic prefix.
  const busListener = (e: PushEvent): void => {
    const topic = e.topic;
    if (topic.startsWith('session:')) {
      const appSessionId = topic.slice('session:'.length);
      const handler = sessionHandlers.get(appSessionId);
      if (handler) handler((e.payload ?? {}) as Record<string, unknown>);
      return;
    }
    if (topic.startsWith('approval:')) {
      const requestId = topic.slice('approval:'.length);
      const payload = (e.payload ?? {}) as { appSessionId?: unknown; approval?: unknown };
      const appSessionId = String(payload.appSessionId ?? '');
      if (!appSessionId) {
        console.warn(`[remote-spawn] approval push without appSessionId dropped: ${requestId}`);
        return;
      }
      const handler = sessionHandlers.get(appSessionId);
      if (!handler) {
        // Nobody can answer this on main; registering a pending entry would
        // only leak. The lite host still has its own copy if it re-emits.
        console.warn(`[remote-spawn] approval push for session without live handler dropped: ${requestId} (${appSessionId})`);
        return;
      }
      registry.addPendingApproval(requestId, { appSessionId, hostId: e.from ?? '' });
      handler({ __remoteApproval: true, requestId, approval: (payload.approval ?? {}) as Record<string, unknown> });
    }
  };
  addPushListener(busListener);

  // Host went offline: fail every in-flight remote run on that host so the
  // spawn promise cannot hang (chat session stuck in "processing" forever).
  registry.onHostOfflineSweep = (affectedSessions) => {
    for (const appSessionId of affectedSessions) failSession(appSessionId);
  };

  function wrapSpawn(localSpawn: SpawnFn): SpawnFn {
    return async function spawn(command, options, writer) {
      const projectPath = (options.projectPath ?? options.cwd) as string | undefined;
      const hostId = deps.lookupHost(projectPath);
      if (!hostId) return localSpawn(command, options, writer);

      const appSessionId = String(options.appSessionId ?? '');
      if (appSessionId.length < 1) throw new Error('remote spawn requires appSessionId');

      const w = writer as Writer;
      const providerSessionId = (options.sessionId ?? null) as string | null;
      const params = makeSessionStartParamsSchema().parse({
        appSessionId,
        providerSessionId,
        command,
        cwd: projectPath,
        model: options.model,
        permissionMode: (options.permissionMode as string | undefined) ?? 'default',
        includePartialMessages: options.includePartialMessages === true,
      });

      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          sessionHandlers.delete(appSessionId);
          sessionStates.delete(appSessionId);
        };
        const finish = (value: unknown): void => {
          if (settled) return;
          settled = true;
          sweepSessionState(appSessionId);
          cleanup();
          resolve(value);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          sweepSessionState(appSessionId);
          cleanup();
          reject(err);
        };
        sessionStates.set(appSessionId, { hostId, fail });

        // Install BEFORE the rpc so no event is missed.
        const handler: SessionHandler = (event) => {
          // Approval envelope: main forwards a permission_request to the
          // client and mirrors the pending approval locally.
          if (event.__remoteApproval === true) {
            const requestId = String(event.requestId ?? '');
            const approval = (event.approval ?? {}) as Record<string, unknown>;
            const toolName = String(approval.name ?? approval.toolName ?? 'UnknownTool');
            const input = approval.input;
            localApprovals.set(requestId, { appSessionId, toolName, input });
            const entry = registry.getSessionHost(appSessionId);
            w.send(
              createNormalizedMessage({
                kind: 'permission_request',
                requestId,
                toolName,
                input,
                sessionId: entry?.providerSessionId ?? providerSessionId,
                provider: 'claude',
              }),
            );
            return;
          }

          const entry = registry.getSessionHost(appSessionId);
          const sid = (event.session_id as string | undefined) ?? entry?.providerSessionId ?? providerSessionId;
          const msgs = normalizeEvent(event, sid ?? null);
          for (const m of msgs) w.send(m);
          if (event.type === 'complete') finish(undefined);
        };
        sessionHandlers.set(appSessionId, handler);

        registry
          .rpc<{ providerSessionId: string }>(hostId, 'session/start', params)
          .then((res) => {
            // The run may already have finished (complete before the lite even
            // answered): do not re-register a sessionHost entry that sweep
            // already cleared — it would leak until the next disconnect.
            if (settled) return;
            registry.setSessionHost(appSessionId, res.providerSessionId, hostId);
            w.setSessionId?.(res.providerSessionId);
          })
          .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
      });
    };
  }

  function wrapAbort(
    localAbort: (providerSessionId: string) => Promise<boolean>,
  ): (providerSessionId: string) => Promise<boolean> {
    return async function abort(providerSessionId) {
      const entry = registry.getSessionHostByProvider(providerSessionId);
      if (!entry) return localAbort(providerSessionId);
      if (!registry.isOnline(entry.hostId)) {
        // Host is gone; the offline sweep already failed the run. Fall back to
        // the local abort so the run registry is still released, and log.
        console.warn(`[remote-spawn] host ${entry.hostId} offline, falling back to local abort for ${providerSessionId}`);
        return localAbort(providerSessionId);
      }
      try {
        await registry.rpc(entry.hostId, 'session/interrupt', { appSessionId: entry.appSessionId });
        return true;
      } catch (err) {
        console.warn('[remote-spawn] session/interrupt failed:', err instanceof Error ? err.message : String(err));
        return false;
      }
    };
  }

  function wrapResolveToolApproval(
    localResolve: (requestId: string, payload: unknown) => void,
  ): (requestId: string, payload: unknown) => void {
    return function resolve(requestId, payload) {
      const pending = registry.takePendingApproval(requestId);
      if (!pending) {
        localResolve(requestId, payload);
        return;
      }
      localApprovals.delete(requestId);
      void registry
        .rpc(pending.hostId, 'approval/respond', { requestId, decision: payload })
        .catch((e: unknown) => {
          console.warn('[remote-spawn] approval/respond failed:', e instanceof Error ? e.message : String(e));
        });
    };
  }

  /**
   * Mirror of claude-sdk.js `getPendingApprovalsForSession`, keyed by the
   * PROVIDER session id (the id callers know an established run by). Resolves
   * the app session for that provider id and returns its mirrored approvals.
   */
  function getPendingApprovals(
    providerSessionId: string,
  ): { requestId: string; toolName: string; input: unknown; sessionId: string }[] {
    const entry = registry.getSessionHostByProvider(providerSessionId);
    if (!entry) return [];
    return getPendingApprovalsForAppSession(entry.appSessionId);
  }

  /**
   * Approvals for a run identified by its APP session id. Used by Task 13 for
   * fresh remote runs whose provider session id is not known yet (the lite has
   * not announced one); the mirrored approvals are keyed by appSessionId, so a
   * provider-id lookup is unnecessary.
   */
  function getPendingApprovalsForAppSession(
    appSessionId: string,
  ): { requestId: string; toolName: string; input: unknown; sessionId: string }[] {
    const out: { requestId: string; toolName: string; input: unknown; sessionId: string }[] = [];
    for (const [requestId, a] of localApprovals) {
      if (a.appSessionId === appSessionId) {
        out.push({ requestId, toolName: a.toolName, input: a.input, sessionId: appSessionId });
      }
    }
    return out;
  }

  function dispose(): void {
    removePushListener(busListener);
    registry.onHostOfflineSweep = undefined;
    sessionHandlers.clear();
    sessionStates.clear();
    localApprovals.clear();
  }

  return { wrapSpawn, wrapAbort, wrapResolveToolApproval, getPendingApprovals, getPendingApprovalsForAppSession, dispose };
}