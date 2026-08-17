import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { taskTimeLabel, formatRelativeTime, formatAbsoluteTime } from './taskTimestamp';

function mk(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'x',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
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
    source_schedule_id: null,
    created_at: '2026-08-07T10:00:00.000Z',
    updated_at: '2026-08-07T10:00:00.000Z',
    ...overrides,
  };
}

test('taskTimeLabel: todo → 创建于 created_at', () => {
  assert.deepEqual(taskTimeLabel(mk({ status: 'todo' })), { label: '创建于', iso: '2026-08-07T10:00:00.000Z' });
});

test('taskTimeLabel: in_progress → 开始于 started_at with fallback', () => {
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'in_progress', started_at: '2026-08-07T11:00:00.000Z' })),
    { label: '开始于', iso: '2026-08-07T11:00:00.000Z' },
  );
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'in_progress', started_at: null, updated_at: '2026-08-07T11:30:00.000Z' })),
    { label: '开始于', iso: '2026-08-07T11:30:00.000Z' },
  );
});

test('taskTimeLabel: in_review → 评审于 updated_at', () => {
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'in_review', updated_at: '2026-08-07T12:00:00.000Z' })),
    { label: '评审于', iso: '2026-08-07T12:00:00.000Z' },
  );
});

test('taskTimeLabel: done → 完成于 completed_at with fallback', () => {
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'done', completed_at: '2026-08-07T13:00:00.000Z' })),
    { label: '完成于', iso: '2026-08-07T13:00:00.000Z' },
  );
  assert.deepEqual(
    taskTimeLabel(mk({ status: 'done', completed_at: null, updated_at: '2026-08-07T13:30:00.000Z' })),
    { label: '完成于', iso: '2026-08-07T13:30:00.000Z' },
  );
});

test('formatRelativeTime buckets', () => {
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-07T10:00:30.000Z')), '刚刚');
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-07T10:05:00.000Z')), '5 分钟前');
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-07T12:00:00.000Z')), '2 小时前');
  assert.equal(formatRelativeTime('2026-08-07T10:00:00.000Z', new Date('2026-08-10T10:00:00.000Z')), '3 天前');
});

test('formatRelativeTime invalid → —', () => {
  assert.equal(formatRelativeTime('not-a-date', new Date()), '—');
});

test('formatAbsoluteTime invalid → —', () => {
  assert.equal(formatAbsoluteTime('not-a-date'), '—');
});

test('formatAbsoluteTime formats Y-M-D H:m shape', () => {
  assert.match(formatAbsoluteTime('2026-08-07T10:00:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
