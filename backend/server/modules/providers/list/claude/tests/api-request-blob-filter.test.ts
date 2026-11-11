import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Newer Claude Code CLI builds write a request-payload MIRROR record into the
 * transcript alongside the real incremental turns:
 *   { type: 'api-request-blob', sessionId, hash, message: { role, content } }
 * It re-states the entire request sent to the model — the user text, every
 * system-reminder, and the whole step's assistant content blocks / tool_results
 * — and crucially carries NO `uuid`.
 *
 * `normalizeMessage` dispatches purely on `message.role`, so without a type
 * guard it emits these blobs as if they were real messages. Because they have
 * no uuid, `baseId` falls back to a fresh random id on every read, so they can
 * never be deduped against the genuine records. The visible symptom: the user's
 * own message (and the turn's tool calls) render a second time — reported as
 * "my message keeps appearing twice".
 *
 * Every `api-request-blob` must be dropped outright.
 */
const provider = new ClaudeSessionsProvider();
const SID = 'sess-blob';

test('api-request-blob mirroring a user turn is dropped', () => {
  const raw = {
    type: 'api-request-blob',
    sessionId: SID,
    hash: 'abc123',
    message: {
 role: 'user',
      content: [
   { type: 'text', text: '<system-reminder>\nCodebase ...\n</system-reminder>' },
 { type: 'text', text: '当前skill里面是否有一个根据手机号和有线获取用户Sophnet UID的skill？' },
      ],
    },
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('api-request-blob mirroring an assistant turn (thinking + tool_use) is dropped', () => {
  const raw = {
    type: 'api-request-blob',
    sessionId: SID,
    hash: 'def456',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me look' },
        { type: 'tool_use', name: 'Bash', id: 'toolu_1', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Bash', id: 'toolu_2', input: { command: 'pwd' } },
   ],
  },
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('api-request-blob mirroring tool_results is dropped', () => {
  const raw = {
    type: 'api-request-blob',
    sessionId: SID,
    hash: 'ghi789',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
   { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' },
   ],
  },
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('a genuine assistant turn with the same shape is NOT dropped', () => {
  const raw = {
    type: 'assistant',
    uuid: 'real-uuid-1',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Bash', id: 'toolu_1', input: { command: 'ls' } },
      ],
    },
    session_id: SID,
    timestamp: '2026-11-11T06:56:34.806Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_use');
  assert.equal(out[0].toolId, 'toolu_1');
});

test('a genuine user message is NOT dropped', () => {
  const raw = {
type: 'user',
    uuid: 'real-uuid-2',
    message: { role: 'user', content: '帮我修一下这个 bug' },
    session_id: SID,
    timestamp: '2026-11-11T06:56:31.278Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, '帮我修一下这个 bug');
});
