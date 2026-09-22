import test from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduledTask, Task } from '../../types/app';

import { blockingRunsBySchedule, runNowBlockedReason, runNowErrorMessage } from './scheduleRunNow';

const schedule = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  schedule_id: 's1', title: '每日站会', description: null, project_path: '/proj',
  executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
  is_operator: 0, auto_run: 1, auto_approve: 0, schedule_type: 'cron', cron_expr: '0 9 * * *',
  interval_seconds: null, run_at: null, timezone: 'local',
  next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
  enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', project_path: '/proj', title: '跑', description: null,
  status: 'in_progress', sub_status: null, executor_provider: 'claude', executor_model: null,
  position: 0, session_id: 'sess-1', started_at: null, completed_at: null,
  ai_summary: null, verdict_reason: null, verdict_at: null,
  priority: 'P2', deadline: null, is_operator: 0, label: 'other', remark: null,
  auto_approve: 0, context_summary: null, context_source_session_id: null,
  context_mode: 'none', context_status: null, context_raw: null,
  source_schedule_id: 's1', created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
  ...over,
});

test('blockingRunsBySchedule: 进行中且没跑挂的上一轮才算挡住', () => {
  const s = schedule({ last_task_id: 't1' });

  // 无标签也算「没走完」：裸 DB 行是 null，decorate() 之后是 running，两种都要挡
  assert.ok(blockingRunsBySchedule([s], [task({ sub_status: null })]).has('s1'), 'in_progress + null 必须挡');
  assert.ok(blockingRunsBySchedule([s], [task({ sub_status: 'running' })]).has('s1'));
  assert.ok(blockingRunsBySchedule([s], [task({ sub_status: 'waiting_answer' })]).has('s1'), '等你回答也要挡');

  // failed 是唯一明确的「上一轮已经终止、可以重来」
  assert.equal(blockingRunsBySchedule([s], [task({ sub_status: 'failed' })]).has('s1'), false, '跑挂的必须放行');

  // 不在进行中列的一律放行
  for (const status of ['todo', 'in_review', 'done', 'archived'] as const) {
    assert.equal(blockingRunsBySchedule([s], [task({ status, sub_status: null })]).has('s1'), false, `${status} 不该挡`);
  }
});

test('blockingRunsBySchedule: 查不到上一轮时不挡', () => {
  assert.equal(blockingRunsBySchedule([schedule({ last_task_id: null })], [task()]).size, 0, '没跑过');
  assert.equal(blockingRunsBySchedule([schedule({ last_task_id: 'gone' })], [task()]).size, 0, '任务已被删');
  assert.equal(blockingRunsBySchedule([], [task()]).size, 0, '没有调度');
});

test('blockingRunsBySchedule: 多条调度各归各的键', () => {
  const a = schedule({ schedule_id: 'sa', last_task_id: 'ta' });
  const b = schedule({ schedule_id: 'sb', last_task_id: 'tb' });
  const c = schedule({ schedule_id: 'sc', last_task_id: null });
  const blocked = blockingRunsBySchedule([a, b, c], [
    task({ task_id: 'ta', status: 'in_progress', sub_status: 'running' }),
    task({ task_id: 'tb', status: 'done', sub_status: null }),
  ]);
  assert.deepEqual([...blocked.keys()], ['sa']);
  assert.equal(blocked.get('sa')?.task_id, 'ta');
});

test('runNowBlockedReason: 按 sub_status 说人话', () => {
  assert.equal(runNowBlockedReason(task({ sub_status: 'waiting_answer' })), '上一轮在等你回答，去会话里回复后才会继续');
  assert.equal(runNowBlockedReason(task({ sub_status: 'waiting_plan' })), '上一轮在等你确认计划');
  assert.equal(runNowBlockedReason(task({ sub_status: 'waiting_approval' })), '上一轮在等你批准权限请求');
  assert.equal(runNowBlockedReason(task({ sub_status: 'running' })), '上一轮还在运行中，先等它结束或中断它');
  assert.equal(runNowBlockedReason(task({ sub_status: null })), '上一轮还在运行中，先等它结束或中断它');
  // decorate() 对 in_progress 行会保留这几个标签，设计 §4 同样视为「挡」，走的都是默认分支
  assert.equal(runNowBlockedReason(task({ sub_status: 'blocked' })), '上一轮还在运行中，先等它结束或中断它', 'blocked 也走默认文案');
});

test('runNowErrorMessage: 409 走专用文案', () => {
  assert.equal(
    runNowErrorMessage('每日站会', 409, { error: { code: 'SCHEDULE_RUNNING', message: 'still has an unfinished run' } }),
    '「每日站会」上一轮还没结束，先处理或中断它再触发',
  );
});

test('runNowErrorMessage: 其它失败带出后端 message，读不到就退回状态码', () => {
  assert.equal(
    runNowErrorMessage('每日站会', 500, { error: { code: 'INTERNAL', message: '数据库连接失败' } }),
    '「每日站会」数据库连接失败',
  );
  assert.equal(runNowErrorMessage('每日站会', 503, null), '「每日站会」立即触发失败 (503)');
  assert.equal(runNowErrorMessage('每日站会', 502, { error: { message: '   ' } }), '「每日站会」立即触发失败 (502)');
  // body 来自 JSON 解析，什么都可能是；畸形输入一律走兜底、不抛异常
  assert.equal(runNowErrorMessage('每日站会', 500, 'oops'), '「每日站会」立即触发失败 (500)', '非对象 body');
  assert.equal(runNowErrorMessage('每日站会', 500, { error: 5 }), '「每日站会」立即触发失败 (500)', 'error 不是对象');
});
