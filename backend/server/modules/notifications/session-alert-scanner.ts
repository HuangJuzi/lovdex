import { parseAlertsFromMessages } from './alert-parser.js';
import type { NotificationsService } from './notifications.service.js';

type ScanEvent = { kind?: string; role?: string; content?: string };

export type SessionAlertScannerDeps = {
  getSessionById: (id: string) => { is_operator?: number | boolean | null } | null;
  getTaskBySession: (id: string) => {
    task_id?: string | null;
    source_schedule_id?: string | null;
    project_path?: string | null;
  } | null;
  notifications: NotificationsService;
};

/**
 * 会话结束时扫描**本轮内存缓冲**（`ChatRun.events`）里的 assistant 文本，提取
 * `lovdex-alert` 标记并投递到收件箱。
 *
 * 为什么扫内存而不是 fetchHistory：complete 到达时本轮 assistant 文本已在
 * `run.events` 里，省掉一次全量转录读取（远程会话还省一次 RPC）。
 *
 * operator 会话跳过 —— 助手没有 Skill 工具、也不该靠解释格式时输出的代码块发通知，
 * 它走 `send_notification` MCP 工具这条确定性路径。
 *
 * 永不抛：与 verdict LLM 同栈，解析/读取失败只 warn，绝不影响会话生命周期。
 */
export function createSessionAlertScanner(deps: SessionAlertScannerDeps) {
  return {
    scanCompletedRun(input: { appSessionId: string; events: readonly ScanEvent[] }): void {
      try {
        const session = deps.getSessionById(input.appSessionId);
        if (session?.is_operator) return;

        const alerts = parseAlertsFromMessages(input.events);
        if (alerts.length === 0) return;

        const task = deps.getTaskBySession(input.appSessionId);
        for (const alert of alerts) {
          deps.notifications.emit({
            severity: alert.severity,
            title: alert.title,
            body: alert.body ?? null,
            code: alert.code ?? null,
            scheduleId: task?.source_schedule_id ?? null,
            taskId: task?.task_id ?? null,
            sessionId: input.appSessionId,
            projectPath: task?.project_path ?? null,
          });
        }
      } catch (error) {
        console.warn('[notifications] session alert scan failed', { sessionId: input.appSessionId }, error);
      }
    },
  };
}

export type SessionAlertScanner = ReturnType<typeof createSessionAlertScanner>;
