import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { EMPTY_TASK_FILTER } from './taskFilter';
import { TaskFilterBar } from './TaskFilterBar';

test('filter bar renders default options', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: EMPTY_TASK_FILTER,
      onChange: () => {},
    }),
  );
  assert.match(html, /全部项目/);
  assert.match(html, /Lovdex助手/);
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
  assert.doesNotMatch(html, /清除筛选/);
});

test('filter bar renders assistant option value and shows clear when active', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [],
      filter: { ...EMPTY_TASK_FILTER, assistantOnly: true },
      onChange: () => {},
    }),
  );
  assert.match(html, new RegExp(ASSISTANT_OPTION_VALUE));
  assert.match(html, /清除筛选/);
});

test('filter bar renders a mobile collapse trigger with a summary', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: { ...EMPTY_TASK_FILTER, preset: 'today' },
      onChange: () => {},
    }),
  );
  // 移动端触发行：筛选 + 摘要（项目：全部 · 日期：今天）
  assert.match(html, /筛选/);
  assert.match(html, /项目：全部 · 日期：今天/);
  assert.match(html, /aria-expanded="false"/);
});
