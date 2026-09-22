import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask, Task } from '../../types/app';
import { ScheduledTasksView } from './ScheduledTasksView';

const baseTask: ScheduledTask = {
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, auto_approve: 0, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const projectOptions = [{ value: '/proj', label: 'proj' }];
const noop = () => {};
const handlers = { onEdit: noop, onDelete: noop, onToggle: noop, onRunNow: noop };

const runningTask: Task = {
  task_id: 't1', project_path: '/proj', title: '跑', description: null,
  status: 'in_progress', sub_status: 'running', executor_provider: 'claude', executor_model: null,
  position: 0, session_id: 'sess-1', started_at: null, completed_at: null,
  ai_summary: null, verdict_reason: null, verdict_at: null,
  priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
  auto_approve: 0, context_summary: null, context_source_session_id: null,
  context_mode: 'none', context_status: null, context_raw: null,
  source_schedule_id: 's1', created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

function render(
  tasks: ScheduledTask[],
  extra: Partial<Parameters<typeof ScheduledTasksView>[0]> = {},
) {
  return renderToStaticMarkup(
    <StaticRouter location="/tasks?view=scheduled">
      <ScheduledTasksView
        tasks={tasks}
        projectOptions={projectOptions}
        {...handlers}
        blockedRuns={new Map()}
        pendingRunNow={new Set()}
        runNowError={null}
        onDismissRunNowError={noop}
        {...extra}
      />
    </StaticRouter>,
  );
}

test('renders both desktop table and mobile card grid', () => {
  const html = render([baseTask]);
  // 桌面表格（lg+ 显示）及其列头
  assert.match(html, /hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block/);
  assert.match(html, /上次触发/);
  // 移动/平板卡片（<lg 显示）
  assert.match(html, /lg:hidden/);
  // 任务标题与调度
  assert.match(html, /每日站会/);
  assert.match(html, /每天 09:00/);
  assert.match(html, /proj/);
});

test('shows 自动执行 badge in card for auto_run=1', () => {
  const html = render([baseTask]);
  assert.match(html, /自动执行/);
});

test('shows 仅提醒 badge in card for auto_run=0', () => {
  const html = render([{ ...baseTask, auto_run: 0 }]);
  assert.match(html, /仅提醒/);
});

test('shows 已停用 badge and dimmed card when disabled', () => {
  const html = render([{ ...baseTask, enabled: 0 }]);
  assert.match(html, /已停用/);
  assert.match(html, /opacity-60/);
});

test('renders 查看任务 link when last_task_id exists', () => {
  const html = render([{ ...baseTask, last_task_id: 't9' }]);
  assert.match(html, /查看任务/);
  assert.match(html, /href="\/task\/t9"/);
});

test('shows — when no last task', () => {
  const html = render([baseTask]);
  assert.match(html, /—/);
});

test('renders empty state', () => {
  const html = render([]);
  assert.match(html, /暂无定时任务/);
});

test('a scheduled task with auto_approve on shows an auto-approval badge', () => {
  const html = render([{ ...baseTask, schedule_id: 's1', auto_approve: 1 }]);
  assert.ok(html.includes('自动审批'), 'the badge must render for flagged schedules');
});

test('a scheduled task without the flag shows no auto-approval badge', () => {
  const html = render([{ ...baseTask, schedule_id: 's1', auto_approve: 0 }]);
  assert.equal(html.includes('自动审批'), false, 'the badge must not render when the flag is off');
});

// 本机时区无关的下次触发断言素材：期望日期与任务用同一个时刻推导，
// 避免硬编码日期在 UTC-9 及以西等时区翻日导致测试翻车。
const NEXT_RUN_ISO = '2026-08-14T12:00:00.000Z';
const expectedNextDate = (() => {
  const d = new Date(NEXT_RUN_ISO);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

test('renders 启用 switch column and 模式 header with aria-checked=true for enabled task', () => {
  const html = render([baseTask]);
  assert.match(html, /<th[^>]*>启用<\/th>/);
  assert.match(html, /<th[^>]*>模式<\/th>/);
  assert.match(html, /role="switch"/);
  // SSR 同时渲染桌面表格与手机卡片，单任务恰好 2 个开关
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 2, 'table and card switch both on');
  assert.match(html, /每日站会：启用\/停用/);
  // 旧 ⏻ Power 按钮（aria-label=启停）已由开关取代
  assert.doesNotMatch(html, /aria-label="启停"/);
});

test('enabled task renders next_run_at time', () => {
  const html = render([{ ...baseTask, next_run_at: NEXT_RUN_ISO }]);
  assert.match(html, new RegExp(expectedNextDate));
});

test('disabled task: aria-checked=false, dimmed, em-dash next run, desktop mode badge persists', () => {
  const html = render([{ ...baseTask, enabled: 0, next_run_at: NEXT_RUN_ISO }]);
  // SSR 同时渲染桌面表格与手机卡片，单任务恰好 2 个开关，且没有残留开启态
  assert.equal((html.match(/aria-checked="false"/g) ?? []).length, 2, 'table and card switch both off');
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 0, 'no switch left on');
  assert.match(html, /opacity-60/);
  assert.match(html, /已停用/);
  // 卡片停用时徽标被「已停用」取代，此处的「自动执行」只能来自桌面「模式」列
  assert.match(html, /自动执行/);
  // 停用后不再渲染会误导的下次触发时间
  assert.doesNotMatch(html, new RegExp(expectedNextDate));
});

// 桌面表格与移动卡片都会渲染 ▶，所以每条断言都用计数覆盖两套布局。
const countDisabledRunNow = (html: string) =>
  (html.match(/<button[^>]*aria-label="立即触发"[^>]*disabled[^>]*>/g) ?? []).length;

test('上一轮还在跑时两套布局的立即触发都禁用，且 title 说明原因', () => {
  const html = render(
    [{ ...baseTask, last_task_id: 't1' }],
    { blockedRuns: new Map([['s1', runningTask]]) },
  );
  assert.equal(countDisabledRunNow(html), 2, '桌面表格与移动卡片都要禁用');
  assert.match(html, /上一轮还在运行中，先等它结束或中断它/);
});

test('等你回答时禁用文案换成对应说法', () => {
  const html = render(
    [{ ...baseTask, last_task_id: 't1' }],
    { blockedRuns: new Map([['s1', { ...runningTask, sub_status: 'waiting_answer' }]]) },
  );
  assert.equal(countDisabledRunNow(html), 2);
  assert.match(html, /上一轮在等你回答/);
});

test('派发中的那一行也禁用，文案是「正在触发…」', () => {
  const html = render([baseTask], { pendingRunNow: new Set(['s1']) });
  assert.equal(countDisabledRunNow(html), 2);
  assert.match(html, /正在触发…/);
});

test('没被挡住的立即触发保持可点', () => {
  const html = render([baseTask]);
  assert.equal(countDisabledRunNow(html), 0, '默认状态下按钮不该是灰的');
  assert.match(html, /title="立即触发"/);
});

test('runNowError 渲染成列表上方的提示条，可关闭', () => {
  const html = render([baseTask], { runNowError: '「每日站会」上一轮还没结束，先处理或中断它再触发' });
  assert.match(html, /上一轮还没结束，先处理或中断它再触发/);
  assert.match(html, />关闭</);
});

test('runNowError 为 null 时不渲染提示条', () => {
  const html = render([baseTask]);
  assert.doesNotMatch(html, />关闭</);
});