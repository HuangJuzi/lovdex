import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { runsOf } from './ScheduledRunHistoryView';
import { STATUS_ORDER } from './taskStatus';
import {
  EMPTY_TASK_FILTER,
  filterTasks,
  isTaskFilterActive,
  manualTasksOf,
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
  auto_approve: 0,
  context_summary: null,
  context_source_session_id: null,
  context_mode: 'none',
  context_status: null,
  context_raw: null,
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

test('filterTasks: archived tasks are hidden by default', () => {
  const archived = mkTask({ task_id: 'a', status: 'archived' });
  const done = mkTask({ task_id: 'b', status: 'done' });
  const out = filterTasks([archived, done], filterOf({}), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['b']);
});

test('filterTasks: showArchived=true includes archived tasks', () => {
  const archived = mkTask({ task_id: 'a', status: 'archived' });
  const done = mkTask({ task_id: 'b', status: 'done' });
  const out = filterTasks([archived, done], filterOf({ showArchived: true }), NOW);
  assert.deepEqual(out.map((t) => t.task_id), ['a', 'b']);
});

test('normalizeTaskFilter: missing showArchived defaults to false', () => {
  assert.equal(normalizeTaskFilter({}).showArchived, false);
  assert.equal(normalizeTaskFilter({ showArchived: true }).showArchived, true);
});

// ── isTaskFilterActive：折叠后要不要亮「有东西被筛掉」的圆点 ──────────────

test('isTaskFilterActive: all defaults is inactive', () => {
  assert.equal(isTaskFilterActive(filterOf({}), [...STATUS_ORDER]), false);
});

test('isTaskFilterActive: a project selection is active', () => {
  assert.equal(isTaskFilterActive(filterOf({ projectPaths: ['/p1'] }), [...STATUS_ORDER]), true);
});

test('isTaskFilterActive: a date preset is active', () => {
  assert.equal(isTaskFilterActive(filterOf({ preset: 'today' }), [...STATUS_ORDER]), true);
});

test('isTaskFilterActive: a custom range on one side only is active', () => {
  assert.equal(isTaskFilterActive(filterOf({ customFrom: '2026-08-01' }), [...STATUS_ORDER]), true);
  assert.equal(isTaskFilterActive(filterOf({ customTo: '2026-08-01' }), [...STATUS_ORDER]), true);
});

test('isTaskFilterActive: showArchived alone is NOT active (it adds rows, never hides)', () => {
  assert.equal(isTaskFilterActive(filterOf({ showArchived: true }), [...STATUS_ORDER]), false);
});

test('isTaskFilterActive: dateField alone is NOT active', () => {
  assert.equal(isTaskFilterActive(filterOf({ dateField: 'deadline' }), [...STATUS_ORDER]), false);
});

test('isTaskFilterActive: dropping one status pill is active', () => {
  const partial = STATUS_ORDER.filter((s) => s !== 'in_progress');
  assert.equal(isTaskFilterActive(filterOf({}), partial), true);
});

test('isTaskFilterActive: archived pill is ignored while showArchived is off', () => {
  // 默认（showArchived=false）不渲染 archived 列，所以「没勾 archived」不算筛掉东西。
  const withoutArchived = STATUS_ORDER.filter((s) => s !== 'archived');
  assert.equal(isTaskFilterActive(filterOf({}), withoutArchived), false);
});

test('isTaskFilterActive: archived pill counts once showArchived is on', () => {
  const withoutArchived = STATUS_ORDER.filter((s) => s !== 'archived');
  assert.equal(isTaskFilterActive(filterOf({ showArchived: true }), withoutArchived), true);
});

test('manualTasksOf 滤掉定时任务跑出来的任务', () => {
  const tasks = [
    mkTask({ task_id: 'manual-1' }),
    mkTask({ task_id: 'run-1', source_schedule_id: 's1' }),
    mkTask({ task_id: 'manual-2' }),
  ];
  assert.deepEqual(manualTasksOf(tasks).map((t) => t.task_id), ['manual-1', 'manual-2']);
});

test('manualTasksOf 空数组还是空数组', () => {
  assert.deepEqual(manualTasksOf([]), []);
});

// 护栏：两个谓词互为补集。fixture 刻意让**每个 status 值在「手动」和「定时」两侧
// 各出现一次**，is_operator=1 同样两侧都有 —— 只放 todo 一种 status 时，所有行除
// source_schedule_id 外完全一样，任何「顺手多加一个条件」的漂移（比如
// `&& t.status !== 'archived'`）都重新划分不出差别，护栏就成了摆设。
// 覆盖满之后，这类单边漂移会恰好丢掉一行，互补性立刻破掉。
// 判据落在 fixture 没覆盖的字段上时护栏仍是绿的（sub_status 曾是这种），所以这里
// 也放了一对 failed 行。另外两类任何 fixture 都救不了：两边同步改判据、以及接线漂移
// （TaskBoard 里那两处调用没有测试钉住，靠它自己的注释顶着）。
test('manualTasksOf 与 runsOf 互为补集', () => {
  const tasks = [
    mkTask({ task_id: 'a', status: 'todo' }),
    mkTask({ task_id: 'b', source_schedule_id: 's1', status: 'todo', is_operator: 1 }),
    mkTask({ task_id: 'c', status: 'in_progress', is_operator: 1 }),
    mkTask({ task_id: 'd', source_schedule_id: 's2', status: 'in_progress' }),
    mkTask({ task_id: 'e', status: 'in_review' }),
    mkTask({ task_id: 'f', source_schedule_id: 's3', status: 'in_review' }),
    mkTask({ task_id: 'g', status: 'done' }),
    mkTask({ task_id: 'h', source_schedule_id: 's4', status: 'done' }),
    mkTask({ task_id: 'i', status: 'archived' }),
    mkTask({ task_id: 'j', source_schedule_id: 's5', status: 'archived' }),
    // 同一 status、只有 sub_status 不同的成对行：钉住「failed 的定时任务被放回看板
    // 让用户重试」这个最诱人的例外。
    mkTask({ task_id: 'k', status: 'in_review', sub_status: 'failed' }),
    mkTask({ task_id: 'l', source_schedule_id: 's6', status: 'in_review', sub_status: 'failed' }),
  ];
  const manual = manualTasksOf(tasks).map((t) => t.task_id);
  const runs = runsOf(tasks).map((t) => t.task_id);

  assert.equal(manual.length + runs.length, tasks.length);
  assert.deepEqual(
    [...manual, ...runs].sort(),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
  );
  assert.equal(manual.filter((id) => runs.includes(id)).length, 0);
});
