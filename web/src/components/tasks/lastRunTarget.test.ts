import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduledTask, Task } from '../../types/app';

import { lastRunTarget } from './lastRunTarget';

const baseTask: ScheduledTask = {
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, permission_mode: 'default', schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 't1', project_path: '/proj', title: '跑', description: null,
    status: 'done', sub_status: null, executor_provider: 'claude', executor_model: null,
    position: 0, session_id: null, started_at: null, completed_at: null,
    ai_summary: null, verdict_reason: null, verdict_at: null,
    priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
    permission_mode: 'default', context_summary: null, context_source_session_id: null,
    context_mode: 'none', context_status: null, context_raw: null,
    source_schedule_id: 's1', created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

test('no last_task_id → none', () => {
  assert.deepEqual(lastRunTarget(baseTask, new Map()), { kind: 'none' });
});

test('last task with an openable session → session link', () => {
  const byId = new Map([['t1', task({ task_id: 't1', session_id: 'sess-1' })]]);
  assert.deepEqual(
    lastRunTarget({ ...baseTask, last_task_id: 't1' }, byId),
    { kind: 'session', path: '/session/sess-1' },
  );
});

test('last task with null session → task fallback', () => {
  const byId = new Map([['t1', task({ task_id: 't1', session_id: null })]]);
  assert.deepEqual(
    lastRunTarget({ ...baseTask, last_task_id: 't1' }, byId),
    { kind: 'task', path: '/task/t1' },
  );
});

test('last task whose session is deleted → task fallback', () => {
  const byId = new Map([['t1', task({ task_id: 't1', session_id: 'sess-1', session_deleted: true })]]);
  assert.deepEqual(
    lastRunTarget({ ...baseTask, last_task_id: 't1' }, byId),
    { kind: 'task', path: '/task/t1' },
  );
});

test('last task missing from the map → task fallback', () => {
  assert.deepEqual(
    lastRunTarget({ ...baseTask, last_task_id: 't9' }, new Map()),
    { kind: 'task', path: '/task/t9' },
  );
});
