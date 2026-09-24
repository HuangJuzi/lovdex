import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { ScheduledTask, Task } from '../../types/app';

import { ScheduledTaskDetail } from './ScheduledTaskDetail';

const baseTask: ScheduledTask = {
  schedule_id: 's1', title: '每日站会', description: '汇总各人进展', project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, permission_mode: 'default', schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const runningTask: Task = {
  task_id: 't1', project_path: '/proj', title: '跑', description: null,
  status: 'in_progress', sub_status: 'running', executor_provider: 'claude', executor_model: null,
  position: 0, session_id: 'sess-1', started_at: null, completed_at: null,
  ai_summary: null, verdict_reason: null, verdict_at: null,
  priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
  permission_mode: 'default', context_summary: null, context_source_session_id: null,
  context_mode: 'none', context_status: null, context_raw: null,
  source_schedule_id: 's1', created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
};

const projectOptions = [{ value: '/proj', label: 'proj' }];
const noop = () => {};

function render(
  task: ScheduledTask,
  extra: Partial<Parameters<typeof ScheduledTaskDetail>[0]> = {},
) {
  return renderToStaticMarkup(
    <StaticRouter location="/scheduled">
      <ScheduledTaskDetail
        task={task}
        taskById={new Map()}
        projectOptions={projectOptions}
        submitting={false}
        error={null}
        onSubmit={noop}
        onClose={noop}
        onToggle={noop}
        onRunNow={noop}
        onDelete={noop}
        blocked={null}
        pendingRunNow={false}
        {...extra}
      />
    </StaticRouter>,
  );
}

test('renders the title and enabled switch', () => {
  const html = render(baseTask);
  assert.match(html, /每日站会/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
});

test('renders the inline edit form body', () => {
  const html = render(baseTask);
  assert.match(html, /说清楚要做什么就行，名称留空会自动生成/);
});

// 提交入口必须是**带文字**的底部按钮：此前详情面板只有 composer 里那个无标签的圆形
// 箭头，底部又只剩一个「取消」，用户找不到「确认修改」，以为没法改定时任务。
test('offers a labelled 保存修改 submit instead of the icon-only composer arrow', () => {
  const html = render(baseTask);
  assert.match(html, /aria-label="保存修改"/);
  assert.doesNotMatch(html, /aria-label="保存定时任务"/);
});

// 位置也要对：得挨着「取消」。面板内容（855px）比可视区（789px@1440×900）高，
// 底部本来就会先滚出屏幕，按钮再往上藏就没有意义了。
test('places the submit next to 取消 in the footer', () => {
  const html = render(baseTask);
  const cancelAt = html.indexOf('取消');
  assert.ok(cancelAt >= 0, '取消 must render');
  assert.ok(html.indexOf('保存修改') > cancelAt, 'the submit must come after 取消 in the footer');
});

test('renders schedule meta: schedule label and project', () => {
  const html = render(baseTask);
  assert.match(html, /每天 09:00/);
  assert.match(html, /proj/);
});

test('renders 打开会话 link when the last run has an openable session', () => {
  const html = render(
    { ...baseTask, last_task_id: 't1' },
    { taskById: new Map([['t1', runningTask]]) },
  );
  assert.match(html, /打开会话/);
  assert.match(html, /href="\/session\/sess-1"/);
});

test('renders quick actions 立即触发 and 删除 plus a close button', () => {
  const html = render(baseTask);
  assert.match(html, /aria-label="立即触发"/);
  assert.match(html, /aria-label="删除"/);
  assert.match(html, /aria-label="关闭详情"/);
});

test('disabled schedule shows dimmed next run em-dash', () => {
  const html = render({ ...baseTask, enabled: 0 });
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /—/);
});
