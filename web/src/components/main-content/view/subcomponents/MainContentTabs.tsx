import { ClipboardList, FolderOpen, GitBranch, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AppTab } from '../../../../types/app';
import { cn } from '../../../../lib/utils';

type Props = {
  activeTab: AppTab;
  onSelect: (tab: 'chat' | 'files' | 'git') => void;
  className?: string;
};

/**
 * Merged workspace tabs: chat / files / git switch the in-place activeTab,
 * and the tasks item navigates to the /tasks route. This keeps a single
 * segmented control in the main-content header (Tasks stays an entry point
 * without duplicating a separate chat/tasks switcher).
 */
function MainContentTabs({ activeTab, onSelect, className }: Props) {
  const navigate = useNavigate();

  const workspace: { value: 'chat' | 'files' | 'git'; label: string; icon: typeof MessageSquare }[] = [
    { value: 'chat', label: 'Chat', icon: MessageSquare },
    { value: 'files', label: 'Files', icon: FolderOpen },
    { value: 'git', label: 'Source Control', icon: GitBranch },
  ];

  return (
    <div className={cn('flex rounded-xl border border-border/70 bg-muted/50 p-0.5', className)}>
      {workspace.map(({ value, label, icon: Icon }) => {
        const isActive = activeTab === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            title={label}
            aria-label={label}
            onClick={() => !isActive && onSelect(value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-normal transition-all',
              isActive
                ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('h-3 w-3 flex-shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
            {/* 移动端（<640px）只留图标，桌面端恢复文字；断点与 Task 页 isMobile(640) 对齐。 */}
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={false}
        title="Tasks"
        onClick={() => navigate('/tasks')}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-normal transition-all',
          'text-muted-foreground hover:text-foreground',
        )}
      >
        <ClipboardList className="h-3 w-3 flex-shrink-0 text-emerald-500" />
        Tasks
      </button>
    </div>
  );
}

export default MainContentTabs;