import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { createLlmForwarder } from '../llm-forwarder.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('full round-trip: HTTP request becomes llm_req; llm_res streams back', async () => {
  const f = createLlmForwarder();
  const frames: any[] = [];
  f.setSend((frame) => frames.push(frame));
  const port = await f.start(0);

  const body = JSON.stringify({ model: 'sonnet', messages: [] });
  const respPromise = new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  // The forwarder must have emitted one llm_req with base64 body.
  await waitFor(() => frames.length === 1);
  const reqFrame = frames[0];
  assert.equal(reqFrame.type, 'llm_req');
  assert.equal(reqFrame.path, '/v1/messages');
  assert.equal(Buffer.from(reqFrame.bodyBase64, 'base64').toString(), body);

  // Stream a response back in 2 chunks + done.
  f.handleLlmRes({ type: 'llm_res', id: reqFrame.id, status: 200, headers: { 'content-type': 'application/json' }, chunkBase64: Buffer.from('{"ok":').toString('base64'), done: false });
  f.handleLlmRes({ type: 'llm_res', id: reqFrame.id, status: 200, headers: {}, chunkBase64: Buffer.from('true}').toString('base64'), done: false });
  f.handleLlmRes({ type: 'llm_res', id: reqFrame.id, status: 200, headers: {}, chunkBase64: '', done: true });

  const resp = await respPromise;
  assert.equal(resp.status, 200);
  assert.equal(resp.data, '{"ok":true}');
  assert.equal(f.pendingCount(), 0);

  f.stop();
});

test('handleLlmRes returns false for unknown id', () => {
  const f = createLlmForwarder();
  assert.equal(f.handleLlmRes({ type: 'llm_res', id: 'nope', status: 200, headers: {}, chunkBase64: '', done: true }), false);
});

test('abortPending ends an in-flight request with 502', async () => {
  const f = createLlmForwarder();
  const frames: any[] = [];
  f.setSend((frame) => frames.push(frame));
  const port = await f.start(0);

  const respPromise = new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.on('error', reject);
    req.end();
  });

  await waitFor(() => frames.length === 1);
  assert.equal(f.pendingCount(), 1);
  assert.equal(f.abortPending(), 1);

  const resp = await respPromise;
  assert.equal(resp.status, 502);
  assert.equal(f.pendingCount(), 0);

  f.stop();
});

test('strips hop-by-hop headers so a bad content-length cannot crash', async () => {
  const f = createLlmForwarder();
  const frames: any[] = [];
  f.setSend((frame) => frames.push(frame));
  const port = await f.start(0);

  const respPromise = new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.on('error', reject);
    req.end();
  });

  await waitFor(() => frames.length === 1);
  const reqFrame = frames[0];

  f.handleLlmRes({
    type: 'llm_res',
    id: reqFrame.id,
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '999' },
    chunkBase64: Buffer.from('{"ok":true}').toString('base64'),
    done: true,
  });

  const resp = await respPromise;
  assert.equal(resp.status, 200);
  assert.equal(resp.data, '{"ok":true}');
  assert.equal(f.pendingCount(), 0);

  f.stop();
});
