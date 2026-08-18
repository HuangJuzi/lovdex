import type { WebSocket } from 'ws';

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

  return {
    isOnline(hostId: string): boolean {
      const c = connections.get(hostId);
      return c !== undefined && c.ws.readyState === c.ws.OPEN;
    },
    register(registration: LiteRegistration, ws: WebSocket): void {
      connections.set(registration.hostId, { registration, ws });
    },
    unregister(hostId: string): void {
      connections.delete(hostId);
    },
    getCapabilities(hostId: string): string[] | undefined {
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
      const affected: string[] = [];
      for (const [appSessionId, entry] of sessionHost) {
        if (entry.hostId === hostId) {
          sessionHost.delete(appSessionId);
          affected.push(appSessionId);
        }
      }
      return affected;
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
      if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
        return Promise.reject(new Error(`remote host offline: ${hostId}`));
      }
      return new Promise<T>((resolve, reject) => {
        const id = createRpcId();
        const entry: PendingRpc = {
          id,
          resolve: (value) => resolve(value as T),
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`remote rpc timeout: ${method}`));
          }, timeoutMs),
        };
        pending.set(id, entry);
        connection.ws.send(JSON.stringify({ type: 'rpc_req', id, method, params }));
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
    pendingCount(): number {
      return pending.size;
    },
  };
}

export type PendingRpc = {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type RemoteAgentsRegistry = ReturnType<typeof createRemoteAgentsRegistry>;
