import { WebSocket } from 'ws';

export type LiteRegistration = {
  hostId: string;
  roots: string[];
  capabilities: string[];
};

export function createRemoteAgentsRegistry() {
  const connections = new Map<string, { registration: LiteRegistration; ws: WebSocket }>();
  const pending = new Map<string, PendingRpc>();
  const sessionHost = new Map<string, { hostId: string; providerSessionId: string | null }>();
  const pendingApprovals = new Map<string, { appSessionId: string; hostId: string }>();

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
      return doClearSessionsForHost(hostId);
    },
    getCapabilities(hostId: string): string[] | undefined {
      return connections.get(hostId)?.registration.capabilities;
    },
    getRoots(hostId: string): string[] | undefined {
      return connections.get(hostId)?.registration.roots;
    },
    listenerCount(): number {
      return connections.size;
    },
    setSessionHost(appSessionId: string, providerSessionId: string | null, hostId: string): void {
      sessionHost.set(appSessionId, { hostId, providerSessionId });
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
    rpc<T = unknown>(hostId: string, method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
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
      });
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