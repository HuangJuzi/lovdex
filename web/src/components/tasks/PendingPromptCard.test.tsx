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
