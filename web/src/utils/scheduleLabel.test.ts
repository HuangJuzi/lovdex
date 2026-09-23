import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduledTask } from '../types/app';
import { cronLabel, intervalLabel, scheduleLabel } from './scheduleLabel';

function mkTask(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    schedule_id: 's1', title: 't', description: null, project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, permission_mode: 'default', schedule_type: 'once', cron_expr: null,
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

test('intervalLabel uses the same exact decomposition as the form', () => {
  // 与表单的单位表对齐：一周不再显示成「每 7 天」
  assert.equal(intervalLabel(604800), '每 1 星期');
  // 非整除值如实显示，不再四舍五入撒谎成「每 90 分钟」
  assert.equal(intervalLabel(5401), '每 5401 秒');
  // 退化输入必须走守卫，不能落进 decomposeInterval ——
  // decomposeInterval(0) 会命中「0 % 604800 === 0」返回「每 0 星期」
  assert.equal(intervalLabel(0), '每 0 秒');
  assert.equal(intervalLabel(-5), '每 -5 秒');
  assert.equal(intervalLabel(Number.NaN), '每 NaN 秒');
});

test('cronLabel humanizes common patterns and falls back to raw', () => {
  assert.equal(cronLabel('0 9 * * *'), '每天 09:00');
  assert.equal(cronLabel('0 9 * * 1'), '每周一 09:00');
  assert.equal(cronLabel('0 10 15 * *'), '每月 15 日 10:00');
  assert.equal(cronLabel('0 9,17 * * *'), '0 9,17 * * *');
});

test('cronLabel humanizes weekdays', () => {
  assert.equal(cronLabel('0 9 * * 1-5'), '工作日 09:00');
});

test('cronLabel falls back to raw for expressions the preset parser rejects', () => {
  // 复用 parseCronPreset 之后 cronLabel 变严了：越界的表达式不再被硬凑成中文
  // （以前 '99 9 * * *' 会输出「每天 09:99」这种明显坏掉的结果）
  assert.equal(cronLabel('99 9 * * *'), '99 9 * * *');
  assert.equal(cronLabel('0 9 * 3 *'), '0 9 * 3 *');
  assert.equal(cronLabel('0 9 * * 1,3'), '0 9 * * 1,3');
  assert.equal(cronLabel('0 24 * * *'), '0 24 * * *');
  assert.equal(cronLabel('0 10 99 * *'), '0 10 99 * *');
});

test('scheduleLabel dispatches by schedule_type', () => {
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'once', run_at: '2026-08-14T01:00:00.000Z' })), '一次性');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'interval', interval_seconds: 86400 })), '每 1 天');
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'cron', cron_expr: '0 9 * * 1-5' })), '工作日 09:00');
  // humanize 不了的表达式仍然原样显示
  assert.equal(scheduleLabel(mkTask({ schedule_type: 'cron', cron_expr: '0 9,17 * * *' })), '0 9,17 * * *');
});
