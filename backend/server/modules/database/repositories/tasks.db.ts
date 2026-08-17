import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { isAiVerdict, type TaskStatus, type AiVerdict, type PersistedSubStatus, type TaskLabel, type TaskPriority } from '@/shared/task-status.js';
import type { TaskEngine, TaskRow } from '@/shared/types.js';

export { TASK_STATUSES, isTaskStatus } from '@/shared/task-status.js';
export const TASK_ENGINES: readonly TaskEngine[] = ['claude', 'codex', 'opencode', 'qoder'];

export function isTaskEngine(value: unknown): value is TaskEngine {
  return typeof value === 'string' && (TASK_ENGINES as readonly string[]).includes(value);
}

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every task reader returns canonical ISO strings and
  // the board never interprets fresh rows as local-time hours off.
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

/**
 * Extra SET clauses written alongside a status change so each lifecycle
 * timestamp records the moment the task entered its corresponding state.
 * - entering in_progress  → started_at = now (refreshed on every re-run)
 * - entering done         → completed_at = now
 * - leaving done          → completed_at = NULL (task reopened, completion invalidated)
 */
function statusTimestampSets(from: TaskStatus, to: TaskStatus): string[] {
  // A same-status move (drag-reorder within a column) is not a transition —
  // leave lifecycle timestamps untouched.
  if (from === to) return [];
  const sets: string[] = [];
  if (to === 'in_progress') sets.push('started_at = CURRENT_TIMESTAMP');
  if (to === 'done') sets.push('completed_at = CURRENT_TIMESTAMP');
  if (to !== 'done' && from === 'done') sets.push('completed_at = NULL');
  return sets;
}

function normalizeTaskRow(row: TaskRow): TaskRow {
  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
    started_at: row.started_at ? (normalizeTimestamp(row.started_at) ?? row.started_at) : null,
    completed_at: row.completed_at ? (normalizeTimestamp(row.completed_at) ?? row.completed_at) : null,
    // verdict_at is written by `writeSummary` as CURRENT_TIMESTAMP (UTC, no
    // suffix). Without this it returns raw "YYYY-MM-DD HH:MM:SS" and the
    // frontend parses it as local time — showing the verdict timestamp hours
    // off. Same normalization as the lifecycle timestamps above.
    verdict_at: row.verdict_at ? (normalizeTimestamp(row.verdict_at) ?? row.verdict_at) : null,
  };
}

export const tasksDb = {
  createTask(input: {
    projectPath: string;
    title: string;
    description?: string | null;
    executorProvider: TaskEngine;
    executorModel?: string | null;
    status?: TaskStatus;
    sessionId?: string | null;
    priority?: TaskPriority;
    deadline?: string | null;
    isOperator?: boolean;
    label?: TaskLabel;
    remark?: string | null;
    sourceScheduleId?: string | null;
  }): TaskRow {
    const db = getConnection();
    const taskId = randomUUID();
    const status = input.status ?? 'todo';
    const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE status = ?').get(status) as { p: number }).p;
    // SQLite literals: only write lifecycle timestamps when entering that status (safe, not user input).
    const startedAtSet = status === 'in_progress' ? 'CURRENT_TIMESTAMP' : 'NULL';
    const completedAtSet = status === 'done' ? 'CURRENT_TIMESTAMP' : 'NULL';
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, priority, deadline, is_operator, label, remark, source_schedule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${startedAtSet}, ${completedAtSet}, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      taskId,
      input.projectPath,
      input.title,
      input.description ?? null,
      status,
      input.executorProvider,
      input.executorModel ?? null,
      position,
      input.sessionId ?? null,
      input.priority ?? 'P2',
      input.deadline ?? null,
      input.isOperator ? 1 : 0,
      input.label ?? 'other',
      input.remark ?? null,
      input.sourceScheduleId ?? null,
    ) as TaskRow;
    return normalizeTaskRow(row);
  },

  getTask(taskId: string): TaskRow | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined;
    return row ? normalizeTaskRow(row) : null;
  },

  getTaskBySessionId(sessionId: string): TaskRow | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(sessionId) as TaskRow | undefined;
    return row ? normalizeTaskRow(row) : null;
  },

  listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectPath) {
      clauses.push('project_path = ?');
      params.push(filter.projectPath);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return (db.prepare(`SELECT * FROM tasks ${where} ORDER BY position ASC, created_at ASC`).all(...params) as TaskRow[]).map(normalizeTaskRow);
  },

  updateTask(taskId: string, updates: {
    title?: string;
    description?: string | null;
    executorProvider?: TaskEngine;
    executorModel?: string | null;
    sessionId?: string | null;
    projectPath?: string;
    priority?: TaskPriority;
    deadline?: string | null;
    label?: TaskLabel;
    remark?: string | null;
  }): TaskRow | null {
    const db = getConnection();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.executorProvider !== undefined) { sets.push('executor_provider = ?'); params.push(updates.executorProvider); }
    if (updates.executorModel !== undefined) { sets.push('executor_model = ?'); params.push(updates.executorModel); }
    if (updates.sessionId !== undefined) { sets.push('session_id = ?'); params.push(updates.sessionId); }
    if (updates.projectPath !== undefined) { sets.push('project_path = ?'); params.push(updates.projectPath); }
    if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority); }
    if (updates.deadline !== undefined) { sets.push('deadline = ?'); params.push(updates.deadline); }
    if (updates.label !== undefined) { sets.push('label = ?'); params.push(updates.label); }
    if (updates.remark !== undefined) { sets.push('remark = ?'); params.push(updates.remark); }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(taskId);
    if (sets.length === 1) return tasksDb.getTask(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...params);
    return tasksDb.getTask(taskId);
  },

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    const db = getConnection();
    const current = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: TaskStatus } | undefined;
    if (!current) return;
    const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP', ...statusTimestampSets(current.status, status)];
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(status, taskId);
  },

  /**
   * Persist (or clear) the layer-2 sub_status tag on a task. Only the persisted
   * subset is valid; pass null to clear a stale tag (e.g. when a fresh run
   * starts and the old "failed" badge should disappear).
   */
  updateTaskSubStatus(taskId: string, subStatus: PersistedSubStatus | null): void {
    const db = getConnection();
    db.prepare('UPDATE tasks SET sub_status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(subStatus, taskId);
  },

  /**
   * Clear the verdict audit fields (ai_summary / verdict_reason / verdict_at)
   * without touching sub_status. Called when a task resumes execution (a fresh
   * run starts) so a stale premature verdict — written when an earlier run ended
   * at an AskUserQuestion pause — does not linger on the row and taint the next
   * verdict judge (which reads these as weak prior-verdict context) nor surface
   * on the board as a residual "failed" tag after the task has moved on.
   */
  clearVerdictFields(taskId: string): void {
    const db = getConnection();
    db.prepare(`
      UPDATE tasks
      SET ai_summary = NULL, verdict_reason = NULL, verdict_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(taskId);
  },

  /**
   * Persist the operator agent's post-run verdict on a task: an AI summary,
   * the verdict folded into sub_status, an optional reason, and the moment it
   * was recorded. Validates the verdict BEFORE touching the DB so an invalid
   * value can never produce a partial write. Returns the refreshed row (null if
   * the task vanished).
   */
  writeSummary(taskId: string, input: { summary: string; verdict: AiVerdict; reason?: string | null }): TaskRow | null {
    if (!isAiVerdict(input.verdict)) {
      throw new Error(`invalid verdict: ${String(input.verdict)}`);
    }
    const db = getConnection();
    db.prepare(`
      UPDATE tasks
      SET ai_summary = ?, sub_status = ?, verdict_reason = ?, verdict_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(input.summary, input.verdict, input.reason ?? null, taskId);
    return tasksDb.getTask(taskId);
  },

  linkSession(taskId: string, sessionId: string | null): void {
    const db = getConnection();
    db.prepare('UPDATE tasks SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(sessionId, taskId);
  },

  deleteTask(taskId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  },

  moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): void {
    const db = getConnection();
    const current = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: TaskStatus } | undefined;
    if (!current) return;
    let position: number;
    if (beforeId && afterId) {
      const before = tasksDb.getTask(beforeId);
      const after = tasksDb.getTask(afterId);
      const beforePos = before?.position ?? 0;
      const afterPos = after?.position ?? beforePos;
      position = (beforePos + afterPos) / 2;
    } else if (beforeId) {
      const before = tasksDb.getTask(beforeId);
      position = (before?.position ?? 0) - 1;
    } else if (afterId) {
      const after = tasksDb.getTask(afterId);
      position = (after?.position ?? 0) + 1;
    } else {
      const max = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE status = ?').get(status) as { p: number };
      position = max.p;
    }
    const sets = ['status = ?', 'position = ?', 'updated_at = CURRENT_TIMESTAMP', ...statusTimestampSets(current.status, status)];
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(status, position, taskId);
  },
};
