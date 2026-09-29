import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { PendingPermissionRequest } from '../chat/types/types';

import { PendingPromptCard } from './PendingPromptCard';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const render = (
  request: PendingPermissionRequest,
  nowMs = NOW,
): string =>
  renderToStaticMarkup(
    <PendingPromptCard
      request={request}
      nowMs={nowMs}
      timeoutMs={TIMEOUT}
      onRespond={() => {}}
    />,
  );

test('AskUserQuestion：渲染每个选项的 label 与 description，且标注不会超时', () => {
  const html = render({
    requestId: 'r1',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [{
        question: 'AppContent 的订阅怎么处理？',
        header: '订阅',
        options: [
          { label: '全部收敛进 store', description: '订阅集中一处' },
          { label: '只收敛弹窗那条', description: '改动最小' },
        ],
      }],
    },
  });

  assert.match(html, /AppContent 的订阅怎么处理/);
  assert.match(html, /全部收敛进 store/);
  assert.match(html, /订阅集中一处/);
  assert.match(html, /只收敛弹窗那条/);
  assert.match(html, /不会超时/);
  assert.doesNotMatch(html, /自动拒绝/);
});

test('ExitPlanMode：渲染计划内容与两个动作，标注不会超时', () => {
  const html = render({
    requestId: 'r2',
    toolName: 'ExitPlanMode',
    receivedAt: new Date(NOW),
    input: { plan: '1. 收紧 store 订阅\n2. 角标等级派生' },
  });

  assert.match(html, /1\. 收紧 store 订阅/);
  assert.match(html, /角标等级派生/);
  assert.match(html, /不会超时/);
});

test('普通工具：渲染工具名与命令原文，并给出倒计时', () => {
  const html = render({
    requestId: 'r3',
    toolName: 'Bash',
    receivedAt: new Date(NOW),
    input: { command: 'git commit -m "fix(csv)"' },
  });

  assert.match(html, /Bash/);
  assert.match(html, /git commit/);
  assert.match(html, /60 秒后自动拒绝/);
});

test('普通工具剩余不足 25 秒：换紧迫文案', () => {
  const html = render(
    { requestId: 'r4', toolName: 'Bash', receivedAt: new Date(NOW), input: { command: 'ls' } },
    NOW + 40_000,
  );
  assert.match(html, /即将自动拒绝（20 秒）/);
});

test('缺少 receivedAt 的普通工具：退回「不会超时」而不是编倒计时', () => {
  const html = render({ requestId: 'r5', toolName: 'Bash', input: { command: 'ls' } });
  assert.match(html, /不会超时/);
});

test('「总是允许」旁标注仅本次会话有效', () => {
  const html = render({
    requestId: 'r6',
    toolName: 'Bash',
    receivedAt: new Date(NOW),
    input: { command: 'ls' },
  });
  assert.match(html, /仅本次会话有效/);
});

test('未知工具名不崩，退化为通用授权卡', () => {
  const html = render({
    requestId: 'r7',
    toolName: 'UnknownTool',
    receivedAt: new Date(NOW),
    input: {},
  });
  assert.ok(html.length > 0);
  assert.match(html, /UnknownTool/);
});

// 多选与单选的判据都是**静态**标记，不靠点击：多选每题有一个显式「提交选择」
// 确认按钮与方框选择符，单选没有（它点一下就走）。点了之后发出去的确是
// 「, 」连接的串 —— 那部分在 pendingPromptAnswers.test.ts 里测，因为
// 这里没有 DOM 可以模拟点击。
test('multiSelect: true 渲染方框选择符与「提交选择」确认按钮', () => {
  const html = render({
    requestId: 'r8',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [{
        question: '哪些地方要一起改？',
        header: '范围',
        multiSelect: true,
        options: [
          { label: '弹窗', description: 'AppContent' },
          { label: '工具栏', description: '加一个开关' },
        ],
      }],
    },
  });

  assert.match(html, /哪些地方要一起改/);
  assert.match(html, /可多选/);
  assert.match(html, /提交选择/);
  // 方框（未选中态）而不是单选的实心点：用户得能一眼看出这里可以选好几个。
  assert.match(html, /☐/);
  assert.doesNotMatch(html, /●/);
  // 确认按钮在，且因为一项都没选而禁用 —— 选中态才解锁。
  assert.match(html, /disabled=""/);
  // 「可多选」与计数里的「点一下取消」都重复出现，所以计数断言放共存用例里做。
});

test('单选问题不渲染确认按钮（保持一击即发）', () => {
  const html = render({
    requestId: 'r9',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [{
        question: '哪个方案？',
        options: [{ label: '甲' }, { label: '乙' }],
      }],
    },
  });

  assert.match(html, /哪个方案/);
  assert.doesNotMatch(html, /提交选择/);
  assert.doesNotMatch(html, /☐/);
});

test('同一张卡里单选与多选共存：只有多选那题带确认按钮，且只出现一次', () => {
  const html = render({
    requestId: 'r10',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [
        { question: '第一题（单选）', options: [{ label: '甲' }] },
        { question: '第二题（多选）', multiSelect: true, options: [{ label: '乙' }] },
      ],
    },
  });

  assert.match(html, /第一题（单选）/);
  assert.match(html, /第二题（多选）/);
  // 确认按钮与「可多选」提示都只属于多选那一题；单选那题仍是实心点。
  assert.equal(html.match(/提交选择/g)?.length, 1);
  assert.equal(html.match(/可多选/g)?.length, 1);
  assert.match(html, /●/);
  assert.match(html, /☐/);
});

