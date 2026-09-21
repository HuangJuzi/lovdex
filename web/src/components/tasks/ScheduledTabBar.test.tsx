import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScheduledTabBar, type ScheduledTab } from './ScheduledTabBar';

// 用导出的类型而不是内联联合：顺带钉住「ScheduledTab 是对外契约」这件事
// （TaskBoard / ScheduledTasksPanel 都要 import 它）。
function render(tab: ScheduledTab) {
  return renderToStaticMarkup(<ScheduledTabBar tab={tab} onChange={() => {}} />);
}

test('渲染两个子标签', () => {
  const html = render('schedules');
  assert.match(html, /调度/);
  assert.match(html, /运行记录/);
});

test('当前子标签带 aria-pressed=true，另一个为 false', () => {
  const schedules = render('schedules');
  assert.equal((schedules.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((schedules.match(/aria-pressed="false"/g) ?? []).length, 1);

  const runs = render('runs');
  assert.equal((runs.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((runs.match(/aria-pressed="false"/g) ?? []).length, 1);
});

test('激活态与未激活态用不同的样式类', () => {
  const html = render('runs');
  assert.match(html, /bg-card text-card-foreground shadow-raised-sm/);
  assert.match(html, /text-muted-foreground hover:text-foreground/);
});
