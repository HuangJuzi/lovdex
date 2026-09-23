import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveDenyNotice, resolveToolResultVariant } from './AutoApproveDenyNotice';

// --- 接线：三分支判定 ---

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

// --- 叶子：两个变体的渲染 ---

test('the interaction variant is a quiet info line, never an error', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, {
      kind: 'interaction',
      toolName: 'AskUserQuestion',
      reason: '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。',
    }),
  );
  assert.ok(html.includes('AskUserQuestion'));
  assert.ok(html.includes('无人可应答'));
  assert.ok(!html.includes('Error'), 'must not be labelled Error');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  assert.ok(!html.includes('请基于现有信息自行判断'), 'the model-facing instruction must not render');
});

test('the blocked variant keeps a box but is not an Error', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, {
      kind: 'blocked',
      toolName: 'Bash',
      reason: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
    }),
  );
  assert.ok(html.includes('已自动拒绝'));
  assert.ok(html.includes('不允许在无人值守时推送远端'));
  assert.ok(!html.includes('Error'), 'must not be labelled Error');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  assert.ok(html.includes('warning'), 'should use the warning palette');
});

test('a missing tool name degrades gracefully', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, { kind: 'interaction' }),
  );
  assert.ok(html.includes('无人可应答'));
  assert.ok(!html.includes('undefined'));
});

// --- 接线：组件真的调了上面那个判定 ---
//
// 上面三组都是纯函数/叶组件，把 MessageComponent 里的分支整个删掉它们仍然全绿。
// 渲染整个 MessageComponent 又会拉进 ToolRenderer/Markdown/i18n，无 DOM 环境下
// 成本高且脆。所以这里直接对源码做结构断言：判定必须被**调用**（带上真实实参，
// 防"import 了却没接"），叶组件必须被渲染，且判定的优先级不能倒过来。
//
// 这与 permissionModeLabels.i18n.test.ts 同属一类：手写副本之间的自洽证明不了接线。

const readSource = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('MessageComponent routes tool results through resolveToolResultVariant', () => {
  const src = readSource('./MessageComponent.tsx');
  assert.ok(
    /resolveToolResultVariant\(\s*message\.toolResult\s*\)/.test(src),
    'MessageComponent must call resolveToolResultVariant(message.toolResult) — importing it is not enough',
  );
  assert.ok(
    /<AutoApproveDenyNotice/.test(src),
    'MessageComponent must render AutoApproveDenyNotice for the auto-denied branch',
  );
  // 判定必须出现在红框分支之前，否则带标记的结果仍会被 isError 抢走。
  const variantAt = src.indexOf('resolveToolResultVariant(message.toolResult)');
  const errorBranchAt = src.indexOf('message.toolResult.isError ?');
  assert.ok(variantAt !== -1 && errorBranchAt !== -1, 'both branches must be present');
  assert.ok(
    variantAt < errorBranchAt,
    'the auto-denied check must come before the isError red-box branch',
  );
});

test('ToolRenderer derives "denied" from the structured field before sniffing text', () => {
  const src = readSource('../../tools/ToolRenderer.tsx');
  const denyAt = src.indexOf('toolResult.autoApproveDeny');
  const errorAt = src.indexOf('toolResult.isError');
  assert.ok(denyAt !== -1, 'deriveToolStatus must consult toolResult.autoApproveDeny');
  assert.ok(errorAt !== -1, 'the isError branch must still exist');
  assert.ok(
    denyAt < errorAt,
    'the structured autoApproveDeny check must precede the isError text-sniffing branch',
  );
});
