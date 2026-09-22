import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';

import type { ScheduledTask, ScheduledTaskScheduleType, TaskEngine } from '../../types/app';
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
import {
  CRON_MODES,
  DOM_OPTIONS,
  DOW_OPTIONS,
  parseCronPreset,
  resolveCronExpr,
  type CronMode,
} from '../../utils/cronPreset';

import { AnchorPopover } from './AnchorPopover';
import { ChipSelect, type ChipSelectOption } from './ChipSelect';
import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import type { TaskProjectOption } from './TaskCard';
import { modelOptionsFor, nextModelOnLoad, useProviderModels } from './useProviderModels';
import { ENGINE_NAMES, useTaskEngineAvailability } from './useTaskEngineAvailability';

export type ScheduledTaskDraft = {
  title: string;
  description: string;
  projectPath: string;
  executorProvider: TaskEngine;
  /** 空串 = 不指定，跑 provider 的默认模型槽位（后端见 null）。 */
  executorModel: string;
  autoRun: boolean;
  /** 无人值守执行时自动放行工具调用（危险操作仍会拒绝）。 */
  autoApprove: boolean;
  scheduleType: ScheduledTaskScheduleType;
  cronExpr: string;
  // cronExpr 只承载「自定义」模式；其余模式由 cronMode + 下面三个参数拼出
  // （见 utils/cronPreset.ts 的 resolveCronExpr）。这样改时间/星期时表达式是算出来的，
  // 不需要回写，也就不存在双源同步。
  cronMode: CronMode;
  cronTime: string;
  cronDow: string;
  cronDom: string;
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
  executorModel: '',
  autoRun: true,
  autoApprove: false,
  scheduleType: 'once',
  cronExpr: '',
  cronMode: 'daily',
  cronTime: '09:00',
  cronDow: '1',
  cronDom: '1',
  intervalAmount: '1',
  intervalUnit: 'hour',
  runAt: '',
};

/**
 * 确认按钮的可用性判据：描述非空，且没有保存请求在途。
 *
 * 在途那一档不是锦上添花 —— title 留空时后端要等模型取名（阻塞窗口最长
 * `TITLE_BLOCKING_TIMEOUT_MS` = 3s）才落库，这期间弹窗一直开着，按钮若仍可点，
 * 双击连击就是两次 POST，列表里多出一条一模一样的定时任务。
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
    executorModel: d.executorModel || null,
    autoRun: d.autoRun ? 1 : 0,
    // 后端用 body.autoApprove === true 判定，所以这里发布尔值（不是 0/1）——
    // 与 autoRun 的 0|1 不同，发 1 会被后端当成缺失静默丢弃。别顺手统一。
    autoApprove: d.autoApprove,
    scheduleType: d.scheduleType,
    cronExpr: d.scheduleType === 'cron' ? resolveCronExpr(d) : null,
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

export function toDraft(initial?: ScheduledTask | null): ScheduledTaskDraft {
  if (!initial) return EMPTY_DRAFT;
  const runAt = initial.run_at ? toLocalDateTimeInput(initial.run_at) : '';
  // 非法值（null / NaN / < 1）兜底到 EMPTY_DRAFT 的默认间隔；能整除的最大单位由 decomposeInterval 决定。
  const rawSeconds = Number(initial.interval_seconds);
  const safeSeconds =
    Number.isFinite(rawSeconds) && rawSeconds >= 1
      ? rawSeconds
      : intervalSecondsOf(Number(EMPTY_DRAFT.intervalAmount), EMPTY_DRAFT.intervalUnit);
  const { amount: intervalAmount, unit: intervalUnit } = decomposeInterval(safeSeconds);
  // 认得出就结构化回填；认不出则自定义模式 + 原始表达式原样保留。
  const preset = parseCronPreset(initial.cron_expr ?? '');
  return {
    title: initial.title,
    description: initial.description ?? '',
    projectPath: initial.project_path ?? ASSISTANT_OPTION_VALUE,
    executorProvider: initial.executor_provider,
    executorModel: initial.executor_model ?? '',
    autoRun: initial.auto_run === 1,
    // 用 === 1 而不是真值判断：老行或后端漏传时得到 false（保持询问），是安全方向。
    autoApprove: initial.auto_approve === 1,
    scheduleType: initial.schedule_type,
    cronExpr: initial.cron_expr ?? '',
    cronMode: preset?.mode ?? 'custom',
    cronTime: preset?.time ?? EMPTY_DRAFT.cronTime,
    cronDow: preset?.dow ?? EMPTY_DRAFT.cronDow,
    cronDom: preset?.dom ?? EMPTY_DRAFT.cronDom,
    intervalAmount: String(intervalAmount),
    intervalUnit: intervalUnit,
    runAt,
  };
}

/**
 * 切换 cron 模式。切到「自定义」时把 `cronExpr` 播种好，判据是**里面有没有内容**
 * 而不是「解不解析得出来」—— 新建任务时 `cronExpr` 是空串，按后者判会让用户面对
 * 一个空框，播种的初衷就没了。
 *
 * 只在模式切换这个显式动作里播种一次，之后用户在裸输入框里逐字敲的内容不会再被
 * 回写覆盖（那正是计划里担心的 clobber）。抽成纯函数是为了能在无 DOM 环境下直接
 * 断言（同 toProjectChipOptions）。
 */
export function switchCronMode(d: ScheduledTaskDraft, mode: CronMode): ScheduledTaskDraft {
  if (mode !== 'custom') return { ...d, cronMode: mode };
  // 切到自定义时播种，但要区分两种情况：
  //   - cronExpr 为空（新建任务、或从没进过自定义）→ 用当前生效的表达式播种，
  //     免得用户面对一个空框；
  //   - cronExpr 非空（用户手敲过、且切到 preset 时被保留下来）→ 原样留着，
  //     否则「自定义 → preset → 自定义」的往返会把手敲的内容吞掉。
  return { ...d, cronMode: mode, cronExpr: d.cronExpr.trim() ? d.cronExpr : resolveCronExpr(d) };
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

/**
 * 表单本体（不含 Dialog 壳、不含标题头），自管 draft state。新建弹窗与详情面板共用：
 * - 新建弹窗（`ScheduledTaskForm`）包一层 Dialog + 标题头；
 * - 详情面板（`ScheduledTaskDetail`）把它嵌进面板里，直接改选中任务。
 *
 * `active` 是模型拉取闸门（见 useProviderModels）：弹窗关着时传 false 不发请求，
 * 详情面板常开传 true。
 */
export type ScheduledTaskFormBodyProps = {
  initial?: ScheduledTask | null;
  active?: boolean;
  projectOptions: TaskProjectOption[];
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: ScheduledTaskDraft) => void;
};

export function ScheduledTaskFormBody({
  initial,
  active = true,
  projectOptions,
  submitting,
  error,
  onCancel,
  onSubmit,
}: ScheduledTaskFormBodyProps) {
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => toDraft(initial));
  const [localError, setLocalError] = useState<string | null>(null);
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640 });
  const { models, loadedEngine } = useProviderModels(draft.executorProvider, active);
  // 「上次落定引擎」：每次 effect 应用完选中值后更新。用它（而不是挂载时的引擎）判断
  // 是否发生了切换，否则「切到别的引擎再切回来」会被误判成没切过，模型停在中间那个
  // 引擎的选项上，保存后就是「引擎 A + 引擎 B 的模型」这种错配。
  const settledEngineRef = useRef(draft.executorProvider);
  const modelPickedRef = useRef(false);

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

  // 模型列表到达后决定选中哪一项。策略在 nextModelOnLoad 里，这里只负责调用时机：
  //   - loadedEngine !== 当前引擎 → 列表还没跟上，等；
  //   - 用户手动选过且没切引擎 → 不覆盖他的选择；
  //   - 自动纠正引擎（上面那个 effect）也算「切过」——engineSwitched 为真，模型跟着重置。
  useEffect(() => {
    if (loadedEngine !== draft.executorProvider) return;
    const engineSwitched = loadedEngine !== settledEngineRef.current;
    if (modelPickedRef.current && !engineSwitched) return;
    const next = nextModelOnLoad({
      mode: initial ? 'edit' : 'create',
      engineSwitched,
      models,
      current: draft.executorModel,
    });
    // 记录本次落定的引擎。放在早退之后是安全的：engineSwitched 为 false 时
    // loadedEngine 本来就等于 settledEngineRef.current，更新是空操作。
    settledEngineRef.current = loadedEngine;
    if (next !== draft.executorModel) set('executorModel', next);
  }, [loadedEngine, models, draft.executorProvider, draft.executorModel, initial]);

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
    if (draft.scheduleType === 'cron' && !resolveCronExpr(draft).trim()) {
      // preset 模式下用户眼前是时间控件，没有「表达式」可填，文案得跟着模式走。
      setLocalError(draft.cronMode === 'custom' ? '请填写 cron 表达式' : '请选择触发时间');
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
  const projectChipOptions = toProjectChipOptions(projectOptions);
  const canSubmit = canSubmitScheduledTask(draft.description, submitting);

  return (
    <>
      <div className="rounded-2xl border border-border/80 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/50">
        <textarea
          autoFocus
          className="min-h-[180px] w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:min-h-[240px]"
          placeholder="说清楚要做什么就行，名称留空会自动生成"
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
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
            onChange={(v) => {
              modelPickedRef.current = false;
              set('executorProvider', v as TaskEngine);
            }}
          />
          <ChipSelect
            ariaLabel="模型"
            label="模型"
            options={modelOptionsFor(models, draft.executorModel)}
            value={draft.executorModel}
            disabled={models.length === 0}
            isMobile={isMobile}
            onChange={(v) => {
              modelPickedRef.current = true;
              set('executorModel', v);
            }}
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
        <span className="text-2xs font-semibold tracking-wide text-muted-foreground">调度</span>
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
            <>
              <ChipSelect
                ariaLabel="Cron 模式"
                label="Cron 模式"
                options={CRON_MODES}
                value={draft.cronMode}
                isMobile={isMobile}
                onChange={(v) => setDraft((d) => switchCronMode(d, v as CronMode))}
              />
              {draft.cronMode === 'custom' ? (
                <Input
                  className="h-9 w-auto"
                  placeholder="0 9 * * *"
                  aria-label="cron 表达式"
                  value={draft.cronExpr}
                  onChange={(e) => set('cronExpr', e.target.value)}
                />
              ) : (
                <>
                  {draft.cronMode === 'weekly' && (
                    <ChipSelect
                      ariaLabel="星期"
                      label="星期"
                      options={DOW_OPTIONS}
                      value={draft.cronDow}
                      isMobile={isMobile}
                      onChange={(v) => set('cronDow', v)}
                    />
                  )}
                  {draft.cronMode === 'monthly' && (
                    <ChipSelect
                      ariaLabel="日期"
                      label="日期"
                      options={DOM_OPTIONS}
                      value={draft.cronDom}
                      isMobile={isMobile}
                      onChange={(v) => set('cronDom', v)}
                    />
                  )}
                  <Input
                    type="time"
                    aria-label="触发时间"
                    className="h-9 w-auto"
                    value={draft.cronTime}
                    onChange={(e) => set('cronTime', e.target.value)}
                  />
                </>
              )}
            </>
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
          <button
            type="button"
            aria-label="自动审批"
            aria-pressed={draft.autoApprove}
            onClick={() => set('autoApprove', !draft.autoApprove)}
            className={cn(
              'flex h-9 items-center rounded-full border px-3 text-sm transition-colors',
              draft.autoApprove
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border/80 bg-card text-muted-foreground',
            )}
          >
            自动审批
          </button>
          <span className="text-xs text-muted-foreground">
            无人值守时自动放行工具调用（危险操作仍会拒绝）
          </span>
        </div>
      </div>

      {(localError || error) && <p className="mt-2 text-sm text-destructive">{localError ?? error}</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
      </div>
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

/** 新建定时任务弹窗（编辑已改走详情面板内联，见 ScheduledTaskDetail）。 */
export function ScheduledTaskForm({
  open,
  initial,
  projectOptions,
  submitting,
  error,
  onClose,
  onSubmit,
}: ScheduledTaskFormProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-[66.7vw]">
        <DialogTitle>{initial ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{initial ? '编辑定时任务' : '新建定时任务'}</h2>
          <p className="text-xs text-muted-foreground">说清楚要做什么就行，其余都可以之后再补</p>
        </div>

        <div className="p-5">
          <ScheduledTaskFormBody
            initial={initial}
            active={open}
            projectOptions={projectOptions}
            submitting={submitting}
            error={error}
            onCancel={onClose}
            onSubmit={onSubmit}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
