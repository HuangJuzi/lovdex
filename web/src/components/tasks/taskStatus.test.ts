import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task, TaskStatus } from '../../types/app';

import {
  STATUS_META, STATUS_ORDER, SUB_STATUS_META, SUB_STATUS_ORDER, groupByStatus,
  PRIORITY_ORDER, PRIORITY_META, LABEL_ORDER, LABEL_META,
  toggleStatus,
} from './taskStatus';

function mkTask(task_id: string, status: Task['status']): Task {
  return {
    task_id, project_path: '/p', title: 't', description: null, status,
    executor_provider: 'claude', executor_model: null, position: 0, session_id: null,
    started_at: null, completed_at: null, ai_summary: null,
    sub_status: null, verdict_reason: null, verdict_at: null,
    priority: 'P2',
    deadline: null,
    is_operator: 0,
    label: 'other',
    remark: null,
    source_schedule_id: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
}

test('STATUS_ORDER is the unified 4', () => {
  assert.deepEqual(STATUS_ORDER, ['todo', 'in_progress', 'in_review', 'done']);
});

test('STATUS_META covers every status', () => {
  for (const s of STATUS_ORDER) assert.ok(STATUS_META[s], `missing meta for ${s}`);
});

test('SUB_STATUS_ORDER is the full 10', () => {
  assert.equal(SUB_STATUS_ORDER.length, 10);
  assert.ok(SUB_STATUS_ORDER.includes('blocked'));
  assert.ok(SUB_STATUS_ORDER.includes('pending_acceptance'));
});

test('SUB_STATUS_META covers every sub_status', () => {
  for (const s of SUB_STATUS_ORDER) assert.ok(SUB_STATUS_META[s], `missing meta for ${s}`);
});

test('groupByStatus buckets into 4 columns', () => {
  const tasks = [mkTask('a', 'todo'), mkTask('b', 'in_progress'), mkTask('c', 'in_review'), mkTask('d', 'done')];
  const g = groupByStatus(tasks);
  assert.equal(g['todo'].length, 1);
  assert.equal(g['done'].length, 1);
});
test('PRIORITY_META covers all priorities', () => {
  assert.deepEqual(PRIORITY_ORDER, ['P0', 'P1', 'P2', 'P3']);
  for (const p of PRIORITY_ORDER) assert.ok(PRIORITY_META[p].label && PRIORITY_META[p].color);
});
test('LABEL_META covers all labels', () => {
  assert.deepEqual(LABEL_ORDER, ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder']);
  for (const l of LABEL_ORDER) assert.ok(LABEL_META[l].label && LABEL_META[l].color);
});

test('toggleStatus adds an unselected status', () => {
  assert.deepEqual(toggleStatus(['done'] as TaskStatus[], 'todo'), ['todo', 'done']);
});

test('toggleStatus removes a selected status', () => {
  assert.deepEqual(
    toggleStatus(['todo', 'in_progress', 'done'] as TaskStatus[], 'in_progress'),
    ['todo', 'done'],
  );
});

test('toggleStatus keeps result in STATUS_ORDER order', () => {
  assert.deepEqual(toggleStatus(['done'] as TaskStatus[], 'in_review'), ['in_review', 'done']);
});

test('toggleStatus does not mutate the input array', () => {
  const selected: TaskStatus[] = ['todo', 'done'];
  const out = toggleStatus(selected, 'in_progress');
  assert.deepEqual(selected, ['todo', 'done']);
  assert.notEqual(out, selected);
});
