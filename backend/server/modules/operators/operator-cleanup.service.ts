import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import { sessionsDb, tasksDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

export type OperatorCleanupResult = {
  removed: number;
  failed: number;
  sessionIds: string[];
};

/**
 * 硬删 Lovdex助手 工作区内 is_operator = 0 的残留会话（DB 行 + transcript 文件）。
 * 这些行是 is_operator 列迁移前的历史遗留；工作区是助手专用，项目列表隐藏后
 * 它们不再有 UI 入口，属于孤儿数据。幂等：只作用于当前工作区路径。
 *
 * 破坏性操作——删除后不可恢复。
 */
export async function cleanOperatorWorkspaceLegacySessions(): Promise<OperatorCleanupResult> {
  const workspace = getOperatorConfig().workspace;
  if (!workspace) {
    return { removed: 0, failed: 0, sessionIds: [] };
  }

  const orphaned = sessionsDb.getNonOperatorSessionsByProjectPath(workspace);
  const sessionIds: string[] = [];
  let failed = 0;

  for (const session of orphaned) {
    try {
      // 仍被任务引用的会话删除后，任务侧 get_session_transcript 会 404（任务行
      // 的 session_id 变成悬空外键）。2026-08-18 曾因此误删 23 个含 in_review
      // 任务的会话。按需求仍然删除，但必须先打出醒目提醒，便于事后追溯。
      const linkedTask = tasksDb.getTaskBySessionId(session.session_id);
      if (linkedTask) {
        console.warn(
          '[operator-cleanup] WARNING: 即将删除的会话仍挂在任务上，删除后该任务将无法再读取会话记录',
          {
            sessionId: session.session_id,
            taskId: linkedTask.task_id,
            taskTitle: linkedTask.title,
            taskStatus: linkedTask.status,
          },
        );
      }
      await sessionsService.deleteOrArchiveSessionById(session.session_id, {
        force: true,
        deletedFromDisk: true,
      });
      sessionIds.push(session.session_id);
    } catch (error) {
      failed += 1;
      console.error('[operator-cleanup] failed to delete session', {
        sessionId: session.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (sessionIds.length > 0) {
    console.log(
      `[operator-cleanup] removed ${sessionIds.length} orphaned non-operator session(s) from the Lovdex 助手 workspace`,
      sessionIds,
    );
  }

  if (failed > 0) {
    console.error(
      `[operator-cleanup] failed to remove ${failed} orphaned non-operator session(s) from the Lovdex 助手 workspace`,
    );
  }

  return { removed: sessionIds.length, failed, sessionIds };
}
