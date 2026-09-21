import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, Pencil, Play, Trash2 } from 'lucide-react';

import type { ScheduledTask } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import { Switch } from '../../shared/view/ui';
import type { TaskProjectOption } from './TaskCard';
import { projectLabel } from './projectLabel';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledTasksViewProps = {
  tasks: ScheduledTask[];
  projectOptions: TaskProjectOption[];
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
};

type ScheduledTaskCardProps = Omit<ScheduledTasksViewProps, 'tasks'> & { task: ScheduledTask };

const MODE_BADGE_CLASS = {
  auto: 'rounded-full bg-success/10 px-2 py-0.5 font-semibold text-success',
  remind: 'rounded-full bg-warning/10 px-2 py-0.5 font-semibold text-warning',
} as const;

/** 模式徽标：只表达 auto_run 两态。桌面「模式」列常显；卡片启用态经 statusBadge 复用。 */
function modeBadge(task: ScheduledTask) {
  return task.auto_run === 1 ? (
    <span className={MODE_BADGE_CLASS.auto}>✅ 自动执行</span>
  ) : (
    <span className={MODE_BADGE_CLASS.remind}>🔔 仅提醒</span>
  );
}

function statusBadge(task: ScheduledTask) {
  if (task.enabled === 0) {
    return (
      <span className="rounded-full border border-dashed border-border bg-muted px-2 py-0.5 font-semibold text-muted-foreground">⏸ 已停用</span>
    );
  }
  return modeBadge(task);
}

/**
 * 只在开启时渲染。默认关是绝大多数情况，给它一个「已关闭」徽标只会让列表更吵，
 * 而这个徽标的唯一作用是让人扫一眼看出哪些任务在无人值守时会自己批。
 */
function autoApproveBadge(task: ScheduledTask) {
  if (task.auto_approve !== 1) return null;
  return (
    <span className="rounded-full bg-info/10 px-2 py-0.5 font-semibold text-info">⚡ 自动审批</span>
  );
}

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="text-right font-medium text-card-foreground">{value}</span>
    </div>
  );
}

function ActionButton({ title, label, className, onClick, children }: {
  title: string; label: string; className: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button title={title} aria-label={label} onClick={onClick} className={`mobile-touch-target rounded-lg px-2 py-1 ${className}`}>{children}</button>
  );
}

function ScheduledTaskCard({ task, projectOptions, onEdit, onDelete, onToggle, onRunNow }: ScheduledTaskCardProps) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-sm ${task.enabled === 0 ? 'opacity-60' : ''}`}>
      {/* 标题与启停开关同行：开关即状态；长标题最多两行，开关不随标题拉伸。 */}
      <div className="flex items-center justify-between gap-2">
        <span className={`line-clamp-2 overflow-hidden text-sm font-semibold ${task.enabled === 0 ? 'text-muted-foreground' : 'text-card-foreground'}`}>{task.title}</span>
        <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {statusBadge(task)}
        {autoApproveBadge(task)}
      </div>
      <FieldRow label="调度" value={<><CalendarClock className="mr-1 inline h-3 w-3" />{scheduleLabel(task)}</>} />
      <FieldRow label="项目" value={projectLabel(task, projectOptions)} />
      <FieldRow label="下次" value={<span className="font-mono text-2xs">{task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}</span>} />
      <FieldRow
        label="上次"
        value={task.last_task_id ? <Link className="text-primary underline" to={`/task/${task.last_task_id}`}>查看任务</Link> : '—'}
      />
      <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
        <ActionButton title="立即触发" label="立即触发" className="text-info hover:bg-info/10" onClick={() => onRunNow(task)}><Play className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="编辑" label="编辑" className="text-muted-foreground hover:bg-muted" onClick={() => onEdit(task)}><Pencil className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="删除" label="删除" className="text-destructive hover:bg-destructive/10" onClick={() => onDelete(task)}><Trash2 className="h-3.5 w-3.5" /></ActionButton>
      </div>
    </div>
  );
}

export function ScheduledTasksView({ tasks, projectOptions, onEdit, onDelete, onToggle, onRunNow }: ScheduledTasksViewProps) {
  const navigate = useNavigate();

  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <div className="text-sm text-muted-foreground">暂无定时任务</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Desktop table (≥1024px)；移动/平板用下方卡片。 */}
      <div className="hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              {['启用', '标题', '调度', '项目', '模式', '下次触发', '上次触发', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.schedule_id} className={`bg-card shadow-sm ${task.enabled === 0 ? 'opacity-60' : ''}`}>
                <td className="rounded-l-lg px-4 py-3">
                  <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
                </td>
                <td className={`px-4 py-3 font-semibold [overflow-wrap:anywhere] ${task.enabled === 0 ? 'text-muted-foreground' : 'text-card-foreground'}`}>{task.title}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <CalendarClock className="mr-1 inline h-3 w-3" />
                  {scheduleLabel(task)}
                </td>
                {/* projectLabel 在项目不在 projectOptions 时会回退成完整路径（不可断
                    长 token），截断 + title 兜底，避免将来把本表推出横向滚动。 */}
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <span className="block max-w-40 truncate" title={projectLabel(task, projectOptions)}>
                    {projectLabel(task, projectOptions)}
                  </span>
                </td>
                {/* 自动审批与自动执行同属「运行方式」，共用一格省一列；flex-wrap 防止两个徽标把行撑高。 */}
                <td className="px-4 py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-1">
                    {modeBadge(task)}
                    {autoApproveBadge(task)}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">
                  {task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {task.last_task_id ? (
                    <button className="text-primary underline" onClick={() => navigate(`/task/${task.last_task_id}`)}>查看</button>
                  ) : '—'}
                </td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button title="立即触发" aria-label="立即触发" onClick={() => onRunNow(task)} className="rounded-lg px-2 py-1 text-info hover:bg-info/10"><Play className="h-3 w-3" /></button>
                    <button title="编辑" aria-label="编辑" onClick={() => onEdit(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Pencil className="h-3 w-3" /></button>
                    <button title="删除" aria-label="删除" onClick={() => onDelete(task)} className="rounded-lg px-2 py-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile/tablet cards (<1024px) */}
      <div className="grid min-h-0 w-full auto-rows-min flex-1 grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:hidden">
        {tasks.map((task) => (
          <ScheduledTaskCard key={task.schedule_id} task={task} projectOptions={projectOptions} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onRunNow={onRunNow} />
        ))}
      </div>
    </div>
  );
}