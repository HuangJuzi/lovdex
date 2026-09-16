import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { TaskInboxPanel } from './TaskInboxPanel';

const NOW = new Date('2026-09-16T12:00:00');

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
  context_summary: null,
  source_schedule_id: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('renders nothing when no attention items', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, { tasks: [mkTask({ task_id: 't1' })], now: NOW }),
  );
  assert.equal(html, '');
});

test('renders header, title, signal, and action button per item', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({ task_id: 'a1', title: '等待批准的任务', status: 'in_progress', sub_status: 'waiting_approval', session_id: 's1' }),
        mkTask({ task_id: 'f1', title: '失败的任务', status: 'in_progress', sub_status: 'failed' }),
      ],
      now: NOW,
      onOpenSession: () => {},
      onRetry: () => {},
    }),
  );
  assert.match(html, /data-testid="task-inbox"/);
  assert.match(html, /需要你处理/);
  assert.match(html, /等待批准的任务/);
  assert.match(html, /等你批准/);
  assert.match(html, /打开会话/);
  assert.match(html, /失败的任务/);
  assert.match(html, /↻ 重试/);
});

test('falls back to 查看 for a waiting signal without session', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'w1', status: 'in_progress', sub_status: 'waiting_approval' })],
      now: NOW,
      onOpenSession: () => {},
      onOpenTask: () => {},
    }),
  );
  assert.match(html, /查看/);
  assert.doesNotMatch(html, /打开会话/);
});

test('renders overdue todo with start action', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15' })],
      now: NOW,
      onStart: () => {},
    }),
  );
  assert.match(html, /已逾期 1 天/);
  assert.match(html, /▶ 开始执行/);
});

test('omits the action button when the matching handler is not provided', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'f1', status: 'in_progress', sub_status: 'failed' })],
      now: NOW,
    }),
  );
  assert.match(html, /需要你处理/);
  assert.doesNotMatch(html, /↻ 重试/);
});

test('renders operator project as Lovdex助手', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'op1', title: '助手任务', status: 'in_progress', sub_status: 'waiting_approval', session_id: 's1', is_operator: 1 })],
      now: NOW,
      onOpenSession: () => {},
    }),
  );
  assert.match(html, /🤖 Lovdex助手/);
});

test('renders remote project with its host badge', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'r1', title: '远程任务', status: 'in_progress', sub_status: 'failed', project_path: '/r/pay' })],
      now: NOW,
      projectOptions: [{ value: '/r/pay', label: 'payment-gateway', remoteHostId: 'h1', remoteHostName: 'hk-build-01' }],
      onRetry: () => {},
    }),
  );
  assert.match(html, /payment-gateway/);
  assert.match(html, /🌐 hk-build-01/);
});

test('renders collapsible header in expanded state', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [mkTask({ task_id: 'c1', status: 'in_progress', sub_status: 'failed' })],
      now: NOW,
      onRetry: () => {},
    }),
  );
  assert.match(html, /aria-expanded="true"/);
});
