import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';

import { makePing } from '../../server/shared/agent-runtime/protocol.js';
import { loadConfigFile, type RemoteAgentConfig } from './config.js';
import { handleRpc } from './rpc-dispatch.js';

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 3_000;

/** Minimal WebSocket surface the frame handler needs; keeps it unit-testable. */
export interface WsLike {
  readyState: number;
  OPEN: number;
  send(raw: string): void;
}

/**
 * Handle one decoded inbound frame.
 *
 * - `ping` → reply `pong`.
 * - `rpc_req` → run {@link handleRpc}, reply `rpc_res` with `ok` + `data`/`error`.
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

  if (f.type === 'rpc_req' && typeof f.id === 'string' && typeof f.method === 'string') {
    const id = f.id;
    try {
      const data = await handleRpc(f.method, f.params, cfg);
      ws.send(JSON.stringify({ type: 'rpc_res', id, ok: true, data }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'rpc_res', id, ok: false, error }));
    }
    return;
  }
}

function buildHelloFrame(cfg: RemoteAgentConfig): string {
  return JSON.stringify({
    type: 'hello',
    hostId: cfg.hostId,
    agentVersion: cfg.agentVersion,
    nodeVersion: process.version,
    os: process.platform,
    roots: cfg.roots,
    capabilities: ['session/claude', 'fs/read'],
  });
}

function buildWsUrl(cfg: RemoteAgentConfig): string {
  const url = new URL(cfg.serverUrl);
  url.searchParams.set('token', cfg.token);
  return url.toString();
}

/**
 * Connect to the main server, announce this host, then service pings and RPC
 * requests. Reconnects on close. Exported (not auto-run on import) so tests can
 * import the module safely.
 */
export function main(cfg: RemoteAgentConfig = loadConfigFile()): void {
  const ws = new WebSocket(buildWsUrl(cfg));
  let heartbeat: NodeJS.Timeout | undefined;

  const clearHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  ws.on('open', () => {
    ws.send(buildHelloFrame(cfg));
    clearHeartbeat();
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(makePing()));
      }
    }, HEARTBEAT_MS);
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handleIncomingFrame(ws as unknown as WsLike, frame, cfg);
  });

  ws.on('error', (err: Error) => {
    console.error('[remote-agent] ws error:', err.message);
  });

  ws.on('close', () => {
    console.error('[remote-agent] ws closed; reconnecting in', RECONNECT_MS, 'ms');
    clearHeartbeat();
    setTimeout(() => {
      try {
        main(cfg);
      } catch (err) {
        console.error('[remote-agent] reconnect failed:', err);
      }
    }, RECONNECT_MS);
  });
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
