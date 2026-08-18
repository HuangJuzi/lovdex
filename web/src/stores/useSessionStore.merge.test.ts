import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { computeMerged, pruneRealtimeSupersededByServer } from './useSessionStore';

function msg(partial: Partial<NormalizedMessage> & { id: string; sessionId?: string }): NormalizedMessage {
  return {
    sessionId: 's1',
    timestamp: new Date().toISOString(),
    provider: 'claude',
    kind: 'text',
    ...partial,
  };
}

/**
 * The same id in the realtime stream can only be a duplicate delivery (id-less
 * frames get a seq-derived id, stream rows are replaced not appended, and
 * server rows are merged separately). The merged view must not render it twice.
 * tool_use rows are used because the adjacent same-text collapse only guards
 * assistant text rows — an id-duplicate must be dropped on its own.
 */
test('computeMerged drops same-id rows delivered more than once', () => {
  const server = [msg({ id: 's-user', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' })];
  const realtime = [
    msg({
      id: 'tu-1',
      kind: 'tool_use',
      toolName: 'Bash',
      toolId: 'tu-1',
      toolInput: { command: 'ls' },
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    // The replay double-delivered the same tool_use row.
    msg({
      id: 'tu-1',
      kind: 'tool_use',
      toolName: 'Bash',
      toolId: 'tu-1',
      toolInput: { command: 'ls' },
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
  ];

  const merged = computeMerged(server, realtime);
  const ids = merged.map((m) => m.id);
  assert.equal(ids.filter((id) => id === 'tu-1').length, 1, 'realtime same-id rows must collapse to one');
});

/**
 * After `finalizeStreaming` a run's reply lives in realtime with a client-made
 * id while the server refresh soon owns the persisted copy. The optimistic
 * `local_*` user echo mirrors the server user row one-for-one; counting it as an
 * extra turn skewed the turn ordinal so the finalized assistant twin looked
 * "not echoed" and was kept, rendering the reply twice.
 */
test('pruneRealtimeSupersededByServer drops the finalized assistant twin when a local_ user echo is present', () => {
  const server = [
    msg({ id: 'u-1', role: 'user', kind: 'text', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }),
    msg({ id: 'a-1', role: 'assistant', kind: 'text', content: 'reply', timestamp: '2026-01-01T00:00:02.000Z' }),
  ];
  const realtime = [
    msg({ id: 'local_abc', role: 'user', kind: 'text', content: 'hi', timestamp: '2026-01-01T00:00:00.100Z' }),
    // The finalized live copy of the same reply with a client-made id.
    msg({ id: 'text_xyz', role: 'assistant', kind: 'text', content: 'reply', timestamp: '2026-01-01T00:00:02.100Z' }),
  ];

  const remaining = pruneRealtimeSupersededByServer(server, realtime);
  const remainingIds = remaining.map((m) => m.id);
  assert.ok(!remainingIds.includes('local_abc'), 'optimistic user echo is owned by the server copy');
  assert.ok(!remainingIds.includes('text_xyz'), 'finalized assistant twin is owned by the server copy');
});

/**
 * The turn-ordinal fix must not break the ordinary case: a finalized twin in a
 * later turn is still recognized and pruned with no local_ row present.
 */
test('pruneRealtimeSupersededByServer still prunes a later-turn finalized echo without local_ rows', () => {
  const server = [
    msg({ id: 'u-1', role: 'user', kind: 'text', content: 'q1', timestamp: '2026-01-01T00:00:00.000Z' }),
    msg({ id: 'a-1', role: 'assistant', kind: 'text', content: 'a1', timestamp: '2026-01-01T00:00:01.000Z' }),
    msg({ id: 'u-2', role: 'user', kind: 'text', content: 'q2', timestamp: '2026-01-01T00:00:03.000Z' }),
    msg({ id: 'a-2', role: 'assistant', kind: 'text', content: 'a2', timestamp: '2026-01-01T00:00:04.000Z' }),
  ];
  const realtime = [
    msg({ id: 'text_live', role: 'assistant', kind: 'text', content: 'a2', timestamp: '2026-01-01T00:00:04.100Z' }),
  ];

  const remaining = pruneRealtimeSupersededByServer(server, realtime);
  assert.ok(!remaining.some((m) => m.id === 'text_live'), 'later-turn finalized echo must be pruned');
});

/**
 * A finalized row whose text genuinely does NOT exist on the server (still
 * between stream_end and server persistence) is kept so the pane never flashes
 * empty — the merge twin-collapse must not be over-aggressive.
 */
test('pruneRealtimeSupersededByServer keeps a finalized row the server does not yet own', () => {
  const server = [
    msg({ id: 'u-1', role: 'user', kind: 'text', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }),
  ];
  const realtime = [
    msg({ id: 'text_live', role: 'assistant', kind: 'text', content: 'brand new reply', timestamp: '2026-01-01T00:00:01.000Z' }),
  ];

  const remaining = pruneRealtimeSupersededByServer(server, realtime);
  assert.ok(remaining.some((m) => m.id === 'text_live'), 'unpersisted live reply must survive pruning');
});