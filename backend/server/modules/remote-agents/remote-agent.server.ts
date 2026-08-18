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
  /**
   * Maps a ws `?token=` to the host it is authorized to impersonate; `null`
   * rejects the connection. In the standalone handler (no real request), the
   * caller may instead pass the authorized hostId directly as the third
   * connection-handler argument.
   */
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
  for (const l of pushListeners) {
    try {
      l(e);
    } catch (err) {
      // one throwing listener must neither starve the others nor escape the ws callback
      console.warn('[remote-agent] push listener error:', err instanceof Error ? err.message : String(err));
    }
  }
}

export function createRemoteAgentConnectionHandler(deps: RemoteAgentServerDeps) {
  return function onConnection(ws: ServerWebSocketLike, _req: unknown, authorizedHostId?: string | null): void {
    let hostId: string | null = null;
    // Without an 'error' listener a socket error (e.g. a malformed frame from
    // anyone able to reach the endpoint) is an uncaught exception that crashes
    // the whole process.
    ws.on('error', (err) =>
      console.warn('[remote-agent] socket error:', err instanceof Error ? err.message : String(err)),
    );
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
        // First hello wins: a lite retrying hello after a lost ack must not
        // tear itself down (register would close its own live socket).
        if (hostId) return;
        // Bind identity to the token: a client holding one host's token must
        // not impersonate another host (spoofed rpc targets, push `from`, or
        // online/offline transitions).
        if (authorizedHostId != null && f.hostId !== authorizedHostId) {
          ws.close(4002, 'host id mismatch');
          return;
        }
        deps.registry.register({ hostId: f.hostId, roots: f.roots, capabilities: f.capabilities }, ws);
        hostId = f.hostId;
        deps.onHostOnline?.(hostId);
        ws.send(JSON.stringify({ type: 'rpc_res', id: 'hello', ok: true, data: { accepted: true } }));
        return;
      }
      // rpc_res / push / pong before hello carry no trusted host identity; drop.
      if (!hostId) return;
      if (f.type === 'rpc_res') {
        deps.registry.resolveRpc(f.id, { ok: f.ok, data: f.data, error: f.error });
        return;
      }
      if (f.type === 'push') {
        emitPush({ topic: f.topic, payload: f.payload, from: hostId });
        return;
      }
      if (f.type === 'pong') {
        deps.registry.touchSeenAt(hostId, f.at);
      }
    });
    ws.on('close', () => {
      if (!hostId) return; // close before hello: nothing to tear down
      // Identity-aware teardown: disconnect is a no-op for a stale socket that
      // was already superseded by a reconnect (avoids the session/approval
      // sweep ABA). Only when this teardown actually removed the live
      // connection do we fail in-flight rpcs (fast Task 6 aborts) and signal
      // offline — a stale socket close must not fail the new socket's rpcs.
      deps.registry.disconnect(hostId, ws);
      if (!deps.registry.isOnline(hostId)) {
        deps.registry.failPendingForHost(hostId);
        deps.onHostOffline?.(hostId);
      }
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
      // Unhandled 'error' on a socket we are about to close would crash the process.
      ws.on('error', (err) =>
        console.warn('[remote-agent] socket error:', err instanceof Error ? err.message : String(err)),
      );
      ws.close(4001, 'invalid token');
      return;
    }
    handler(ws, req, hostId);
  });
  return wss;
}