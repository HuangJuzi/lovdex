import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { sortTasks } from './taskTable';

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

test('sortTasks: created desc orders newest first', () => {
  const old = mkTask({ task_id: 'a', created_at: '2026-08-01T00:00:00.000Z' });
  const recent = mkTask({ task_id: 'b', created_at: '2026-08-12T00:00:00.000Z' });
  const out = sortTasks([old, recent], 'created', 'desc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'a']);
});

test('sortTasks: title asc uses localeCompare (apple before Zebra)', () => {
  const apple = mkTask({ task_id: 'a', title: 'apple' });
  const zebra = mkTask({ task_id: 'b', title: 'Zebra' });
  const out = sortTasks([zebra, apple], 'title', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('sortTasks: status follows STATUS_ORDER (todo before done)', () => {
  const done = mkTask({ task_id: 'a', status: 'done' });
  const todo = mkTask({ task_id: 'b', status: 'todo' });
  const out = sortTasks([done, todo], 'status', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'a']);
});

test('sortTasks: priority follows PRIORITY_ORDER (P0 before P2)', () => {
  const p2 = mkTask({ task_id: 'a', priority: 'P2' });
  const p0 = mkTask({ task_id: 'b', priority: 'P0' });
  const out = sortTasks([p2, p0], 'priority', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'a']);
});

test('sortTasks: deadline asc puts no-deadline first then by date', () => {
  const noDeadline = mkTask({ task_id: 'a', deadline: null });
  const later = mkTask({ task_id: 'b', deadline: '2026-08-20' });
  const earlier = mkTask({ task_id: 'c', deadline: '2026-08-10' });
  const out = sortTasks([later, noDeadline, earlier], 'deadline', 'asc');
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'c', 'b']);
});

test('sortTasks: deadline desc puts no-deadline last', () => {
  const noDeadline = mkTask({ task_id: 'a', deadline: null });
  const later = mkTask({ task_id: 'b', deadline: '2026-08-20' });
  const earlier = mkTask({ task_id: 'c', deadline: '2026-08-10' });
  const out = sortTasks([later, noDeadline, earlier], 'deadline', 'desc');
  assert.deepEqual(out.map((t) => t.task_id), ['b', 'c', 'a']);
});

test('sortTasks: does not mutate the input array', () => {
  const a = mkTask({ task_id: 'a', created_at: '2026-08-01T00:00:00.000Z' });
  const b = mkTask({ task_id: 'b', created_at: '2026-08-12T00:00:00.000Z' });
  const input = [a, b];
  sortTasks(input, 'created', 'desc');
  assert.deepEqual(input.map((t) => t.task_id), ['a', 'b']);
});
