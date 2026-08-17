import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../types/app';

import { shouldApplyUpsert } from './useLinkedTask';

function mkTask(session_id: string | null): Task {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'in_progress',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id,
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
    created_at: '',
    updated_at: '',
    approval_pending: false,
  };
}

test('shouldApplyUpsert true when event task session matches', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_upserted', task: mkTask('s1') }, 's1'), true);
});

test('shouldApplyUpsert false on session mismatch', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_upserted', task: mkTask('s2') }, 's1'), false);
});

test('shouldApplyUpsert false when session id is null', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_upserted', task: mkTask('s1') }, null), false);
});

test('shouldApplyUpsert false for non-upsert events', () => {
  assert.equal(shouldApplyUpsert({ kind: 'task_deleted' }, 's1'), false);
});
