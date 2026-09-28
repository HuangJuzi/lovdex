import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { attentionItems } from './taskInbox';

const NOW = new Date('2026-09-16T12:00:00');

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
  permission_mode: 'default',
  context_summary: null,
  context_source_session_id: null,
  context_mode: 'none',
  context_status: null,
  context_raw: null,
  source_schedule_id: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('ignores tasks that need no attention', () => {
  assert.equal(attentionItems([mkTask({ task_id: 't1' })], NOW).length, 0);
  assert.equal(attentionItems([mkTask({ task_id: 'r1', status: 'in_progress', sub_status: 'running' })], NOW).length, 0);
  assert.equal(attentionItems([mkTask({ task_id: 'd1', status: 'done', sub_status: 'done' })], NOW).length, 0);
});

test('maps each action sub_status to its action', () => {
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', sub_status: 'failed' })], NOW)[0].action, 'retry');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_review', sub_status: 'pending_acceptance' })], NOW)[0].action, 'accept');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'waiting_approval' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'waiting_answer' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'waiting_plan' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_review', session_id: 's1', sub_status: 'needs_review' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'blocked' })], NOW)[0].action, 'openSession');
  assert.equal(attentionItems([mkTask({ task_id: 'x', status: 'in_progress', session_id: 's1', sub_status: 'only_plan' })], NOW)[0].action, 'openSession');
});

test('waiting signal without a session falls back to openTask', () => {
  const [item] = attentionItems([mkTask({ task_id: 'w1', status: 'in_progress', sub_status: 'waiting_approval' })], NOW);
  assert.equal(item.action, 'openTask');
});

test('overdue todo task becomes a start item', () => {
  const [item] = attentionItems([mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15' })], NOW);
  assert.equal(item.signal, 'overdue');
  assert.equal(item.label, '已逾期 1 天');
  assert.equal(item.action, 'start');
});

test('overdue non-todo task with a session becomes an openSession item', () => {
  const [item] = attentionItems([mkTask({ task_id: 'o2', status: 'in_progress', deadline: '2026-09-15', session_id: 's1' })], NOW);
  assert.equal(item.action, 'openSession');
});

test('overdue done/archived tasks are ignored', () => {
  assert.equal(attentionItems([mkTask({ task_id: 'd1', status: 'done', deadline: '2026-09-15' })], NOW).length, 0);
  assert.equal(attentionItems([mkTask({ task_id: 'a1', status: 'archived', deadline: '2026-09-15' })], NOW).length, 0);
});

test('deadline today is not overdue', () => {
  assert.equal(attentionItems([mkTask({ task_id: 't1', deadline: '2026-09-16' })], NOW).length, 0);
});

test('failed + overdue counts once, preferring the sub_status signal', () => {
  const items = attentionItems([mkTask({ task_id: 'f1', status: 'in_progress', sub_status: 'failed', deadline: '2026-09-10' })], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].signal, 'failed');
});

// —— 条目产生时刻：由后端 decorate 派生，前端只透传（映射规则不在此重复推导） ——

test('carries attention_since through to the attention item', () => {
  const [item] = attentionItems(
    [mkTask({ task_id: 'x', status: 'in_progress', sub_status: 'failed', attention_since: '2026-09-16T11:48:00.000Z' })],
    NOW,
  );
  assert.equal(item.since, '2026-09-16T11:48:00.000Z');
});

test('since is null when the backend could not derive a moment', () => {
  // 审批行取不到等待起点时后端给 null；前端不得回退到别的字段编时间。
  const [item] = attentionItems(
    [mkTask({ task_id: 'x', status: 'in_progress', sub_status: 'waiting_approval', session_id: 's1' })],
    NOW,
  );
  assert.equal(item.since, null);
  const [older] = attentionItems(
    [mkTask({ task_id: 'y', status: 'in_progress', sub_status: 'failed' })],
    NOW,
  );
  assert.equal(older.since, null);
});

test('overdue items carry no since — a deadline date has no moment', () => {
  const [item] = attentionItems(
    [mkTask({ task_id: 'o1', status: 'todo', deadline: '2026-09-15', attention_since: '2026-09-16T11:48:00.000Z' })],
    NOW,
  );
  assert.equal(item.signal, 'overdue');
  assert.equal(item.since, null, '逾期用「已逾期 N 天」表达，不做成时刻');
});
