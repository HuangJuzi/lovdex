import { Link } from 'react-router-dom';

import type { ScheduledTask, Task } from '../../types/app';

import { projectLabel } from './projectLabel';
import { canOpenSession } from './taskActions';
import type { TaskProjectOption } from './TaskCard';
import { STATUS_META } from './taskStatus';
import { SubStatusBadge } from './SubStatusBadge';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledRunHistoryViewProps = {
  /** 已过滤的运行记录（`source_schedule_id` 非空）。 */
  runs: Task[];
  /** 调度列表，用于 `schedule_id → title` 映射。 */
  schedules: ScheduledTask[];
  projectOptions: TaskProjectOption[];
};

const DELETED_SCHEDULE = '已删除的调度';

/** 定时来源过滤。删调度不会删它跑出来的任务，所以过滤条件只看任务自身的字段。 */
export function runsOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.source_schedule_id);
}

/** 「所属调度」列：调度被删掉后任务行仍在，回退成占位文案。 */
export function scheduleTitleOf(scheduleId: string | null, schedules: ScheduledTask[]): string {
  if (!scheduleId) return DELETED_SCHEDULE;
  return schedules.find((s) => s.schedule_id === scheduleId)?.title ?? DELETED_SCHEDULE;
}

/**
 * 触发时间倒序。后端时间戳是定长裸 UTC（`YYYY-MM-DD HH:MM:SS`），字典序即时序，
 * 所以直接比字符串，不用 `Date`（对齐 taskTimestamp.ts 的约定）。
 */
export function sortRunsByTriggeredDesc(runs: Task[]): Task[] {
  return [...runs].sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1));
}

function StatusCell({ task }: { task: Task }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: STATUS_META[task.status].color }} />
      <span className="text-xs text-muted-foreground">{STATUS_META[task.status].label}</span>
      <SubStatusBadge subStatus={task.sub_status} />
    </span>
  );
}

function OpenActions({ task }: { task: Task }) {
  return (
    <div className="inline-flex items-center gap-1">
      <Link
        className="whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold text-primary hover:bg-primary/10"
        to={`/task/${task.task_id}`}
      >
        打开任务
      </Link>
      {canOpenSession(task) && (
        <Link
          className="whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold text-info hover:bg-info/10"
          to={`/session/${task.session_id}`}
        >
          打开会话
        </Link>
      )}
    </div>
  );
}

/**
 * 定时任务的运行记录：这个调度跑出来的那些任务。只读查看 + 跳转，不做排序 / 多选 /
 * 批量删除，也不套用任务页的筛选栏（定时视图本来就没有筛选栏）。
 */
export function ScheduledRunHistoryView({ runs, schedules, projectOptions }: ScheduledRunHistoryViewProps) {
  if (runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无运行记录</div>
      </div>
    );
  }

  const ordered = sortRunsByTriggeredDesc(runs);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Desktop table (≥1024px)；移动/平板用下方卡片。 */}
      <div className="hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              {['标题', '所属调度', '项目', '状态', '触发时间', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((task) => (
              <tr key={task.task_id} className="bg-card shadow-sm">
                <td className="rounded-l-lg px-4 py-3 font-semibold text-card-foreground [overflow-wrap:anywhere]">{task.title}</td>
                {/* 调度名与项目名都可能是不含空格的完整路径，截断 + title 兜底，
                    避免把表推出横向滚动（沿用 ScheduledTasksView 的同类处理）。 */}
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="block max-w-40 truncate" title={scheduleTitleOf(task.source_schedule_id, schedules)}>
                    {scheduleTitleOf(task.source_schedule_id, schedules)}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="block max-w-40 truncate" title={projectLabel(task, projectOptions)}>
                    {projectLabel(task, projectOptions)}
                  </span>
                </td>
                <td className="px-4 py-3"><StatusCell task={task} /></td>
                <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right"><OpenActions task={task} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile/tablet cards (<1024px) */}
      <div className="grid min-h-0 w-full auto-rows-min flex-1 grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:hidden">
        {ordered.map((task) => (
          <div key={task.task_id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm">
            <span className="line-clamp-2 overflow-hidden text-sm font-semibold text-card-foreground">{task.title}</span>
            <span className="truncate text-xs text-muted-foreground">{scheduleTitleOf(task.source_schedule_id, schedules)}</span>
            <div className="self-start"><StatusCell task={task} /></div>
            <span className="font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</span>
            <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
              <OpenActions task={task} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
