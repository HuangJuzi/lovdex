import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type WebSocket, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleTerminalConnection } from '@/modules/terminal/index.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  terminal: Parameters<typeof handleTerminalConnection>[2];
};

/**
 * Creates and wires the server-wide websocket gateway used for chat.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
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

  return wss;
}
