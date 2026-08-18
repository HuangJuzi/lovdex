import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, Pencil, Play, Power, Trash2 } from 'lucide-react';

import type { ScheduledTask } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import type { TaskProjectOption } from './TaskCard';
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

function projectLabel(task: ScheduledTask, projectOptions: TaskProjectOption[]): string {
  if (task.is_operator === 1 || !task.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return opt?.label ?? task.project_path;
}

function statusBadge(task: ScheduledTask) {
  if (task.enabled === 0) {
    return <span className="rounded-full bg-muted px-2 py-0.5 font-semibold text-muted-foreground">⏸ 已停用</span>;
  }
  return task.auto_run === 1 ? (
    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-600 dark:text-emerald-400">✅ 自动执行</span>
  ) : (
    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-600 dark:text-amber-400">🔔 仅提醒</span>
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
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-card-foreground">{task.title}</span>
        {statusBadge(task)}
      </div>
      <FieldRow label="调度" value={<><CalendarClock className="mr-1 inline h-3 w-3" />{scheduleLabel(task)}</>} />
      <FieldRow label="项目" value={projectLabel(task, projectOptions)} />
      <FieldRow label="下次" value={<span className="font-mono text-[11px]">{formatAbsoluteTime(task.next_run_at)}</span>} />
      <FieldRow
        label="上次"
        value={task.last_task_id ? <Link className="text-primary underline" to={`/task/${task.last_task_id}`}>查看任务</Link> : '—'}
      />
      <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
        <ActionButton title="立即触发" label="立即触发" className="text-sky-600 hover:bg-sky-500/10" onClick={() => onRunNow(task)}><Play className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title={task.enabled === 1 ? '停用' : '启用'} label="启停" className="text-muted-foreground hover:bg-muted" onClick={() => onToggle(task)}><Power className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="编辑" label="编辑" className="text-muted-foreground hover:bg-muted" onClick={() => onEdit(task)}><Pencil className="h-3.5 w-3.5" /></ActionButton>
        <ActionButton title="删除" label="删除" className="text-red-500 hover:bg-red-500/10" onClick={() => onDelete(task)}><Trash2 className="h-3.5 w-3.5" /></ActionButton>
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
      <div className="flex flex-shrink-0 items-center justify-between px-3 py-2 sm:px-4">
        <span className="text-sm font-semibold text-foreground">⏰ 定时任务</span>
      </div>

      {/* Desktop table (≥1024px)；移动/平板用下方卡片。 */}
      <div className="hidden min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4 lg:block">
        <table className="w-full min-w-[900px] border-separate text-sm" style={{ borderSpacing: '0 7px' }}>
          <thead>
            <tr>
              {['标题', '调度', '项目', '自动执行', '下次触发', '上次触发', '操作'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 pb-1 text-left text-xs font-semibold text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.schedule_id} className="bg-card shadow-sm">
                <td className="rounded-l-lg px-4 py-3 font-semibold text-card-foreground">{task.title}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <CalendarClock className="mr-1 inline h-3 w-3" />
                  {scheduleLabel(task)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{projectLabel(task, projectOptions)}</td>
                <td className="px-4 py-3 text-xs">{task.auto_run === 1 ? '✅ 自动执行' : '🔔 仅提醒'}</td>
                <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{formatAbsoluteTime(task.next_run_at)}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {task.last_task_id ? (
                    <button className="text-primary underline" onClick={() => navigate(`/task/${task.last_task_id}`)}>查看</button>
                  ) : '—'}
                </td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button title="立即触发" aria-label="立即触发" onClick={() => onRunNow(task)} className="rounded-lg px-2 py-1 text-sky-600 hover:bg-sky-500/10"><Play className="h-3 w-3" /></button>
                    <button title={task.enabled === 1 ? '停用' : '启用'} aria-label="启停" onClick={() => onToggle(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Power className="h-3 w-3" /></button>
                    <button title="编辑" aria-label="编辑" onClick={() => onEdit(task)} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><Pencil className="h-3 w-3" /></button>
                    <button title="删除" aria-label="删除" onClick={() => onDelete(task)} className="rounded-lg px-2 py-1 text-red-500 hover:bg-red-500/10"><Trash2 className="h-3 w-3" /></button>
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