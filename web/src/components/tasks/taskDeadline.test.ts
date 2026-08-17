import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineInfo, taskDeadlineInfo } from './taskDeadline';

const NOW = new Date('2026-08-11T12:00:00'); // 本地时间

test('deadlineInfo renders remaining/overdue labels', () => {
  assert.equal(deadlineInfo('2026-08-12', NOW).label, '剩 1 天');
  assert.equal(deadlineInfo('2026-08-11', NOW).label, '今天截止');
  assert.equal(deadlineInfo('2026-08-11', NOW).overdue, false);
  const past = deadlineInfo('2026-08-08', NOW);
  assert.equal(past.label, '已逾期 3 天');
  assert.equal(past.overdue, true);
});

test('deadlineInfo falls back to raw string on malformed input', () => {
  assert.equal(deadlineInfo('nonsense', NOW).label, 'nonsense');
});

test('taskDeadlineInfo returns null when task has no deadline', () => {
  assert.equal(taskDeadlineInfo({ deadline: null } as any, NOW), null);
  assert.equal(taskDeadlineInfo({ deadline: '2026-08-12' } as any, NOW)?.label, '剩 1 天');
});
