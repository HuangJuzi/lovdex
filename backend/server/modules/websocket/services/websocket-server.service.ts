import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleTerminalConnection } from '@/modules/terminal/index.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { REMOTE_AGENT_WS_PATH } from '@/modules/remote-agents/remote-agent.server.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  terminal: Parameters<typeof handleTerminalConnection>[2];
};

const CHAT_WS_PATH = '/ws';
const TERMINAL_WS_PATH = '/ws/terminal';
/** ws package internal `_state` value for a running (not yet closed) server. */
const WS_SERVER_RUNNING = 0;

/** The pathname of an upgrade request (query string dropped). */
function upgradePathname(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

/** Writes a bare HTTP response on an upgrade socket and closes it. */
function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Creates and wires the server-wide websocket gateway used for chat.
 *
 * Upgrade routing: the chat wss runs in `noServer` mode and registers its own
 * path-scoped `upgrade` listener. Running two WebSocketServers that both listen
 * to the same http server via the `server` option does NOT work — each one's
 * auto-registered listener runs on every upgrade and a non-matching server
 * calls `abortHandshake` (400), destroying the socket before the matching
 * server can complete the handshake. Manual `handleUpgrade` dispatch keeps
 * every path served by exactly one server:
 *   - `/ws`, `/ws/terminal`        → this wss (chat + pty gateway)
 *   - `/api/remote-agents/ws`      → the remote-agents wss (left untouched here)
 *   - anything else                → rejected with 404
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });

  wss.on('connection', (ws, request) => {
    // Keep WebSocket alive across reverse-proxy idle timeouts (Cloudflare ~100s,
    // AWS ALB 60s, nginx 60s, etc.). Without app-level pings these connections
    // are silently torn down even when the UI is active, causing repeated
    // reconnect cycles. ws library heartbeat is opt-in.
    //
    // isAlive tracking doubles as dead-peer detection: a socket that stops
    // answering pings (client suspended, half-open TCP, proxy gone) is
    // terminated here so the browser's `onclose` fires and the client
    // reconnects + resubscribes. Without termination a half-open socket keeps
    // `readyState === OPEN` on the client forever — it misses every live
    // stream_delta and only "recovers" after a manual page refresh.
    const alive = ws as WebSocket & { isAlive?: boolean };
    alive.isAlive = true;
    alive.on('pong', () => { alive.isAlive = true; });

    const HEARTBEAT_INTERVAL_MS = 30_000;
    const heartbeat = setInterval(() => {
      if (alive.readyState === alive.OPEN) {
        try {
          if (alive.isAlive === false) {
            alive.terminate();
            return;
          }
          alive.isAlive = false;
          alive.ping();
        } catch {
          // socket may have been closed concurrently — interval will be cleared below
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    const stopHeartbeat = () => clearInterval(heartbeat);
    alive.on('close', stopHeartbeat);
    alive.on('error', stopHeartbeat);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname === '/ws/terminal') {
      handleTerminalConnection(ws, incomingRequest, dependencies.terminal);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  // Path-scoped upgrade dispatch (see createWebSocketServer doc comment). The
  // remote-agents path is deliberately left alone: its own wss claims it, and
  // touching the socket here would destroy it before that wss can complete the
  // handshake.
  server.on('upgrade', (request, socket, head) => {
    const pathname = upgradePathname(request);
    if (pathname === CHAT_WS_PATH || pathname === TERMINAL_WS_PATH) {
      if ((wss as unknown as { _state?: number })._state !== WS_SERVER_RUNNING) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
      return;
    }
    if (pathname !== REMOTE_AGENT_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
    }
  });

  return wss;
}
