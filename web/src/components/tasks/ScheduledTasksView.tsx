import type { ReactNode } from 'react';
import { CalendarClock, Play, Trash2 } from 'lucide-react';

import type { ScheduledTask, Task } from '../../types/app';
import { scheduleLabel } from '../../utils/scheduleLabel';
import { Switch } from '../../shared/view/ui';

import type { TaskProjectOption } from './TaskCard';
import { projectLabel } from './projectLabel';
import { runNowBlockedReason } from './scheduleRunNow';
import { FieldRow, LastRunLink, AutoApproveBadge, ModeBadge } from './scheduledTaskPresentation';
import { formatAbsoluteTime } from './taskTimestamp';

export type ScheduledTasksViewProps = {
  tasks: ScheduledTask[];
  projectOptions: TaskProjectOption[];
  /** 全量任务表（task_id → Task），把 `last_task_id` 映射到那条运行开的会话。 */
  taskById: Map<string, Task>;
  /** 当前在详情面板里打开的那条调度（高亮用）。 */
  selectedId: string | null;
  /** 点中某条调度 → 打开详情。 */
  onSelect: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask) => void;
  onRunNow: (task: ScheduledTask) => void;
  /** 「上一轮还没结束」的调度 → schedule_id 对应的那个运行。 */
  blockedRuns: Map<string, Task>;
  /** 正在派发中的 schedule_id（连点闸门）。 */
  pendingRunNow: Set<string>;
  /** 列表级操作（立即触发 / 删除）失败的提示条文案；null = 不显示。 */
  actionError: string | null;
  onDismissActionError: () => void;
};

type ScheduledTaskCardProps = Omit<ScheduledTasksViewProps, 'tasks' | 'actionError' | 'onDismissActionError'> & { task: ScheduledTask };

function statusBadge(task: ScheduledTask) {
  if (task.enabled === 0) {
    return (
      <span className="rounded-full border border-dashed border-border bg-muted px-2 py-0.5 font-semibold text-muted-foreground">⏸ 已停用</span>
    );
  }
  return ModeBadge(task);
}

function ActionButton({ title, label, className, onClick, disabled = false, children }: {
  title: string; label: string; className: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      className={`mobile-touch-target rounded-lg px-2 py-1 ${className}`}
    >
      {children}
    </button>
  );
}

function ScheduledTaskCard({ task, projectOptions, taskById, selectedId, onSelect, onDelete, onToggle, onRunNow, blockedRuns, pendingRunNow }: ScheduledTaskCardProps) {
  const selected = task.schedule_id === selectedId;
  const blocked = blockedRuns.get(task.schedule_id) ?? null;
  const pending = pendingRunNow.has(task.schedule_id);
  const runNowDisabled = Boolean(blocked) || pending;
  const runNowTitle = blocked ? runNowBlockedReason(blocked) : pending ? '正在触发…' : '立即触发';
  return (
    <div
      data-selected={selected ? 'true' : 'false'}
      onClick={() => onSelect(task)}
      className={`flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 shadow-sm ${selected ? 'border-primary/60 bg-accent' : 'border-border bg-card'} ${task.enabled === 0 ? 'opacity-60' : ''}`}
    >
      {/* 标题与启停开关同行：开关即状态；长标题最多两行，开关不随标题拉伸。 */}
      <div className="flex items-center justify-between gap-2">
        <span className={`line-clamp-2 overflow-hidden text-sm font-semibold ${task.enabled === 0 ? 'text-muted-foreground' : 'text-card-foreground'}`}>{task.title}</span>
        <span onClick={(e) => e.stopPropagation()} className="inline-flex">
          <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {statusBadge(task)}
        {AutoApproveBadge(task)}
      </div>
      <FieldRow label="调度" value={<><CalendarClock className="mr-1 inline h-3 w-3" />{scheduleLabel(task)}</>} />
      <FieldRow label="项目" value={projectLabel(task, projectOptions)} />
      <FieldRow label="下次" value={<span className="font-mono text-2xs">{task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}</span>} />
      <FieldRow label="上次" value={<LastRunLink schedule={task} taskById={taskById} />} />
      <div className="mt-1 flex items-center justify-end gap-1 border-t border-border pt-1.5">
        <ActionButton
          title={runNowTitle}
          label="立即触发"
          className={runNowDisabled ? 'cursor-not-allowed text-muted-foreground/50' : 'text-info hover:bg-info/10'}
          onClick={() => onRunNow(task)}
          disabled={runNowDisabled}
        >
          <Play className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton title="删除" label="删除" className="text-destructive hover:bg-destructive/10" onClick={() => onDelete(task)}><Trash2 className="h-3.5 w-3.5" /></ActionButton>
      </div>
    </div>
  );
}

export function ScheduledTasksView({ tasks, projectOptions, taskById, selectedId, onSelect, onDelete, onToggle, onRunNow, blockedRuns, pendingRunNow, actionError, onDismissActionError }: ScheduledTasksViewProps) {
  // 列表级操作失败的提示条：与 ScheduledRunHistoryView 的结果条同位置（列表上方），
  // 空态也要能报错（比如删掉列表最后一条调度时撞上 409）。立即触发与删除共用一条 ——
  // 同一时刻只该有一条「刚才那次操作怎么了」，最新的一次覆盖上一条。
  const errorStrip = actionError ? (
    <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-4">
      <span className="min-w-0 flex-1 break-words">{actionError}</span>
      <button type="button" onClick={onDismissActionError} className="shrink-0 font-semibold hover:underline">关闭</button>
    </div>
  ) : null;

  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {errorStrip}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
          <div className="text-sm text-muted-foreground">暂无定时任务</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {errorStrip}
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
            {tasks.map((task) => {
              const selected = task.schedule_id === selectedId;
              const blocked = blockedRuns.get(task.schedule_id) ?? null;
              const pending = pendingRunNow.has(task.schedule_id);
              const runNowDisabled = Boolean(blocked) || pending;
              const runNowTitle = blocked ? runNowBlockedReason(blocked) : pending ? '正在触发…' : '立即触发';
              return (
              <tr
                key={task.schedule_id}
                data-selected={selected ? 'true' : 'false'}
                onClick={() => onSelect(task)}
                className={`cursor-pointer shadow-sm ${selected ? 'bg-accent' : 'bg-card'} ${task.enabled === 0 ? 'opacity-60' : ''}`}
              >
                <td className="rounded-l-lg px-4 py-3">
                  <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                    <Switch checked={task.enabled === 1} onToggle={() => onToggle(task)} ariaLabel={`${task.title}：启用/停用`} />
                  </span>
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
                    {ModeBadge(task)}
                    {AutoApproveBadge(task)}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-2xs text-muted-foreground">
                  {task.enabled === 0 ? '—' : formatAbsoluteTime(task.next_run_at)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <LastRunLink schedule={task} taskById={taskById} />
                </td>
                <td className="whitespace-nowrap rounded-r-lg px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      title={runNowTitle}
                      aria-label="立即触发"
                      onClick={(e) => { e.stopPropagation(); onRunNow(task); }}
                      disabled={runNowDisabled}
                      className={`rounded-lg px-2 py-1 ${runNowDisabled ? 'cursor-not-allowed text-muted-foreground/50' : 'text-info hover:bg-info/10'}`}
                    >
                      <Play className="h-3 w-3" />
                    </button>
                    <button title="删除" aria-label="删除" onClick={(e) => { e.stopPropagation(); onDelete(task); }} className="rounded-lg px-2 py-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile/tablet cards (<1024px) */}
      <div className="grid min-h-0 w-full flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:hidden">
        {tasks.map((task) => (
          <ScheduledTaskCard key={task.schedule_id} task={task} projectOptions={projectOptions} taskById={taskById} selectedId={selectedId} onSelect={onSelect} onDelete={onDelete} onToggle={onToggle} onRunNow={onRunNow} blockedRuns={blockedRuns} pendingRunNow={pendingRunNow} />
        ))}
      </div>
    </div>
  );
}
