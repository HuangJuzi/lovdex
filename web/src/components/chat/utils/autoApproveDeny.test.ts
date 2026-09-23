import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_APPROVE_INTERACTION_TOOLS,
  classifyAutoApproveNotice,
  resolveToolResultVariant,
} from './autoApproveDeny';

test('both interaction tools are covered', () => {
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('AskUserQuestion'), true);
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('ExitPlanMode'), true);
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('Bash'), false);
});

test('a denied interaction tool classifies as interaction', () => {
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'deny'), 'interaction');
  assert.equal(classifyAutoApproveNotice('ExitPlanMode', 'deny'), 'interaction');
});

test('a denied ordinary tool classifies as blocked', () => {
  assert.equal(classifyAutoApproveNotice('Bash', 'deny'), 'blocked');
});

test('an allow has no classification', () => {
  assert.equal(classifyAutoApproveNotice('Bash', 'allow'), undefined);
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'allow'), undefined);
});

test('a missing tool name still classifies as blocked, never interaction', () => {
  assert.equal(classifyAutoApproveNotice(undefined, 'deny'), 'blocked');
});

test('the deny-kind literals are the exact wire values', () => {
  // 这条测试**冻结的是前端侧的字面量**：防止前端重构时把 `'blocked'` 写成别的。
  // 它**防不住跨进程漂移** —— 后端改 `AutoApproveDenyKind`（或加交互型工具名）时
  // 这条测试不会红，因为 web 与 backend 是两个独立的包，没有共享类型通道
  // （web 里没有 backend 的 tsconfig paths）。别把它当成跨进程契约的保证。
  //
  // 后端对应定义：backend/server/shared/types.ts 的 AutoApproveDenyKind。
  assert.deepEqual([...AUTO_APPROVE_INTERACTION_TOOLS].sort(), ['AskUserQuestion', 'ExitPlanMode']);
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'deny'), 'interaction');
  assert.equal(classifyAutoApproveNotice('Bash', 'deny'), 'blocked');
});

// --- 三分支判定（渲染接线的判据；渲染本身在 AutoApproveDenyNotice.test.tsx）---

test('a tagged result wins over isError', () => {
  // 核心语义：带标记的结果不是错误，即使 isError 为真。
  assert.equal(
    resolveToolResultVariant({ isError: true, autoApproveDeny: 'interaction' }),
    'auto-denied',
  );
  assert.equal(
    resolveToolResultVariant({ isError: true, autoApproveDeny: 'blocked' }),
    'auto-denied',
  );
});

test('an untagged error stays an error', () => {
  assert.equal(resolveToolResultVariant({ isError: true }), 'error');
});

test('a plain result is a result', () => {
  assert.equal(resolveToolResultVariant({}), 'result');
  assert.equal(resolveToolResultVariant(null), 'result');
  assert.equal(resolveToolResultVariant(undefined), 'result');
});
