import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentEvent, terminalCompleteEvent } from '../normalize.js';

test('assistant event passes through verbatim and gains eventId', () => {
  const input = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    session_id: 'P1',
  };
  const evt = normalizeAgentEvent(input, {});
  assert.equal(evt.type, 'assistant');
  assert.deepEqual(evt.message, input.message);
  assert.equal(evt.session_id, 'P1');
  assert.ok(typeof evt.eventId === 'string');
});

test('tool_use passes through toolUseId/name/input and parent_tool_use_id', () => {
  const input = {
    type: 'tool_use',
    toolUseId: 'tu-1',
    name: 'Bash',
    input: { command: 'ls' },
    parent_tool_use_id: null,
    session_id: 'P1',
  };
  const evt = normalizeAgentEvent(input, {});
  assert.equal(evt.type, 'tool_use');
  assert.equal(evt.toolUseId, 'tu-1');
  assert.equal(evt.name, 'Bash');
  assert.deepEqual(evt.input, { command: 'ls' });
  assert.equal(evt.parent_tool_use_id, null);
  assert.equal(evt.session_id, 'P1');
  assert.ok(typeof evt.eventId === 'string');
});

test('error event passes through error field', () => {
  const evt = normalizeAgentEvent({ type: 'error', error: 'boom' }, {});
  assert.equal(evt.type, 'error');
  assert.equal(evt.error, 'boom');
});

test('unknown event type passes through with type unchanged and gains eventId', () => {
  const evt = normalizeAgentEvent({ type: 'weird_thing', foo: 'bar', session_id: 'P1' }, {});
  assert.equal(evt.type, 'weird_thing');
  assert.equal(evt.foo, 'bar');
  assert.equal(evt.session_id, 'P1');
  assert.ok(typeof evt.eventId === 'string');
});

test('complete event carries provider session id + done flag', () => {
  const evt = terminalCompleteEvent('S1');
  assert.equal(evt.type, 'complete');
  assert.equal(evt.providerSessionId, 'S1');
  assert.equal(evt.done, true);
  assert.ok(typeof evt.eventId === 'string');
});

test('extra fields merge over the sdk event', () => {
  const evt = normalizeAgentEvent(
    { type: 'assistant', session_id: 'P1', message: { role: 'assistant', content: [] } },
    { taskId: 'T7', session_id: 'RENAMED' },
  );
  assert.equal(evt.taskId, 'T7');
  assert.equal(evt.session_id, 'RENAMED');
  assert.ok(typeof evt.eventId === 'string');
});

test('extra fields merge into terminal complete event', () => {
  const evt = terminalCompleteEvent('S1', { exitCode: 0, provider: 'claude' });
  assert.equal(evt.providerSessionId, 'S1');
  assert.equal(evt.exitCode, 0);
  assert.equal(evt.provider, 'claude');
  assert.equal(evt.type, 'complete');
});