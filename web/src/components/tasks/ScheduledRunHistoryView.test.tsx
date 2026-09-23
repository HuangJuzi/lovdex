import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask, Task } from '../../types/app';

import {
  ScheduledRunHistoryView,
  runsOf,
  scheduleTitleOf,
  sortRunsByTriggeredDesc,
  type ScheduleLookup,
} from './ScheduledRunHistoryView';

const baseTask: Task = {
  task_id: 't1',
  project_path: '/proj',
  title: '每日巡检',
  description: null,
  status: 'done',
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
  permission_mode: 'default',
  context_summary: null,
  context_source_session_id: null,
  context_mode: 'none',
  context_status: null,
  context_raw: null,
  source_schedule_id: 's1',
  created_at: '2026-08-14T09:00:00.000Z',
  updated_at: '2026-08-14T09:00:00.000Z',
};

const baseSchedule: ScheduledTask = {
  schedule_id: 's1', title: '每天早上九点', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, permission_mode: 'default', schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-15T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const projectOptions = [{ value: '/proj', label: 'proj' }];

// 用导出的 ScheduleLookup 而不是内联联合，和 ScheduledTabBar.test.tsx 一个路子：
// 顺带钉住「它是对外契约」。
function render(runs: Task[], schedules: ScheduledTask[] = [baseSchedule], scheduleLookup?: ScheduleLookup) {
  return renderToStaticMarkup(
    <StaticRouter location="/scheduled?tab=runs">
      <ScheduledRunHistoryView
        runs={runs}
        schedules={schedules}
        scheduleLookup={scheduleLookup}
        projectOptions={projectOptions}
        onDelete={async () => ({ deleted: [], failed: [] })}
      />
    </StaticRouter>,
  );
}

test('runsOf 只保留 source_schedule_id 非空的任务', () => {
  const manual = { ...baseTask, task_id: 't2', source_schedule_id: null };
  const runs = runsOf([baseTask, manual]);
  assert.deepEqual(runs.map((t) => t.task_id), ['t1']);
});

test('sortRunsByTriggeredDesc 按触发时间倒序，且不改原数组', () => {
  const older = { ...baseTask, task_id: 'old', created_at: '2026-08-13 09:00:00' };
  const newer = { ...baseTask, task_id: 'new', created_at: '2026-08-15 09:00:00' };
  const input = [older, newer];
  assert.deepEqual(sortRunsByTriggeredDesc(input).map((t) => t.task_id), ['new', 'old']);
  assert.deepEqual(input.map((t) => t.task_id), ['old', 'new']);
});

test('scheduleTitleOf 命中调度时返回标题，查不到回退占位文案', () => {
  assert.equal(scheduleTitleOf('s1', [baseSchedule]), '每天早上九点');
  assert.equal(scheduleTitleOf('gone', [baseSchedule]), '已删除的调度');
  assert.equal(scheduleTitleOf(null, [baseSchedule]), '已删除的调度');
});

test('渲染桌面表格与移动卡片，含运行记录特有的列', () => {
  const html = render([baseTask]);
  // 桌面表格（lg+ 显示）及其列头
  assert.match(html, /hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block/);
  assert.match(html, /所属调度/);
  assert.match(html, /触发时间/);
  // 移动/平板卡片（<lg 显示）
  assert.match(html, /lg:hidden/);
  // 内容：标题、调度名、项目名、状态
  assert.match(html, /每日巡检/);
  assert.match(html, /每天早上九点/);
  assert.match(html, /proj/);
  assert.match(html, /完成/);
});

test('调度已删除时渲染占位文案', () => {
  const html = render([{ ...baseTask, source_schedule_id: 'gone' }]);
  assert.match(html, /已删除的调度/);
});

test('调度列表加载中时不把每行标成已删除', () => {
  assert.equal(scheduleTitleOf('s1', [baseSchedule], 'loading'), '调度加载中');
  assert.equal(scheduleTitleOf('gone', [baseSchedule], 'loading'), '调度加载中');
  const html = render([baseTask], [], 'loading');
  assert.match(html, /调度加载中/);
  assert.doesNotMatch(html, /已删除的调度/);
});

test('调度列表加载失败时显示不可用而不是已删除', () => {
  assert.equal(scheduleTitleOf('s1', [baseSchedule], 'error'), '调度列表不可用');
  const html = render([baseTask], [], 'error');
  assert.match(html, /调度列表不可用/);
  assert.doesNotMatch(html, /已删除的调度/);
});

test('调度列表就绪后仍能区分已删除的调度', () => {
  const html = render([{ ...baseTask, source_schedule_id: 'gone' }], [baseSchedule], 'ready');
  assert.match(html, /已删除的调度/);
  assert.doesNotMatch(html, /调度加载中/);
});

test('任务可跟进的会话才渲染「打开会话」', () => {
  const openable = render([{ ...baseTask, status: 'in_progress', session_id: 'sess-1' }]);
  assert.match(openable, /打开会话/);
  assert.match(openable, /href="\/session\/sess-1"/);

  // status=done 且没有 session：canOpenSession 为 false
  const closed = render([baseTask]);
  assert.doesNotMatch(closed, /打开会话/);
});

test('始终渲染「打开任务」链接', () => {
  const html = render([baseTask]);
  assert.match(html, /打开任务/);
  assert.match(html, /href="\/task\/t1"/);
});

test('空列表渲染空态', () => {
  const html = render([]);
  assert.match(html, /暂无运行记录/);
});

test('按触发时间倒序渲染', () => {
  const older = { ...baseTask, task_id: 'old', created_at: '2026-08-13 09:00:00' };
  const newer = { ...baseTask, task_id: 'new', created_at: '2026-08-15 09:00:00' };
  const html = render([older, newer]);
  assert.ok(html.indexOf('/task/new') < html.indexOf('/task/old'));
});

test('运行中的行不给勾选框', () => {
  const html = render([
    { ...baseTask, task_id: 'done-1', status: 'done' },
    { ...baseTask, task_id: 'run-1', status: 'in_progress' },
    { ...baseTask, task_id: 'done-2', status: 'done' },
  ]);
  // 每行在桌面表格与移动卡片各渲染一次勾选框，所以是「可选行数 × 2」
  assert.equal((html.match(/aria-label="选择运行"/g) ?? []).length, 4);
});

test('运行中的行删除按钮置灰并说明原因', () => {
  const html = render([{ ...baseTask, status: 'in_progress' }]);
  assert.match(html, /disabled="" title="运行中，先停止再删除"/);
});

test('没有可选行时全选框置灰', () => {
  const html = render([{ ...baseTask, status: 'in_progress' }]);
  assert.match(html, /aria-label="全选" disabled=""/);
});
