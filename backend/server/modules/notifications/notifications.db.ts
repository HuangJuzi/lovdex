import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { AlertSeverity } from './alert-format.js';

export type NotificationRow = {
  notification_id: string;
  severity: AlertSeverity;
  code: string | null;
  title: string;
  body: string | null;
  schedule_id: string | null;
  task_id: string | null;
  session_id: string | null;
  project_path: string | null;
  dedupe_key: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  read_at: string | null;
  created_at: string;
};

export type UpsertInput = {
  severity: AlertSeverity;
  title: string;
  dedupeKey: string;
  body?: string | null;
  code?: string | null;
  scheduleId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
};

export type ListOptions = { limit: number; offset: number; unreadOnly?: boolean };

/**
 * DI 工厂：默认用生产共享连接（getConnection），测试传入内存库。
 * 合并语义见 spec §6：同 dedupe_key 未读→计数++刷新；已读→复活原条。
 */
export function createNotificationsDb(connection?: BetterSqlite3.Database) {
  const db = connection ?? getConnection();

  const getByDedupe = db.prepare<[string]>(
    'SELECT * FROM notifications WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1',
  );

  const repo = {
    upsert(input: UpsertInput): NotificationRow {
      const existing = getByDedupe.get(input.dedupeKey) as NotificationRow | undefined;
      if (existing) {
        // 未读命中：计数++ + 刷新内容；已读命中：额外复活（read_at=NULL）。
        db.prepare(`
          UPDATE notifications
          SET occurrence_count = occurrence_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              severity = @severity,
              title = @title,
              body = @body,
              code = @code,
              read_at = NULL
          WHERE notification_id = @id
        `).run({
          id: existing.notification_id,
          severity: input.severity,
          title: input.title,
          body: input.body ?? null,
          code: input.code ?? null,
        });
        return db.prepare('SELECT * FROM notifications WHERE notification_id = ?')
          .get(existing.notification_id) as NotificationRow;
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO notifications
          (notification_id, severity, code, title, body, schedule_id, task_id, session_id, project_path, dedupe_key)
        VALUES (@id, @severity, @code, @title, @body, @scheduleId, @taskId, @sessionId, @projectPath, @dedupeKey)
      `).run({
        id,
        severity: input.severity,
        code: input.code ?? null,
        title: input.title,
        body: input.body ?? null,
        scheduleId: input.scheduleId ?? null,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
        projectPath: input.projectPath ?? null,
        dedupeKey: input.dedupeKey,
      });
      return db.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(id) as NotificationRow;
    },

    list(options: ListOptions): NotificationRow[] {
      const where = options.unreadOnly ? 'WHERE read_at IS NULL' : '';
      return db.prepare(
        `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(options.limit, options.offset) as NotificationRow[];
    },

    get(id: string): NotificationRow | null {
      return (db.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(id) as NotificationRow) ?? null;
    },

    markRead(id: string): NotificationRow | null {
      db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE notification_id = ? AND read_at IS NULL').run(id);
      return repo.get(id);
    },

    markAllRead(): void {
      db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL').run();
    },

    unreadCount(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number };
      return row.n;
    },

    /**
     * 保留策略（spec §11）：先按时间删超过 maxAgeDays 的已读，再按 maxRows 上限
     * 删最旧的已读。全程只裁已读，未读永不删。返回删除条数。
     */
    pruneOldRead(opts: { maxRows: number; maxAgeDays?: number }): number {
      let removed = 0;
      if (opts.maxAgeDays) {
        const info = db.prepare(
          `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < datetime('now', ?)`,
        ).run(`-${opts.maxAgeDays} days`);
        removed += info.changes;
      }
      const total = (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
      if (total > opts.maxRows) {
        const excess = total - opts.maxRows;
        const info = db.prepare(`
          DELETE FROM notifications WHERE notification_id IN (
            SELECT notification_id FROM notifications
            WHERE read_at IS NOT NULL
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(excess);
        removed += info.changes;
      }
      return removed;
    },
  };

  return repo;
}

export type NotificationsDb = ReturnType<typeof createNotificationsDb>;
