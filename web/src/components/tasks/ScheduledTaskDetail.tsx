import { CalendarClock, Play, Trash2, X } from 'lucide-react';

import type { ScheduledTask, Task } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import { Switch } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
import { projectLabel } from './projectLabel';
import { runNowBlockedReason } from './scheduleRunNow';
import { ScheduledTaskFormBody, type ScheduledTaskDraft } from './ScheduledTaskForm';
import { FieldRow, LastRunLink, AutoApproveBadge, ModeBadge } from './scheduledTaskPresentation';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledTaskDetailProps = {
  task: ScheduledTask;
  /** 全量任务表（task_id → Task），把 `last_task_id` 映射到那条运行开的会话。 */
  taskById: Map<string, Task>;
  projectOptions: TaskProjectOption[];
  submitting: boolean;
  error: string | null;
  onSubmit: (draft: ScheduledTaskDraft) => void;
  onClose: () => void;
  onToggle: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  /** 「上一轮还没结束」的运行；null = 没被挡。 */
  blocked: Task | null;
  pendingRunNow: boolean;
};

/**
 * 定时任务详情（点击列表行/卡片后打开）。桌面作右栏、移动作底部 sheet（容器由
 * ScheduledTasksPanel 决定），本组件只管内容：只读摘要头 + 内联编辑表单 + 快捷操作。
 */
export function ScheduledTaskDetail({
  task,
  taskById,
  projectOptions,
  submitting,
  error,
  onSubmit,
  onClose,
  onToggle,
  onRunNow,
  onDelete,
  blocked,
  pendingRunNow,
}: ScheduledTaskDetailProps) {
  const runNowDisabled = Boolean(blocked) || pendingRunNow;
  const runNowTitle = blocked ? runNowBlockedReason(blocked) : pendingRunNow ? '正在触发…' : '立即触发';
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* 顶栏：标题 + 启停开关 + 立即触发 / 删除 / 关闭。 */}
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{task.title}</h2>
        <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
        <button
          title={runNowTitle}
          aria-label="立即触发"
          onClick={() => onRunNow(task)}
          disabled={runNowDisabled}
          className={`rounded-lg px-2 py-1 ${runNowDisabled ? 'cursor-not-allowed text-muted-foreground/50' : 'text-info hover:bg-info/10'}`}
        >
          <Play className="h-4 w-4" />
        </button>
        <button title="删除" aria-label="删除" onClick={() => onDelete(task)} className="rounded-lg px-2 py-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>
        <button title="关闭" aria-label="关闭详情" onClick={onClose} className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>

      {/* 只读摘要：徽标 + 调度/项目/下次/上次。 */}
      <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {ModeBadge(task)}
          {AutoApproveBadge(task)}
        </div>
        <FieldRow label="调度" value={<><CalendarClock className="mr-1 inline h-3 w-3" />{scheduleLabel(task)}</>} />
        <FieldRow label="项目" value={projectLabel(task, projectOptions)} />
        <FieldRow label="下次" value={<span className="font-mono text-2xs">{task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}</span>} />
        <FieldRow label="上次" value={<LastRunLink schedule={task} taskById={taskById} />} />
      </div>

      {/* 内联编辑表单：新建弹窗共用同一套 ScheduledTaskFormBody。提交入口必须是底部
          带文字的按钮 —— composer 里那个无标签的圆形箭头在详情面板里不像「确认修改」，
          用户找不到它就没法改定时任务。 */}
      <div className="p-4">
        <ScheduledTaskFormBody
          initial={task}
          active
          projectOptions={projectOptions}
          submitting={submitting}
          error={error}
          onCancel={onClose}
          onSubmit={onSubmit}
          submitLabel="保存修改"
        />
      </div>
    </div>
  );
}
