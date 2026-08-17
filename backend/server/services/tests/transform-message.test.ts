import assert from 'node:assert/strict';
import test from 'node:test';

// transformMessage is internal to claude-sdk.js (not exported). This test guards
// the observable contract: a tool_progress-shaped SDK payload must survive the
// transform layer and reach normalizeMessage, which emits one tool_progress
// message. If a future refactor adds an early return that drops tool_progress,
// this test fails even though transformMessage itself has no direct unit tests.
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();

test('tool_progress survives the transform layer (smoke)', () => {
  const raw = {
    type: 'tool_progress',
    tool_use_id: 'TU_leaf',
    tool_name: 'Read',
    parent_tool_use_id: 'TU_agent',
    task_id: 'T1',
    elapsed_time_seconds: 0.2,
    uuid: 'u-tp',
    session_id: 's',
    timestamp: '2026-08-05T00:00:00.000Z',
  };
  // transformMessage is identity for non-stream non-parent_tool_use_id payloads,
  // so normalizeMessage should see exactly the raw shape and emit one tool_progress.
  const out = provider.normalizeMessage(raw, 's');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_progress');
  assert.equal(out[0].toolName, 'Read');
});
