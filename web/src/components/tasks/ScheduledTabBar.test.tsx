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

/**
 * 上面两条只数了「1 个 true + 1 个 false」、只看了「两串类都在」——把 `aria-pressed`
 * 取反、或把两串样式对调，它们照样全绿。这条把「哪个标签是激活态」钉死：
 * 断言 `aria-pressed="true"` 的那个按钮后面跟的是当前 tab 的文案，且它带激活样式。
 * （React 静态标记里属性顺序是 JSX 里的书写顺序：type → aria-pressed → class，故可正则匹配。）
 */
test('激活态落在当前 tab 上，样式方向也不反向', () => {
  const schedules = render('schedules');
  assert.match(schedules, /aria-pressed="true" class="[^"]*bg-card text-card-foreground shadow-raised-sm[^"]*">调度</);
  assert.match(schedules, /aria-pressed="false" class="[^"]*text-muted-foreground hover:text-foreground[^"]*">运行记录</);

  const runs = render('runs');
  assert.match(runs, /aria-pressed="true" class="[^"]*bg-card text-card-foreground shadow-raised-sm[^"]*">运行记录</);
  assert.match(runs, /aria-pressed="false" class="[^"]*text-muted-foreground hover:text-foreground[^"]*">调度</);
});
