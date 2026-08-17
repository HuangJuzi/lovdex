import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import { sessionsDb } from '@/modules/database/index.js';
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
