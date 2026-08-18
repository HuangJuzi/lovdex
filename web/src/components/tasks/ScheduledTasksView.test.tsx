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

test('renders scheduled tasks rows', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView
        tasks={[baseTask]}
        projectOptions={[{ value: '/proj', label: 'proj' }]}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggle={() => {}}
        onRunNow={() => {}}
      />
    </StaticRouter>,
  );
  assert.match(html, /每日站会/);
  assert.match(html, /每天 09:00/);
});

test('renders empty state', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView tasks={[]} projectOptions={[]} onEdit={() => {}} onDelete={() => {}} onToggle={() => {}} onRunNow={() => {}} />
    </StaticRouter>,
  );
  assert.match(html, /暂无定时任务/);
});
