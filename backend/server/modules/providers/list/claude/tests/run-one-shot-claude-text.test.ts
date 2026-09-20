import assert from 'node:assert/strict';
import test from 'node:test';

import { runOneShotClaudeText } from '@/claude-sdk.js';

// runOneShotClaudeText 从 getOperatorConfig() 读 workspace（同时决定 cwd 与 mark
// 参数）。getOperatorConfig 的取值优先级：app_config 表存的 operator_config >
// LOVDEX_OPERATOR_WORKSPACE 环境变量 > import 期冻结的默认值。测试进程不落真实配置：
// DATABASE_PATH 指向空临时库（node:test 下 connection.ts 只认这条 env seam），
// app_config 表查不到 operator_config，env 覆盖即生效 —— 隔离手法同
// sessions-provider-mapping.test.ts。
process.env.DATABASE_PATH = `/tmp/one-shot-claude-text-${process.pid}.db`;
process.env.LOVDEX_OPERATOR_WORKSPACE = '/op-workspace';

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

test('runOneShotClaudeText marks the session as verdict with the operator workspace', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', session_id: 'shot-1', message: { content: [{ type: 'text', text: 'ok' }] } };
    yield { type: 'result', session_id: 'shot-1', result: 'ok' };
  };
  const marks: Array<[string, string]> = [];
  const text = await runOneShotClaudeText({
    prompt: 'p',
    systemPrompt: 's',
    queryFn,
    markVerdictSession: (sessionId: string, workspace: string) => marks.push([sessionId, workspace]),
  });
  assert.equal(text, 'ok');
  assert.deepEqual(marks, [['shot-1', '/op-workspace']]);
});

test('runOneShotClaudeText does not mark when the stream has no session_id', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'no id' }] } };
  };
  let called = false;
  const text = await runOneShotClaudeText({
    prompt: 'p',
    systemPrompt: 's',
    queryFn,
    markVerdictSession: () => { called = true; },
  });
  assert.equal(text, 'no id');
  assert.equal(called, false);
});

test('runOneShotClaudeText swallows marker failures', async () => {
  const queryFn = async function* () {
    yield { type: 'result', session_id: 'shot-2', result: '' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'still ok' }] } };
  };
  const text = await runOneShotClaudeText({
    prompt: 'p',
    systemPrompt: 's',
    queryFn,
    markVerdictSession: () => { throw new Error('db down'); },
  });
  assert.equal(text, 'still ok');
});
test('runOneShotClaudeText still marks when the stream fails after the session id', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', session_id: 'shot-3', message: { content: [{ type: 'text', text: 'partial' }] } };
    throw new Error('stream closed');
  };
  const marks: Array<[string, string]> = [];
  await assert.rejects(
    runOneShotClaudeText({
      prompt: 'p',
      systemPrompt: 's',
      queryFn,
      markVerdictSession: (sessionId: string, workspace: string) => marks.push([sessionId, workspace]),
    }),
    /stream closed/,
  );
  // 打标发生在流内首次见到 session_id 时：流中途挂掉，transcript 已落盘，照样要排除出侧栏。
  assert.deepEqual(marks, [['shot-3', '/op-workspace']]);
});
