import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FolderOpen, GitBranch, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { AppTab } from '../../types/app';

type WorkspaceTab = 'chat' | 'files' | 'git';

type WorkspaceNavProps = {
  /** 工作区模式：当前激活的 tab（用于高亮）。任务模式不传。 */
  activeTab?: AppTab;
  /** 工作区模式：切换 tab 回调（原地切换，不导航）。任务模式不传。 */
  onSelectTab?: (tab: WorkspaceTab) => void;
  /** 任务模式：点击 Chat/Files/源码管理 跳转到的任务关联项目路径。 */
  projectPath?: string;
  /** 选填：跟在 tabs 后面的右侧操作区（如「转为任务/任务详情」），由调用方控制条件渲染。 */
  children?: ReactNode;
  className?: string;
};

/**
 * 统一的右上角导航：Chat / Files / 源码管理（工作区 tab）+ 右侧操作区（children）；
 * 任务模式（传 projectPath）左侧多一个「返回任务面板」。
 *
 * 工作区模式（传 onSelectTab）：原地切换 activeTab；任务模式（传 projectPath）：
 * 跳转到关联项目的工作区对应 tab（通过 `/?project=…&tab=…` 深链）。
 */
export function WorkspaceNav({
  activeTab,
  onSelectTab,
  projectPath,
  children,
  className,
}: WorkspaceNavProps) {
  const navigate = useNavigate();

  const tabItems: { value: WorkspaceTab; label: string; icon: LucideIcon; iconClass: string }[] = [
    { value: 'chat', label: 'Chat', icon: MessageSquare, iconClass: 'text-sky-500' },
    { value: 'files', label: 'Files', icon: FolderOpen, iconClass: 'text-emerald-500' },
    { value: 'git', label: 'Source Control', icon: GitBranch, iconClass: 'text-violet-500' },
  ];

  const handleTab = (tab: WorkspaceTab) => {
    if (onSelectTab) {
      onSelectTab(tab);
      return;
    }
    if (projectPath) {
      navigate(`/?project=${encodeURIComponent(projectPath)}&tab=${tab}`);
    }
  };

  return (
    <div className={cn('flex rounded-xl border border-border/70 bg-muted/50 p-0.5', className)}>
      {projectPath && (
        <>
          <button
            type="button"
            title="返回任务面板"
            aria-label="返回任务面板"
            onClick={() => navigate('/tasks')}
            className="flex items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal text-muted-foreground transition-all hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            {/* 移动端（<640px）只留返回图标 */}
            <span className="hidden sm:inline">返回任务面板</span>
          </button>
          <span className="mx-0.5 w-px self-stretch bg-border/70" aria-hidden="true" />
        </>
      )}
      {tabItems.map(({ value, label, icon: Icon, iconClass }) => {
        const isActive = onSelectTab && activeTab === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            title={label}
            aria-label={label}
            onClick={() => handleTab(value)}
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal transition-all',
              isActive
                ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5 flex-shrink-0', isActive ? 'text-primary' : iconClass)} />
            {/* 移动端（<640px）只留图标；断点与 Task 页 isMobile(640) 对齐。 */}
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
      {children && (
        <>
          <span className="mx-0.5 w-px self-stretch bg-border/70" aria-hidden="true" />
          {children}
        </>
      )}
    </div>
  );
}