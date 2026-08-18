import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'node:http';
import { describe, it } from 'node:test';
import { createRemoteAgentsRegistry, ConnectionError } from '../remote-agents.registry.js';
import {
  createRemoteAgentConnectionHandler,
  createRemoteAgentWss,
  addPushListener,
  removePushListener,
} from '../remote-agent.server.js';
import type { PushEvent } from '../remote-agent.server.js';

function makeFakeWs() {
  const handlers: Record<string, (raw?: unknown) => void> = {};
  const ws = {
    state: 1,
    sent: [] as string[],
    closeCode: 0,
    closeReason: '',
    on(evt: string, cb: (raw?: unknown) => void) {
      handlers[evt] = cb;
    },
    send(raw: string) {
      ws.sent.push(raw);
    },
    close(code: number = 0, reason: string = '') {
      ws.closeCode = code;
      ws.closeReason = reason;
      ws.state = 3; // CLOSED
      // Real ws emits 'close' asynchronously; firing it here synchronously
      // would reorder events (e.g. a superseded socket's close firing before
      // its replacement is registered).
      setImmediate(() => handlers['close']?.());
    },
    get readyState() {
      return ws.state;
    },
    OPEN: 1,
    _fire(evt: 'message' | 'close' | 'error', raw?: unknown) {
      handlers[evt]?.(raw);
    },
  };
  return ws;
}

type FakeWs = ReturnType<typeof makeFakeWs>;

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
  const handler = createRemoteAgentConnectionHandler({ verifyToken: () => 'h1', registry });
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
  const gotPush: PushEvent[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: () => 'h1',
    registry,
    onHostOnline: () => {},
    onHostOffline: () => {},
  });
  const listener = (e: PushEvent) => gotPush.push(e);
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

// --- risky-path regressions (M2) ---

test('second hello on the same socket is a no-op: host stays online, single ack', () => {
  const registry = createRemoteAgentsRegistry();
  const online: string[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: () => 'h1',
    registry,
    onHostOnline: (h) => online.push(h),
    onHostOffline: () => {},
  });
  const ws = makeFakeWs();
  handler(ws as never, {});
  const hello = JSON.stringify({ type: 'hello', hostId: 'h1', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] });
  ws._fire('message', hello);
  ws._fire('message', hello);
  assert.equal(registry.isOnline('h1'), true);
  assert.deepEqual(online, ['h1']); // onHostOnline once
  const acks = ws.sent.filter((s) => {
    try {
      return JSON.parse(s).id === 'hello';
    } catch {
      return false;
    }
  });
  assert.equal(acks.length, 1);
  assert.equal(ws.closeCode, 0); // socket was not shut down by the re-hello
});

test('hello with a mismatched hostId closes 4002 and does not register', () => {
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
  // token verified → authorized host is h1; the lite claims h2
  handler(ws as never, {}, 'h1');
  ws._fire(
    'message',
    JSON.stringify({ type: 'hello', hostId: 'h2', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] }),
  );
  assert.equal(ws.closeCode, 4002);
  assert.equal(ws.closeReason, 'host id mismatch');
  assert.deepEqual(ws.sent, []); // no ack, no registration
  assert.equal(registry.isOnline('h2'), false);
  assert.equal(registry.isOnline('h1'), false);
  assert.deepEqual(online, []);
  assert.deepEqual(offline, []); // forced close fired the close handler but nothing to tear down
});

test('push before hello is dropped', () => {
  const registry = createRemoteAgentsRegistry();
  const gotPush: PushEvent[] = [];
  const handler = createRemoteAgentConnectionHandler({ verifyToken: () => 'h1', registry });
  const listener = (e: PushEvent) => gotPush.push(e);
  addPushListener(listener);
  try {
    const ws = makeFakeWs();
    handler(ws as never, {});
    ws._fire('message', JSON.stringify({ type: 'push', topic: 'session:s1', payload: { x: 1 } }));
    ws._fire('message', JSON.stringify({ type: 'pong', at: 1 }));
    ws._fire('message', JSON.stringify({ type: 'rpc_res', id: 'nope', ok: false }));
    assert.deepEqual(gotPush, []);
    assert.equal(registry.isOnline('h1'), false);
    assert.equal(ws.sent.length, 0);
  } finally {
    removePushListener(listener);
  }
});

test('close without hello is a no-op: no crash, no offline callback', () => {
  const registry = createRemoteAgentsRegistry();
  const offline: string[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: () => 'h1',
    registry,
    onHostOffline: (h) => offline.push(h),
  });
  const ws = makeFakeWs();
  handler(ws as never, {});
  ws._fire('close');
  assert.deepEqual(offline, []);
  assert.equal(registry.isOnline('h1'), false);
});

test('stale socket close does not fail the live socket rpcs (ABA)', async () => {
  const registry = createRemoteAgentsRegistry();
  const offline: string[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: () => 'h1',
    registry,
    onHostOffline: (h) => offline.push(h),
  });
  const stale = makeFakeWs();
  handler(stale as never, {});
  stale._fire(
    'message',
    JSON.stringify({ type: 'hello', hostId: 'h1', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] }),
  );
  // reconnect: a second handler/socket supersedes the stale one
  const fresh = makeFakeWs();
  handler(fresh as never, {});
  fresh._fire(
    'message',
    JSON.stringify({ type: 'hello', hostId: 'h1', agentVersion: '1', nodeVersion: '20', os: 'linux', roots: [], capabilities: [] }),
  );
  assert.equal(registry.isOnline('h1'), true);
  const p = registry.rpc('h1', 'fs/stat', { path: '/live' }, 1000);
  const req = JSON.parse(fresh.sent[fresh.sent.length - 1]) as { id: string };
  // stale socket closes last — must NOT fail the fresh socket's pending rpc
  stale._fire('close');
  assert.equal(registry.isOnline('h1'), true);
  assert.deepEqual(offline, []);
  fresh._fire('message', JSON.stringify({ type: 'rpc_res', id: req.id, ok: true, data: { ok: 1 } }));
  await p.then((data) => assert.deepEqual(data, { ok: 1 }));
  fresh._fire('close');
  assert.equal(registry.isOnline('h1'), false);
  assert.deepEqual(offline, ['h1']);
});

describe('registry failPendingForHost', () => {
  it('rejects in-flight rpcs for the host without touching other hosts', async () => {
    const reg = createRemoteAgentsRegistry();
    const ws = makeFakeWs();
    reg.register({ hostId: 'h1', roots: [], capabilities: [] }, ws as never);
    const p1 = reg.rpc('h1', 'fs/stat', { path: '/x' }, 2000);
    const p2 = reg.rpc('h1', 'session/start', { appSessionId: 's1', command: 'x', cwd: '/srv' }, 2000);
    const ws2 = makeFakeWs();
    reg.register({ hostId: 'h2', roots: [], capabilities: [] }, ws2 as never);
    const p3 = reg.rpc('h2', 'fs/stat', { path: '/y' }, 2000);
    assert.equal(reg.failPendingForHost('h1'), 2);
    await assert.rejects(p1, ConnectionError);
    await assert.rejects(p2, /disconnect/);
    assert.equal(reg.pendingCount(), 1); // h2's rpc survives
    reg.resolveRpc(JSON.parse(ws2.sent[0]).id, { ok: false, error: 'nope' });
    await assert.rejects(p3, /nope/);
    assert.equal(reg.pendingCount(), 0);
  });
});