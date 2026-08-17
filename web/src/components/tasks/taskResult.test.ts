import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLastAssistantText } from './taskResult';

test('returns null for an empty message list', () => {
  assert.equal(pickLastAssistantText([]), null);
});

test('returns the content of the last assistant text message', () => {
  const messages = [
    { kind: 'text', role: 'user', content: 'do the thing' },
    { kind: 'text', role: 'assistant', content: 'done' },
  ];
  assert.equal(pickLastAssistantText(messages), 'done');
});

test('picks the LAST assistant text when several exist', () => {
  const messages = [
    { kind: 'text', role: 'assistant', content: 'first attempt' },
    { kind: 'text', role: 'assistant', content: 'final conclusion' },
  ];
  assert.equal(pickLastAssistantText(messages), 'final conclusion');
});

test('skips user text messages', () => {
  const messages = [{ kind: 'text', role: 'user', content: 'only user' }];
  assert.equal(pickLastAssistantText(messages), null);
});

test('skips non-text kinds (tool_use, thinking, etc.)', () => {
  const messages = [
    { kind: 'tool_use', role: 'assistant', content: 'ran a tool' },
    { kind: 'thinking', role: 'assistant', content: 'pondering' },
  ];
  assert.equal(pickLastAssistantText(messages), null);
});

test('skips assistant text with empty or whitespace-only content', () => {
  const messages = [
    { kind: 'text', role: 'assistant', content: '   ' },
    { kind: 'text', role: 'assistant', content: '' },
  ];
  assert.equal(pickLastAssistantText(messages), null);
});

test('trims surrounding whitespace from the returned content', () => {
  const messages = [{ kind: 'text', role: 'assistant', content: '  hello  ' }];
  assert.equal(pickLastAssistantText(messages), 'hello');
});

test('returns null when the only assistant text is blank but a later non-text exists', () => {
  const messages = [
    { kind: 'text', role: 'assistant', content: '' },
    { kind: 'tool_result', role: 'assistant', content: 'tool output' },
  ];
  assert.equal(pickLastAssistantText(messages), null);
});
