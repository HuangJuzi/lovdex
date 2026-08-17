import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ensureOperatorSession } from './operatorSession';
import { Button } from '../../shared/view/ui';

/**
 * 助手面板入口（路由组件 /assistant）。
 *
 * 「助手」是一个跑在 operator 工作区的 Claude session（is_operator=1），后端
 * 在 queryClaudeSDK 的 operator 分支里给它换上封闭工具集（list_tasks /
 * create_task / write_task_summary 等，无 Bash/Edit/Write）。
 *
 * 这里只负责「拿到一个 operator session 然后打开它」：复用现有 /session/:id
 * 聊天 UI，不重写一套 chat。用 SPA navigate 跳到 /session/:id——/assistant 路由
 * 下 AppContent 未挂载，跳转后它会全新挂载并重拉项目列表（含 operator 工作区
 * 这个项目 + 它的 session），session 能正确解析为 selectedSession，且无整页刷新。
 *
 * 两种入口：
 *  - /assistant        → 复用最近一个 operator session，没有则新建
 *  - /assistant?new=1  → 强制新建一个 operator session（侧边栏「+」按钮）
 *
 * 工作区路径由后端 operator 配置决定（不再出现在设置页面），客户端不需要也不
 * 传 projectPath。
 */
export function AssistantPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const forceNew = searchParams.get('new') === '1';
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // `ensureOperatorSession` runs the whole flow (settings gate → reuse
      // latest → create) single-flighted at module level, so React StrictMode's
      // dev remount shares ONE in-flight flow instead of POSTing twice.
      const result = await ensureOperatorSession(forceNew);
      if (!result.ok) {
        if (!cancelled) {
          if (result.reason === 'disabled') {
            setError('交互式 Lovdex助手已在设置中关闭');
          } else if (result.reason === 'http') {
            setError(`创建 Lovdex助手会话失败（${result.status}）`);
          } else if (result.reason === 'missing-id') {
            setError('创建 Lovdex助手会话失败：无 sessionId');
          } else {
            setError(result.message ?? '启动 Lovdex助手失败');
          }
        }
        return;
      }
      if (cancelled) return;
      const { sessionId } = result;
      // SPA 跳转而非整页刷新：/assistant 路由下 AppContent 未挂载，跳到
      // /session/:id 后 AppContent 全新挂载、useProjectsState 重拉项目列表。
      // 新建的 session 是最新的，必然出现在 operator 工作区项目的 payload 里，
      // 解析循环能直接命中——无需整页 reload，避免白屏闪烁。
      navigate(`/session/${sessionId}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [forceNew, navigate]);

  if (error) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <div className="text-sm text-red-500">{error}</div>
        <Button variant="chunky" size="sm" onClick={() => navigate('/tasks')}>
          返回任务面板
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">正在启动 Lovdex助手…</div>
    </div>
  );
}

export default AssistantPanel;
