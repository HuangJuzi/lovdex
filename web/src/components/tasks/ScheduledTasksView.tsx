import { useNavigate } from 'react-router-dom';
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

function projectLabel(task: ScheduledTask, projectOptions: TaskProjectOption[]): string {
  if (task.is_operator === 1 || !task.project_path) return '🤖 Lovdex助手';
  const opt = projectOptions.find((o) => o.value === task.project_path);
  return opt?.label ?? task.project_path;
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
      <div className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4">
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
    </div>
  );
}
