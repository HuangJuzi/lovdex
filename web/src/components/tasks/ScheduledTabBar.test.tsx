import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScheduledTabBar } from './ScheduledTabBar';

function render(tab: 'schedules' | 'runs') {
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
