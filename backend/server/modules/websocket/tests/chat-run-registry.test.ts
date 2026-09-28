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

// ---------------------------------------------------------------------------
// When a "waiting for your approval" inbox item started. The task inbox shows
// that moment; persistent signals get it from tasks.updated_at, but the live
// approval state has no row — so it is remembered in memory here, added and
// dropped with the request lifecycle.
// ---------------------------------------------------------------------------

function startApprovalRun(appSessionId: string) {
  return chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: makeConnection(),
    userId: null,
  });
}

test('records the wait start on the first pending request', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-1');
  assert.ok(run);
  assert.equal(chatRunRegistry.getApprovalRequestedAt('app-ap-1'), null, 'no moment before the wait');

  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-1' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-1');
  assert.ok(startedAt, 'the first pending request should record a moment');
  assert.ok(!Number.isNaN(new Date(startedAt).getTime()), 'the moment should be a parseable time string');
});

test('a second pending request does not move the wait start', async (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-2');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-2' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-2');

  // Cross a millisecond tick, otherwise an overwrite is invisible in the ISO string.
  await new Promise((resolve) => setTimeout(resolve, 5));
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-2' });

  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-2'),
    startedAt,
    'still waiting, so the wait start must not move',
  );
});

test('a new wait segment after the queue empties gets a fresh start', async (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-3');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-3' });
  const firstStart = chatRunRegistry.getApprovalRequestedAt('app-ap-3');

  assert.equal(chatRunRegistry.takeApprovalRequestSession('req-a'), 'app-ap-3');
  assert.equal(chatRunRegistry.getApprovalRequestedAt('app-ap-3'), null, 'no longer waiting once the only pending request is decided');

  await new Promise((resolve) => setTimeout(resolve, 5));
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-3' });
  const secondStart = chatRunRegistry.getApprovalRequestedAt('app-ap-3');
  assert.ok(secondStart);
  assert.notEqual(secondStart, firstStart, 'the wait ended in between, so this is a new segment');
});

test('deciding one of several pending requests keeps the wait start', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-4');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-4' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-4');
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-4' });

  assert.equal(chatRunRegistry.takeApprovalRequestSession('req-a'), 'app-ap-4');
  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-4'),
    startedAt,
    'a second request is still pending, so the wait never ended',
  );
});

test('terminal complete drops the wait start', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-5');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-5' });
  assert.ok(chatRunRegistry.getApprovalRequestedAt('app-ap-5'));

  chatRunRegistry.completeRun('app-ap-5', { exitCode: 0, aborted: true });
  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-5'),
    null,
    'a run that ended can never have its request answered, so the wait state must go',
  );
});

test('getApprovalRequestedAt is null for an unknown session and after clearAll', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  assert.equal(chatRunRegistry.getApprovalRequestedAt('nobody'), null);
  const run = startApprovalRun('app-ap-6');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-6' });
  chatRunRegistry.clearAll();
  assert.equal(chatRunRegistry.getApprovalRequestedAt('app-ap-6'), null);
});

test('a cancelled request ends the wait segment', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-7');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-7' });
  assert.ok(chatRunRegistry.getApprovalRequestedAt('app-ap-7'));

  run.writer.send({ kind: 'permission_cancelled', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-7' });
  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-7'),
    null,
    'a cancelled request can never be answered, so the wait is over',
  );
});

test('cancelling one of two pending requests keeps the wait start', (t) => {
  t.after(() => chatRunRegistry.clearAll());
  const run = startApprovalRun('app-ap-8');
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-8' });
  const startedAt = chatRunRegistry.getApprovalRequestedAt('app-ap-8');
  run.writer.send({ kind: 'permission_request', requestId: 'req-b', provider: 'claude', sessionId: 'app-ap-8' });

  run.writer.send({ kind: 'permission_cancelled', requestId: 'req-a', provider: 'claude', sessionId: 'app-ap-8' });
  assert.equal(
    chatRunRegistry.getApprovalRequestedAt('app-ap-8'),
    startedAt,
    'req-b is still pending, so the wait never ended',
  );
});
