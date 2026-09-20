import type { AlertSeverity } from './alert-format.js';
import type { NotificationsDb, NotificationRow, ListOptions } from './notifications.db.js';

/** emit 的入参：来源标识（scheduleId 或 taskId）决定去重键前缀。 */
export type EmitInput = {
  severity: AlertSeverity;
  title: string;
  body?: string | null;
  code?: string | null;
  scheduleId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
};

export type NotificationBroadcast =
  | { kind: 'notification_created'; payload: NotificationRow }
  | { kind: 'notification_updated'; payload: { notification_id?: string; unreadCount: number } };

export type NotificationsServiceDeps = {
  broadcast: (event: NotificationBroadcast) => void;
  /** 保留上限；超出裁剪最旧已读（spec §11）。 */
  maxRows?: number;
  /** 保留天数；超过的已读按时间裁剪（spec §11，默认 90）。 */
  maxAgeDays?: number;
};

/**
 * 去重键（spec §6）：定时任务用 schedule_id，普通任务用 task_id；类别用 code，
 * 无 code 退化到 title。前缀缺失时用 'anon'，避免不同来源误合并。
 */
function buildDedupeKey(input: EmitInput): string {
  const source = input.scheduleId ?? input.taskId ?? 'anon';
  const category = input.code ?? input.title;
  return `${source}:${category}`;
}

export function createNotificationsService(db: NotificationsDb, deps: NotificationsServiceDeps) {
  const maxRows = deps.maxRows ?? 500;
  const maxAgeDays = deps.maxAgeDays ?? 90;

  return {
    /** 落库（合并去重）+ 裁剪 + 广播。新建发 created，命中已存在发 updated。 */
    emit(input: EmitInput): NotificationRow {
      const dedupeKey = buildDedupeKey(input);
      const row = db.upsert({
        severity: input.severity,
        title: input.title,
        dedupeKey,
        body: input.body ?? null,
        code: input.code ?? null,
        scheduleId: input.scheduleId ?? null,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
        projectPath: input.projectPath ?? null,
      });
      db.pruneOldRead({ maxRows, maxAgeDays });
      // occurrence_count === 1 → 首次出现（新建条），发 created；否则是已存在
      // 未读条的合并（或已读复活，计数≥2），发 updated 只带计数。
      if (row.occurrence_count === 1) {
        deps.broadcast({ kind: 'notification_created', payload: row });
      } else {
        deps.broadcast({ kind: 'notification_updated', payload: { notification_id: row.notification_id, unreadCount: db.unreadCount() } });
      }
      return row;
    },

    list(options: ListOptions): NotificationRow[] {
      return db.list(options);
    },

    unreadCount(): number {
      return db.unreadCount();
    },

    markRead(id: string): NotificationRow | null {
      const row = db.markRead(id);
      deps.broadcast({ kind: 'notification_updated', payload: { notification_id: id, unreadCount: db.unreadCount() } });
      return row;
    },

    markAllRead(): void {
      db.markAllRead();
      deps.broadcast({ kind: 'notification_updated', payload: { unreadCount: db.unreadCount() } });
    },
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
