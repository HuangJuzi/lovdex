import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';

import type { ScheduledTask, Task } from '../../types/app';

import { projectLabel } from './projectLabel';
import { deleteConfirmMessage, deleteOutcomeMessage, selectableRuns, selectionAfterOutcome, toggleSelectAll, type DeleteOutcome } from './runHistoryDelete';
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
  /** 调度列表的就绪状态。未就绪时「所属调度」列显示状态占位而不是「已删除的调度」。 */
  scheduleLookup?: ScheduleLookup;
  projectOptions: TaskProjectOption[];
  /** 删除指定的运行。返回逐条结果，供结果条展示。 */
  onDelete: (taskIds: string[]) => Promise<DeleteOutcome>;
};

const DELETED_SCHEDULE_LABEL = '已删除的调度';
const UNKNOWN_SCHEDULE_LABEL = '调度加载中';
const SCHEDULE_LOOKUP_FAILED_LABEL = '调度列表不可用';

/** 调度列表的就绪状态。未就绪时不能把每行都断言成「已删除」。 */
export type ScheduleLookup = 'loading' | 'error' | 'ready';

/** 定时来源过滤。删调度不会删它跑出来的任务，所以过滤条件只看任务自身的字段。 */
export function runsOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.source_schedule_id);
}

/** 「所属调度」列：调度被删掉后任务行仍在，回退成占位文案。 */
export function scheduleTitleOf(
  scheduleId: string | null,
  schedules: ScheduledTask[],
  lookup: ScheduleLookup = 'ready',
): string {
  if (lookup === 'loading') return UNKNOWN_SCHEDULE_LABEL;
  if (lookup === 'error') return SCHEDULE_LOOKUP_FAILED_LABEL;
  if (!scheduleId) return DELETED_SCHEDULE_LABEL;
  return schedules.find((s) => s.schedule_id === scheduleId)?.title ?? DELETED_SCHEDULE_LABEL;
}

/**
 * 触发时间倒序。调度触发时先建任务行、再起运行，所以 `created_at` 就是这次调度的
 * 触发时间（`started_at` 在未启动/仅提醒的任务上是 NULL）。后端时间戳是定长裸 UTC
 * （`YYYY-MM-DD HH:MM:SS`），字典序即时序，所以直接比字符串，不用 `Date`
 * （对齐 taskTimestamp.ts 的约定）。
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

function RowActions({
  task,
  canDelete,
  deleting,
  onDelete,
}: {
  task: Task;
  canDelete: boolean;
  deleting: boolean;
  onDelete: (taskIds: string[]) => void;
}) {
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
      <button
        type="button"
        disabled={!canDelete || deleting}
        title={canDelete ? '删除' : '运行中，先停止再删除'}
        aria-label="删除"
        onClick={() => onDelete([task.task_id])}
        className="whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs font-semibold text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        删除
      </button>
    </div>
  );
}

/**
 * 定时任务的运行记录：这个调度跑出来的那些任务。可勾选批量删除，也可逐条删除；
 * 不做排序，也不套用任务页的筛选栏（定时视图本来就没有筛选栏）。
 *
 * 删除走 `onDelete` 回调而不是自己发请求 —— 视图保持展示层，请求与刷新留给面板，
 * 这样它仍能被 `renderToStaticMarkup` 静态测试。
 */
export function ScheduledRunHistoryView({
  runs,
  schedules,
  scheduleLookup = 'ready',
  projectOptions,
  onDelete,
}: ScheduledRunHistoryViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [outcome, setOutcome] = useState<DeleteOutcome | null>(null);

  // 已删、以及「选完之后被 WS 改成 in_progress」的 id 都从选择里剪掉，避免幽灵勾选。
  // （删除刚结束的那一帧 selectionAfterOutcome 可能短暂放回不可选的 id，随后这里会再剪一次。）
  useEffect(() => {
    const ids = new Set(selectableRuns(runs).map((t) => t.task_id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [runs]);

  if (runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无运行记录</div>
      </div>
    );
  }

  const ordered = sortRunsByTriggeredDesc(runs);
  const selectableIds = selectableRuns(runs).map((t) => t.task_id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const outcomeText = outcome ? deleteOutcomeMessage(outcome) : null;

  async function runDelete(taskIds: string[]) {
    if (taskIds.length === 0 || deleting) return;
    if (!window.confirm(deleteConfirmMessage(taskIds.length))) return;
    setDeleting(true);
    try {
      const result = await onDelete(taskIds);
      setOutcome(result);
      setSelected((prev) => selectionAfterOutcome(prev, result));
    } catch (e) {
      // onDelete 的契约是「逐条收集」，理论上不会 reject；万一将来换成会抛的实现，
      // 也别让一次删除变成静默的 unhandled rejection。
      console.error('delete runs failed', e);
      const reason = e instanceof Error ? e.message : '网络错误';
      setOutcome({ deleted: [], failed: taskIds.map((taskId) => ({ taskId, reason, running: false })) });
    } finally {
      setDeleting(false);
    }
  }

  function toggleOne(taskId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 结果条在上、操作条在下：前者说「上次删了什么」，后者说「现在选了什么」。 */}
      {outcomeText && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 sm:px-4">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{outcomeText}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setOutcome(null)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 sm:px-4">
          <span className="text-sm font-medium">已选 {selected.size} 项</span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            取消选择
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void runDelete([...selected])}
            className="ml-auto rounded-lg bg-destructive/10 px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      )}

      {/* Desktop table (≥1024px)；移动/平板用下方卡片。 */}
      <div className="hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              <th className="px-2 pb-1">
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={allSelected}
                  disabled={selectableIds.length === 0}
                  onChange={() => setSelected((prev) => toggleSelectAll(prev, selectableIds))}
                  className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
              </th>
              {['标题', '所属调度', '项目', '状态', '触发时间', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((task) => {
              // 运行中的删不掉（后端 409），勾选框与删除按钮都从源头挡住。
              const canDelete = task.status !== 'in_progress';
              return (
                <tr key={task.task_id} className="bg-card shadow-sm">
                  <td className="rounded-l-lg bg-card px-2 py-3">
                    {canDelete && (
                      <input
                        type="checkbox"
                        aria-label="选择运行"
                        checked={selected.has(task.task_id)}
                        onChange={() => toggleOne(task.task_id)}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold text-card-foreground [overflow-wrap:anywhere]">{task.title}</td>
                  {/* 调度名与项目名都可能是不可断的长 token（项目名会回退成完整路径），
                      截断 + title 兜底，避免把表推出横向滚动（沿用 ScheduledTasksView 的同类处理）。 */}
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <span className="block max-w-40 truncate" title={scheduleTitleOf(task.source_schedule_id, schedules, scheduleLookup)}>
                      {scheduleTitleOf(task.source_schedule_id, schedules, scheduleLookup)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <span className="block max-w-40 truncate" title={projectLabel(task, projectOptions)}>
                      {projectLabel(task, projectOptions)}
                    </span>
                  </td>
                  <td className="px-4 py-3"><StatusCell task={task} /></td>
                  <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</td>
                  <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                    <RowActions task={task} canDelete={canDelete} deleting={deleting} onDelete={(ids) => void runDelete(ids)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile/tablet cards (<1024px) */}
      <div className="grid min-h-0 w-full flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:hidden">
        {ordered.map((task) => {
          const canDelete = task.status !== 'in_progress';
          return (
            <div key={task.task_id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm">
              <div className="flex items-start gap-2">
                {canDelete && (
                  <input
                    type="checkbox"
                    aria-label="选择运行"
                    checked={selected.has(task.task_id)}
                    onChange={() => toggleOne(task.task_id)}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-primary"
                  />
                )}
                <span className="line-clamp-2 overflow-hidden text-sm font-semibold text-card-foreground">{task.title}</span>
              </div>
              <span className="truncate text-xs text-muted-foreground">{scheduleTitleOf(task.source_schedule_id, schedules, scheduleLookup)}</span>
              <div className="self-start"><StatusCell task={task} /></div>
              <span className="font-mono text-2xs text-muted-foreground">{formatAbsoluteTime(task.created_at)}</span>
              <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
                <RowActions task={task} canDelete={canDelete} deleting={deleting} onDelete={(ids) => void runDelete(ids)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
