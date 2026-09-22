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
   * `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100`
   * —— 组件不替它兜底，因为各动作的配色不同（primary / foreground / destructive）。
   * `group-focus-within:` 不能省：键盘 Tab 进动作区时 `group-hover:` 不触发，
   * 焦点会落在 `opacity: 0` 的元素上，用户既看不见按钮也看不见焦点。
   */
  actions?: ReactNode;
  /** 挂在最外层 wrapper 上，用于加分隔线等。tailwind-merge 会正确覆盖。 */
  className?: string;
  /**
   * 区块体（可折叠的列表等）。渲染在标题行**下方、同一个 wrapper 内**，
   * 这样 wrapper 的 `px-2 pt-1.5 md:px-1.5` 同时作用于标题与区块体 ——
   * 调用方不必在兄弟节点上复刻一遍内边距，`className` 里的 `pb-2` 也
   * 自然落在区块底部而不是标题与列表之间。
   */
  children?: ReactNode;
};

/**
 * 侧栏区块的整行标题：图标 + 标题在左，动作区 + 折叠箭头在右，**箭头永远在最右**。
 * 样式对齐 SidebarAssistant / SidebarScheduledEntry / SidebarInboxEntry 那几行。
 *
 * 触屏没有 hover，动作区靠 `touch:opacity-100` 常显 —— 那是 src/index.css 里
 * `@media (hover: none) and (pointer: coarse)` 下的 `opacity: 1 !important`。
 * 所以一份 markup 同时管桌面和触屏，不必像 SidebarAssistant 那样拆两套。
 *
 * 最外层 wrapper 带 `group`，正是为了让 `group-hover:` / `group-focus-within:`
 * 这些变体能作用到传入的 `actions` 后代上 —— 删掉它，动作区的显形规则会全部失效。
 *
 * `children` 与标题行共用同一个 wrapper：wrapper 的水平内边距同时管住两者，
 * 调用方传的 `className`（`pb-2` 等）落在整个区块的底部。
 *
 * 行按钮显式带 `aria-label={label}`：`actions` 里嵌的 `div role="button"` 自带
 * `aria-label`，不显式指定名字的话它会被折进行按钮的 name-from-content，
 * 无障碍树里读成「项目 新建项目」。可见文案本来就等于 `label`，所以这不是
 * 用不同的名字覆盖可见标签，只是挡住后代内容污染名字；展开/收起状态仍由
 * `aria-expanded` 承载（那才是 disclosure 控件的正确表达）。
 */
export default function SidebarSectionRow({
  icon: Icon,
  label,
  collapsed,
  onToggle,
  actions,
  className,
  children,
}: SidebarSectionRowProps) {
  return (
    <div className={cn('group flex-shrink-0 px-2 pt-1.5 md:px-1.5', className)}>
      <Button
        variant="ghost"
        className="flex h-auto w-full justify-between bg-primary/5 p-2 font-normal hover:bg-muted"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={label}
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
      {children}
    </div>
  );
}
