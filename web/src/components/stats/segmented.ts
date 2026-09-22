/**
 * 分段控件（segmented control）的按钮样式。
 *
 * 全站惯例见 `ViewSwitcher.tsx:49` / `ScheduledTabBar.tsx:20` / `TaskBoard.tsx:287`：
 * 外层 `flex rounded-xl border border-border/70 bg-muted/50 p-0.5`，内层按钮用这两个类。
 *
 * 抽出来是因为统计页的「范围」「维度」留在页头、「口径」搬进了 TPM 卡片，
 * 两处需要同一份样式。
 */
export const SEGMENT_ACTIVE =
  'rounded-lg bg-card px-2 py-1 text-xs font-normal text-card-foreground shadow-sm';
export const SEGMENT_IDLE =
  'rounded-lg px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground';
