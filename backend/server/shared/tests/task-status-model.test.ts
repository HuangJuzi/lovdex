import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_VERDICTS, PERSISTED_SUB_STATUSES, STATUS_ORDER, SUB_STATUSES,
  TASK_LABELS, TASK_PRIORITIES, isAiVerdict, isPersistedSubStatus,
  isSubStatus, isTaskDeadline, isTaskLabel, isTaskPriority, isTaskStatus,
} from '@/shared/task-status.js';

test('status list is the unified 4', () => {
  assert.deepEqual([...STATUS_ORDER], ['todo', 'in_progress', 'in_review', 'done']);
  assert.equal(isTaskStatus('todo'), true);
  assert.equal(isTaskStatus('backlog'), false);
  assert.equal(isTaskStatus('blocked'), false);
});

test('sub_status is the full 10', () => {
  assert.deepEqual([...SUB_STATUSES], [
    'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
    'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
  ]);
  assert.equal(isSubStatus('running'), true);
  assert.equal(isSubStatus('done'), true);
  assert.equal(isSubStatus('todo'), false);
});

test('persisted subset + ai verdicts', () => {
  assert.deepEqual([...PERSISTED_SUB_STATUSES], [
    'failed', 'done', 'only_plan', 'needs_review', 'blocked',
    'waiting_answer', 'waiting_plan',
  ]);
  assert.equal(isPersistedSubStatus('failed'), true);
  assert.equal(isPersistedSubStatus('waiting_answer'), true);
  assert.equal(isPersistedSubStatus('running'), false);
  assert.deepEqual([...AI_VERDICTS], ['done', 'only_plan', 'needs_review', 'blocked']);
  assert.equal(isAiVerdict('blocked'), true);
  assert.equal(isAiVerdict('failed'), false);
});

test('TASK_PRIORITIES is P0..P3', () => {
  assert.deepEqual(TASK_PRIORITIES, ['P0', 'P1', 'P2', 'P3']);
  assert.equal(isTaskPriority('P0'), true);
  assert.equal(isTaskPriority('P4'), false);
  assert.equal(isTaskPriority(undefined), false);
});

test('isTaskDeadline validates YYYY-MM-DD real dates', () => {
  assert.equal(isTaskDeadline('2026-12-31'), true);
  assert.equal(isTaskDeadline('2026-02-30'), false);   // 非法日期
  assert.equal(isTaskDeadline('2026/12/31'), false);   // 分隔符错
  assert.equal(isTaskDeadline(null), false);
});

test('TASK_LABELS is the seven categories', () => {
  assert.deepEqual(TASK_LABELS, ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder']);
  assert.equal(isTaskLabel('bug'), true);
  assert.equal(isTaskLabel('reminder'), true);
  assert.equal(isTaskLabel('nope'), false);
  assert.equal(isTaskLabel(undefined), false);
});
