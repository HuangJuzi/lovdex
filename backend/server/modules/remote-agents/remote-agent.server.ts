import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';
import { isAgentFrameIn } from '@/shared/agent-runtime/protocol.js';
import type { AgentFrameIn } from '@/shared/agent-runtime/protocol.js';

/** A `push` frame delivered to subscribers, tagged with the originating host. */
export type PushEvent = { topic: string; payload: unknown; from: string | null };

export type RemoteAgentServerDeps = {
  /** sha256(token) → hostId via remoteHostsDb; null rejects the connection. */
  verifyToken: (token: string | null) => string | null;
  registry: RemoteAgentsRegistry;
  onHostOnline?: (hostId: string) => void;
  onHostOffline?: (hostId: string) => void;
};

/** Minimal socket surface the connection handler needs (real `ws` WebSocket satisfies it). */
export type ServerWebSocketLike = WebSocket;

/** topic 订阅器集合：Task 6 的 remote-spawn 注册会话 push 处理 */
const pushListeners = new Set<(e: PushEvent) => void>();

export function addPushListener(listener: (e: PushEvent) => void): void {
  pushListeners.add(listener);
}

export function removePushListener(listener: (e: PushEvent) => void): void {
  pushListeners.delete(listener);
}

export function emitPush(e: PushEvent): void {
  for (const l of pushListeners) l(e);
}

/**
 * Builds the per-connection message/close handler for an authenticated lite
 * socket. The socket is already authenticated by the time this runs; the
 * `hello` frame carries the authoritative `hostId` and registration payload.
 */
export function createRemoteAgentConnectionHandler(deps: RemoteAgentServerDeps) {
  return function onConnection(ws: ServerWebSocketLike, _req: unknown): void {
    let hostId: string | null = null;
    ws.on('message', (raw: unknown) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: 'rpc_res', id: '', ok: false, error: 'bad json' }));
        return;
      }
      if (!isAgentFrameIn(frame)) return; // drop malformed inbound
      const f = frame as AgentFrameIn;
      if (f.type === 'hello') {
        deps.registry.register({ hostId: f.hostId, roots: f.roots, capabilities: f.capabilities }, ws);
        hostId = f.hostId;
        deps.onHostOnline?.(hostId);
        ws.send(JSON.stringify({ type: 'rpc_res', id: 'hello', ok: true, data: { accepted: true } }));
        return;
      }
      if (f.type === 'rpc_res') {
        deps.registry.resolveRpc(f.id, { ok: f.ok, data: f.data, error: f.error });
        return;
      }
      if (f.type === 'push') {
        emitPush({ topic: f.topic, payload: f.payload, from: hostId });
        return;
      }
      if (f.type === 'pong') {
        if (hostId) deps.registry.touchSeenAt(hostId, f.at);
      }
    });
    ws.on('close', () => {
      if (!hostId) return;
      // Identity-aware teardown: disconnect is a no-op for a stale socket that
      // was already superseded by a reconnect (avoids the session/approval
      // sweep ABA). Only signal offline when this host truly has no live socket.
      deps.registry.disconnect(hostId, ws);
      if (!deps.registry.isOnline(hostId)) deps.onHostOffline?.(hostId);
    });
  };
}

/**
 * Binds a {@link WebSocketServer} to the existing http server at
 * `/api/remote-agents/ws`. Each connection is authenticated via the `?token=`
 * query param through `verifyToken`; failures are closed with code 4001.
 */
export function createRemoteAgentWss(server: HttpServer, deps: RemoteAgentServerDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/api/remote-agents/ws' });
  const handler = createRemoteAgentConnectionHandler(deps);
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const hostId = deps.verifyToken(url.searchParams.get('token'));
    if (!hostId) {
      ws.close(4001, 'invalid token');
      return;
    }
    handler(ws, req);
  });
  return wss;
}
