import assert from 'node:assert/strict';
import test from 'node:test';

import { chatRunRegistry, setTaskLinkage } from '@/modules/websocket/services/chat-run-registry.service.js';

function makeConnection() {
  return { readyState: 1, send: () => {} };
}

test('terminal complete clears the approval marker and evicts its request map', (t) => {
  const statuses: string[] = [];
  const approvals: boolean[] = [];
  setTaskLinkage({
    onSessionStatus: (_sessionId, state) => {
      statuses.push(state);
    },
    onSessionApproval: (_sessionId, pending) => {
      approvals.push(pending);
    },
  });
  t.after(() => {
    setTaskLinkage(null);
    chatRunRegistry.clearAll();
  });

  const run = chatRunRegistry.startRun({
    appSessionId: 'app-1',
    provider: 'claude',
    providerSessionId: null,
    connection: makeConnection(),
    userId: null,
  });
  assert.ok(run);

  // Two pending tool-approvals surface as live "等你批准" markers.
  run.writer.send({ kind: 'permission_request', requestId: 'req-1', provider: 'claude', sessionId: 'app-1' });
  run.writer.send({ kind: 'permission_request', requestId: 'req-2', provider: 'claude', sessionId: 'app-1' });
  assert.ok(approvals.includes(true), 'permission_request should raise the approval marker');
  assert.equal(chatRunRegistry.takeApprovalRequestSession('req-1'), 'app-1');

  // The synthetic terminal complete (abort path / crash safety-net) never emits
  // permission_cancelled, so it must clear the marker itself and forget the map.
  chatRunRegistry.completeRun('app-1', { exitCode: 0 });
  assert.ok(statuses.includes('running') && statuses.includes('completed'));
  assert.equal(approvals.at(-1), false, 'terminal complete should drop the approval marker');
  assert.equal(
    chatRunRegistry.takeApprovalRequestSession('req-2'),
    null,
    'terminal complete should evict the requestId→session mapping',
  );
});

test('attachConnection fans out to every subscriber instead of stealing the stream', (t) => {
  const receivedA: string[] = [];
  const receivedB: string[] = [];
  const closeListeners = new Map<'A' | 'B', () => void>();
  const makeConnection = (label: 'A' | 'B') => ({
    readyState: 1,
    send: (data: string) => {
      if (label === 'A') receivedA.push(data);
      else receivedB.push(data);
    },
    on: (_event: string, listener: () => void) => {
      closeListeners.set(label, listener);
    },
  });
  const connA = makeConnection('A');
  const connB = makeConnection('B');

  t.after(() => chatRunRegistry.clearAll());

  const run = chatRunRegistry.startRun({
    appSessionId: 'app-3',
    provider: 'claude',
    providerSessionId: null,
    connection: connA,
    userId: null,
  });
  assert.ok(run);

  // A second tab subscribes while the run is live — must NOT steal the stream.
  assert.equal(chatRunRegistry.attachConnection('app-3', connB), true);

  run.writer.send({ kind: 'text', content: 'hello', provider: 'claude', sessionId: 'app-3' });
  assert.equal(receivedA.length, 1, 'first subscriber still receives the frame');
  assert.equal(receivedB.length, 1, 'second subscriber also receives the frame');
  assert.equal(receivedA[0], receivedB[0], 'both subscribers receive the identical frame');

  // Tab B closes (page refresh/close): it must stop receiving without
  // affecting tab A.
  const closeB = closeListeners.get('B');
  assert.ok(closeB, 'addConnection should register a close listener');
  closeB();

  run.writer.send({ kind: 'text', content: 'world', provider: 'claude', sessionId: 'app-3' });
  assert.equal(receivedA.length, 2, 'surviving subscriber keeps receiving after B closes');
  assert.equal(receivedB.length, 1, 'closed subscriber receives no further frames');

  // Re-attaching the same socket is idempotent — no duplicate delivery.
  chatRunRegistry.attachConnection('app-3', connA);
  run.writer.send({ kind: 'text', content: 'again', provider: 'claude', sessionId: 'app-3' });
  assert.equal(receivedA.length, 3, 'idempotent re-attach must not double-deliver');
});

test('completeRun is a no-op once a run already completed', (t) => {
  const approvals: boolean[] = [];
  setTaskLinkage({
    onSessionStatus: () => {},
    onSessionApproval: (_sessionId, pending) => {
      approvals.push(pending);
    },
  });
  t.after(() => {
    setTaskLinkage(null);
    chatRunRegistry.clearAll();
  });

  const run = chatRunRegistry.startRun({
    appSessionId: 'app-2',
    provider: 'codex',
    providerSessionId: null,
    connection: makeConnection(),
    userId: null,
  });
  assert.ok(run);

  chatRunRegistry.completeRun('app-2', { exitCode: 0 });
  // Second complete is dropped by the exactly-one-complete contract; the marker
  // should not be flipped again (it was already cleared to false on the first).
  chatRunRegistry.completeRun('app-2', { exitCode: 0 });
  assert.equal(approvals.at(-1), false);
});
