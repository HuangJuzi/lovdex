import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentEvent, terminalCompleteEvent } from '../normalize.js';

test('normalizes an assistant message with text', () => {
  const evt = normalizeAgentEvent(
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    {},
  );
  assert.ok(evt.role === 'assistant');
  assert.ok(typeof evt.eventId === 'string');
  assert.ok(Array.isArray(evt.content));
  assert.equal(evt.type, 'assistant');
  assert.deepEqual(evt.content, [{ type: 'text', text: 'hi' }]);
});

test('assistant maps sessionId -> providerSessionId and lifts model', () => {
  const evt = normalizeAgentEvent(
    {
      type: 'assistant',
      sessionId: 'P1',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }] },
    },
    {},
  );
  assert.equal(evt.providerSessionId, 'P1');
  assert.equal(evt.model, 'claude-x');
});

test('assistant with no content defaults to empty array', () => {
  const evt = normalizeAgentEvent({ type: 'assistant', message: { role: 'assistant' } }, {});
  assert.deepEqual(evt.content, []);
});

test('complete event carries provider session id + done flag', () => {
  const evt = terminalCompleteEvent('SDK_SESSION_1', {});
  assert.equal(evt.type, 'complete');
  assert.equal(evt.providerSessionId, 'SDK_SESSION_1');
  assert.equal(evt.done, true);
  assert.ok(typeof evt.eventId === 'string');
});

test('result event normalizes to a complete event', () => {
  const evt = normalizeAgentEvent({ type: 'result', sessionId: 'P1' }, {});
  assert.equal(evt.type, 'complete');
  assert.equal(evt.providerSessionId, 'P1');
  assert.equal(evt.done, true);
});

test('tool_use preserves toolUseId/name/input and maps providerSessionId', () => {
  const evt = normalizeAgentEvent(
    { type: 'tool_use', toolUseId: 'tu-1', name: 'Bash', input: { command: 'ls' }, sessionId: 'P1' },
    {},
  );
  assert.equal(evt.type, 'tool_use');
  assert.ok(typeof evt.eventId === 'string');
  assert.equal(evt.providerSessionId, 'P1');
  assert.equal(evt.toolUseId, 'tu-1');
  assert.equal(evt.name, 'Bash');
  assert.deepEqual(evt.input, { command: 'ls' });
});

test('error event passes through error field', () => {
  const evt = normalizeAgentEvent({ type: 'error', error: 'boom' }, {});
  assert.equal(evt.type, 'error');
  assert.equal(evt.error, 'boom');
});

test('unknown event type passes through with type unchanged and gains eventId', () => {
  const evt = normalizeAgentEvent({ type: 'weird_thing', foo: 'bar' }, {});
  assert.equal(evt.type, 'weird_thing');
  assert.equal(evt.foo, 'bar');
  assert.ok(typeof evt.eventId === 'string');
});

test('extra fields are merged into the base envelope', () => {
  const evt = normalizeAgentEvent(
    { type: 'assistant', message: { role: 'assistant', content: [] } },
    { taskId: 'T7' },
  );
  assert.equal(evt.taskId, 'T7');
});
