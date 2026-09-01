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

test('runOneShotClaudeText builds headless sdkOptions with closed tools + bypassPermissions', async () => {
  let captured: { options?: Record<string, unknown> } = {};
  const queryFn = async function* (args: { options: Record<string, unknown> }) {
    captured = { options: args.options };
    yield { type: 'result', result: '' };
  };
  await runOneShotClaudeText({ prompt: 'p', systemPrompt: '是系统提示', queryFn });
  const options = captured.options!;
  assert.ok(options, 'expected query to be called with options');
  assert.deepEqual(options.tools, [], 'built-in tools must be disabled (closed tool set)');
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.systemPrompt, '是系统提示');
  assert.ok(options.cwd, 'cwd from operator config must be set');
});

test('runOneShotClaudeText returns null for whitespace-only output', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '   \n  ' }] } };
  };
  const text = await runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn });
  assert.equal(text, null);
});

test('runOneShotClaudeText propagates a throwing generator as a rejection', async () => {
  const queryFn = async function* () {
    throw new Error('llm unavailable');
  };
  await assert.rejects(
    runOneShotClaudeText({ prompt: 'p', systemPrompt: 's', queryFn }),
    /llm unavailable/,
  );
});