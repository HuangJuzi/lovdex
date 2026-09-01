import assert from 'node:assert/strict';
import test from 'node:test';

import { runOneShotClaudeText } from '@/claude-sdk.js';

const FAKE_RESULT = [
  { type: 'assistant', message: { content: [{ type: 'text', text: '摘要内容' }] } },
  { type: 'result', result: '' },
];

test('runOneShotClaudeText returns concat assistant text', async () => {
  const queryFn = async function* () {
    yield* FAKE_RESULT;
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, '摘要内容');
});

test('runOneShotClaudeText ignores non-assistant messages', async () => {
  const queryFn = async function* () {
    yield { type: 'result', result: '' };
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, null);
});

test('runOneShotClaudeText joins multiple text blocks', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } };
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, 'a\nb');
});