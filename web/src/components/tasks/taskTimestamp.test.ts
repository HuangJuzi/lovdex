import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { taskTimeLabel, formatRelativeTime, formatAbsoluteTime, parseBackendTimestamp } from './taskTimestamp';

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
    context_summary: null,
    context_source_session_id: null,
    context_mode: 'none',
    context_status: null,
    context_raw: null,
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

// —— 后端裸时间戳（SQLite CURRENT_TIMESTAMP）的时区处理 ——
// 后端给的是 UTC 但不带时区标识，JS 默认按本地时间解析，会整体偏一个时区偏移。

test('parseBackendTimestamp: 裸格式按 UTC 解析，不是本地时间', () => {
  assert.equal(parseBackendTimestamp('2026-09-21 02:37:40').toISOString(), '2026-09-21T02:37:40.000Z');
  assert.equal(parseBackendTimestamp('2026-09-21T02:37:40').toISOString(), '2026-09-21T02:37:40.000Z');
  assert.equal(parseBackendTimestamp('2026-09-21 02:37:40.123').toISOString(), '2026-09-21T02:37:40.123Z');
});

test('parseBackendTimestamp: 已带时区标识的串原样交给 Date', () => {
  assert.equal(parseBackendTimestamp('2026-09-21T02:37:40.000Z').toISOString(), '2026-09-21T02:37:40.000Z');
  assert.equal(parseBackendTimestamp('2026-09-21T10:37:40+08:00').toISOString(), '2026-09-21T02:37:40.000Z');
});

test('formatRelativeTime 对裸格式不再偏一个时区偏移', () => {
  // 后端记的是 UTC 02:00，此刻是 UTC 05:00 → 真实相差 3 小时（不是 11 小时）
  assert.equal(
    formatRelativeTime('2026-09-21 02:00:00', new Date('2026-09-21T05:00:00Z')),
    '3 小时前',
  );
});

test('formatAbsoluteTime 对裸格式按 UTC 解析、按本地渲染', () => {
  const d = new Date('2026-09-21T02:00:00Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  assert.equal(
    formatAbsoluteTime('2026-09-21 02:00:00'),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  );
});
