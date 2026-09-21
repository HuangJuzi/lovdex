import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useScheduledTasks } from '../../hooks/useScheduledTasks';
import type { ScheduledTask, Task } from '../../types/app';
import { api } from '../../utils/api';
import { ScheduledRunHistoryView, runsOf, type ScheduleLookup } from './ScheduledRunHistoryView';
import { ScheduledTabBar, type ScheduledTab } from './ScheduledTabBar';
import { ScheduledTaskForm, toApiBody, type ScheduledTaskDraft } from './ScheduledTaskForm';
import { ScheduledTasksView } from './ScheduledTasksView';
import type { TaskProjectOption } from './TaskCard';

export type ScheduledTasksPanelHandle = {
  openNew: () => void;
};

export type ScheduledTasksPanelProps = {
  projectOptions: TaskProjectOption[];
  /** 任务页的全量任务列表（TaskBoard 的 useTasks），运行记录从这里过滤出来。 */
  tasks: Task[];
  tab: ScheduledTab;
  onTabChange: (next: ScheduledTab) => void;
};

export const ScheduledTasksPanel = forwardRef<ScheduledTasksPanelHandle, ScheduledTasksPanelProps>(
  function ScheduledTasksPanel({ projectOptions, tasks, tab, onTabChange }, ref) {
  const { subscribe } = useWebSocket();
  // 注意改名：hook 解构出来的字段本来就叫 `tasks`，但那是**调度**列表
  // （ScheduledTask[]），跟 props 里传进来的**任务**列表（Task[]）同名。
  const { tasks: schedules, loading, loadError, refresh } = useScheduledTasks({}, subscribe);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  // 连击守卫。用同步的 ref 而不是 submitting state：setState 要等下一轮渲染才生效，
  // 同一 tick 里（双击、Enter 连击）的第二次调用读到的还是旧值。标题留空时后端要等
  // 模型取名（最长 3s），这个窗口期足够双击两次。
  const submittingRef = useRef(false);

  const runs = useMemo(() => runsOf(tasks), [tasks]);

  const openNew = useCallback(() => { setEditing(null); setError(null); setFormKey((k) => k + 1); setFormOpen(true); }, []);
  // 供全局「新建任务」按钮在定时视图下直接唤起新建定时任务表单。
  useImperativeHandle(ref, () => ({ openNew }), [openNew]);
  const openEdit = (t: ScheduledTask) => { setEditing(t); setError(null); setFormKey((k) => k + 1); setFormOpen(true); };

  async function submit(draft: ScheduledTaskDraft) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const body = toApiBody(draft);
    try {
      const res = editing
        ? await api.scheduledTasks.update(editing.schedule_id, body)
        : await api.scheduledTasks.create(body);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message ?? `保存失败 (${res.status})`);
        return;
      }
      setFormOpen(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function remove(t: ScheduledTask) {
    if (!window.confirm(`删除定时任务「${t.title}」？已生成的任务不会被删除。`)) return;
    await api.scheduledTasks.remove(t.schedule_id);
    void refresh();
  }

  async function toggle(t: ScheduledTask) {
    const res = t.enabled === 1
      ? await api.scheduledTasks.disable(t.schedule_id)
      : await api.scheduledTasks.enable(t.schedule_id);
    if (res.ok) void refresh();
  }

  async function runNow(t: ScheduledTask) {
    const res = await api.scheduledTasks.runNow(t.schedule_id);
    if (res.ok) void refresh();
  }

  // 运行记录不依赖调度请求，所以它不等 loading —— 但必须把「列表还没到」这个事实
  // 传下去，否则每行都会显示成「已删除的调度」。
  const scheduleLookup: ScheduleLookup = loading ? 'loading' : loadError ? 'error' : 'ready';

  // 加载与失败只挡「调度」子标签：运行记录不依赖调度请求，调度列表还在路上时它
  // 照样能看，「所属调度」列按 scheduleLookup 显示状态占位。
  let body;
  if (tab === 'runs') {
    body = <ScheduledRunHistoryView runs={runs} schedules={schedules} scheduleLookup={scheduleLookup} projectOptions={projectOptions} />;
  } else if (loading) {
    body = <div className="px-3 text-sm text-muted-foreground sm:px-6">加载中…</div>;
  } else if (loadError) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div className="text-sm text-muted-foreground">加载定时任务失败</div>
        <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90" onClick={() => void refresh()}>重试</button>
      </div>
    );
  } else {
    body = (
      <ScheduledTasksView
        tasks={schedules}
        projectOptions={projectOptions}
        onEdit={openEdit}
        onDelete={(t) => void remove(t)}
        onToggle={(t) => void toggle(t)}
        onRunNow={(t) => void runNow(t)}
      />
    );
  }

  return (
    <>
      <ScheduledTabBar tab={tab} onChange={onTabChange} />
      {body}
      <ScheduledTaskForm key={formKey} open={formOpen} initial={editing} projectOptions={projectOptions} submitting={submitting} error={error} onClose={() => { if (!submittingRef.current) setFormOpen(false); }} onSubmit={(d) => void submit(d)} />
    </>
  );
});
