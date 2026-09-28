import test from 'node:test';
import assert from 'node:assert/strict';

import type { PendingPermissionRequest } from '../chat/types/types';

import { pendingQueueView, summarizePendingRequest } from './pendingPromptQueue';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const ask = (id: string, question = `问题 ${id}`): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'AskUserQuestion',
  receivedAt: new Date(NOW),
  input: { questions: [{ question, options: [{ label: '好' }] }] },
});

/** 已过去 `agoMs` 的普通工具 —— 剩余时间就是 `TIMEOUT - agoMs`。 */
const bash = (id: string, agoMs: number): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'Bash',
  receivedAt: new Date(NOW - agoMs),
  input: { command: `echo ${id}` },
});

const view = (requests: PendingPermissionRequest[]) => pendingQueueView(requests, TIMEOUT);

test('零条待办：current 为 null，且不显示队列条', () => {
  const result = view([]);
  assert.equal(result.current, null);
  assert.equal(result.showQueue, false);
});

test('单条待办：不显示队列条（队里只有一条不是队）', () => {
  const result = view([ask('a1')]);
  assert.equal(result.current?.requestId, 'a1');
  assert.equal(result.showQueue, false);
});

test('两条待办：显示队列条', () => {
  assert.equal(view([ask('a1'), ask('a2')]).showQueue, true);
});

// 这一条钉的是**当前项的推导方式**：它是排序后的队头，不是入参数组的第一项，
// 也不是最后一项。曾经的计划稿用「入参下标 + clamp effect」来推当前项，下标
// 恒为 0（没有任何交互能推动它），那套状态机是死的；队头推导既等价又不需要
// 任何状态，队列前移也就不用额外代码。
test('current 是队头（会超时的排最前），不是数组第一项、也不是最后一项', () => {
  const result = view([ask('a1'), bash('b1', 50_000)]);
  assert.equal(result.sorted[0].requestId, 'b1');
  assert.equal(result.sorted[1].requestId, 'a1');
  assert.equal(result.current?.requestId, 'b1');
});

// 「答完一条自动前移」不需要任何本地状态：父级是唯一真源，它把答掉的那条从
// 数组里摘掉之后，队头自然换了人。这里模拟的就是父级摘完之后的入参。
test('父级摘掉已答的那条后，队头前移；只剩一条时队列条随之消失', () => {
  const before = view([ask('a1'), bash('b1', 50_000)]);
  assert.equal(before.current?.requestId, 'b1');

  const after = view([ask('a1')]);
  assert.equal(after.current?.requestId, 'a1');
  assert.equal(after.showQueue, false);
});

test('摘要：AskUserQuestion 用第一道题面', () => {
  assert.equal(summarizePendingRequest(ask('a1', 'AppContent 的订阅怎么处理？')), '回答「AppContent 的订阅怎么处理？」');
});

// 输入形状不可信时给一句兜底，别把 undefined / 空串拼进界面。
test('摘要：AskUserQuestion 的 input 形状不对时兜底，不抛也不拼 undefined', () => {
  const malformed: PendingPermissionRequest[] = [
    { ...ask('a1'), input: undefined },
    { ...ask('a2'), input: {} },
    { ...ask('a3'), input: { questions: [] } },
    { ...ask('a4'), input: { questions: [{ options: [] }] } },
    { ...ask('a5'), input: { questions: 'not-an-array' } },
    { ...ask('a6'), input: { questions: [{}] } },
  ];
  for (const request of malformed) {
    assert.equal(summarizePendingRequest(request), '回答一个问题');
  }
});

test('摘要：计划工具的两个拼写都给同一句话', () => {
  const plan = { requestId: 'p1', toolName: 'ExitPlanMode', receivedAt: new Date(NOW), input: { plan: '1. 收紧 store 订阅' } };
  const snake = { ...plan, requestId: 'p2', toolName: 'exit_plan_mode' };
  assert.equal(summarizePendingRequest(plan), '确认它写的计划');
  assert.equal(summarizePendingRequest(snake), '确认它写的计划');
});

test('摘要：普通工具带上工具名', () => {
  assert.equal(summarizePendingRequest(bash('b1', 0)), '允许 Bash 执行');
});
