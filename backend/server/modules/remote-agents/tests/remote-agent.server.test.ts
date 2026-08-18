import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'node:http';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';
import {
  createRemoteAgentConnectionHandler,
  createRemoteAgentWss,
  addPushListener,
  removePushListener,
} from '../remote-agent.server.js';

function makeFakeWs() {
  const handlers: Record<string, (raw?: unknown) => void> = {};
  const ws = {
    sent: [] as string[],
    on(evt: string, cb: (raw?: unknown) => void) {
      handlers[evt] = cb;
    },
    send(raw: string) {
      ws.sent.push(raw);
    },
    close() {},
    readyState: 1,
    OPEN: 1,
    _fire(evt: 'message' | 'close', raw?: unknown) {
      handlers[evt]?.(raw);
    },
  };
  return ws;
}

test('hello registers host, replies accepted, pong touches seen, close tears down identity-aware', () => {
  const registry = createRemoteAgentsRegistry();
  const online: string[] = [];
  const offline: string[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: (t) => (t === 'tok' ? 'h1' : null),
    registry,
    onHostOnline: (h) => online.push(h),
    onHostOffline: (h) => offline.push(h),
  });
  const ws = makeFakeWs();
  handler(ws as never, {});
  ws._fire(
    'message',
    JSON.stringify({
      type: 'hello',
      hostId: 'h1',
      agentVersion: '1',
      nodeVersion: '20',
      os: 'linux',
      roots: ['/srv'],
      capabilities: ['session/claude'],
    }),
  );
  assert.equal(registry.isOnline('h1'), true);
  assert.deepEqual(online, ['h1']);
  const resp = JSON.parse(ws.sent[0]);
  assert.equal(resp.id, 'hello');
  assert.equal(resp.ok, true);
  assert.equal(resp.data.accepted, true);
  ws._fire('message', JSON.stringify({ type: 'pong', at: 1 }));
  // close: the current socket
  ws._fire('close');
  assert.equal(registry.isOnline('h1'), false);
  assert.deepEqual(offline, ['h1']);
});

test('bad json replies with error frame', () => {
  const registry = createRemoteAgentsRegistry();
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: () => 'h1',
    registry,
  });
  const ws = makeFakeWs();
  handler(ws as never, {});
  ws._fire('message', 'not json{');
  const resp = JSON.parse(ws.sent[0]);
  assert.equal(resp.type, 'rpc_res');
  assert.equal(resp.id, '');
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'bad json');
});

test('push is dispatched to listeners', () => {
  const registry = createRemoteAgentsRegistry();
  const gotPush: { topic: string; payload: unknown; from: string | null }[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: () => 'h1',
    registry,
    onHostOnline: () => {},
    onHostOffline: () => {},
  });
  const listener = (e: { topic: string; payload: unknown; from: string | null }) => gotPush.push(e);
  addPushListener(listener);
  try {
    const ws = makeFakeWs();
    handler(ws as never, {});
    ws._fire(
      'message',
      JSON.stringify({ type: 'hello', hostId: 'h1', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] }),
    );
    ws.sent = [];
    ws._fire('message', JSON.stringify({ type: 'push', topic: 'session:s1', payload: { type: 'assistant' } }));
    assert.deepEqual(gotPush, [{ topic: 'session:s1', payload: { type: 'assistant' }, from: 'h1' }]);
  } finally {
    removePushListener(listener);
  }
});

test('rpc_res is routed through the registry', () => {
  const registry = createRemoteAgentsRegistry();
  const handler = createRemoteAgentConnectionHandler({ verifyToken: () => 'h1', registry });
  const ws = makeFakeWs();
  handler(ws as never, {});
  ws._fire(
    'message',
    JSON.stringify({ type: 'hello', hostId: 'h1', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] }),
  );
  ws.sent = [];
  // Register a pending rpc so we have a real id to resolve through the handler.
  const p = registry.rpc('h1', 'fs/stat', { path: '/x' }, 1000);
  const req = JSON.parse(ws.sent[0]) as { id: string };
  ws._fire('message', JSON.stringify({ type: 'rpc_res', id: req.id, ok: true, data: { ok: 1 } }));
  return p.then((data) => {
    assert.deepEqual(data, { ok: 1 });
  });
});

test('wss factory authenticates token and rejects bad token', async () => {
  const server = http.createServer();
  const registry = createRemoteAgentsRegistry();
  const wss = createRemoteAgentWss(server, {
    verifyToken: (t) => (t === 'good' ? 'h1' : null),
    registry,
    onHostOnline: () => {},
    onHostOffline: () => {},
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const bad = new WebSocket(`ws://127.0.0.1:${port}/api/remote-agents/ws?token=bad`);
  await new Promise<void>((r) => {
    bad.on('close', (code) => {
      assert.equal(code, 4001);
      r();
    });
  });
  const good = new WebSocket(`ws://127.0.0.1:${port}/api/remote-agents/ws?token=good`);
  await new Promise<void>((r) => {
    good.on('open', () => r());
  });
  good.send(
    JSON.stringify({ type: 'hello', hostId: 'h1', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] }),
  );
  await new Promise<void>((r) => {
    good.on('message', () => r());
  });
  assert.equal(registry.isOnline('h1'), true);
  good.close();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});
