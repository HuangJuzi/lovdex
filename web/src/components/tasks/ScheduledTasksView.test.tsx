import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask } from '../../types/app';
import { ScheduledTasksView } from './ScheduledTasksView';

const baseTask: ScheduledTask = {
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const projectOptions = [{ value: '/proj', label: 'proj' }];
const noop = () => {};
const handlers = { onEdit: noop, onDelete: noop, onToggle: noop, onRunNow: noop };

function render(tasks: ScheduledTask[]) {
  return renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView tasks={tasks} projectOptions={projectOptions} {...handlers} />
    </StaticRouter>,
  );
}

test('renders both desktop table and mobile card grid', () => {
  const html = render([baseTask]);
  // 桌面表格（lg+ 显示）及其列头
  assert.match(html, /hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block/);
  assert.match(html, /上次触发/);
  // 移动/平板卡片（<lg 显示）
  assert.match(html, /lg:hidden/);
  // 任务标题与调度
  assert.match(html, /每日站会/);
  assert.match(html, /每天 09:00/);
  assert.match(html, /proj/);
});

test('shows 自动执行 badge in card for auto_run=1', () => {
  const html = render([baseTask]);
  assert.match(html, /自动执行/);
});

test('shows 仅提醒 badge in card for auto_run=0', () => {
  const html = render([{ ...baseTask, auto_run: 0 }]);
  assert.match(html, /仅提醒/);
});

test('shows 已停用 badge and dimmed card when disabled', () => {
  const html = render([{ ...baseTask, enabled: 0 }]);
  assert.match(html, /已停用/);
  assert.match(html, /opacity-60/);
});

test('renders 查看任务 link when last_task_id exists', () => {
  const html = render([{ ...baseTask, last_task_id: 't9' }]);
  assert.match(html, /查看任务/);
  assert.match(html, /href="\/task\/t9"/);
});

test('shows — when no last task', () => {
  const html = render([baseTask]);
  assert.match(html, /—/);
});

test('renders empty state', () => {
  const html = render([]);
  assert.match(html, /暂无定时任务/);
});