import { useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';

import type { Project, ProjectSession } from '../../../../types/app';
import { resolveSessionTitle } from '../../../../utils/sessionTitle';
import { formatCompactSessionAge, getRecentSessions, getSessionTime } from '../../utils/utils';

import SidebarSectionRow from './SidebarSectionRow';

type SidebarRecentSessionsProps = {
  projects: Project[];
  /** 点击某条最近会话：打开该会话对话（父级负责导航）。 */
  onRecentSessionSelect: (session: ProjectSession, project: Project) => void;
};

// 折叠状态持久化，避免切到 /tasks 等独立路由再回到主页面时列表被重置为展开。
// 模式对齐 SidebarAssistant 的 COLLAPSE_KEY（'lovdex:assistant:sessions-collapsed'）。
const COLLAPSE_KEY = 'lovdex:sidebar:recent-sessions-collapsed';

/**
 * 侧边栏「最近会话」区块：展示最近活跃的 session（含助手会话），最多 10 条。
 * 置于项目列表滚动区与底部设置之间。样式对齐 SidebarScheduledEntry / SidebarAssistant。
 */
export default function SidebarRecentSessions({
  projects,
  onRecentSessionSelect,
}: SidebarRecentSessionsProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  // 相对时间自刷新，不依赖父级 timer（30s 粒度足够）。
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setCurrentTime(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const recent = useMemo(() => getRecentSessions(projects, 10), [projects]);

  const toggleCollapsed = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage failures
      }
      return next;
    });

  return (
    <SidebarSectionRow
      icon={History}
      label="最近会话"
      collapsed={collapsed}
      onToggle={toggleCollapsed}
      // 行组件自带 `px-2 pt-1.5 md:px-1.5`；分隔线与下间距通过 className 挂在它的 wrapper 上。
      className="border-t border-border/60 pb-2"
    >
      {!collapsed && (
        // 水平内边距由行组件 wrapper 统一提供，这里只保留列表自己的缩进线。
        <div className="ml-3 max-h-[28vh] overflow-y-auto border-l border-border pl-3">
          {recent.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">暂无最近会话</p>
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
                        <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-4xs uppercase text-muted-foreground">
                          {provider}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3">
                      <span className="min-w-0 flex-1 truncate text-3xs text-muted-foreground">
                        {project.displayName || project.projectId}
                      </span>
                      <span className="flex-shrink-0 text-3xs text-muted-foreground/60">
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
    </SidebarSectionRow>
  );
}
