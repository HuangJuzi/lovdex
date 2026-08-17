import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { ScheduledTaskRow, ScheduledTaskScheduleType } from '@/shared/types.js';

export const SCHEDULE_TYPES: readonly ScheduledTaskScheduleType[] = ['once', 'interval', 'cron'];

export function isScheduleType(value: unknown): value is ScheduledTaskScheduleType {
  return typeof value === 'string' && (SCHEDULE_TYPES as readonly string[]).includes(value);
}

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeScheduledTaskRow(row: ScheduledTaskRow): ScheduledTaskRow {
  return {
    ...row,
    next_run_at: normalizeTimestamp(row.next_run_at) ?? row.next_run_at,
    last_run_at: row.last_run_at ? (normalizeTimestamp(row.last_run_at) ?? row.last_run_at) : null,
    run_at: row.run_at ? (normalizeTimestamp(row.run_at) ?? row.run_at) : null,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

export const scheduledTasksDb = {
  createScheduledTask(input: {
    title: string;
    description?: string | null;
    projectPath?: string | null;
    executorProvider?: string;
    executorModel?: string | null;
    priority?: string;
    label?: string;
    autoRun?: boolean | 0 | 1;
    scheduleType: ScheduledTaskScheduleType;
    cronExpr?: string | null;
    intervalSeconds?: number | null;
    runAt?: string | null;
    timezone?: string;
    nextRunAt: string;
  }): ScheduledTaskRow {
    const db = getConnection();
    const scheduleId = randomUUID();
    const row = db.prepare(`
      INSERT INTO scheduled_tasks (schedule_id, title, description, project_path, executor_provider, executor_model, priority, label, is_operator, auto_run, schedule_type, cron_expr, interval_seconds, run_at, timezone, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      scheduleId,
      input.title,
      input.description ?? null,
      input.projectPath ?? null,
      input.executorProvider ?? 'claude',
      input.executorModel ?? null,
      input.priority ?? 'P2',
      input.label ?? 'other',
      input.projectPath ? 0 : 1,
      input.autoRun === false || input.autoRun === 0 ? 0 : 1,
      input.scheduleType,
      input.cronExpr ?? null,
      input.intervalSeconds ?? null,
      input.runAt ?? null,
      input.timezone ?? 'local',
      input.nextRunAt,
    ) as ScheduledTaskRow;
    return normalizeScheduledTaskRow(row);
  },

  getScheduledTask(scheduleId: string): ScheduledTaskRow | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE schedule_id = ?').get(scheduleId) as ScheduledTaskRow | undefined;
    return row ? normalizeScheduledTaskRow(row) : null;
  },

  listScheduledTasks(filter: { projectPath?: string; enabled?: boolean } = {}): ScheduledTaskRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectPath) { clauses.push('project_path = ?'); params.push(filter.projectPath); }
    if (filter.enabled !== undefined) { clauses.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return (db.prepare(`SELECT * FROM scheduled_tasks ${where} ORDER BY next_run_at ASC`).all(...params) as ScheduledTaskRow[]).map(normalizeScheduledTaskRow);
  },

  updateScheduledTask(scheduleId: string, updates: Record<string, unknown>): ScheduledTaskRow | null {
    const db = getConnection();
    const sets: string[] = [];
    const params: unknown[] = [];
    const allowed: Record<string, (v: unknown) => unknown> = {
      title: (v) => v, description: (v) => v, project_path: (v) => v,
      executor_provider: (v) => v, executor_model: (v) => v, priority: (v) => v, label: (v) => v,
      is_operator: (v) => (v ? 1 : 0), auto_run: (v) => (v ? 1 : 0),
      schedule_type: (v) => v, cron_expr: (v) => v, interval_seconds: (v) => v, run_at: (v) => v,
      timezone: (v) => v, next_run_at: (v) => v, last_run_at: (v) => v, last_task_id: (v) => v,
      enabled: (v) => (v ? 1 : 0),
    };
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in allowed)) continue;
      sets.push(`${key} = ?`);
      params.push(allowed[key](value));
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(scheduleId);
    if (sets.length === 1) return scheduledTasksDb.getScheduledTask(scheduleId);
    db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE schedule_id = ?`).run(...params);
    return scheduledTasksDb.getScheduledTask(scheduleId);
  },

  deleteScheduledTask(scheduleId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM scheduled_tasks WHERE schedule_id = ?').run(scheduleId);
  },

  listDueScheduledTasks(now: string): ScheduledTaskRow[] {
    const db = getConnection();
    return (db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC').all(now) as ScheduledTaskRow[]).map(normalizeScheduledTaskRow);
  },

  listMissedSince(now: string): ScheduledTaskRow[] {
    const db = getConnection();
    return (db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at < ? ORDER BY next_run_at ASC').all(now) as ScheduledTaskRow[]).map(normalizeScheduledTaskRow);
  },
};