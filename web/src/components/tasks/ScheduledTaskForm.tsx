import { useEffect, useState } from 'react';
import type { ScheduledTask, ScheduledTaskScheduleType, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import type { TaskProjectOption } from './TaskCard';
import { useTaskEngineAvailability } from './useTaskEngineAvailability';
import { TaskEngineSelect } from './TaskEngineSelect';

export type ScheduledTaskDraft = {
  title: string;
  description: string;
  projectPath: string;
  executorProvider: TaskEngine;
  priority: TaskPriority;
  label: TaskLabel;
  autoRun: boolean;
  scheduleType: ScheduledTaskScheduleType;
  cronExpr: string;
  intervalSeconds: string;
  runAt: string;
};

export const EMPTY_DRAFT: ScheduledTaskDraft = {
  title: '', description: '', projectPath: ASSISTANT_OPTION_VALUE, executorProvider: 'claude',
  priority: 'P2', label: 'other', autoRun: true, scheduleType: 'once',
  cronExpr: '', intervalSeconds: '3600', runAt: '',
};

const INTERVAL_PRESETS = [
  { value: '3600', label: '每 1 小时' },
  { value: '21600', label: '每 6 小时' },
  { value: '86400', label: '每天' },
  { value: '604800', label: '每周' },
];

function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDraft(initial?: ScheduledTask | null): ScheduledTaskDraft {
  if (!initial) return EMPTY_DRAFT;
  const runAt = initial.run_at ? toLocalDateTimeInput(initial.run_at) : '';
  return {
    title: initial.title,
    description: initial.description ?? '',
    projectPath: initial.project_path ?? ASSISTANT_OPTION_VALUE,
    executorProvider: initial.executor_provider,
    priority: initial.priority,
    label: initial.label,
    autoRun: initial.auto_run === 1,
    scheduleType: initial.schedule_type,
    cronExpr: initial.cron_expr ?? '',
    intervalSeconds: String(initial.interval_seconds ?? 3600),
    runAt,
  };
}

export type ScheduledTaskFormProps = {
  open: boolean;
  initial?: ScheduledTask | null;
  projectOptions: TaskProjectOption[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (draft: ScheduledTaskDraft) => void;
};

export function ScheduledTaskForm({ open, initial, projectOptions, submitting, error, onClose, onSubmit }: ScheduledTaskFormProps) {
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => toDraft(initial));
  const [localError, setLocalError] = useState<string | null>(null);

  const set = <K extends keyof ScheduledTaskDraft>(key: K, value: ScheduledTaskDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const selectedProjectOption = projectOptions.find((o) => o.value === draft.projectPath) ?? null;
  const engineAvailability = useTaskEngineAvailability(
    selectedProjectOption
      ? { value: selectedProjectOption.value, remoteHostId: selectedProjectOption.remoteHostId ?? null }
      : null,
    draft.projectPath === ASSISTANT_OPTION_VALUE,
  );

  // Keep the picked engine valid once availability settles.
  useEffect(() => {
    if (engineAvailability.status !== 'ready') return;
    if (engineAvailability.options.length === 0) return;
    if (!engineAvailability.options.includes(draft.executorProvider)) {
      set('executorProvider', engineAvailability.options[0]);
    }
  }, [engineAvailability, draft.executorProvider]);

  const submit = () => {
    setLocalError(null);
    if (engineAvailability.status === 'unavailable') {
      setLocalError(engineAvailability.hint);
      return;
    }
    if (!draft.title.trim()) { setLocalError('标题不能为空'); return; }
    if (draft.scheduleType === 'cron' && !draft.cronExpr.trim()) { setLocalError('请填写 cron 表达式'); return; }
    if (draft.scheduleType === 'once' && !draft.runAt) { setLocalError('请选择触发时间'); return; }
    if (draft.scheduleType === 'interval' && !(Number(draft.intervalSeconds) > 0)) { setLocalError('间隔必须大于 0 秒'); return; }
    onSubmit(draft);
  };

  const fieldCls = 'h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-full max-w-lg overflow-y-auto">
        <DialogTitle>{initial ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">标题</label>
            <Input className="h-9 w-full" placeholder="触发时创建的任务标题" value={draft.title} onChange={(e) => set('title', e.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">描述</label>
            <Input className="h-9 w-full" placeholder="触发时创建的任务内容，可选" value={draft.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">项目</label>
            <select className={fieldCls} value={draft.projectPath} onChange={(e) => set('projectPath', e.target.value)}>
              <option value={ASSISTANT_OPTION_VALUE}>🤖 Lovdex助手</option>
              {projectOptions.map((o) => (
                <option key={o.value} value={o.value} title={o.remoteHostName ? `${o.remoteHostName}:${o.value}` : o.value}>
                  {o.remoteHostName ? `🌐 ${o.remoteHostName} · ${o.label}` : o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">执行引擎</label>
            <TaskEngineSelect
              availability={engineAvailability}
              value={engineAvailability.status === 'unavailable' ? '' : draft.executorProvider}
              onChange={(engine) => set('executorProvider', engine)}
              className={fieldCls}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">优先级</label>
            <select className={fieldCls} value={draft.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Label</label>
            <select className={fieldCls} value={draft.label} onChange={(e) => set('label', e.target.value as TaskLabel)}>
              {LABEL_ORDER.map((l) => <option key={l} value={l}>{LABEL_META[l].label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={draft.autoRun} onChange={(e) => set('autoRun', e.target.checked)} />
            自动执行（关闭则仅生成提醒任务）
          </label>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">调度类型</label>
            <select className={fieldCls} value={draft.scheduleType} onChange={(e) => set('scheduleType', e.target.value as ScheduledTaskScheduleType)}>
              <option value="once">一次性</option>
              <option value="interval">间隔</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </div>
          {draft.scheduleType === 'once' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">触发时间</label>
              <Input type="datetime-local" className="h-9 w-full" value={draft.runAt} onChange={(e) => set('runAt', e.target.value)} />
            </div>
          )}
          {draft.scheduleType === 'interval' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">间隔</label>
              <select className={fieldCls} value={draft.intervalSeconds} onChange={(e) => set('intervalSeconds', e.target.value)}>
                {INTERVAL_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          )}
          {draft.scheduleType === 'cron' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Cron 表达式</label>
              <Input className="h-9 w-full" placeholder="0 9 * * *" value={draft.cronExpr} onChange={(e) => set('cronExpr', e.target.value)} />
            </div>
          )}
          {(localError || error) && <div className="text-sm text-red-500">{localError ?? error}</div>}
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
            <Button size="sm" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '保存'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
