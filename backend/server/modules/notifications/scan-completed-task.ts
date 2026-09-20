import { parseAlertsFromMessages } from './alert-parser.js';
import type { NotificationsService } from './notifications.service.js';

export type ScanDeps = {
  /** 复用 sessionsService.fetchHistory；返回 { messages }。 */
  fetchHistory: (sessionId: string, opts?: { limit?: number; offset?: number }) => Promise<{ messages?: unknown[] }>;
  notifications: NotificationsService;
  /** 取任务的关联信息（project_path / schedule 来源），用于去重键与跳转。 */
  getTaskMeta: (taskId: string) => { scheduleId?: string | null; projectPath?: string | null } | null;
};

/**
 * 任务完成时读转录、提取 lovdex-alert 标记、逐条 emit。挂在 index.js 的
 * onTaskCompleted（只在 state==='completed' 触发）。永不抛：解析/读取失败只
 * console.warn，绝不影响任务生命周期（与 verdict LLM 同栈，spec §4）。
 */
export async function scanCompletedTaskForAlerts(
  args: { taskId: string; sessionId: string },
  deps: ScanDeps,
): Promise<void> {
  try {
    const history = await deps.fetchHistory(args.sessionId, { limit: 200, offset: 0 });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const alerts = parseAlertsFromMessages(messages as never);
    if (alerts.length === 0) return;
    const meta = deps.getTaskMeta(args.taskId) ?? {};
    for (const alert of alerts) {
      deps.notifications.emit({
        severity: alert.severity,
        title: alert.title,
        body: alert.body ?? null,
        code: alert.code ?? null,
        scheduleId: meta.scheduleId ?? null,
        taskId: args.taskId,
        sessionId: args.sessionId,
        projectPath: meta.projectPath ?? null,
      });
    }
  } catch (error) {
    console.warn('[notifications] scan failed', { taskId: args.taskId }, error);
  }
}
