import type { ComponentType, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

type SidebarSectionRowProps = {
  icon: ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * hover 才显形的右侧动作区。每个动作**自己**带
   * `opacity-0 group-hover:opacity-100 touch:opacity-100` —— 组件不替它兜底，
   * 因为各动作的配色不同（primary / foreground / destructive）。
   */
  actions?: ReactNode;
  /** 挂在最外层 wrapper 上，用于加分隔线等。tailwind-merge 会正确覆盖。 */
  className?: string;
};

/**
 * 侧栏区块的整行标题：图标 + 标题在左，动作区 + 折叠箭头在右，**箭头永远在最右**。
 * 样式对齐 SidebarAssistant / SidebarScheduledEntry / SidebarInboxEntry 那几行。
 *
 * 触屏没有 hover，动作区靠 `touch:opacity-100` 常显 —— 那是 src/index.css 里
 * `@media (hover: none) and (pointer: coarse)` 下的 `opacity: 1 !important`。
 * 所以一份 markup 同时管桌面和触屏，不必像 SidebarAssistant 那样拆两套。
 */
export default function SidebarSectionRow({
  icon: Icon,
  label,
  collapsed,
  onToggle,
  actions,
  className,
}: SidebarSectionRowProps) {
  return (
    <div className={cn('group flex-shrink-0 px-2 pt-1.5 md:px-1.5', className)}>
      <Button
        variant="ghost"
        className="flex h-auto w-full justify-between bg-primary/5 p-2 font-normal hover:bg-muted"
        onClick={onToggle}
        title={`${collapsed ? '展开' : '收起'} ${label}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Icon className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">
            {label}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {actions}
          {collapsed ? (
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )}
        </div>
      </Button>
    </div>
  );
}
