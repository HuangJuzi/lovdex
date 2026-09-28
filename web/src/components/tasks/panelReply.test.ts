import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { replyState } from './panelReply';

const task = (over: Partial<Task>): Task => ({
  task_id: 't1',
  title: '任务',
  description: '',
  status: 'in_progress',
  priority: 'P2',
  project_id: 'p1',
  session_id: 's1',
  ...over,
} as Task);

test('无 session_id：禁用，不能排队也不能发', () => {
  const s = replyState({ task: task({ session_id: null }), isProcessing: false, hasPendingPrompt: false });
  assert.equal(s.mode, 'no-session');
  assert.equal(s.canType, false);
  assert.equal(s.willQueue, false);
});

test('会话正在跑：可输入，但发送会排队', () => {
  const s = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: false });
  assert.equal(s.mode, 'queued');
  assert.equal(s.canType, true);
  assert.equal(s.willQueue, true);
});

test('跑着且有未答复的待办：仍可输入（待办是选择、回复是补充说明，两者不互斥）', () => {
  const s = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: true });
  assert.equal(s.mode, 'queued');
  assert.equal(s.canType, true);
});

test('空闲无待办：直接可发', () => {
  const s = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: false });
  assert.equal(s.mode, 'ready');
  assert.equal(s.canType, true);
  assert.equal(s.willQueue, false);
});

test('空闲但有待办：可发（回复会以 chat.send 走，与答复帧不冲突）', () => {
  const s = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: true });
  assert.equal(s.mode, 'ready');
  assert.equal(s.canType, true);
});

test('每种形态都给出非空提示文案', () => {
  const cases = [
    { task: task({ session_id: null }), isProcessing: false, hasPendingPrompt: false },
    { task: task({}), isProcessing: true, hasPendingPrompt: false },
    { task: task({}), isProcessing: false, hasPendingPrompt: false },
  ];
  for (const c of cases) {
    const s = replyState(c);
    assert.equal(typeof s.hint, 'string');
    assert.ok(s.hint.length > 0, `mode=${s.mode} 的 hint 不能为空`);
  }
});

// hasPendingPrompt 唯一可观察的出口就是 hint：不钉住两个分支的差异，
// 一个「忽略 hasPendingPrompt」的实现照样能全绿。
test('排队中：有/无待办给出不同文案，且在跑的文案要点出「回答」', () => {
  const withPrompt = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: true });
  const without = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: false });

  assert.notEqual(withPrompt.hint, without.hint);
  assert.match(withPrompt.hint, /回答/);
  assert.match(without.hint, /排队/);
});

test('空闲：有/无待办给出不同文案', () => {
  const withPrompt = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: true });
  const without = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: false });

  assert.notEqual(withPrompt.hint, without.hint);
});
