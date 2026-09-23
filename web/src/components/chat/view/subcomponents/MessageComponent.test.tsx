import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// 在组件调用 useTranslation 之前先把共享 i18n 实例（chat 命名空间）初始化好。
// 同目录的 ProviderSelectionEmptyState.test.tsx 是同一个先例。
import '../../../../i18n/config.js';

import type { ChatMessage } from '../../types/types';

import MessageComponent from './MessageComponent';

// 这里是**接线**测试：真渲染 MessageComponent，而不是只渲染叶组件、也不是
// 读源码断言结构。后两种都漏过这个功能的核心路径 ——
//   * 只渲染叶组件：把 MessageComponent 里的分支删掉，测试照样全绿。
//   * 读源码 + indexOf：多行书写会误红；把路由写反成 `!==` 却全绿。
// 真渲染在无 DOM 环境下完全可行（i18n 初始化后约 13ms、零报错），覆盖面还更大。

const THE_MODEL_FACING_INSTRUCTION =
  '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。';

const render = (over: Partial<ChatMessage>) =>
  renderToStaticMarkup(
    React.createElement(MessageComponent, {
      message: {
        id: 'm1',
        type: 'tool',
        timestamp: '2026-09-23T00:00:00Z',
        isToolUse: true,
        provider: 'claude',
        ...over,
      } as ChatMessage,
      prevMessage: null,
      createDiff: () => [],
      provider: 'claude',
    } as never),
  );

const toolMessage = (over: Partial<ChatMessage>): Partial<ChatMessage> => ({
  toolName: 'Bash',
  toolInput: { command: 'git push origin main' },
  toolId: 'tu_1',
  ...over,
});

test('a denied interaction renders the quiet line, not an error box', () => {
  const html = render(
    toolMessage({
      toolName: 'AskUserQuestion',
      toolResult: {
        content: THE_MODEL_FACING_INSTRUCTION,
        isError: true,
        autoApproveDeny: 'interaction',
      },
    }),
  );
  assert.ok(html.includes('无人可应答'), 'the quiet line must render');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  assert.ok(
    !html.includes('请基于现有信息自行判断'),
    'the model-facing instruction must not render',
  );
});

test('a denied non-Bash tool renders the amber box', () => {
  const html = render(
    toolMessage({
      toolName: 'Write',
      toolInput: { file_path: '/root/.ssh/id_rsa' },
      toolResult: {
        // 后端 FILE_PATH_TOOLS 分支的真实模板：`拒绝：${target} 属于凭证或关键配置路径`
        // （backend/server/modules/permissions/auto-approve-policy.ts:267）。
        content: '拒绝：/root/.ssh/id_rsa 属于凭证或关键配置路径',
        isError: true,
        autoApproveDeny: 'blocked',
      },
    }),
  );
  assert.ok(html.includes('已自动拒绝'));
  assert.ok(html.includes('属于凭证或关键配置路径'));
  assert.ok(html.includes('warning'), 'should use the warning palette');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
});

// 这条是本功能**多数场景**的路径：后端 COMMAND_RULES 里 7/9 条规则、真实
// transcript 里 109/173 次拒绝都是 Bash。改动前 `toolName !== 'Bash'` 把它们
// 全挡在门外，只剩 ToolRenderer 的红框 —— 用户看到的正是要消掉的那个红框。
test('a denied Bash command renders the amber box, not the red one', () => {
  const html = render(
    toolMessage({
      toolResult: {
        content: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
        isError: true,
        autoApproveDeny: 'blocked',
      },
    }),
  );
  assert.ok(html.includes('已自动拒绝'), 'the amber box must render for Bash too');
  assert.ok(html.includes('不允许在无人值守时推送远端'), 'the reason must be shown');
  assert.ok(html.includes('warning'), 'should use the warning palette');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
});

// 真·工具错误必须**原样**保持红框：这次改动不能把「故障」也漂白成策略决定。
//
// 两条用例各管一条路径，缺一不可：
//   * 这条走 Bash —— 它的红来自 `BashCommandDisplay`（`isError` 驱动），
//     **不经过** MessageComponent 的第三条路由分支。
//   * 下面那条用非 Bash 工具 —— 它才是 `: message.toolResult.isError ?` 那个
//     红框分支的唯一覆盖。只留 Bash 这条时，把该分支改成 `: false ? ` 会
//     让非 Bash 真错误渲染成空 div（错误正文整个消失）而测试全绿。
test('a genuine Bash error stays red (BashCommandDisplay path)', () => {
  const html = render(
    toolMessage({
      toolResult: { content: 'ENOENT: no such file or directory', isError: true },
    }),
  );
  assert.ok(html.includes('destructive'), 'a real error must stay destructive');
  assert.ok(!html.includes('已自动拒绝'));
});

test('a genuine non-Bash error keeps its red box AND its body', () => {
  const html = render(
    toolMessage({
      toolName: 'Read',
      toolInput: { file_path: '/nope.txt' },
      toolResult: { content: 'ENOENT: no such file or directory', isError: true },
    }),
  );
  // 红框的边框类：Bash 那条路径的 `destructive` 来自徽标/命令行，不是这里。
  assert.ok(html.includes('border-destructive/20'), 'the red box border must render');
  // 红框标题（`text-xs font-medium text-destructive`），与命令行的 Error 徽标区分开 ——
  // 单看 `>Error</span>` 是抓不住这个变异的，徽标也会吐那个片段。
  assert.ok(
    html.includes('text-xs font-medium text-destructive'),
    'the red box title must render',
  );
  // 错误正文本身：路由写坏时这里会渲染成空 div，正文消失。
  assert.ok(html.includes('ENOENT: no such file or directory'), 'the error body must render');
  assert.ok(!html.includes('已自动拒绝'));
});

// 原生拒绝（SDK 文案嗅探出的 'denied'）的 Bash：`deriveToolStatus` 认它
// 不是故障，所以命令行那一行走琥珀 Denied，不再染红。
// spec §7 原先写「应保持红框」，这条把现状钉死（spec 已同步修订）：
// denied ≠ malfunction，与徽标保持一致，否则同一行上徽标琥珀、边框通红。
test('a native (text-sniffed) Bash denial is amber, not red', () => {
  const html = render(
    toolMessage({
      toolResult: { content: 'Error: Permission request timed out', isError: true },
    }),
  );
  assert.ok(html.includes('Denied'), 'the badge must read Denied');
  assert.ok(html.includes('warning'), 'should use the warning palette');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  // 它不是自动审批的拒绝，不该长出自定义通知。
  assert.ok(!html.includes('已自动拒绝'));
});

test('a plain successful result renders neither box', () => {
  const html = render(
    toolMessage({
      toolName: 'Write',
      toolResult: { content: 'File written' },
    }),
  );
  assert.ok(!html.includes('destructive'));
  assert.ok(!html.includes('已自动拒绝'));
  assert.ok(!html.includes('无人可应答'));
});

test('the denied notice carries the jump-to-results anchor', () => {
  const html = render(
    toolMessage({
      toolResult: {
        content: '拒绝：不允许在无人值守时推送远端',
        isError: true,
        autoApproveDeny: 'blocked',
      },
    }),
  );
  assert.ok(html.includes('id="tool-result-tu_1"'), 'the anchor must be emitted');
});
