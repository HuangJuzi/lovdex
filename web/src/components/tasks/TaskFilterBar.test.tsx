import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EMPTY_TASK_FILTER } from './taskFilter';
import { TaskFilterBar } from './TaskFilterBar';

test('filter bar renders the project multi-select and no assistant toggle', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: EMPTY_TASK_FILTER,
      onChange: () => {},
    }),
  );
  assert.match(html, /全部项目/);
  assert.match(html, /Lovdex助手/);
  assert.match(html, /proj/);
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
  assert.doesNotMatch(html, /只看助手/);
  assert.doesNotMatch(html, /清除筛选/);
});

test('filter bar shows the selected project and a clear button when active', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: { ...EMPTY_TASK_FILTER, projectPaths: ['/p'] },
      onChange: () => {},
    }),
  );
  assert.match(html, /proj/);
  assert.match(html, /清除筛选/);
});

test('filter bar mobile trigger shows a multi-project summary', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter: { ...EMPTY_TASK_FILTER, projectPaths: ['/p'], preset: 'today' },
      onChange: () => {},
    }),
  );
  assert.match(html, /筛选/);
  assert.match(html, /项目：proj · 日期：今天/);
  assert.match(html, /aria-expanded="false"/);
});
