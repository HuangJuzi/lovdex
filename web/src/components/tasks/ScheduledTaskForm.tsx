import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';

import type { ScheduledTask, ScheduledTaskScheduleType, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { cn } from '../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import {
  INTERVAL_MAX_SECONDS,
  INTERVAL_MIN_SECONDS,
  INTERVAL_UNITS,
  decomposeInterval,
  intervalSecondsOf,
  type IntervalUnit,
} from '../../utils/interval';

import { AnchorPopover } from './AnchorPopover';
import { ChipSelect, type ChipSelectOption } from './ChipSelect';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import type { TaskProjectOption } from './TaskCard';
import { ENGINE_NAMES, useTaskEngineAvailability } from './useTaskEngineAvailability';

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
  // 拆成数字 + 单位两个字段而不是只存秒数：用户把数字改成 90 再切到「小时」时，
  // 只存秒数会变成 1.5 小时或需要四舍五入，有损；拆开后改数字和改单位是两个独立动作。
  intervalAmount: string;
  intervalUnit: IntervalUnit;
  runAt: string;
};

export const EMPTY_DRAFT: ScheduledTaskDraft = {
  title: '',
  description: '',
  projectPath: ASSISTANT_OPTION_VALUE,
  executorProvider: 'claude',
  priority: 'P2',
  label: 'other',
  autoRun: true,
  scheduleType: 'once',
  cronExpr: '',
  intervalAmount: '1',
  intervalUnit: 'hour',
  runAt: '',
};

/**
 * 确认按钮的可用性判据：描述非空，且没有保存请求在途。
 *
 * 在途那一档不是锦上添花 —— title 留空时后端要等模型取名（阻塞窗口最长
 * `TITLE_BLOCKING_TIMEOUT_MS` = 3s）才落库，这期间弹窗一直开着，按钮若仍可点，
 * 双击 / Enter 连击就是两次 POST，列表里多出一条一模一样的定时任务。
 *
 * 只卡描述：调度字段（cron / 触发时间 / 间隔）的缺失走提交时的内联报错，与
 * CreateTaskDialog 把可用性判据保持在单一维度上的做法一致。
 */
export function canSubmitScheduledTask(description: string, submitting: boolean): boolean {
  return description.trim() !== '' && !submitting;
}

/**
 * draft 的间隔换算成秒。取整是因为 `<input type="number">` 的 step 拦不住手输的小数，
 * 而小数秒会一路流进后端、把列表标签退化成「每 3960.0000000000005 秒」。
 */
function draftIntervalSeconds(d: ScheduledTaskDraft): number {
  return Math.round(intervalSecondsOf(Number(d.intervalAmount), d.intervalUnit));
}

/**
 * draft → POST/PATCH /api/scheduled-tasks 的请求体。
 *
 * `title` 原样透传，**不做任何本地兜底**：空串是「让后端用 LLM 从描述取名」的信号，
 * 前端一旦在这里填了名字，后端的取名分支就永远不会进入（同 CreateTaskDialog）。
 */
export function toApiBody(d: ScheduledTaskDraft) {
  const projectPath = d.projectPath === ASSISTANT_OPTION_VALUE || !d.projectPath ? null : d.projectPath;
  return {
    title: d.title,
    description: d.description || null,
    projectPath,
    executorProvider: d.executorProvider,
    priority: d.priority,
    label: d.label,
    autoRun: d.autoRun ? 1 : 0,
    scheduleType: d.scheduleType,
    cronExpr: d.scheduleType === 'cron' ? d.cronExpr : null,
    intervalSeconds: d.scheduleType === 'interval' ? draftIntervalSeconds(d) : null,
    runAt: d.scheduleType === 'once' ? (d.runAt ? new Date(d.runAt).toISOString() : null) : null,
  };
}

const SCHEDULE_TYPES: { value: ScheduledTaskScheduleType; label: string }[] = [
  { value: 'once', label: '单次' },
  { value: 'interval', label: '间隔' },
  { value: 'cron', label: 'Cron' },
];

/**
 * 项目 chip 的选项：远端项目把主机名挂在弹层行的右侧（同 CreateTaskDialog）。
 * 抽成纯函数是为了能在无 DOM 环境下直接断言。
 */
export function toProjectChipOptions(projectOptions: TaskProjectOption[]): ChipSelectOption[] {
  return projectOptions.map((o) => ({
    value: o.value,
    label: o.label,
    hint: o.remoteHostName ?? undefined,
  }));
}

function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDraft(initial?: ScheduledTask | null): ScheduledTaskDraft {
  if (!initial) return EMPTY_DRAFT;
  const runAt = initial.run_at ? toLocalDateTimeInput(initial.run_at) : '';
  // 非法值（null / NaN / < 1）兜底到 EMPTY_DRAFT 的默认间隔；能整除的最大单位由 decomposeInterval 决定。
  const rawSeconds = Number(initial.interval_seconds);
  const safeSeconds =
    Number.isFinite(rawSeconds) && rawSeconds >= 1
      ? rawSeconds
      : intervalSecondsOf(Number(EMPTY_DRAFT.intervalAmount), EMPTY_DRAFT.intervalUnit);
  const { amount: intervalAmount, unit: intervalUnit } = decomposeInterval(safeSeconds);
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
    intervalAmount: String(intervalAmount),
    intervalUnit: intervalUnit,
    runAt,
  };
}

/** 名称芯片：空名时虚线边框 + 文案「名称」，点开是个普通输入框。 */
function NameChip({ value, onChange, isMobile }: { value: string; onChange: (v: string) => void; isMobile: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="名称"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 items-center gap-1 rounded-full border bg-card px-3 text-sm transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          value.trim() ? 'border-border/80 text-foreground' : 'border-dashed border-border text-muted-foreground',
        )}
      >
        <span className="max-w-[190px] truncate">{value.trim() || '名称'}</span>
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} isMobile={isMobile} ariaLabel="名称">
        <div className="flex flex-col gap-1 p-1">
          <span className="text-xs font-medium text-muted-foreground">名称</span>
          <Input
            className="h-9 w-full"
            placeholder="留空则由 AI 从描述生成"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </AnchorPopover>
    </>
  );
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

export function ScheduledTaskForm({
  open,
  initial,
  projectOptions,
  submitting,
  error,
  onClose,
  onSubmit,
}: ScheduledTaskFormProps) {
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => toDraft(initial));
  const [localError, setLocalError] = useState<string | null>(null);
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640 });

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
    if (!draft.description.trim()) {
      setLocalError('请先描述这个定时任务要做什么');
      return;
    }
    if (draft.scheduleType === 'cron' && !draft.cronExpr.trim()) {
      setLocalError('请填写 cron 表达式');
      return;
    }
    if (draft.scheduleType === 'once' && !draft.runAt) {
      setLocalError('请选择触发时间');
      return;
    }
    if (draft.scheduleType === 'interval') {
      const seconds = draftIntervalSeconds(draft);
      if (!(seconds >= INTERVAL_MIN_SECONDS && seconds <= INTERVAL_MAX_SECONDS)) {
        setLocalError('间隔需在 1 分钟到 365 天之间');
        return;
      }
    }
    onSubmit(draft);
  };

  const engineOptions: ChipSelectOption[] =
    engineAvailability.status === 'ready'
      ? engineAvailability.options.map((e) => ({ value: e, label: ENGINE_NAMES[e] }))
      : // 非 ready 时保留一项，芯片才显示得出当前引擎的中文名而不是裸的「引擎」二字。
        [{ value: draft.executorProvider, label: ENGINE_NAMES[draft.executorProvider] }];
  const engineHint = 'hint' in engineAvailability ? engineAvailability.hint : undefined;
  const priorityOptions: ChipSelectOption[] = PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_META[p].label }));
  const labelOptions: ChipSelectOption[] = LABEL_ORDER.map((l) => ({ value: l, label: LABEL_META[l].label }));
  const projectChipOptions = toProjectChipOptions(projectOptions);
  const canSubmit = canSubmitScheduledTask(draft.description, submitting);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] w-full sm:max-w-[66.7vw] overflow-y-auto">
        <DialogTitle>{initial ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{initial ? '编辑定时任务' : '新建定时任务'}</h2>
          <p className="text-xs text-muted-foreground">说清楚要做什么就行，其余都可以之后再补</p>
        </div>

        <div className="p-5">
          <div className="rounded-2xl border border-border/80 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/50">
            <textarea
              autoFocus
              className="min-h-[180px] w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:min-h-[240px]"
              placeholder="说清楚要做什么就行，名称留空会自动生成"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
              <NameChip value={draft.title} onChange={(v) => set('title', v)} isMobile={isMobile} />
              <ChipSelect
                ariaLabel="项目"
                label="项目"
                options={projectChipOptions}
                value={draft.projectPath}
                isMobile={isMobile}
                onChange={(v) => set('projectPath', v)}
              />
              <ChipSelect
                ariaLabel="引擎"
                label="引擎"
                options={engineOptions}
                value={draft.executorProvider}
                disabled={engineAvailability.status !== 'ready'}
                isMobile={isMobile}
                onChange={(v) => set('executorProvider', v as TaskEngine)}
              />
              <ChipSelect
                ariaLabel="优先级"
                label="优先级"
                options={priorityOptions}
                value={draft.priority}
                isMobile={isMobile}
                onChange={(v) => set('priority', v as TaskPriority)}
              />
              <ChipSelect
                ariaLabel="标签"
                label="标签"
                options={labelOptions}
                value={draft.label}
                isMobile={isMobile}
                onChange={(v) => set('label', v as TaskLabel)}
              />
              <button
                type="button"
                aria-label={submitting ? '保存中，请稍候' : canSubmit ? '保存定时任务' : '描述为空，暂不能保存'}
                aria-busy={submitting}
                title="保存"
                disabled={!canSubmit}
                onClick={submit}
                className={cn(
                  'ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90',
                  submitting ? 'cursor-wait opacity-70' : 'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {engineHint && <p className="mt-2 text-xs text-muted-foreground">{engineHint}</p>}

          <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border p-3">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">调度</span>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
                {SCHEDULE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => set('scheduleType', t.value)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm transition-colors',
                      draft.scheduleType === t.value
                        ? 'bg-card shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {draft.scheduleType === 'once' && (
                <Input
                  type="datetime-local"
                  className="h-9 w-auto"
                  value={draft.runAt}
                  onChange={(e) => set('runAt', e.target.value)}
                />
              )}
              {draft.scheduleType === 'interval' && (
                <>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    aria-label="间隔数量"
                    className="h-9 w-24"
                    value={draft.intervalAmount}
                    onChange={(e) => set('intervalAmount', e.target.value)}
                  />
                  <ChipSelect
                    ariaLabel="间隔单位"
                    label="间隔单位"
                    options={INTERVAL_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                    value={draft.intervalUnit}
                    isMobile={isMobile}
                    onChange={(v) => set('intervalUnit', v as IntervalUnit)}
                  />
                </>
              )}
              {draft.scheduleType === 'cron' && (
                <Input
                  className="h-9 w-auto"
                  placeholder="0 9 * * *"
                  value={draft.cronExpr}
                  onChange={(e) => set('cronExpr', e.target.value)}
                />
              )}
              <button
                type="button"
                aria-pressed={draft.autoRun}
                onClick={() => set('autoRun', !draft.autoRun)}
                className={cn(
                  'flex h-9 items-center rounded-full border px-3 text-sm transition-colors',
                  draft.autoRun
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border/80 bg-card text-muted-foreground',
                )}
              >
                自动执行
              </button>
              <span className="text-xs text-muted-foreground">关闭则仅生成提醒任务，不自动开跑</span>
            </div>
          </div>

          {(localError || error) && <p className="mt-2 text-sm text-red-600">{localError ?? error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
              取消
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
