import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleIncomingFrame } from '../index.js';
import type { RemoteAgentConfig } from '../config.js';

const cfg: RemoteAgentConfig = {
  serverUrl: 'ws://localhost:3000/agent',
  token: 'a-long-enough-token',
  hostId: 'host-1',
  roots: ['/'],
  agentVersion: '0.1.0',
};

function makeFakeWs() {
  const sent: string[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      sent.push(raw);
    },
    sent,
  };
}

test('handleIncomingFrame replies to ping with pong', async () => {
  const ws = makeFakeWs();
  await handleIncomingFrame(ws, { type: 'ping', at: 1 }, cfg);
  assert.equal(ws.sent.length, 1);
  const frame = JSON.parse(ws.sent[0]);
  assert.equal(frame.type, 'pong');
  assert.equal(typeof frame.at, 'number');
});

test('handleIncomingFrame replies rpc_res ok:false for an unknown method', async () => {
  const ws = makeFakeWs();
  await handleIncomingFrame(ws, { type: 'rpc_req', id: 'r1', method: 'does/not-exist', params: {} }, cfg);
  assert.equal(ws.sent.length, 1);
  const frame = JSON.parse(ws.sent[0]);
  assert.equal(frame.type, 'rpc_res');
  assert.equal(frame.id, 'r1');
  assert.equal(frame.ok, false);
  assert.match(frame.error, /unknown rpc method/);
});

test('handleIncomingFrame ignores frames it does not handle', async () => {
  const ws = makeFakeWs();
  await handleIncomingFrame(ws, { type: 'pong', at: 5 }, cfg);
  assert.equal(ws.sent.length, 0);
});
