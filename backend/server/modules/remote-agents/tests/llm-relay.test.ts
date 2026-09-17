import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { relayLlmRequest } from '../llm-relay.js';

test('relayLlmRequest forwards to local proxy and streams llm_res frames', async () => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"echo":');
      res.end('true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const sent: string[] = [];
  const ws = { send: (raw: string) => sent.push(raw) };

  relayLlmRequest(
    {
      id: 'r1', method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from('{"model":"sonnet"}').toString('base64'),
    },
    ws,
    { proxyPort: upstreamPort },
  );

  await new Promise((r) => setTimeout(r, 50)); // wait for streaming to finish

  const frames = sent.map((s) => JSON.parse(s));
  assert.equal(frames[0].id, 'r1');
  assert.equal(frames[0].status, 200);
  assert.equal(frames[0].done, false);
  assert.equal(frames[frames.length - 1].done, true);
  const body = frames
    .slice(1)
    .filter((f) => f.chunkBase64)
    .map((f) => Buffer.from(f.chunkBase64, 'base64').toString())
    .join('');
  assert.equal(body, '{"echo":true}');

  upstream.close();
});

test('relayLlmRequest emits a 502 error frame when proxy is down', async () => {
  const sent: string[] = [];
  const ws = { send: (raw: string) => sent.push(raw) };
  relayLlmRequest(
    { id: 'r2', method: 'POST', path: '/v1/messages', headers: {}, bodyBase64: '' },
    ws,
    { proxyPort: 1 }, // nothing listening
  );
  await new Promise((r) => setTimeout(r, 50));
  const last = JSON.parse(sent[sent.length - 1]);
  assert.equal(last.id, 'r2');
  assert.equal(last.status, 502);
  assert.equal(last.done, true);
});
