import http from 'node:http';

export type LlmReqFrame = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

/** Minimal WS surface the relay needs; tests inject a capturing fake. */
export type LlmRelaySocket = { send: (raw: string) => void };

export type LlmRelayOpts = { proxyPort: number };

/** Hop-by-hop / connection-scoped request headers that must NOT be forwarded to
 * the llm-proxy (host/content-length are recomputed below). */
const SKIP_FORWARD_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'upgrade', 'proxy-connection',
]);

/** Forwards one lite `llm_req` to the local llm-proxy and streams the response
 * back as `llm_res` frames (status+headers on the first frame, base64 chunks,
 * final `done:true`). */
export function relayLlmRequest(frame: LlmReqFrame, ws: LlmRelaySocket, opts: LlmRelayOpts): void {
  const body = Buffer.from(frame.bodyBase64, 'base64');
  const send = (status: number, headers: Record<string, string>, chunkBase64: string, done: boolean): void => {
    ws.send(JSON.stringify({ type: 'llm_res', id: frame.id, status, headers, chunkBase64, done }));
  };

  const headersOut: Record<string, string> = {};
  for (const [k, v] of Object.entries(frame.headers)) {
    if (!SKIP_FORWARD_HEADERS.has(k.toLowerCase())) headersOut[k] = v;
  }
  headersOut.host = `127.0.0.1:${opts.proxyPort}`;
  headersOut['content-length'] = String(body.length);

  const req = http.request(
    { host: '127.0.0.1', port: opts.proxyPort, path: frame.path, method: frame.method, headers: headersOut },
    (res) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        h[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      }
      send(res.statusCode ?? 502, h, '', false);
      res.on('data', (chunk: Buffer) => send(res.statusCode ?? 502, {}, chunk.toString('base64'), false));
      res.on('end', () => send(res.statusCode ?? 502, {}, '', true));
      res.on('error', () => send(502, {}, '', true));
    },
  );
  req.on('error', () => {
    const errBody = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'llm proxy unavailable' } })).toString('base64');
    send(502, { 'content-type': 'application/json' }, errBody, true);
  });
  req.write(body);
  req.end();
}
