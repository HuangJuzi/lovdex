import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveDenyNotice } from './AutoApproveDenyNotice';

// 这里是**叶组件**的渲染变体。接线（MessageComponent 是否真的把它接上、
// Bash 那条路径是否也走它）由 MessageComponent.test.tsx 真渲染覆盖 ——
// 曾经用「读源码 + indexOf 断言结构」代替，那种写法两个方向都会误判
// （多行书写会误红，路由写反成 `!==` 却全绿），已删。

test('the interaction variant is a quiet info line, never an error', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, {
      kind: 'interaction',
      toolName: 'AskUserQuestion',
    }),
  );
  assert.ok(html.includes('AskUserQuestion'));
  assert.ok(html.includes('无人可应答'));
  assert.ok(!html.includes('Error'), 'must not be labelled Error');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  // 交互型**不能**带 reason：模型面协议指令（「请基于现有信息自行判断…」）
  // 不是 UI 文案。props 判别联合把它变成不可表达的状态 —— 比一条渲染断言强。
  // 运行时确实没渲染出那句话，由 MessageComponent.test.tsx 覆盖（那里
  // toolResult.content 真的带着那句指令）。
});

test('the blocked variant keeps a box but is not an Error', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, {
      kind: 'blocked',
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

// 两个变体都产出锚点：被自动拒绝的结果同样可能被 `jump-to-results` 指过来。
test('both variants emit the jump-to-results anchor when a toolId is given', () => {
  const interaction = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, { kind: 'interaction', toolId: 'tu_1' }),
  );
  assert.ok(interaction.includes('id="tool-result-tu_1"'));

  const blocked = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, { kind: 'blocked', reason: '拒绝：x', toolId: 'tu_2' }),
  );
  assert.ok(blocked.includes('id="tool-result-tu_2"'));
});

test('no toolId means no anchor at all, not a literal "undefined"', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, { kind: 'blocked', reason: '拒绝：x' }),
  );
  assert.ok(!html.includes('tool-result-'), 'no anchor should be emitted');
  assert.ok(!html.includes('undefined'));
});
