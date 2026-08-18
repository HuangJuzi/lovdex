import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';

import type { Project, ProjectSession } from '../../../../types/app';
import { resolveSessionTitle } from '../../../../utils/sessionTitle';
import { formatCompactSessionAge, getRecentSessions, getSessionTime } from '../../utils/utils';

type SidebarRecentSessionsProps = {
  projects: Project[];
  /** 点击某条最近会话：打开该会话对话（父级负责导航）。 */
  onRecentSessionSelect: (session: ProjectSession, project: Project) => void;
};

/**
 * 侧边栏「最近任务」区块：展示最近活跃的 session（含助手会话），最多 10 条。
 * 置于项目列表滚动区与底部设置之间。样式对齐 SidebarScheduledEntry / SidebarAssistant。
 */
export default function SidebarRecentSessions({
  projects,
  onRecentSessionSelect,
}: SidebarRecentSessionsProps) {
  const [collapsed, setCollapsed] = useState(false);
  // 相对时间自刷新，不依赖父级 timer（30s 粒度足够）。
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setCurrentTime(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const recent = useMemo(() => getRecentSessions(projects, 10), [projects]);

  return (
    <div className="flex-shrink-0 border-t border-border/60 px-2 pb-2 pt-1.5 md:px-1.5">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? '展开 最近任务' : '收起 最近任务'}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
        <History className="h-4 w-4 flex-shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">最近任务</span>
      </button>

      {!collapsed && (
        <div className="ml-3 max-h-[28vh] overflow-y-auto border-l border-border pl-3">
          {recent.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">暂无最近任务</p>
          ) : (
            <div className="space-y-0.5 py-1">
              {recent.map(({ session, project }) => {
                const provider = session.__provider ?? session.provider;
                return (
                  <button
                    key={`${project.projectId}-${session.id}`}
                    type="button"
                    onClick={() => onRecentSessionSelect(session, project)}
                    className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs font-normal text-foreground">
                        {resolveSessionTitle(session) ?? '新建会话'}
                      </span>
                      {provider && provider !== 'claude' && (
                        <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                          {provider}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3">
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {project.displayName || project.projectId}
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
                        {formatCompactSessionAge(getSessionTime(session), currentTime)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
