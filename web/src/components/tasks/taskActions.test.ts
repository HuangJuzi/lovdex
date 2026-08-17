import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { canOpenSession } from './taskActions';

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

test('canOpenSession: in_progress with session_id opens', () => {
  assert.equal(canOpenSession(mkTask({ task_id: 'a', status: 'in_progress', session_id: 's1' })), true);
});

test('canOpenSession: in_progress without session_id does not open', () => {
  assert.equal(canOpenSession(mkTask({ task_id: 'a', status: 'in_progress', session_id: null })), false);
});

test('canOpenSession: in_review with session_id opens', () => {
  assert.equal(canOpenSession(mkTask({ task_id: 'a', status: 'in_review', session_id: 's1' })), true);
});

test('canOpenSession: todo + only_plan + session_id opens', () => {
  assert.equal(
    canOpenSession(mkTask({ task_id: 'a', status: 'todo', sub_status: 'only_plan', session_id: 's1' })),
    true,
  );
});

test('canOpenSession: done + blocked + session_id opens', () => {
  assert.equal(
    canOpenSession(mkTask({ task_id: 'a', status: 'done', sub_status: 'blocked', session_id: 's1' })),
    true,
  );
});

test('canOpenSession: todo without sub_status never opens', () => {
  assert.equal(canOpenSession(mkTask({ task_id: 'a', status: 'todo', session_id: 's1' })), false);
});

test('canOpenSession: todo with unrelated sub_status + session_id does not open', () => {
  assert.equal(
    canOpenSession(mkTask({ task_id: 'a', status: 'todo', sub_status: 'running', session_id: 's1' })),
    false,
  );
});
