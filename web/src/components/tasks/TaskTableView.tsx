import { Fragment, useMemo, type ReactNode } from 'react';

import type { Task, TaskStatus } from '../../types/app';
import { Pill, PillBar } from '../../shared/view/ui';
import useLocalStorage from '../../hooks/useLocalStorage';

import type { TaskProjectOption } from './TaskCard';
import { canOpenSession } from './taskActions';
import { SubStatusBadge } from './SubStatusBadge';
import { sortTasks, type TaskSortDir, type TaskSortKey } from './taskTable';
import { groupByStatus, LABEL_META, PRIORITY_META, STATUS_META, STATUS_ORDER, toggleStatus, EXECUTOR_META } from './taskStatus';
import { taskDeadlineInfo } from './taskDeadline';
import { formatAbsoluteTime } from './taskTimestamp';

/** 列定义：`key` 存在即可排序；`static` 列（子状态/操作）无排序。 */
const COLUMNS: { key?: TaskSortKey; label: string; alignRight?: boolean }[] = [
  { key: 'title', label: '标题' },
  { key: 'project', label: '项目' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
  { label: '子状态' },
  { key: 'deadline', label: '截止日期' },
  { key: 'created', label: '创建时间' },
  { key: 'activity', label: '最近活动' },
  { label: '操作', alignRight: true },
];

type TaskTableViewProps = {
  tasks: Task[];
  projectOptions: TaskProjectOption[];
  onStart?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onOpenSession?: (task: Task) => void;
  onProjectChange?: (task: Task, nextPath: string) => void;
  onOpenTask?: (task: Task) => void;
  selected?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  onToggleSelectAll?: (taskIds: string[]) => void;
};

function ActionBtn({
  className,
  onClick,
  children,
}: {
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-opacity hover:opacity-80 ${
        className ?? ''
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 任务表格视图（B3+ B 视觉）：按状态分组 + 卡片行 + 左色条 + 组内排序 + 行内操作。
 * 仅渲染非空分组；空列表显示「暂无任务」。
 */
export function TaskTableView({
  tasks,
  projectOptions,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
  selected,
  onToggleSelect,
  onToggleSelectAll,
}: TaskTableViewProps) {
  const hasSelection = Boolean(onToggleSelect);
  const [sortKey, setSortKey] = useLocalStorage<TaskSortKey>('taskTableSortKey', 'created');
  const [sortDir, setSortDir] = useLocalStorage<TaskSortDir>('taskTableSortDir', 'desc');
  const [statusFilter, setStatusFilter] = useLocalStorage<TaskStatus[]>('taskTableStatusFilter', [...STATUS_ORDER]);
  const groups = useMemo(() => groupByStatus(tasks), [tasks]);
  const now = new Date();

  const toggleSort = (key: TaskSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'created' || key === 'activity' ? 'desc' : 'asc');
    }
  };

  const sorted = (status: TaskStatus) => sortTasks(groups[status], sortKey, sortDir);

  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="py-16 text-center text-sm text-muted-foreground">暂无任务</div>
      </div>
    );
  }

  const visibleStatuses = STATUS_ORDER.filter((s) => statusFilter.includes(s));
  const hasVisibleRows = visibleStatuses.some((s) => groups[s].length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)]">
      {/* 状态筛选行：固定，不随表格横向滚动 */}
      <div
        data-testid="status-filter"
        className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4"
      >
        <PillBar>
          <Pill
            isActive={statusFilter.length === STATUS_ORDER.length}
            onClick={() => setStatusFilter([...STATUS_ORDER])}
          >
            全部
          </Pill>
          {STATUS_ORDER.map((status) => (
            <Pill
              key={status}
              isActive={statusFilter.includes(status)}
              onClick={() => setStatusFilter((sel) => toggleStatus(sel, status))}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[status].color }} />
              {STATUS_META[status].label}
              <span className="text-xs text-muted-foreground">{groups[status].length}</span>
            </Pill>
          ))}
        </PillBar>
      </div>

      {/* 表格滚动区 */}
      <div className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4">
        <table
          className="w-full min-w-[1080px] border-separate text-sm"
          style={{ borderSpacing: '0 7px' }}
        >
          <thead>
            <tr>
              {hasSelection && (
                <th className="px-2 pb-1">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={tasks.length > 0 && tasks.every((t) => selected?.has(t.task_id))}
                    onChange={() => onToggleSelectAll?.(tasks.map((t) => t.task_id))}
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </th>
              )}
              {COLUMNS.map((col) => {
                const sortable = col.key !== undefined;
                return (
                  <th
                    key={col.label}
                    onClick={sortable ? () => toggleSort(col.key as TaskSortKey) : undefined}
                    className={`whitespace-nowrap px-4 pb-1 text-xs font-semibold text-muted-foreground ${
                      col.alignRight ? 'text-right' : 'text-left'
                    } ${sortable ? 'cursor-pointer select-none hover:text-foreground' : ''}`}
                  >
                    {col.label}
                    {sortable && sortKey === col.key && (
                      <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleStatuses.map((status) => {
              const rows = sorted(status);
              if (rows.length === 0) return null;
              return (
                <Fragment key={status}>
                  <tr>
                    <td colSpan={hasSelection ? 10 : 9} className="px-2 pb-1">
                      <div className="flex items-center gap-2 px-2 text-sm font-semibold">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: STATUS_META[status].color }}
                        />
                        {STATUS_META[status].label}
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {rows.length}
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    </td>
                  </tr>
                  {rows.map((task) => (
                    <TaskRow
                      key={task.task_id}
                      task={task}
                      projectOptions={projectOptions}
                      now={now}
                      onStart={onStart}
                      onStatusChange={onStatusChange}
                      onOpenSession={onOpenSession}
                      onProjectChange={onProjectChange}
                      onOpenTask={onOpenTask}
                      selected={selected}
                      onToggleSelect={onToggleSelect}
                    />
                  ))}
                </Fragment>
              );
            })}
            {!hasVisibleRows && (
              <tr>
                <td colSpan={hasSelection ? 10 : 9} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  暂无任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  projectOptions,
  now,
  onStart,
  onStatusChange,
  onOpenSession,
  onProjectChange,
  onOpenTask,
  selected,
  onToggleSelect,
}: {
  task: Task;
  projectOptions: TaskProjectOption[];
  now: Date;
  onStart?: (task: Task) => void;
  onStatusChange?: (task: Task, status: TaskStatus) => void;
  onOpenSession?: (task: Task) => void;
  onProjectChange?: (task: Task, nextPath: string) => void;
  onOpenTask?: (task: Task) => void;
  selected?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
}) {
  const priority = task.priority ?? 'P2';
  const label = task.label ?? 'other';
  const deadlineInfo = taskDeadlineInfo(task, now);
  const overdue = deadlineInfo?.overdue ?? false;
  const statusColor = STATUS_META[task.status].color;

  return (
    <tr
      className="cursor-pointer transition-transform hover:-translate-y-px"
      onClick={() => onOpenTask?.(task)}
    >
      {onToggleSelect && (
        <td className="bg-card px-4 py-3 shadow-sm" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label="选择任务"
            checked={selected?.has(task.task_id) ?? false}
            onChange={() => onToggleSelect(task.task_id)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
        </td>
      )}
      {/* 标题 + 副行（Label + 引擎·模型） */}
      <td
        className="rounded-l-lg bg-card px-4 py-3 shadow-sm"
        style={{ borderLeft: `3px solid ${statusColor}` }}
      >
        <div className="font-semibold text-card-foreground">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {LABEL_META[label] && (
            <span
              className="rounded-full px-2 py-0.5 font-semibold"
              style={{ color: LABEL_META[label].color, backgroundColor: `${LABEL_META[label].color}1a` }}
            >
              {LABEL_META[label].label}
            </span>
          )}
          {EXECUTOR_META[task.executor_provider] && (
            <span className={`font-semibold ${EXECUTOR_META[task.executor_provider].badge}`}>
              {EXECUTOR_META[task.executor_provider].label}
            </span>
          )}
          {task.executor_model && <span className="font-mono">{task.executor_model}</span>}
        </div>
      </td>

      {/* 项目 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 text-xs shadow-sm">
        {task.status === 'todo' && task.is_operator !== 1 && projectOptions.length > 0 ? (
          <select
            value={task.project_path}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              onProjectChange?.(task, e.target.value);
            }}
            title="修改项目"
            className="max-w-40 cursor-pointer truncate rounded-full border border-border/50 bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground outline-none"
          >
            {!projectOptions.some((o) => o.value === task.project_path) && (
              <option value={task.project_path} disabled>
                {task.project_path}
              </option>
            )}
            {projectOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span
            className={
              task.is_operator === 1
                ? 'font-medium text-violet-600 dark:text-violet-400'
                : 'text-muted-foreground'
            }
          >
            {task.is_operator === 1 ? '🤖 Lovdex助手' : task.project_path}
          </span>
        )}
      </td>

      {/* 状态 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 text-xs font-medium shadow-sm">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: statusColor }} />
          {STATUS_META[task.status].label}
        </span>
      </td>

      {/* 优先级 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 shadow-sm">
        {PRIORITY_META[priority] && (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ color: PRIORITY_META[priority].color, backgroundColor: `${PRIORITY_META[priority].color}1a` }}
          >
            {PRIORITY_META[priority].label}
          </span>
        )}
      </td>

      {/* 子状态 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 shadow-sm">
        {task.sub_status ? (
          <SubStatusBadge subStatus={task.sub_status} />
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </td>

      {/* 截止日期 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 text-xs shadow-sm">
        {task.deadline ? (
          <span className={overdue ? 'font-semibold text-red-500' : 'text-muted-foreground'}>
            {task.deadline}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>

      {/* 创建时间 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 font-mono text-[11px] text-muted-foreground shadow-sm">
        {formatAbsoluteTime(task.created_at)}
      </td>

      {/* 最近活动 */}
      <td className="whitespace-nowrap bg-card px-4 py-3 font-mono text-[11px] text-muted-foreground shadow-sm">
        {formatAbsoluteTime(task.updated_at)}
      </td>

      {/* 操作 */}
      <td className="whitespace-nowrap rounded-r-lg bg-card px-4 py-3 text-right shadow-sm">
        <div className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {task.status === 'todo' && onStart && (
            <ActionBtn onClick={() => onStart(task)} className="bg-primary/10 text-primary">
              ▶ 开始执行
            </ActionBtn>
          )}
          {task.sub_status === 'failed' && onStart && (
            <ActionBtn onClick={() => onStart(task)} className="bg-primary/10 text-primary">
              ↻ 重试
            </ActionBtn>
          )}
          {task.status === 'in_review' && (
            <ActionBtn
              onClick={() => onStatusChange?.(task, 'done')}
              className="bg-green-500/10 text-green-600 dark:text-green-400"
            >
              ✓ 标记完成
            </ActionBtn>
          )}
          {canOpenSession(task) && onOpenSession && (
            <ActionBtn onClick={() => onOpenSession(task)} className="bg-muted text-muted-foreground">
              打开会话
            </ActionBtn>
          )}
        </div>
      </td>
    </tr>
  );
}
