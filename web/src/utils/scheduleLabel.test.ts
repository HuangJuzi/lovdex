import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduledTask } from '../types/app';
import { cronLabel, intervalLabel, scheduleLabel } from './scheduleLabel';

function mkTask(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    schedule_id: 's1', title: 't', description: null, project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, schedule_type: 'once', cron_expr: null,
    interval_seconds: null, run_at: null, timezone: 'local',
    next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
    enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

test('intervalLabel converts seconds to readable units', () => {
  assert.equal(intervalLabel(3600), '每 1 小时');
  assert.equal(intervalLabel(21600), '每 6 小时');
  assert.equal(intervalLabel(86400), '每 1 天');
  assert.equal(intervalLabel(1800), '每 30 分钟');
});

test('cronLabel humanizes common patterns and falls back to raw', () => {
  assert.equal(cronLabel('0 9 * * *'), '每天 09:00');
  assert.equal(cronLabel('0 9 * * 1'), '每周一 09:00');
  assert.equal(cronLabel('0 10 15 * *'), '每月 15 日 10:00');
  assert.equal(cronLabel('0 9,17 * * *'), '0 9,17 * * *');
});

test('scheduleLabel dispatches by schedule_type', () => {
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' })), '一次性');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'interval', interval_seconds: 86400 })), '每 1 天');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'cron', cron_expr: '0 9 * * 1-5' })), '0 9 * * 1-5');
});
