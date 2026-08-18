import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';

type FakeWs = { sent: string[]; readyState: number; OPEN: number; send(raw: string): void };

test('registers and unregisters a host', () => {
  const reg = createRemoteAgentsRegistry();
  assert.equal(reg.isOnline('h1'), false);
  reg.register({ hostId: 'h1', roots: ['/srv/app'], capabilities: ['session/claude'] }, fakeWs() as unknown as WebSocket);
  assert.equal(reg.isOnline('h1'), true);
  assert.deepEqual(reg.getCapabilities('h1'), ['/srv/app']);
  reg.unregister('h1');
  assert.equal(reg.isOnline('h1'), false);
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
});

test('rpc rejects when host offline or on timeout/error response', async () => {
  const reg = createRemoteAgentsRegistry();
  await assert.rejects(() => reg.rpc('nope', 'session/start', {}, 100), /offline/);
  const ws = fakeWs();
  reg.register({ hostId: 'h1', roots: [], capabilities: [] }, ws as unknown as WebSocket);
  const p = reg.rpc('h1', 'fs/stat', { path: '/x' }, 1000);
  reg.resolveRpc(JSON.parse(ws.sent[0]).id, { ok: false, error: 'boom' });
  await assert.rejects(p, /boom/);
});

test('session + approval indexes route lookups', () => {
  const reg = createRemoteAgentsRegistry();
  reg.setSessionHost('s1', null, 'h1');
  assert.equal(reg.getSessionHost('s1')?.hostId, 'h1');
  reg.setSessionHost('s1', 'P1', 'h1');
  assert.equal(reg.getSessionHostByProvider('P1')?.appSessionId, 's1');
  reg.addPendingApproval('req1', { appSessionId: 's1', hostId: 'h1' });
  assert.deepEqual(reg.takePendingApproval('req1'), { appSessionId: 's1', hostId: 'h1' });
  assert.equal(reg.takePendingApproval('req1'), undefined);
});

test('clearSessionsForHost returns affected app sessions', () => {
  const reg = createRemoteAgentsRegistry();
  reg.setSessionHost('a', null, 'h1');
  reg.setSessionHost('b', null, 'h2');
  assert.deepEqual(reg.clearSessionsForHost('h1').sort(), ['a']);
});

function fakeWs(): FakeWs {
  return { sent: [] as string[], readyState: 1, OPEN: 1, send(raw: string) { this.sent.push(raw); } };
}
