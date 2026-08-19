import { WebSocket } from 'ws';

/**
 * Probe results cached from each host's `hello` providers payload. Lives at
 * module scope (not per-registry-instance) because the server constructs its
 * registry exactly once; a fresh registry in tests simply observes the same
 * cache, which is a harmless over-share for a read-mostly lookup (Task 13's
 * `GET /:hostId/providers` reads it before falling back to a live probe).
 */
const hostProviders = new Map<string, unknown[]>();

export type LiteRegistration = {
  hostId: string;
  roots: string[];
  capabilities: string[];
};

export function createRemoteAgentsRegistry(
  opts: { onHostOfflineSweep?: (affectedSessions: string[]) => void } = {},
) {
  const connections = new Map<string, { registration: LiteRegistration; ws: WebSocket }>();
  const pending = new Map<string, PendingRpc>();
  const sessionHost = new Map<string, { hostId: string; providerSessionId: string | null }>();
  const pendingApprovals = new Map<string, { appSessionId: string; hostId: string }>();
  let onHostOfflineSweep = opts.onHostOfflineSweep;

  function createRpcId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function doUnregister(hostId: string, ws: WebSocket): boolean {
    const existing = connections.get(hostId);
    if (!existing || existing.ws !== ws) return false;
    connections.delete(hostId);
    return true;
  }

  function doClearSessionsForHost(hostId: string): string[] {
    const affected: string[] = [];
    for (const [appSessionId, entry] of sessionHost) {
      if (entry.hostId === hostId) {
        sessionHost.delete(appSessionId);
        affected.push(appSessionId);
      }
    }
    // stale approvals must not linger for a dead host
    for (const [requestId, entry] of pendingApprovals) {
      if (entry.hostId === hostId) {
        pendingApprovals.delete(requestId);
      }
    }
    return affected;
  }

  return {
    isOnline(hostId: string): boolean {
      const c = connections.get(hostId);
      return c !== undefined && c.ws.readyState === WebSocket.OPEN;
    },
    register(registration: LiteRegistration, ws: WebSocket): void {
      const existing = connections.get(registration.hostId);
      if (existing) {
        // A reconnect supersedes the stale socket: close it so it cannot linger.
        try {
          existing.ws.close();
        } catch (_) {
          // stale socket may already be closed
        }
      }
      connections.set(registration.hostId, { registration, ws });
    },
    unregister(hostId: string, ws: WebSocket): boolean {
      return doUnregister(hostId, ws);
    },
    disconnect(hostId: string, ws: WebSocket): DisconnectResult {
      if (!doUnregister(hostId, ws)) return [];
      const affected = doClearSessionsForHost(hostId);
      // Only a host that actually went offline (identity matched) sweeps; a
      // stale socket superseded by a reconnect returns [] and must not fail
      // the fresh socket's in-flight sessions.
      onHostOfflineSweep?.(affected);
      return affected;
    },
    /**
     * Forcibly drop a host's live connection from outside the ws layer (e.g.
     * the host row was deleted). Closes the socket with 4001 'host removed';
     * the ws close handler then drives the same identity-aware teardown that a
     * natural disconnect performs (unregister → sweep → failPendingForHost →
     * onHostOffline). Returns whether a connection existed so callers can
     * branch on the lite being present at all.
     */
    closeHost(hostId: string): boolean {
      const existing = connections.get(hostId);
      if (!existing) return false;
      try {
        existing.ws.close(4001, 'host removed');
      } catch (_) {
        // socket may already be closing; the ws close handler still fires once
      }
      return true;
    },
    getCapabilities(hostId: string): string[] | undefined {
      return connections.get(hostId)?.registration.capabilities;
    },
    getRoots(hostId: string): string[] | undefined {
      return connections.get(hostId)?.registration.roots;
    },
    setHostProviders(hostId: string, providers: unknown[] | null): void {
      hostProviders.set(hostId, providers ?? []);
    },
    getHostProviders(hostId: string): unknown[] | undefined {
      return hostProviders.get(hostId);
    },
    listenerCount(): number {
      return connections.size;
    },
    list(): { hostId: string; roots: string[] }[] {
      return Array.from(connections.values()).map((c) => ({
        hostId: c.registration.hostId,
        roots: c.registration.roots,
      }));
    },
    setSessionHost(appSessionId: string, providerSessionId: string | null, hostId: string): void {
      sessionHost.set(appSessionId, { hostId, providerSessionId });
    },
    clearSessionHost(appSessionId: string): void {
      sessionHost.delete(appSessionId);
    },
    getSessionHost(appSessionId: string): { hostId: string; providerSessionId: string | null } | undefined {
      return sessionHost.get(appSessionId);
    },
    getSessionHostByProvider(providerSessionId: string): { appSessionId: string; hostId: string } | undefined {
      for (const [appSessionId, entry] of sessionHost) {
        if (entry.providerSessionId === providerSessionId) return { appSessionId, hostId: entry.hostId };
      }
      return undefined;
    },
    clearSessionsForHost(hostId: string): string[] {
      return doClearSessionsForHost(hostId);
    },
    addPendingApproval(requestId: string, entry: { appSessionId: string; hostId: string }): void {
      pendingApprovals.set(requestId, entry);
    },
    takePendingApproval(requestId: string): { appSessionId: string; hostId: string } | undefined {
      const entry = pendingApprovals.get(requestId);
      if (entry) pendingApprovals.delete(requestId);
      return entry;
    },
    rpc<T = unknown>(hostId: string, method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
      const connection = connections.get(hostId);
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`remote host offline: ${hostId}`));
      }
      return new Promise<T>((resolve, reject) => {
        const id = createRpcId();
        const entry: PendingRpc = {
          id,
          hostId,
          resolve: (value) => resolve(value as T),
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`remote rpc timeout: ${method}`));
          }, timeoutMs),
        };
        pending.set(id, entry);
        try {
          connection.ws.send(JSON.stringify({ type: 'rpc_req', id, method, params }), (err?: Error) => {
            if (err) {
              const e = pending.get(id);
              if (e) {
                clearTimeout(e.timer);
                pending.delete(id);
                e.reject(new Error(`remote rpc send failed: ${err.message}`));
              }
            }
          });
        } catch (err) {
          // send() can throw synchronously (e.g. socket just closing); settle once.
          clearTimeout(entry.timer);
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              if (pending.has(id)) {
                clearTimeout(entry.timer);
                pending.delete(id);
                reject(new Error(`remote rpc aborted: ${method}`));
                // Notify the lite to stop the in-flight worker (e.g. a long
                // git/exec); best-effort — the socket may be mid-close.
                try {
                  connection.ws.send(JSON.stringify({ type: 'rpc_cancel', id }));
                } catch {
                  /* socket mid-close */
                }
              }
            },
            { once: true },
          );
        }
      });
    },
    /**
     * Ask the host to cancel an in-flight rpc (used by rpc abort/teardown paths
     * that already settled the pending entry locally but still want the lite to
     * stop its side effect — git kill, etc.). No-op for unknown or unconnected
     * rpcs; settle bookkeeping is NOT done here (the caller owns that).
     */
    cancelRpc(id: string): void {
      const entry = pending.get(id);
      if (!entry) return;
      const conn = connections.get(entry.hostId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify({ type: 'rpc_cancel', id }));
        } catch {
          /* socket mid-close */
        }
      }
    },
    resolveRpc(id: string, response: { ok: boolean; data?: unknown; error?: string }): void {
      const entry = pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(id);
      if (response.ok) entry.resolve(response.data);
      else entry.reject(new Error(response.error ?? 'remote rpc failed'));
    },
    touchSeenAt(_hostId: string, _at: number): void {
      // heartbeat bookkeeping hook; wired to remoteHostsDb in Task 13
    },
    // Settable after construction: remote-spawn installs its offline sweep
    // here (single routing instance — see createRemoteRouting JSDoc).
    get onHostOfflineSweep(): ((affectedSessions: string[]) => void) | undefined {
      return onHostOfflineSweep;
    },
    set onHostOfflineSweep(fn: ((affectedSessions: string[]) => void) | undefined) {
      onHostOfflineSweep = fn;
    },
    failPendingForHost(hostId: string): number {
      let failed = 0;
      for (const [id, entry] of pending) {
        if (entry.hostId !== hostId) continue;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new ConnectionError(`remote host disconnected: ${hostId}`));
        failed++;
      }
      return failed;
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

/** Thrown when a host goes away while one of its rpcs is still in flight. */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export type PendingRpc = {
  id: string;
  hostId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Sessions torn down by a host disconnect; empty when the socket was stale. */
export type DisconnectResult = string[];

export type RemoteAgentsRegistry = ReturnType<typeof createRemoteAgentsRegistry>;