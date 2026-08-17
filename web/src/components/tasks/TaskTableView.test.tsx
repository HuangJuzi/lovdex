import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { TaskTableView } from './TaskTableView';

const mkTask = (over: Partial<Task> & { task_id: string }): Task => ({
  project_path: '/home/user/proj',
  title: '测试任务',
  description: null,
  status: 'todo',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: null,
  started_at: null,
  completed_at: null,
  ai_summary: null,
  sub_status: null,
  verdict_reason: null,
  verdict_at: null,
  priority: 'P2',
  deadline: null,
  is_operator: 0,
  label: 'other',
  remark: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
  ...over,
});

test('table renders status group header and task title', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
      projectOptions: [],
    }),
  );
  assert.match(html, /待办/);
  assert.match(html, /表格任务/);
  assert.match(html, /创建时间/);
  assert.match(html, /操作/);
});

test('table shows empty state when no tasks', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, { tasks: [], projectOptions: [] }),
  );
  assert.match(html, /暂无任务/);
});

test('table renders exactly one open-session button for in_review with needs_review + session', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 'r1', status: 'in_review', sub_status: 'needs_review', session_id: 's1' })],
      projectOptions: [],
      onOpenSession: () => {},
      onStatusChange: () => {},
    }),
  );
  assert.match(html, /标记完成/);
  assert.equal((html.match(/打开会话/g) || []).length, 1);
});

test('table renders exactly one open-session button for in_progress with only_plan + session', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 'p1', status: 'in_progress', sub_status: 'only_plan', session_id: 's1' })],
      projectOptions: [],
      onOpenSession: () => {},
    }),
  );
  assert.equal((html.match(/打开会话/g) || []).length, 1);
});

test('table renders status filter row with 全部 reset pill', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
      projectOptions: [],
    }),
  );
  assert.match(html, /data-testid="status-filter"/);
  assert.match(html, /全部/);
});
