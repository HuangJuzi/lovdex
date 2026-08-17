import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import {
  EMPTY_TASK_FILTER,
  filterTasks,
  normalizeTaskFilter,
  resolveDateRange,
  toggleProjectFilter,
  type TaskFilter,
} from './taskFilter';

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
  source_schedule_id: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
  ...over,
});

const NOW = new Date(2026, 7, 12, 15, 30); // 2026-08-12 15:30 本地时间

const filterOf = (patch: Partial<TaskFilter>): TaskFilter => ({ ...EMPTY_TASK_FILTER, ...patch });

test('resolveDateRange: preset all with no custom returns null', () => {
  assert.equal(resolveDateRange(filterOf({ preset: 'all' }), NOW), null);
});

test('resolveDateRange: today spans local midnight to end of day and covers now', () => {
  const range = resolveDateRange(filterOf({ preset: 'today' }), NOW)!;
  const from = new Date(range.from);
  const to = new Date(range.to);
  assert.equal(from.getHours(), 0);
  assert.equal(from.getMinutes(), 0);
  assert.equal(to.getHours(), 23);
  assert.equal(to.getMinutes(), 59);
  assert.ok(NOW.getTime() >= range.from && NOW.getTime() <= range.to);
});

test('resolveDateRange: week starts Monday local midnight', () => {
  const range = resolveDateRange(filterOf({ preset: 'week' }), NOW)!;
  const from = new Date(range.from);
  assert.equal(from.getDay(), 1); // Monday
  assert.equal(from.getHours(), 0);
  assert.ok(NOW.getTime() >= range.from && NOW.getTime() <= range.to);
});

test('resolveDateRange: month starts on the 1st', () => {
  const range = resolveDateRange(filterOf({ preset: 'month' }), NOW)!;
  const from = new Date(range.from);
  assert.equal(from.getDate(), 1);
  assert.equal(from.getHours(), 0);
  assert.ok(NOW.getTime() <= range.to);
});

test('resolveDateRange: year starts Jan 1', () => {
  const range = resolveDateRange(filterOf({ preset: 'year' }), NOW)!;
  const from = new Date(range.from);
  assert.equal(from.getMonth(), 0);
  assert.equal(from.getDate(), 1);
});

test('resolveDateRange: custom both sides is a closed local-day range', () => {
  const range = resolveDateRange(filterOf({ customFrom: '2026-08-01', customTo: '2026-08-12' }), NOW)!;
  assert.equal(new Date(range.from).getDate(), 1);
  assert.equal(new Date(range.to).getHours(), 23);
  assert.ok(range.from <= NOW.getTime() && NOW.getTime() <= range.to);
});

test('resolveDateRange: from only has no upper bound', () => {
  const range = resolveDateRange(filterOf({ customFrom: '2026-08-12' }), NOW)!;
  assert.equal(new Date(range.from).getDate(), 12);
  assert.equal(range.to, Number.POSITIVE_INFINITY);
});

test('resolveDateRange: to only has no lower bound', () => {
  const range = resolveDateRange(filterOf({ customTo: '2026-08-01' }), NOW)!;
  assert.equal(new Date(range.to).getDate(), 1);
  assert.equal(range.from, Number.NEGATIVE_INFINITY);
});

test('filterTasks: single project path match', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', project_path: '/p2' });
  const out = filterTasks([a, b], filterOf({ projectPaths: ['/p1'] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: multiple projects are OR-ed together', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', project_path: '/p2' });
  const c = mkTask({ task_id: 'c', project_path: '/p3' });
  const out = filterTasks([a, b, c], filterOf({ projectPaths: ['/p1', '/p2'] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('filterTasks: assistant sentinel keeps operator tasks', () => {
  const a = mkTask({ task_id: 'a', is_operator: 1 });
  const b = mkTask({ task_id: 'b', is_operator: 0 });
  const out = filterTasks([a, b], filterOf({ projectPaths: [ASSISTANT_OPTION_VALUE] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: assistant + a project are OR-ed together', () => {
  const a = mkTask({ task_id: 'a', is_operator: 1 });
  const b = mkTask({ task_id: 'b', project_path: '/p1' });
  const c = mkTask({ task_id: 'c', project_path: '/p2' });
  const out = filterTasks([a, b, c], filterOf({ projectPaths: [ASSISTANT_OPTION_VALUE, '/p1'] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('filterTasks: empty projectPaths means no project filter', () => {
  const a = mkTask({ task_id: 'a', project_path: '/p1' });
  const b = mkTask({ task_id: 'b', is_operator: 1 });
  const out = filterTasks([a, b], filterOf({ projectPaths: [] }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('filterTasks: created date range filters by created_at', () => {
  const inRange = mkTask({ task_id: 'a', created_at: '2026-08-12T02:00:00.000Z' });
  const outRange = mkTask({ task_id: 'b', created_at: '2026-07-01T02:00:00.000Z' });
  const out = filterTasks([inRange, outRange], filterOf({ preset: 'today' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: deadline date range excludes tasks without deadline', () => {
  const withDeadline = mkTask({ task_id: 'a', deadline: '2026-08-15' });
  const noDeadline = mkTask({ task_id: 'b', deadline: null });
  const out = filterTasks(
    [withDeadline, noDeadline],
    filterOf({ dateField: 'deadline', customFrom: '2026-08-14', customTo: '2026-08-16' }),
    NOW,
  );
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: activity uses updated_at', () => {
  const active = mkTask({ task_id: 'a', updated_at: '2026-08-12T02:00:00.000Z' });
  const stale = mkTask({ task_id: 'b', updated_at: '2026-07-01T02:00:00.000Z' });
  const out = filterTasks([active, stale], filterOf({ dateField: 'activity', preset: 'today' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('filterTasks: invalid timestamp is excluded by an active date filter', () => {
  const bad = mkTask({ task_id: 'a', created_at: 'not-a-date' });
  const good = mkTask({ task_id: 'b', created_at: '2026-08-12T02:00:00.000Z' });
  const out = filterTasks([bad, good], filterOf({ preset: 'today' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['b']);
});

test('filterTasks: no date filter keeps tasks regardless of timestamps', () => {
  const bad = mkTask({ task_id: 'a', created_at: 'not-a-date' });
  const out = filterTasks([bad], filterOf({ preset: 'all' }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a']);
});

test('normalizeTaskFilter: migrates legacy single projectPath', () => {
  const out = normalizeTaskFilter({ projectPath: '/p1', preset: 'all' });
  assert.deepEqual(out.projectPaths, ['/p1']);
  assert.equal(out.dateField, 'created');
});

test('normalizeTaskFilter: migrates legacy assistantOnly to the sentinel', () => {
  const out = normalizeTaskFilter({ projectPath: '', assistantOnly: true });
  assert.deepEqual(out.projectPaths, [ASSISTANT_OPTION_VALUE]);
});

test('normalizeTaskFilter: keeps the new projectPaths shape as-is', () => {
  const out = normalizeTaskFilter({ projectPaths: ['/p1', ASSISTANT_OPTION_VALUE], dateField: 'deadline', preset: 'week', customFrom: '', customTo: '' });
  assert.deepEqual(out.projectPaths, ['/p1', ASSISTANT_OPTION_VALUE]);
  assert.equal(out.dateField, 'deadline');
  assert.equal(out.preset, 'week');
});

test('normalizeTaskFilter: null/undefined/empty falls back to defaults', () => {
  assert.deepEqual(normalizeTaskFilter(null).projectPaths, []);
  assert.deepEqual(normalizeTaskFilter(undefined).projectPaths, []);
  assert.deepEqual(normalizeTaskFilter({}).projectPaths, []);
});

test('toggleProjectFilter: adds and removes a value', () => {
  assert.deepEqual(toggleProjectFilter([], '/p1'), ['/p1']);
  assert.deepEqual(toggleProjectFilter(['/p1', '/p2'], '/p2'), ['/p1']);
});
