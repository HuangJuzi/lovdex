import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveNotice } from './AutoApproveNotice';

// 叶子组件的渲染变体。**接线**（`permission_auto` 分支有没有把
// `autoApproveDenyKind` 写进 notice）由 useChatMessages.test.ts 覆盖 ——
// 只测这里会漏掉「字段根本没被写进来」这一整类回归。
//
// 配色判据必须是结构化字段，而不是文案前缀：下面第一条契约用例同一段文案只换
// 分类字段，颜色就得跟着字段走。旧实现按 `content.startsWith('已自动拒绝')` 判，
// 那段文案两种情况都会落到 muted，所以这条在旧实现上必红。

function render(content: string, autoApproveDenyKind?: 'interaction' | 'blocked') {
  return renderToStaticMarkup(
    React.createElement(AutoApproveNotice, {
      message: { type: 'notice', content, timestamp: 0, autoApproveDenyKind } as never,
    }),
  );
}

test('the colour follows the tag, not the copy', () => {
  const sameText = '无人值守，无人可应答 — 已自动跳过 AskUserQuestion';
  assert.ok(render(sameText, 'blocked').includes('warning'), 'blocked must be emphasised');
  assert.ok(!render(sameText, 'interaction').includes('warning'), 'interaction must stay muted');
});

test('a blocked notice is emphasised and keeps its copy', () => {
  const html = render('已自动拒绝 Bash：拒绝：不允许在无人值守时推送远端', 'blocked');
  assert.ok(html.includes('warning'), 'blocked must use the warning palette');
  assert.ok(html.includes('不允许在无人值守时推送远端'), 'the reason must still render');
});

test('an interaction notice is quiet', () => {
  const html = render('无人值守，无人可应答 — 已自动跳过 AskUserQuestion', 'interaction');
  assert.ok(!html.includes('warning'), 'interaction must not be emphasised');
  assert.ok(html.includes('muted-foreground'), 'interaction stays muted');
  assert.ok(html.includes('AskUserQuestion'), 'the copy must still render');
});

test('an allow notice (no kind) is quiet', () => {
  const html = render('已自动放行 Read', undefined);
  assert.ok(!html.includes('warning'), 'allow must not be emphasised');
  assert.ok(html.includes('muted-foreground'), 'allow stays muted');
  assert.ok(html.includes('Read'), 'the copy must still render');
});
