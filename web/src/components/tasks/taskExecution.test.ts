import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { TASK_RETRY_MESSAGE, buildTaskChatSend, taskPromptOf } from './taskExecution';

// A minimal Task fixture — only fields buildTaskChatSend reads matter
// (executor_provider, executor_model, title, description).
const task = {
  task_id: 't1',
  project_path: '/p',
  title: '修登录',
  description: '把登录页 500 报错修好',
  status: 'in_progress',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: 's1',
  started_at: null,
  completed_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as Task;

test('taskPromptOf sends the description (the execution content) when present', () => {
  assert.equal(taskPromptOf({ title: '修登录', description: '把登录页 500 报错修好' }), '把登录页 500 报错修好');
});

test('taskPromptOf falls back to the title for older tasks with no description', () => {
  assert.equal(taskPromptOf({ title: '修登录', description: null }), '修登录');
  assert.equal(taskPromptOf({ title: '修登录', description: '' }), '修登录');
  assert.equal(taskPromptOf({ title: '修登录', description: '   ' }), '修登录');
});

test('taskPromptOf trims the description', () => {
  assert.equal(taskPromptOf({ title: 't', description: '  do the thing  ' }), 'do the thing');
});

test('taskPromptOf prefixes slash-leading prompts so the CLI does not treat them as commands', () => {
  const prompt = taskPromptOf({ title: '/help 里面没有弹出所有的命令和skill', description: null });
  assert.ok(!prompt.startsWith('/'));
  assert.ok(prompt.includes('/help 里面没有弹出所有的命令和skill'));
});

test('taskPromptOf leaves ordinary prompts untouched', () => {
  assert.equal(taskPromptOf({ title: 't', description: '修复空指针' }), '修复空指针');
});

test('buildTaskChatSend defaults content to the task prompt', () => {
  const frame = buildTaskChatSend('s1', task);
  assert.equal(frame.type, 'chat.send');
  assert.equal(frame.sessionId, 's1');
  assert.equal(frame.content, '把登录页 500 报错修好');
});

test('buildTaskChatSend opts into live stream_delta streaming', () => {
  const frame = buildTaskChatSend('s1', task);
  // Without this flag the backend never emits stream_delta frames, so a task run
  // shows no live progress in the chat view until it completes and the transcript
  // is re-fetched over REST — the "消息不会动" symptom.
  assert.equal(frame.options.includePartialMessages, true);
});

test('buildTaskChatSend sends TASK_RETRY_MESSAGE when provided as content', () => {
  const frame = buildTaskChatSend('s1', task, TASK_RETRY_MESSAGE);
  assert.equal(frame.sessionId, 's1');
  assert.equal(frame.content, '上次执行中断/出错了，请重试继续完成');
  assert.equal(frame.options.sessionSummary, task.title);
});

test('buildTaskChatSend passes through an arbitrary custom content', () => {
  const frame = buildTaskChatSend('s1', task, '继续完成');
  assert.equal(frame.content, '继续完成');
});

test('buildTaskChatSend reads qoder tools settings from the qoder-settings key', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    store.set('qoder-settings', JSON.stringify({ allowedTools: ['Read'], disallowedTools: [], skipPermissions: true }));
    store.set('claude-settings', JSON.stringify({ allowedTools: ['Write'], disallowedTools: [], skipPermissions: false }));
    const frame = buildTaskChatSend('s1', { ...task, executor_provider: 'qoder' });
    assert.deepEqual(frame.options.toolsSettings, { allowedTools: ['Read'], disallowedTools: [], skipPermissions: true });
    assert.equal(frame.options.skipPermissions, true);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
});

test('TASK_RETRY_MESSAGE is non-empty and mentions retrying', () => {
  assert.ok(TASK_RETRY_MESSAGE.length > 0);
  assert.match(TASK_RETRY_MESSAGE, /重试/);
});
