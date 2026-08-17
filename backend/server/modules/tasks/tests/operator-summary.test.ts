import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';
import type { AiVerdict, PersistedSubStatus } from '@/shared/task-status.js';
import type { TaskRow, TaskStatus } from '@/shared/types.js';

/**
 * Builds a fully-populated TaskRow (verdict fields default to null) with the
 * given overrides so the service's decorate spread sees all required columns.
 */
function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 'x',
    description: null,
    status: 'todo',
    sub_status: null,
    executor_provider: 'claude',
    executor_model: null,
    position: 1,
    session_id: null,
    source_schedule_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ai_summary: null,
    verdict_reason: null,
    verdict_at: null,
    priority: 'P2',
    deadline: null,
    is_operator: 0,
    label: 'other',
    remark: null,
    ...overrides,
  };
}

/**
 * In-memory fake db backed by a live array of rows. Mutations (updateTaskStatus,
 * updateTaskSubStatus, writeSummary) happen in place so the caller's `rows[i]`
 * reference reflects the change — the verdict-driven column-move tests assert on
 * `rows[0].status` directly. Implements every method on TaskDbLike plus
 * writeSummary (which folds the verdict into sub_status like the real db).
 */
function makeDb(rows: TaskRow[]) {
  const tasks = new Map<string, TaskRow>(rows.map((r) => [r.task_id, r]));

  const db = {
    createTask: () => {
      throw new Error('createTask not used in operator-summary tests');
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: () => null,
    listTasks: () => [...tasks.values()],
    updateTask: () => {
      throw new Error('updateTask not used in operator-summary tests');
    },
    updateTaskStatus: (id: string, status: string) => {
      const current = tasks.get(id);
      if (current) current.status = status as TaskStatus;
    },
    updateTaskSubStatus: (id: string, sub: PersistedSubStatus | null) => {
      const current = tasks.get(id);
      if (current) current.sub_status = sub;
    },
    clearVerdictFields: (id: string) => {
      const current = tasks.get(id);
      if (current) { current.ai_summary = null; current.verdict_reason = null; current.verdict_at = null; }
    },
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
    writeSummary: (
      taskId: string,
      input: { summary: string; verdict: AiVerdict; reason?: string | null },
    ): TaskRow | null => {
      const current = tasks.get(taskId);
      if (!current) return null;
      current.ai_summary = input.summary;
      current.sub_status = input.verdict;
      current.verdict_reason = input.reason ?? null;
      current.verdict_at = new Date().toISOString();
      return current;
    },
  };
  return db as unknown as TaskDbLike;
}

test('writeSummary folds a done verdict into sub_status and keeps the task in_review', () => {
  const events: unknown[] = [];
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  const out = svc.writeSummary('t1', { summary: 's', verdict: 'done', reason: 'r' });
  assert.equal(out?.sub_status, 'done');
  assert.equal(out?.status, 'in_review');
  assert.equal(rows[0].status, 'in_review');
  // A done verdict does not move the column, so only the verdict upsert fires.
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
});

test('writeSummary moves a non-done verdict (only_plan) back to in_progress', () => {
  const events: unknown[] = [];
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  const out = svc.writeSummary('t1', { summary: 's', verdict: 'only_plan', reason: 'r' });
  assert.equal(out?.sub_status, 'only_plan');
  assert.equal(out?.status, 'in_progress');
  assert.equal(rows[0].status, 'in_progress');
  // Two upserts: the verdict write, then the in_progress column move.
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal((e as { kind: string }).kind, 'task_upserted');
  }
});

test('writeSummary moves a blocked verdict back to in_progress', () => {
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.writeSummary('t1', { summary: 's', verdict: 'blocked' });
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[0].sub_status, 'blocked');
});

test('writeSummary does not move a task the user already dragged out of in_review', () => {
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'todo' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const out = svc.writeSummary('t1', { summary: 's', verdict: 'blocked', reason: 'r' });
  // Only in_review rows get the auto-move; a todo row stays put.
  assert.equal(rows[0].status, 'todo');
  // The verdict is recorded on the row, but a todo column shows no tag.
  assert.equal(rows[0].sub_status, 'blocked');
  assert.equal(out?.sub_status, null);
});
