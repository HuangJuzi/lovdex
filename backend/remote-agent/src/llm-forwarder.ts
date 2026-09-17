import http from 'node:http';
import { randomUUID } from 'node:crypto';

export type LlmResFrame = {
  type: 'llm_res';
  id: string;
  status: number;
  headers: Record<string, string>;
  chunkBase64: string;
  done: boolean;
};

type Pending = { res: http.ServerResponse; responded: boolean };

export type LlmForwarder = {
  /** Listen on 127.0.0.1:<port> (0 = ephemeral). Resolves to the bound port. */
  start(port: number): Promise<number>;
  stop(): void;
  /** Re-point the outbound sender at the live WS socket (rebound on reconnect). */
  setSend(fn: (frame: unknown) => void): void;
  handleLlmRes(frame: LlmResFrame): boolean;
  /** End every open response and clear the pending map. Returns how many were aborted. */
  abortPending(status?: number): number;
  pendingCount(): number;
};

const HOP_BY_HOP = new Set([
  'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'date', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te',
]);

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export function createLlmForwarder(): LlmForwarder {
  const pending = new Map<string, Pending>();
  let server: http.Server | null = null;
  let listenPromise: Promise<number> | null = null;
  let send: (frame: unknown) => void = () => {};

  function setSend(fn: (frame: unknown) => void): void {
    send = fn;
  }

  function handleLlmRes(frame: LlmResFrame): boolean {
    const p = pending.get(frame.id);
    if (!p) return false;
    try {
      if (!p.responded) {
        p.res.writeHead(frame.status, sanitizeHeaders(frame.headers));
        p.responded = true;
      }
      if (frame.chunkBase64) p.res.write(Buffer.from(frame.chunkBase64, 'base64'));
      if (frame.done) {
        pending.delete(frame.id);
        p.res.end();
      }
      return true;
    } catch {
      pending.delete(frame.id);
      try { p.res.destroy(); } catch { /* ignore */ }
      return false;
    }
  }

  function abortPending(status = 502): number {
    let n = 0;
    for (const [id, p] of pending) {
      try {
        if (!p.responded) {
          p.res.writeHead(status, { 'content-type': 'application/json' });
          p.responded = true;
        }
        p.res.end();
      } catch { /* ignore */ }
      pending.delete(id);
      n++;
    }
    return n;
  }

  function start(port: number): Promise<number> {
    if (listenPromise) return listenPromise;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('error', () => {});
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const id = randomUUID();
        const headers: Record<string, string> = {};
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]] = req.rawHeaders[i + 1];
        pending.set(id, { res, responded: false });
        res.on('error', () => {});
        res.on('close', () => pending.delete(id));
        send({
          type: 'llm_req',
          id,
          method: req.method ?? 'POST',
          path: req.url ?? '/v1/messages',
          headers,
          bodyBase64: Buffer.concat(chunks).toString('base64'),
        });
      });
    });
    listenPromise = new Promise((resolve, reject) => {
      server!.on('error', (err) => {
        listenPromise = null;
        reject(err);
      });
      server!.listen(port, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
    return listenPromise;
  }

  function stop(): void {
    abortPending();
    if (server) { server.close(); server = null; }
    listenPromise = null;
  }

  return { start, stop, setSend, handleLlmRes, abortPending, pendingCount: () => pending.size };
}
