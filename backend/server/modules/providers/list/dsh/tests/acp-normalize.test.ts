import assert from 'node:assert/strict';
import test from 'node:test';

import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';

const sessions = new DshSessionsProvider();

test('agent_message_chunk text maps to an assistant text message', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'hello');
  assert.equal(out[0].provider, 'dsh');
});

test('agent_thought_chunk maps to a thinking message', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'pondering' },
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'thinking');
  assert.equal(out[0].content, 'pondering');
});

test('tool_call maps to a tool_use message carrying name and input', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'read_file',
      rawInput: { path: '/tmp/x' },
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_use');
  assert.equal(out[0].toolName, 'read_file');
  assert.deepEqual(out[0].toolInput, { path: '/tmp/x' });
  assert.equal(out[0].toolId, 'tc-1');
});

test('tool_call_update with completed status maps to a tool_result without fabricating content', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: 'done',
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].toolId, 'tc-1');
  assert.equal(out[0].content, 'done');
  assert.equal(out[0].isError, false);
});

test('a terminal tool_call_update with no rawOutput does not fabricate "" content', () => {
  const raw = {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'failed' },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].isError, true);
  assert.notEqual(out[0].content, '""');
});

test('a non-terminal tool_call_update status yields no message', () => {
  const raw = {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'in_progress' },
  };
  assert.deepEqual(sessions.normalizeMessage(raw, 'app-1'), []);
});

test('unknown update shapes return an empty array, never throw', () => {
  assert.deepEqual(sessions.normalizeMessage({ update: { sessionUpdate: 'mode_update' } }, 'a'), []);
  assert.deepEqual(sessions.normalizeMessage(null, 'a'), []);
  assert.deepEqual(sessions.normalizeMessage({}, 'a'), []);
});
