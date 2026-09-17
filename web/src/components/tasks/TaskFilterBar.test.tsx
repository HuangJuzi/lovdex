import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EMPTY_TASK_FILTER, type TaskFilter } from './taskFilter';
import { TaskFilterBar } from './TaskFilterBar';

const renderBar = (open: boolean, filter: TaskFilter = EMPTY_TASK_FILTER) =>
  renderToStaticMarkup(
    React.createElement(TaskFilterBar, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      filter,
      onChange: () => {},
      open,
    }),
  );

/**
 * 局限同 TaskTableView.test.tsx：`node:test` + `renderToStaticMarkup` 没有 DOM、
 * 没有排版引擎，这里只能证明结构与类名被渲染出来，不能证明视觉结果。
 */
test('filter bar renders nothing while collapsed', () => {
  assert.equal(renderBar(false), '');
});

test('filter bar renders the project multi-select trigger and no assistant toggle', () => {
  const html = renderBar(true);
  assert.match(html, /全部项目/);
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
  assert.doesNotMatch(html, /只看助手/);
  assert.doesNotMatch(html, /清除筛选/);
});

test('filter bar shows the selected project and a clear button when active', () => {
  const html = renderBar(true, { ...EMPTY_TASK_FILTER, projectPaths: ['/p'] });
  assert.match(html, /proj/);
  assert.match(html, /清除筛选/);
});

test('filter bar no longer renders its own mobile trigger row', () => {
  // 移动端触发行已删除：折叠改由 TaskBoard 的 header 按钮统一控制。
  // 触发行独有的特征是「项目：xxx · 日期：xxx」这句摘要，控件区里不会出现。
  assert.doesNotMatch(renderBar(true), /项目：/);
});
