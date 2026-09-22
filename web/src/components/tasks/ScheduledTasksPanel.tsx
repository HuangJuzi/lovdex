import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useScheduledTasks } from '../../hooks/useScheduledTasks';
import type { ScheduledTask, Task } from '../../types/app';
import { api } from '../../utils/api';
import { Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';

import type { DeleteOutcome } from './runHistoryDelete';
import { deletedRunIds, scheduleDeleteConfirmMessage, scheduleDeleteErrorMessage } from './scheduleDelete';
import { ScheduledRunHistoryView, runsOf, type ScheduleLookup } from './ScheduledRunHistoryView';
import { blockingRunsBySchedule, runNowErrorMessage } from './scheduleRunNow';
import { ScheduledTabBar, type ScheduledTab } from './ScheduledTabBar';
import { ScheduledTaskForm, toApiBody, type ScheduledTaskDraft } from './ScheduledTaskForm';
import { ScheduledTaskDetail } from './ScheduledTaskDetail';
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
  /** 删除成功后回调，供页面把行从本地列表里摘掉（WS 不可靠时的兜底）。 */
  onRunsDeleted: (taskIds: string[]) => void;
};

export const ScheduledTasksPanel = forwardRef<ScheduledTasksPanelHandle, ScheduledTasksPanelProps>(
  function ScheduledTasksPanel({ projectOptions, tasks, tab, onTabChange, onRunsDeleted }, ref) {
  const { subscribe } = useWebSocket();
  // 断点与 Tailwind 的 lg（1024px）对齐：>=lg 详情作右栏，<lg 详情作底部 sheet。
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 1024 });
  // 注意改名：hook 解构出来的字段本来就叫 `tasks`，但那是**调度**列表
  // （ScheduledTask[]），跟 props 里传进来的**任务**列表（Task[]）同名。
  const { tasks: schedules, loading, loadError, refresh } = useScheduledTasks({}, subscribe);
  const [formOpen, setFormOpen] = useState(false);
  // 详情面板里打开的那条调度（点击列表行/卡片进入）。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  // 连击守卫。用同步的 ref 而不是 submitting state：setState 要等下一轮渲染才生效，
  // 同一 tick 里（双击、Enter 连击）的第二次调用读到的还是旧值。标题留空时后端要等
  // 模型取名（最长 3s），这个窗口期足够双击两次。
  const submittingRef = useRef(false);

  const runs = useMemo(() => runsOf(tasks), [tasks]);
  // task_id → Task：把调度行的 last_task_id 映射到那条运行开的会话（跳会话用）。
  const taskById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) m.set(t.task_id, t);
    return m;
  }, [tasks]);

  // 选中的调度对象；列表里不存在（被删/刷新后消失）时回落 null。
  const selectedTask = useMemo(
    () => schedules.find((s) => s.schedule_id === selectedId) ?? null,
    [schedules, selectedId],
  );

  // 「上一轮还没结束」的调度 → 那个运行。判据见 scheduleRunNow.blockingRunsBySchedule。
  const blockedRuns = useMemo(() => blockingRunsBySchedule(schedules, tasks), [schedules, tasks]);
  // 派发中的 schedule_id。ref 是同步闸门（setState 要等下一轮渲染，同一 tick 里的
  // 第二次点击读到的还是旧值 —— 双击正好是这个 tick 内的场景），state 只负责把按钮
  // 渲染成 disabled。与同文件 submittingRef 是同一套写法。
  const [pendingRunNow, setPendingRunNow] = useState<Set<string>>(new Set());
  const pendingRunNowRef = useRef<Set<string>>(new Set());
  // 列表级操作（立即触发 / 删除）失败的提示条。同一时刻只留最新的一条。
  const [actionError, setActionError] = useState<string | null>(null);

  // 选中任务从列表里消失（被删 / 刷新后不在）时关闭详情，别渲染一个幽灵面板。
  useEffect(() => {
    if (selectedId && !loading && !schedules.some((s) => s.schedule_id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, schedules, loading]);

  /**
   * 删除运行记录。**逐条**调单个删除接口，而不是 `api.tasks.removeMany` ——
   * 批量接口既不守卫运行中、也不清关联会话（会留下孤儿会话），单个接口才是完整语义。
   * 逐条收集结果，好让 UI 把「哪几条因运行中被拒」如实报出来。
   */
  async function deleteRuns(taskIds: string[]): Promise<DeleteOutcome> {
    const deleted: string[] = [];
    const failed: DeleteOutcome['failed'] = [];
    for (const taskId of taskIds) {
      try {
        const res = await api.tasks.remove(taskId);
        if (res.ok) {
          deleted.push(taskId);
          continue;
        }
        const err = await res.json().catch(() => null);
        const reason = err?.error?.message ?? `HTTP ${res.status}`;
        console.error('delete run failed', taskId, reason);
        failed.push({ taskId, reason, running: err?.error?.code === 'SESSION_RUNNING' });
      } catch (e) {
        console.error('delete run failed', taskId, e);
        failed.push({ taskId, reason: e instanceof Error ? e.message : '网络错误', running: false });
      }
    }
    if (deleted.length > 0) onRunsDeleted(deleted);
    return { deleted, failed };
  }

  const openNew = useCallback(() => { setError(null); setFormKey((k) => k + 1); setFormOpen(true); }, []);
  // 供全局「新建任务」按钮在定时视图下直接唤起新建定时任务表单。
  useImperativeHandle(ref, () => ({ openNew }), [openNew]);
  // 点击列表行/卡片 → 打开详情（内联编辑）。
  const openDetail = (t: ScheduledTask) => { setSelectedId(t.schedule_id); setError(null); };

  async function submitCreate(draft: ScheduledTaskDraft) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.scheduledTasks.create(toApiBody(draft));
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

  async function submitUpdate(scheduleId: string, draft: ScheduledTaskDraft) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.scheduledTasks.update(scheduleId, toApiBody(draft));
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message ?? `保存失败 (${res.status})`);
        return;
      }
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /**
   * 删除定时任务。后端会**级联**删掉它跑出来的任务与关联会话（见
   * tasksService.deleteTasksBySchedule），所以这里两件事都不能省：
   * - 确认文案必须写明会话也会被删（scheduleDeleteConfirmMessage）；
   * - 把响应里带回的 task id 交给 onRunsDeleted，让行从本地任务列表里摘掉。
   *
   * 失败必须如实报出来：删除从「永远成功」变成了「可能被拒」—— 该调度还有一轮在跑时
   * 后端抛 409 SESSION_RUNNING，改动前这里直接把响应丢掉，用户点一下什么也不会发生。
   */
  async function remove(t: ScheduledTask) {
    const runCount = runs.filter((r) => r.source_schedule_id === t.schedule_id).length;
    if (!window.confirm(scheduleDeleteConfirmMessage(t.title, runCount))) return;
    setActionError(null);
    try {
      const res = await api.scheduledTasks.remove(t.schedule_id);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setActionError(scheduleDeleteErrorMessage(t.title, res.status, body));
        console.error('delete schedule failed', t.schedule_id, body ?? res.status);
        return;
      }
      const deletedRuns = deletedRunIds(body);
      if (deletedRuns.length > 0) onRunsDeleted(deletedRuns);
      void refresh();
    } catch (e) {
      // 没拿到响应（断网 / 后端没起来 / 连接中途被重置）：没有 status 可用，直接说清。
      setActionError(`「${t.title}」删除失败：无法连接后端`);
      console.error('delete schedule failed', t.schedule_id, e);
    }
  }

  async function toggle(t: ScheduledTask) {
    const res = t.enabled === 1
      ? await api.scheduledTasks.disable(t.schedule_id)
      : await api.scheduledTasks.enable(t.schedule_id);
    if (res.ok) void refresh();
  }

  async function runNow(t: ScheduledTask) {
    const id = t.schedule_id;
    // 双保险：按钮在这两种情况下本就是灰的，这里防的是键盘/自动化绕过 disabled。
    if (pendingRunNowRef.current.has(id) || blockedRuns.has(id)) return;
    pendingRunNowRef.current.add(id);
    setPendingRunNow(new Set(pendingRunNowRef.current));
    setActionError(null);
    try {
      const res = await api.scheduledTasks.runNow(id);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setActionError(runNowErrorMessage(t.title, res.status, body));
        console.error('runNow failed', id, body ?? res.status);
      }
      // 失败也要刷新：例如被另一个标签页抢先派发了一轮，本地列表已经不同步了。
      void refresh();
    } catch (e) {
      // 没拿到响应（断网 / 后端没起来 / 连接中途被重置）：没有 status 可用，直接说清。
      setActionError(`「${t.title}」立即触发失败：无法连接后端`);
      console.error('runNow failed', id, e);
    } finally {
      pendingRunNowRef.current.delete(id);
      setPendingRunNow(new Set(pendingRunNowRef.current));
    }
  }

  // 运行记录不依赖调度请求，所以它不等 loading —— 但必须把「列表还没到」这个事实
  // 传下去，否则每行都会显示成「已删除的调度」。
  const scheduleLookup: ScheduleLookup = loading ? 'loading' : loadError ? 'error' : 'ready';

  const detailPanel = selectedTask && !isMobile ? (
    <div className="hidden h-full min-h-0 w-[420px] shrink-0 rounded-xl border border-border bg-card lg:block">
      <ScheduledTaskDetail
        key={selectedTask.schedule_id}
        task={selectedTask}
        taskById={taskById}
        projectOptions={projectOptions}
        submitting={submitting}
        error={error}
        onSubmit={(d) => void submitUpdate(selectedTask.schedule_id, d)}
        onClose={() => setSelectedId(null)}
        onToggle={(t) => void toggle(t)}
        onRunNow={(t) => void runNow(t)}
        onDelete={(t) => void remove(t)}
        blocked={blockedRuns.get(selectedTask.schedule_id) ?? null}
        pendingRunNow={pendingRunNow.has(selectedTask.schedule_id)}
      />
    </div>
  ) : null;

  // 加载与失败只挡「调度」子标签：运行记录不依赖调度请求，调度列表还在路上时它
  // 照样能看，「所属调度」列按 scheduleLookup 显示状态占位。
  let body;
  if (tab === 'runs') {
    body = (
      <ScheduledRunHistoryView
        runs={runs}
        schedules={schedules}
        scheduleLookup={scheduleLookup}
        projectOptions={projectOptions}
        onDelete={deleteRuns}
      />
    );
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
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScheduledTasksView
            tasks={schedules}
            projectOptions={projectOptions}
            taskById={taskById}
            selectedId={selectedId}
            onSelect={openDetail}
            onDelete={(t) => void remove(t)}
            onToggle={(t) => void toggle(t)}
            onRunNow={(t) => void runNow(t)}
            blockedRuns={blockedRuns}
            pendingRunNow={pendingRunNow}
            actionError={actionError}
            onDismissActionError={() => setActionError(null)}
          />
        </div>
        {detailPanel}
      </div>
    );
  }

  return (
    <>
      <ScheduledTabBar tab={tab} onChange={onTabChange} />
      {body}
      <ScheduledTaskForm
        key={formKey}
        open={formOpen}
        initial={null}
        projectOptions={projectOptions}
        submitting={submitting}
        error={error}
        onClose={() => { if (!submittingRef.current) setFormOpen(false); }}
        onSubmit={(d) => void submitCreate(d)}
      />
      {/* 移动端详情走底部 sheet；桌面详情是右栏（见 detailPanel）。 */}
      {isMobile && (
        <Dialog open={selectedId != null} onOpenChange={(o) => { if (!o) setSelectedId(null); }}>
          <DialogContent variant="sheet" className="flex h-[85dvh] flex-col p-0">
            <DialogTitle>{selectedTask?.title ?? '定时任务详情'}</DialogTitle>
            {selectedTask && (
              <ScheduledTaskDetail
                key={selectedTask.schedule_id}
                task={selectedTask}
                taskById={taskById}
                projectOptions={projectOptions}
                submitting={submitting}
                error={error}
                onSubmit={(d) => void submitUpdate(selectedTask.schedule_id, d)}
                onClose={() => setSelectedId(null)}
                onToggle={(t) => void toggle(t)}
                onRunNow={(t) => void runNow(t)}
                onDelete={(t) => void remove(t)}
                blocked={blockedRuns.get(selectedTask.schedule_id) ?? null}
                pendingRunNow={pendingRunNow.has(selectedTask.schedule_id)}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
});
