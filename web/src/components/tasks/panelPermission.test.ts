import test from 'node:test';
import assert from 'node:assert/strict';

import type { PendingPermissionRequest } from '../chat/types/types';

import {
  NEVER_TIMES_OUT,
  isInteractiveTool,
  sortPendingRequests,
  timeoutAt,
  remainingSeconds,
  formatCountdown,
} from './panelPermission';

const req = (
  requestId: string,
  toolName: string,
  receivedAtMs: number,
): PendingPermissionRequest => ({
  requestId,
  toolName,
  receivedAt: new Date(receivedAtMs),
});

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

test('交互类工具永不超时', () => {
  assert.equal(isInteractiveTool('AskUserQuestion'), true);
  assert.equal(isInteractiveTool('ExitPlanMode'), true);
  // 'exit_plan_mode' 匹配不到任何真实工具（SDK 里叫 ExitPlanMode），后端照样给它
  // 正常超时 —— 当成交互类会承诺一个不会发生的无限等待。
  assert.equal(isInteractiveTool('exit_plan_mode'), false);
  assert.equal(isInteractiveTool('Bash'), false);
});

test('timeoutAt：交互类返回 NEVER_TIMES_OUT，普通工具是 receivedAt + 超时', () => {
  const ask = req('a', 'AskUserQuestion', NOW);
  const bash = req('b', 'Bash', NOW);

  assert.equal(timeoutAt(ask, TIMEOUT), NEVER_TIMES_OUT);
  assert.equal(timeoutAt(bash, TIMEOUT), NOW + TIMEOUT);
});

test('没有 receivedAt 时视为永不超时（宁可让它排在后面，也不要误报倒计时）', () => {
  const noStamp: PendingPermissionRequest = { requestId: 'c', toolName: 'Bash' };
  assert.equal(timeoutAt(noStamp, TIMEOUT), NEVER_TIMES_OUT);
});

test('无效日期（Invalid Date）也归为永不超时', () => {
  const bad: PendingPermissionRequest = {
    requestId: 'd',
    toolName: 'Bash',
    receivedAt: new Date(NaN),
  };
  assert.equal(timeoutAt(bad, TIMEOUT), NEVER_TIMES_OUT);
});

test('排序：会超时的排前面，且按超时时刻升序', () => {
  const list = [
    req('never', 'AskUserQuestion', NOW),
    req('late', 'Bash', NOW - 10_000),
    req('soon', 'Bash', NOW - 50_000),
  ];

  const sorted = sortPendingRequests(list, TIMEOUT);
  assert.deepEqual(sorted.map((r) => r.requestId), ['soon', 'late', 'never']);
});

test('排序是纯函数：不改动入参数组', () => {
  const list = [req('never', 'AskUserQuestion', NOW), req('soon', 'Bash', NOW)];
  const before = list.map((r) => r.requestId);
  sortPendingRequests(list, TIMEOUT);
  assert.deepEqual(list.map((r) => r.requestId), before);
});

test('两个永不超时的请求保持输入顺序（Infinity - Infinity 的比较结果按规范视为相等）', () => {
  const list = [req('first', 'AskUserQuestion', NOW), req('second', 'ExitPlanMode', NOW)];
  assert.deepEqual(sortPendingRequests(list, TIMEOUT).map((r) => r.requestId), ['first', 'second']);
});

test('remainingSeconds：向上取整，已过期夹到 0', () => {
  const bash = req('b', 'Bash', NOW);
  assert.equal(remainingSeconds(bash, NOW, TIMEOUT), 60);
  assert.equal(remainingSeconds(bash, NOW + 1_500, TIMEOUT), 59);
  assert.equal(remainingSeconds(bash, NOW + 120_000, TIMEOUT), 0);
});

test('remainingSeconds：永不超时返回 null', () => {
  const ask = req('a', 'AskUserQuestion', NOW);
  assert.equal(remainingSeconds(ask, NOW, TIMEOUT), null);
});

test('formatCountdown：25 秒以上保留「N 秒后自动拒绝」，不足 25 秒改紧迫文案', () => {
  assert.equal(formatCountdown(60), '60 秒后自动拒绝');
  assert.equal(formatCountdown(25), '25 秒后自动拒绝');
  assert.equal(formatCountdown(24), '即将自动拒绝（24 秒）');
  assert.equal(formatCountdown(0), '即将自动拒绝（0 秒）');
});
