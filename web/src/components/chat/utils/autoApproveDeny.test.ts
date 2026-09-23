import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_APPROVE_INTERACTION_TOOLS,
  classifyAutoApproveNotice,
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
  // web 与 backend 是两个独立的包，没有共享类型通道（web 里没有 backend 的
  // tsconfig paths），所以这份联合是**结构性**的跨进程重复，无法消除。
  // 后端从拒绝理由反推、前端按字段换渲染，两边字面量一旦漂移，UI 会静默走错
  // 分支而所有测试照样绿。照抄仓库既有先例钉死它 —— 见
  // backend/server/modules/permissions/tests/auto-approve-policy.test.ts 的
  // `the mode constant is the exact wire value`。
  //
  // 后端对应定义：backend/server/shared/types.ts 的 AutoApproveDenyKind。
  assert.deepEqual([...AUTO_APPROVE_INTERACTION_TOOLS].sort(), ['AskUserQuestion', 'ExitPlanMode']);
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'deny'), 'interaction');
  assert.equal(classifyAutoApproveNotice('Bash', 'deny'), 'blocked');
});
