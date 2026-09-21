import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SEVERITY_STYLE, ToastCard } from './Toast';

test('卡片本体不按严重度染色（整块染色是「太突兀」的主因）', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'critical', title: '失败', body: '详情' }} onDismiss={() => {}} />,
  );
  // 图标块按设计带 bg-destructive/10，所以负向断言只看卡片本体（根节点的 class），不能扫整个 HTML。
  const rootClass = html.match(/class="([^"]*)"/)?.[1] ?? '';
  assert.ok(rootClass.includes('bg-popover/80'), '卡片应为毛玻璃底');
  assert.ok(rootClass.includes('backdrop-blur-xl'), '卡片应带毛玻璃模糊');
  assert.ok(rootClass.includes('shadow-raised-md'), '应使用具名阴影档位');
  assert.ok(!rootClass.includes('bg-destructive/10'), '卡片本体不应整块染色');
});

test('严重度只体现在图标块的配色上', () => {
  assert.ok(SEVERITY_STYLE.critical.iconClass.includes('bg-destructive/10'));
  assert.ok(SEVERITY_STYLE.warning.iconClass.includes('bg-warning/10'));
  assert.ok(SEVERITY_STYLE.info.iconClass.includes('bg-muted'));
});

test('渲染标题与正文', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'warning', title: '标题甲', body: '正文乙' }} onDismiss={() => {}} />,
  );
  assert.ok(html.includes('标题甲'));
  assert.ok(html.includes('正文乙'));
});

test('无 body 时不渲染正文节点', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'warning', title: '标题甲', body: null }} onDismiss={() => {}} />,
  );
  assert.ok(!html.includes('line-clamp-2'));
});

test('渲染关闭按钮', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'info', title: '标题甲' }} onDismiss={() => {}} />,
  );
  assert.ok(html.includes('aria-label="关闭"'));
});
