import WebSocket from 'ws';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Node <19 does not define the bare global `crypto` that claude-agent-sdk
// ~0.2.14x and codex-sdk reference (they work on Node 20+ without this). The
// remote host may still run Node 18 (`/usr/bin/node`), so expose webcrypto under
// the global name; on Node >=19 globalThis.crypto already exists and we skip.
if (typeof (globalThis as { crypto?: unknown }).crypto !== 'object') {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

import { makePing } from '../../server/shared/agent-runtime/protocol.js';
import { loadConfigFile, type RemoteAgentConfig } from './config.js';
import { handleRpc, interruptAllFor, setPushEmitter } from './rpc-dispatch.js';

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 3_000;

/**
 * Close codes the main server sends to permanently reject a connection. These
 * are NOT retryable: a reconnect loop would spool forever against a steady
 * rejection and spam the journal. On receiving one, the lite logs the reason
 * and exits with code 0 so systemd `Restart=on-failure` treats it as a clean
 * stop — a deleted/misconfigured host stops quietly instead of crash-looping
 * (I5 review fix).
 */
const FATAL_CLOSE_CODES: Record<number, string> = {
  4001: 'invalid token',
  4002: 'host id mismatch',
};

/** Minimal WebSocket surface the frame handler needs; keeps it unit-testable. */
export interface WsLike {
  readyState: number;
  OPEN: number;
  send(raw: string): void;
}

/**
 * In-flight `rpc_req` id → its AbortController. `rpc_cancel` aborts the
 * matching controller so long-running handlers (git/exec child processes,
 * session loops) can stop promptly instead of running to their timeout.
 */
const inflight = new Map<string, AbortController>();

/**
 * Handle one decoded inbound frame.
 *
 * - `ping` → reply `pong`.
 * - `rpc_req` → run {@link handleRpc}, reply `rpc_res` with `ok` + `data`/`error`.
 * - `rpc_cancel` → abort the in-flight request with the matching `id`.
 * - anything else → ignored.
 */
export async function handleIncomingFrame(
  ws: WsLike,
  frame: unknown,
  cfg: RemoteAgentConfig,
): Promise<void> {
  if (typeof frame !== 'object' || frame === null) return;
  const f = frame as Record<string, unknown>;

  if (f.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    return;
  }

  if (f.type === 'rpc_cancel' && typeof f.id === 'string') {
    inflight.get(f.id)?.abort();
    return;
  }

  if (f.type === 'rpc_req' && typeof f.id === 'string' && typeof f.method === 'string') {
    const id = f.id;
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const data = await handleRpc(f.method, f.params, cfg, controller);
      ws.send(JSON.stringify({ type: 'rpc_res', id, ok: true, data }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'rpc_res', id, ok: false, error }));
    } finally {
      inflight.delete(id);
    }
    return;
  }
}

/**
 * Task 9 — connection-epoch outbound dispatcher:
 * when a link drops mid-RPC, pending `rpc_res` must be re-delivered on the
 * CURRENT socket (or the pending work aborted) — never close over the old
 * socket across reconnects. `handleIncomingFrame` deliberately receives the
 * socket as an argument instead of closing over a stale one; outbound session/
 * approval PUSHES are likewise re-pointed at the live socket on every open via
 * `setPushEmitter` (see `handleOpen`). rpc_res re-delivery remains unwired.
 */

function buildHelloFrame(cfg: RemoteAgentConfig): string {
  // capabilities: every RPC method the dispatcher understands is advertised so
  // main can offer the host's full surface. session/start stays claude-only
  // probe-aware: the lite currently runs ONE provider CLI (claude); codex/
  // opencode/qoder generalization lands with the multi-provider session/start
  // work. session/messages (remote history) serves the claude/qoder transcript.
  return JSON.stringify({
    type: 'hello',
    hostId: cfg.hostId,
    agentVersion: cfg.agentVersion,
    nodeVersion: process.version,
    os: process.platform,
    roots: cfg.roots,
    capabilities: [
      'session/claude',
      'session/messages',
      'fs/stat',
      'fs/list',
      'fs/read',
      'fs/write',
      'fs/tree',
      'fs/create',
      'fs/rename',
      'fs/delete',
      'git/exec',
      'providers/probe',
    ],
  });
}

function buildWsUrl(cfg: RemoteAgentConfig): string {
  const url = new URL(cfg.serverUrl);
  url.searchParams.set('token', cfg.token);
  return url.toString();
}

export interface LiteService {
  /** The live WebSocket connection (created on `start()`). */
  ws: WebSocket;
  /** Opens the connection and begins servicing pings/RPCs. */
  start(): void;
  /**
   * Tears the service down: clears the heartbeat interval, cancels any pending
   * reconnect, and closes the socket. Idempotent; safe to call while the socket
   * is still CONNECTING. After `stop()` no reconnect is ever scheduled.
   *
   * Note: the instance is single-use — `start()` after `stop()` is a no-op.
   */
  stop(): void;
}

/**
 * Create a manageable lite-service instance. The service connects lazily on
 * `start()` so callers (entry, tests, Task 14 in-process loopback) hold an
 * explicit lifecycle handle instead of a fire-and-forget `main()`.
 */
export function createLiteService(cfg: RemoteAgentConfig): LiteService {
  let socket: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const clearTimers = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const clearHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const handleOpen = () => {
    if (stopped) return;
    if (!socket) return;
    socket.send(buildHelloFrame(cfg));
    // Re-point the agent-run push bus at THIS socket. On reconnect this rebinds
    // to the fresh socket so session/approval pushes never close over a stale
    // connection.
    const live = socket;
    setPushEmitter((topic, payload) => {
      if (live.readyState === WebSocket.OPEN) {
        live.send(JSON.stringify({ type: 'push', topic, payload }));
      }
    });
    clearHeartbeat();
    heartbeat = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(makePing()));
      }
    }, HEARTBEAT_MS);
  };

  const handleMessage = (raw: WebSocket.RawData) => {
    if (stopped) return;
    if (!socket) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handleIncomingFrame(socket as unknown as WsLike, frame, cfg).catch((err) =>
      console.error('[remote-agent] frame error:', err),
    );
  };

  const handleError = (err: Error) => {
    if (stopped) return;
    console.error('[remote-agent] ws error:', err.message);
  };

  const handleClose = (code: number) => {
    if (stopped) return;
    clearTimers();
    const fatal = FATAL_CLOSE_CODES[code];
    if (fatal !== undefined) {
      console.error(`[remote-agent] connection rejected by server (${code}: ${fatal}); exiting`);
      process.exit(0); // clean exit — systemd Restart=on-failure does NOT spin on this
      return;
    }
    // I2 review fix: a dropped connection must not leave runs "active" on this
    // side — a later re-send with the same providerSessionId would otherwise
    // fail with `session already running`. Interrupt everything (across ALL
    // provider managers) so a retry starts a fresh run. Mid-turn state is lost
    // (no transparent adopt in v1).
    const interrupted = interruptAllFor(cfg);
    if (interrupted > 0) {
      console.warn(`[remote-agent] interrupted ${interrupted} active run(s) on connection close`);
    }
    console.error('[remote-agent] ws closed; reconnecting in', RECONNECT_MS, 'ms');
    reconnectTimer = setTimeout(() => {
      if (stopped) return;
      try {
        connect();
      } catch (err) {
        console.error('[remote-agent] reconnect failed:', err);
      }
    }, RECONNECT_MS);
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(buildWsUrl(cfg));
    socket.on('open', handleOpen);
    socket.on('message', handleMessage);
    socket.on('error', handleError);
    socket.on('close', handleClose);
  };

  const start = () => {
    if (stopped) return;
    connect();
  };

  const stop = () => {
    stopped = true;
    clearTimers();
    // Deliberately keep all listeners attached. In ws, closing a CONNECTING
    // socket routes through abortHandshake → emitErrorAndClose, which emits
    // 'error' on a process.nextTick; if the 'error' listener were removed here,
    // it surfaces as an uncaught 'Unhandled error event' and crashes the process
    // (breaks Task 14 start→immediate-stop loopback and SIGTERM mid-reconnect).
    // The `stopped` flag already guards every handler and the reconnect paths,
    // so the stuck listeners are silent no-ops post-stop.
    if (socket) socket.close();
  };

  return {
    get ws(): WebSocket {
      if (!socket) throw new Error('[remote-agent] service not started yet');
      return socket;
    },
    start,
    stop,
  };
}

/**
 * Convenience entry: load config, start the service, and wire SIGTERM/SIGINT to
 * a clean stop + exit so systemd and terminal Ctrl-C can shut us down.
 */
export function main(cfg: RemoteAgentConfig = loadConfigFile()): LiteService {
  const service = createLiteService(cfg);
  service.start();
  const shutdown = () => {
    service.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return service;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    main();
  } catch (err) {
    console.error('[remote-agent] fatal:', err);
    process.exit(1);
  }
}