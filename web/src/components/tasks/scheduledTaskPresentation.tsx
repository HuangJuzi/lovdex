import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ScheduledTask, Task } from '../../types/app';

import { lastRunTarget } from './lastRunTarget';

const MODE_BADGE_CLASS = {
  auto: 'rounded-full bg-success/10 px-2 py-0.5 font-semibold text-success',
  remind: 'rounded-full bg-warning/10 px-2 py-0.5 font-semibold text-warning',
} as const;

/** 模式徽标：只表达 auto_run 两态。桌面「模式」列常显；卡片/详情经 statusBadge 或直接复用。 */
export function ModeBadge(task: ScheduledTask) {
  return task.auto_run === 1 ? (
    <span className={MODE_BADGE_CLASS.auto}>✅ 自动执行</span>
  ) : (
    <span className={MODE_BADGE_CLASS.remind}>🔔 仅提醒</span>
  );
}

/**
 * 只在开启时渲染。默认关是绝大多数情况，给它一个「已关闭」徽标只会让列表更吵，
 * 而这个徽标的唯一作用是让人扫一眼看出哪些任务在无人值守时会自己批。
 */
export function AutoApproveBadge(task: ScheduledTask) {
  // INTERIM: still keyed to the legacy auto_approve flag, which the backend no
  // longer writes — new rows keep the badge dark. Task 15 rekeys this badge
  // onto permission_mode ('autoApprove'); the ScheduledTasksView test pins this
  // gap until then.
  if ((task as { auto_approve?: number }).auto_approve !== 1) return null;
  return (
    <span className="rounded-full bg-info/10 px-2 py-0.5 font-semibold text-info">⚡ 自动审批</span>
  );
}

export function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="text-right font-medium text-card-foreground">{value}</span>
    </div>
  );
}

/**
 * 「上次触发」链接：有可用会话就跳会话，否则回退任务详情页，从没跑过渲染 `—`。
 * 自带 stopPropagation —— 在列表里点它是去会话，不是选中这一行。
 */
export function LastRunLink({ schedule, taskById }: { schedule: ScheduledTask; taskById: Map<string, Task> }) {
  const target = lastRunTarget(schedule, taskById);
  if (target.kind === 'none') return <>—</>;
  return (
    <Link className="text-primary underline" to={target.path} onClick={(e) => e.stopPropagation()}>
      {target.kind === 'session' ? '打开会话' : '查看任务'}
    </Link>
  );
}
