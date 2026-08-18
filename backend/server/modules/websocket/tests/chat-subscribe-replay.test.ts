import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';

import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatSubscribe } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * A `chat.subscribe` handler's replay must never re-send a buffered event that
 * the same socket already received. The client sends its highest seen `seq` as
 * `lastSeq`, and two back-to-back subscribes sent from the same tick (React
 * StrictMode double-mount, reconnect flush racing the session-open subscribe)
 * carry the same `lastSeq` — the second subscribe used to replay the exact same
 * seq range a second time, duplicating every message in the client store.
 */
function makeSocket() {
  const frames: Array<{ kind: string; seq?: number }> = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      frames.push(JSON.parse(data) as { kind: string; seq?: number });
    },
  };
  return { socket: socket as unknown as WebSocket, frames };
}

const DEPS = {
  spawnFns: {} as never,
  abortFns: {} as never,
  resolveToolApproval: () => {},
  getPendingApprovalsForSession: () => [],
};

test('duplicate chat.subscribe requests do not replay the same buffered events twice', (t) => {
  const sessionId = 'app-replay-dup';
  const sender = makeSocket();
  t.after(() => chatRunRegistry.clearAll());

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: sender.socket,
    userId: null,
  });
  assert.ok(run);

  // Buffer three events (seq 1..3) while the run is still live.
  run.writer.send({ kind: 'text', role: 'assistant', content: 'one', provider: 'claude', sessionId });
  run.writer.send({ kind: 'tool_use', toolName: 'Bash', toolId: 'tu-1', provider: 'claude', sessionId });
  run.writer.send({ kind: 'text', role: 'assistant', content: 'three', provider: 'claude', sessionId });

  // A NEW socket (page reload) subscribes twice from the same tick — the exact
  // shape that used to double-deliver the whole buffer.
  const viewer = makeSocket();
  handleChatSubscribe(viewer.socket, { sessions: [{ sessionId, lastSeq: 0 }] }, DEPS);
  handleChatSubscribe(viewer.socket, { sessions: [{ sessionId, lastSeq: 0 }] }, DEPS);

  const replayed = viewer.frames.filter((f) => typeof f.seq === 'number');
  assert.ok(replayed.length >= 3, `expected at least the 3 buffered events, got ${replayed.length}`);

  const seen = new Map<number, number>();
  for (const frame of replayed) {
    seen.set(frame.seq as number, (seen.get(frame.seq as number) ?? 0) + 1);
  }
  for (const [, count] of seen) {
    assert.equal(count, 1, `seq appeared ${count} times across the two subscribes`);
  }
});

test('a socket that missed mid-run events still receives them on subscribe', (t) => {
  const sessionId = 'app-replay-lag';
  const sender = makeSocket();
  t.after(() => chatRunRegistry.clearAll());

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: sender.socket,
    userId: null,
  });
  assert.ok(run);
  for (let i = 1; i <= 5; i += 1) {
    run.writer.send({ kind: 'text', role: 'assistant', content: `reply-${i}`, provider: 'claude', sessionId });
  }

  // A fresh socket with lastSeq=1 joins mid-run: it needs seq 2..5 backfilled,
  // and the watermark must not swallow them just because a prior subscribe on
  // another socket recorded a different run.
  const viewer = makeSocket();
  handleChatSubscribe(viewer.socket, { sessions: [{ sessionId, lastSeq: 1 }] }, DEPS);
  handleChatSubscribe(viewer.socket, { sessions: [{ sessionId, lastSeq: 1 }] }, DEPS);

  const replayedSeqs = viewer.frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq as number);
  const expected = [2, 3, 4, 5];
  for (const seq of expected) {
    assert.ok(replayedSeqs.includes(seq), `seq ${seq} should have been replayed exactly once`);
    assert.equal(replayedSeqs.filter((s) => s === seq).length, 1, `seq ${seq} replayed more than once`);
  }
});