import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ResizeHandle } from './ResizeHandle';

const render = (over: Partial<React.ComponentProps<typeof ResizeHandle>> = {}) =>
  renderToStaticMarkup(
    <ResizeHandle
      width={350}
      min={200}
      max={480}
      label="调整通知列表宽度"
      onWidthChange={() => {}}
      onReset={() => {}}
      {...over}
    />,
  );

test('渲染竖直分隔条并带当前宽度', () => {
  const html = render();
  assert.ok(html.includes('role="separator"'));
  assert.ok(html.includes('aria-orientation="vertical"'));
  assert.ok(html.includes('aria-valuenow="350"'));
  assert.ok(html.includes('tabindex="0"'));
});

test('min/max 来自 props，不是写死的侧边栏区间', () => {
  const html = render({ min: 240, max: 640 });
  assert.ok(html.includes('aria-valuemin="240"'));
  assert.ok(html.includes('aria-valuemax="640"'));
  assert.ok(!html.includes('aria-valuemin="200"'));
});

test('无障碍名称来自 props', () => {
  assert.ok(render({ label: '调整通知列表宽度' }).includes('aria-label="调整通知列表宽度"'));
});
