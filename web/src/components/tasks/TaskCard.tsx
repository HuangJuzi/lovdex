import { memo } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Task, TaskStatus } from '../../types/app';

import { STATUS_META, LABEL_META, PRIORITY_META, EXECUTOR_META } from './taskStatus';
import { canOpenSession } from './taskActions';
import { taskDeadlineInfo } from './taskDeadline';
import { formatAbsoluteTime, formatRelativeTime, taskTimeLabel } from './taskTimestamp';
import { SubStatusBadge } from './SubStatusBadge';

export type TaskProjectOption = { value: string; label: string };

type TaskCardProps = {
  task: Task;
  onStart?: () => void;
  onStatusChange?: (status: TaskStatus) => void;
  onOpenSession?: () => void;
  /** Candidate projects for the todo-card project selector. */
  projectOptions?: TaskProjectOption[];
  /** Called with the newly selected project path (todo tasks only). */
  onProjectChange?: (nextPath: string) => void;
  /** 是否被批量删除选择，配合 onToggleSelect 显示复选框。 */
  selected?: boolean;
  onToggleSelect?: (taskId: string) => void;
};

export const TaskCard = memo(function TaskCard({
  task,
  onStart,
  onStatusChange,
  onOpenSession,
  projectOptions,
  onProjectChange,
  selected,
  onToggleSelect,
}: TaskCardProps) {
  const navigate = useNavigate();
  const timeLabel = taskTimeLabel(task);
  const now = new Date();
  const deadline = taskDeadlineInfo(task, now);
  // 旧数据/未设置时回退到 DB 默认值，保证卡片始终显示 Label 与优先级。
  const priority = task.priority ?? 'P2';
  const label = task.label ?? 'other';

  return (
    <div
      className="cursor-pointer rounded-2xl border border-border/70 bg-card p-3 transition-all shadow-[0_3px_0_rgba(30,27,50,0.07),0_8px_18px_rgba(35,33,41,0.05)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_rgba(30,27,50,0.08),0_12px_24px_rgba(35,33,41,0.10)]"
      onClick={() => navigate(`/task/${task.task_id}`)}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: STATUS_META[task.status].color }}
        />
        <span className="min-w-0 flex-1 break-words text-sm font-semibold text-card-foreground">
          {task.title}
        </span>
        {onToggleSelect && (
          <input
            type="checkbox"
            aria-label="选择任务"
            checked={selected ?? false}
            onChange={() => onToggleSelect(task.task_id)}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          />
        )}
      </div>
      {/* 顶部标签条：Label / 优先级 / 截止日期 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {label && LABEL_META[label] && (
          <span
            className="rounded-full px-2 py-0.5 font-semibold"
            style={{ color: LABEL_META[label].color, backgroundColor: `${LABEL_META[label].color}1a` }}
          >
            {LABEL_META[label].label}
          </span>
        )}
        {task.source_schedule_id && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-600 dark:text-amber-400">
            ⏰ 定时
          </span>
        )}
        {priority && PRIORITY_META[priority] && (
          <span
            className="rounded-full px-2 py-0.5 font-semibold"
            style={{ color: PRIORITY_META[priority].color, backgroundColor: `${PRIORITY_META[priority].color}1a` }}
          >
            {PRIORITY_META[priority].label}
          </span>
        )}
        {deadline && (
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              deadline.overdue
                ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {deadline.overdue ? '⏰ ' : ''}{deadline.label}
          </span>
        )}
      </div>
      {task.description && (
        <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{task.description}</p>
      )}
      {task.ai_summary && (
        <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground/80">
          {task.ai_summary}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {task.is_operator === 1 && (
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 font-semibold text-violet-500 dark:text-violet-400">
            🤖 Lovdex助手
          </span>
        )}
        {task.status === 'todo' &&
        task.is_operator !== 1 &&
        onProjectChange &&
        projectOptions &&
        projectOptions.length > 0 ? (
          <select
            value={task.project_path}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              onProjectChange(e.target.value);
            }}
            title="修改项目"
            className="max-w-56 cursor-pointer truncate rounded-full border border-border/50 bg-muted py-0.5 pl-2 pr-6 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:border-primary/40"
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
          <span className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
            {task.project_path}
          </span>
        )}
        {EXECUTOR_META[task.executor_provider] && (
          <span
            className={`rounded-full px-2 py-0.5 font-semibold ${
              EXECUTOR_META[task.executor_provider].badge
            }`}
          >
            {EXECUTOR_META[task.executor_provider].label}
          </span>
        )}
        {task.executor_model && (
          <span className="rounded-full bg-muted/60 px-2 py-0.5 font-mono text-muted-foreground">
            {task.executor_model}
          </span>
        )}
      </div>

      <div className="mt-1 text-[11px] text-muted-foreground/80" title={formatAbsoluteTime(timeLabel.iso)}>
        {timeLabel.label} {formatRelativeTime(timeLabel.iso, now)}
      </div>

      {task.sub_status && (
        <div className="mt-2">
          <SubStatusBadge subStatus={task.sub_status} />
        </div>
      )}

      {/* Actions */}
      <div className="mt-2 flex flex-wrap gap-2">
        {task.status === 'todo' && onStart && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStart();
            }}
            className="min-h-9 min-w-0 flex-1 rounded-lg bg-primary py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:min-h-0 shadow-[0_2px_0_#1c3fa8]"
          >
            ▶ 开始执行
          </button>
        )}
        {task.sub_status === 'failed' && onStart && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStart();
            }}
            className="min-h-9 min-w-0 flex-1 rounded-lg bg-primary py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:min-h-0 shadow-[0_2px_0_#1c3fa8]"
          >
            ↻ 重试
          </button>
        )}
        {task.status === 'in_review' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange?.('done');
            }}
            className="min-h-9 min-w-0 flex-1 rounded-lg bg-green-500/10 py-1.5 text-xs font-semibold text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400 sm:min-h-0 shadow-[0_2px_0_rgba(30,27,50,0.08)]"
          >
            ✓ 标记完成
          </button>
        )}
        {task.session_id && onOpenSession &&
          (task.session_deleted ? (
            <button
              disabled
              title="关联会话已被清理，历史记录不可再读取"
              className="min-h-9 min-w-0 flex-1 cursor-not-allowed rounded-lg border border-border bg-muted py-1.5 text-xs font-semibold text-muted-foreground sm:min-h-0"
            >
              会话被清理
            </button>
          ) : canOpenSession(task) ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenSession();
              }}
              className="min-h-9 min-w-0 flex-1 rounded-lg bg-primary/10 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 sm:min-h-0 shadow-[0_2px_0_rgba(30,27,50,0.08)]"
            >
              打开会话
            </button>
          ) : null)}
      </div>
    </div>
  );
});
