import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';

type FakeWs = {
  sent: string[];
  readyState: number;
  OPEN: number;
  closed: boolean;
  close(): void;
  send(raw: string, cb?: (err?: Error) => void): void;
};

test('registers and unregisters a host', () => {
  const reg = createRemoteAgentsRegistry();
  const ws = fakeWs();
  assert.equal(reg.isOnline('h1'), false);
  reg.register({ hostId: 'h1', roots: ['/srv/app'], capabilities: ['session/claude'] }, ws as unknown as WebSocket);
  assert.equal(reg.isOnline('h1'), true);
  assert.deepEqual(reg.getCapabilities('h1'), ['session/claude']);
  assert.deepEqual(reg.getRoots('h1'), ['/srv/app']);
  // a different socket may not unregister this host
  assert.equal(reg.unregister('h1', fakeWs() as unknown as WebSocket), false);
  assert.equal(reg.isOnline('h1'), true);
  assert.equal(reg.unregister('h1', ws as unknown as WebSocket), true);
  assert.equal(reg.isOnline('h1'), false);
});

test('register supersedes a stale socket (ABA) and closes it', () => {
  const reg = createRemoteAgentsRegistry();
  const stale = fakeWs();
  reg.register({ hostId: 'h1', roots: [], capabilities: [] }, stale as unknown as WebSocket);
  const fresh = fakeWs();
  reg.register({ hostId: 'h1', roots: [], capabilities: [] }, fresh as unknown as WebSocket);
  assert.equal(stale.closed, true);
  assert.equal(reg.isOnline('h1'), true);
  // stale socket's close event must not tear down the fresh registration
  assert.equal(reg.unregister('h1', stale as unknown as WebSocket), false);
  assert.equal(reg.isOnline('h1'), true);
  assert.equal(reg.disconnect('h1', stale as unknown as WebSocket).length, 0);
  assert.equal(reg.isOnline('h1'), true);
  assert.equal(reg.unregister('h1', fresh as unknown as WebSocket), true);
  assert.equal(reg.isOnline('h1'), false);
});

test('disconnect removes identity-matched socket, sessions and approvals', () => {
  const reg = createRemoteAgentsRegistry();
  const ws = fakeWs();
  const other = fakeWs();
  reg.register({ hostId: 'h1', roots: [], capabilities: [] }, ws as unknown as WebSocket);
  reg.setSessionHost('a', null, 'h1');
  reg.setSessionHost('b', 'P2', 'h1');
  reg.addPendingApproval('req1', { appSessionId: 'a', hostId: 'h1' });
  // a stale / different socket must not tear anything down
  assert.deepEqual(reg.disconnect('h1', other as unknown as WebSocket), []);
  assert.equal(reg.isOnline('h1'), true);
  assert.equal(reg.getSessionHost('a')?.hostId, 'h1');
  assert.equal(reg.takePendingApproval('req1')?.appSessionId, 'a');
  // re-add because the take above consumed it
  reg.addPendingApproval('req1', { appSessionId: 'a', hostId: 'h1' });
  assert.deepEqual(reg.disconnect('h1', ws as unknown as WebSocket).sort(), ['a', 'b']);
  assert.equal(reg.isOnline('h1'), false);
  assert.equal(reg.getSessionHost('a'), undefined);
  assert.equal(reg.getSessionHostByProvider('P2'), undefined);
  assert.equal(reg.takePendingApproval('req1'), undefined);
});

test('rpc resolves via pending map when response arrives', async () => {
  const reg = createRemoteAgentsRegistry();
  const ws = fakeWs();
  reg.register({ hostId: 'h1', roots: ['/srv\''], capabilities: [] }, ws as unknown as WebSocket);
  const p = reg.rpc('h1', 'session/start', { appSessionId: 's1', command: 'x', cwd: '/srv' }, 2000);
  assert.equal(ws.sent.length, 1);
  const frame = JSON.parse(ws.sent[0]);
  assert.equal(frame.type, 'rpc_req');
  assert.equal(frame.method, 'session/start');
  reg.resolveRpc(frame.id, { ok: true, data: { providerSessionId: 'P1' } });
  const res = await p;
  assert.equal((res as { providerSessionId: string }).providerSessionId, 'P1');
  assert.equal(reg.pendingCount(), 0);
});

test('rpc rejects when host offline or on error response', async () => {
  const reg = createRemoteAgentsRegistry();
  await assert.rejects(() => reg.rpc('nope', 'session/start', {}, 100), /offline/);
  const ws = fakeWs();
  reg.register({ hostId: 'h1', roots: [], capabilities: [] }, ws as unknown as WebSocket);
  const p = reg.rpc('h1', 'fs/stat', { path: '/x' }, 1000);
  reg.resolveRpc(JSON.parse(ws.sent[0]).id, { ok: false, error: 'boom' });
  await assert.rejects(p, /boom/);
  assert.equal(reg.pendingCount(), 0);
});

test('rpc times out, clears the pending entry, and a late reply is a no-op', async () => {
  const reg = createRemoteAgentsRegistry();
  const ws = fakeWs();
  reg.register({ hostId: 'h1', roots: [], capabilities: [] }, ws as unknown as WebSocket);
  const p = reg.rpc('h1', 'fs/stat', { path: '/slow' }, 25);
  const id = JSON.parse(ws.sent[0]).id;
  await assert.rejects(p, /timeout/);
  assert.equal(reg.pendingCount(), 0);
  // late reply must be silently ignored (promise already rejected with timeout)
  reg.resolveRpc(id, { ok: true, data: 'late' });
  assert.equal(reg.pendingCount(), 0);
});

test('session + approval indexes route lookups', () => {
  const reg = createRemoteAgentsRegistry();
  assert.equal(reg.getSessionHostByProvider('NOPE'), undefined);
  reg.setSessionHost('s1', null, 'h1');
  assert.equal(reg.getSessionHost('s1')?.hostId, 'h1');
  assert.equal(reg.getSessionHost('s1')?.providerSessionId, null);
  reg.setSessionHost('s1', 'P1', 'h1');
  assert.equal(reg.getSessionHostByProvider('P1')?.appSessionId, 's1');
  assert.equal(reg.getSessionHostByProvider('NOPE'), undefined);
  reg.addPendingApproval('req1', { appSessionId: 's1', hostId: 'h1' });
  assert.deepEqual(reg.takePendingApproval('req1'), { appSessionId: 's1', hostId: 'h1' });
  assert.equal(reg.takePendingApproval('req1'), undefined);
});

test('clearSessionsForHost returns affected app sessions and sweeps approvals', () => {
  const reg = createRemoteAgentsRegistry();
  reg.setSessionHost('a', null, 'h1');
  reg.setSessionHost('b', null, 'h2');
  reg.addPendingApproval('req1', { appSessionId: 'a', hostId: 'h1' });
  assert.deepEqual(reg.clearSessionsForHost('h1').sort(), ['a']);
  assert.equal(reg.getSessionHost('a'), undefined);
  assert.equal(reg.getSessionHost('b')?.hostId, 'h2');
  assert.equal(reg.takePendingApproval('req1'), undefined);
});

function fakeWs(): FakeWs {
  return {
    sent: [] as string[],
    readyState: 1,
    OPEN: 1,
    closed: false,
    close() {
      this.closed = true;
    },
    send(raw: string, cb?: (err?: Error) => void) {
      this.sent.push(raw);
      cb?.();
    },
  };
}