import { cn } from '../../lib/utils';

export type ScheduledTab = 'schedules' | 'runs';

const TABS: { value: ScheduledTab; label: string }[] = [
  { value: 'schedules', label: '调度' },
  { value: 'runs', label: '运行记录' },
];

/**
 * 定时任务页的子标签。视觉对齐任务页 header 的视图切换器（TaskBoard.tsx 的
 * 「看板 / 表格 / ⏰ 定时」）：同一个分段控件外壳 + 选中态实色胶囊。
 *
 * 它占的是 ScheduledTasksView 原来那行静态标题「⏰ 定时任务」的位置 —— 那行标题
 * 已被删掉，避免和子标签条叠成两行 chrome。
 */
export function ScheduledTabBar({ tab, onChange }: { tab: ScheduledTab; onChange: (next: ScheduledTab) => void }) {
  return (
    <div className="flex flex-shrink-0 items-center px-3 py-2 sm:px-4">
      <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
        {TABS.map(({ value, label }) => {
          const isActive = tab === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                if (!isActive) onChange(value);
              }}
              className={cn(
                'rounded-lg px-2.5 py-2 text-sm font-normal transition-all',
                isActive
                  ? 'bg-card text-card-foreground shadow-raised-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
