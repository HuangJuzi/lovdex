import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, Loader2, RotateCcw } from 'lucide-react';

import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { cn } from '../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import type { Project, Task, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';
import { api } from '../../utils/api';
import { resolveSessionTitle } from '../../utils/sessionTitle';
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects, taskProjectLabel } from './projectOptions';
import { modelOptionsFor, useProviderModels } from './useProviderModels';
import { useTaskEngineAvailability } from './useTaskEngineAvailability';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import { AnchorPopover } from './AnchorPopover';
import { ChipSelect, type ChipSelectOption } from './ChipSelect';

/** 「更多…」角标：名称/上下文来源/备注 中已填的数量。 */
export function moreSetCount(name: string, sourceSessionId: string, remark: string): number {
  return [name.trim(), sourceSessionId, remark.trim()].filter((v) => v !== '').length;
}

/**
 * 确认按钮的可用性判据：需求非空，且没有创建请求在途。
 *
 * 在途那一档不是锦上添花 —— title 留空时后端要等模型取名（阻塞窗口最长
 * `TITLE_BLOCKING_TIMEOUT_MS` = 3s）才落库，这期间弹窗一直开着，按钮若仍可点，
 * 双击 / Enter 连击就是两次 POST，板上多出一条一模一样的任务。
 */
export function canSubmitNewTask(prompt: string, submitting: boolean): boolean {
  return prompt.trim() !== '' && !submitting;
}

export function CreateTaskDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640 });

  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [engine, setEngine] = useState<TaskEngine>('claude');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [deadline, setDeadline] = useState('');
  const [label, setLabel] = useState<TaskLabel>('other');
  const [remark, setRemark] = useState('');
  const [sourceSessionId, setSourceSessionId] = useState('');
  const [contextMode, setContextMode] = useState<'summary' | 'raw'>('summary');
  const [projects, setProjects] = useState<Project[]>([]);
  const [model, setModel] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [error, setError] = useState('');
  // 创建在途（后端取名期间）。state 只驱动按钮的禁用/转圈，拦截靠下面那个 ref。
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const isAssistant = projectPath === ASSISTANT_OPTION_VALUE || !projectPath;

  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of taskFormProjects(projects)) {
      const n = project.displayName || projectPathOf(project);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, c]) => c > 1).map(([n]) => n));
  }, [projects]);

  const newProjectRecord = useMemo(
    () => taskFormProjects(projects).find((p) => projectPathOf(p) === projectPath) ?? null,
    [projects, projectPath],
  );
  const sourceSessionOptions = useMemo(() => {
    if (!newProjectRecord) return [];
    return [...(newProjectRecord.sessions ?? [])]
      .sort((a, b) => {
        const at = new Date(a.updated_at || a.lastActivity || 0).getTime();
        const bt = new Date(b.updated_at || b.lastActivity || 0).getTime();
        return bt - at;
      })
      .filter((s) => s.id);
  }, [newProjectRecord]);

  const newEngineAvailability = useTaskEngineAvailability(
    newProjectRecord ? { value: projectPathOf(newProjectRecord), remoteHostId: newProjectRecord.remoteHostId ?? null } : null,
    projectPath === ASSISTANT_OPTION_VALUE,
  );

  useEffect(() => {
    if (newEngineAvailability.status !== 'ready') return;
    if (newEngineAvailability.options.length === 0) return;
    if (!newEngineAvailability.options.includes(engine)) setEngine(newEngineAvailability.options[0]);
  }, [newEngineAvailability, engine]);

  // 首次挂载时加载项目列表（沿用 TaskBoard 的 /api/projects 加载逻辑）。
  useEffect(() => {
    let cancelled = false;
    api.projects()
      .then(async (res) => {
        if (!res.ok) return [];
        const data = (await res.json()) as Project[];
        return Array.isArray(data) ? data : [];
      })
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const formProjects = taskFormProjects(list);
        setProjectPath(formProjects.length > 0 ? projectPathOf(formProjects[0]) : ASSISTANT_OPTION_VALUE);
      })
      .catch((err) => console.error('load projects for task create failed', err));
    return () => { cancelled = true; };
  }, []);

  const { models, loadedEngine } = useProviderModels(engine, open);

  // 列表到达后回到第一项：每次打开、每次切引擎都重置（与重构前的行为一致）。
  useEffect(() => {
    if (loadedEngine !== engine) return;
    setModel(models.length > 0 ? models[0].value : '');
  }, [loadedEngine, engine, models]);

  function reset() {
    setPrompt('');
    setName('');
    setPriority('P2');
    setDeadline('');
    setLabel('other');
    setRemark('');
    setSourceSessionId('');
    setContextMode('summary');
    setAutoApprove(false);
    setError('');
  }

  // 每次打开都重置为干净表单（与原 TaskBoard 的 openCreateForm→resetCreateForm 一致）。
  useEffect(() => {
    if (open) reset();
  }, [open]);

  async function submit() {
    // 连击守卫。用同步的 ref 而不是 submitting state：setState 要等下一轮渲染才
    // 生效，同一 tick 里（双击、Enter 连击）的第二次调用读到的还是旧值。
    if (submittingRef.current) return;
    setError('');
    const p = prompt.trim();
    if (!p) return;
    if (!isAssistant && newEngineAvailability.status === 'unavailable') {
      window.alert(newEngineAvailability.hint);
      return;
    }
    // 名字留空交给后端取名：title 为空时 createTask 会用 LLM（DeepSeek Flash）从
    // description 提炼，失败/超时降级到需求首行。这里不再本地提炼 —— 一旦本地填了
    // 非空 title，后端就认为「用户已指定名字」，LLM 取名永远不会触发。
    const title = name.trim();
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await api.tasks.create({
        projectPath: isAssistant ? '' : projectPath,
        title,
        description: p,
        executorProvider: isAssistant ? 'claude' : engine,
        executorModel: isAssistant ? null : model || null,
        status: 'todo',
        priority,
        deadline: deadline || null,
        isOperator: isAssistant,
        // 助手任务也照常带上：这是人在 UI 上做的决定，不随 executor 一起被忽略。
        autoApprove,
        label,
        remark: remark.trim() || null,
        sourceSessionId: sourceSessionId || undefined,
        contextMode: sourceSessionId ? contextMode : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message ?? '创建失败');
        return;
      }
      const created = (await res.json()) as Task;
      reset();
      onCreated(created);
    } catch (err) {
      console.error('createTask failed', err);
      setError('创建失败');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const projectOptions: ChipSelectOption[] = [
    { value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' },
    ...taskFormProjects(projects).map((p) => ({
      value: projectPathOf(p),
      label: taskProjectLabel(p, duplicateProjectNames),
      hint: p.remoteHostName ?? undefined,
    })),
  ];
  const priorityOptions: ChipSelectOption[] = PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_META[p].label }));
  const labelOptions: ChipSelectOption[] = LABEL_ORDER.map((l) => ({ value: l, label: LABEL_META[l].label }));
  const engineOptions: ChipSelectOption[] = newEngineAvailability.status === 'ready'
    ? newEngineAvailability.options.map((e) => ({ value: e, label: e }))
    : [];
  const modelOptions: ChipSelectOption[] = modelOptionsFor(models, model);
  const sourceOptions: ChipSelectOption[] = [
    { value: '', label: '（无）白纸开始' },
    ...sourceSessionOptions.map((s) => ({ value: s.id ?? '', label: resolveSessionTitle(s) || (s.id ?? '').slice(0, 8) })),
  ];

  const moreCount = moreSetCount(name, sourceSessionId, remark);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submittingRef.current) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-full sm:max-w-[66.7vw] overflow-y-auto">
        <DialogTitle>新建任务</DialogTitle>
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">新建任务</h2>
          <p className="text-xs text-muted-foreground">说清楚要做什么就行，其余都可以之后再补</p>
        </div>

        <div className="p-5">
          <div className="rounded-2xl border border-border/80 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/50">
            <textarea
              autoFocus
              className="min-h-[180px] w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:min-h-[240px]"
              placeholder="发给 agent 执行的内容"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
              <ChipSelect
                ariaLabel="项目"
                label="项目"
                options={projectOptions}
                value={projectPath}
                isMobile={isMobile}
                onChange={(v) => { setProjectPath(v); setSourceSessionId(''); }}
              />
              <ChipSelect
                ariaLabel="标签"
                label="标签"
                options={labelOptions}
                value={label}
                isMobile={isMobile}
                onChange={(v) => setLabel(v as TaskLabel)}
              />
              <ChipSelect
                ariaLabel="优先级"
                label="优先级"
                options={priorityOptions}
                value={priority}
                isMobile={isMobile}
                onChange={(v) => setPriority(v as TaskPriority)}
              />
              <label className="flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card px-3 text-sm text-foreground">
                <span className="text-muted-foreground">截止</span>
                <input
                  type="date"
                  className="bg-transparent text-sm text-foreground focus:outline-none"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </label>
              <ChipSelect
                ariaLabel="引擎"
                label="引擎"
                options={engineOptions}
                value={isAssistant ? '' : engine}
                disabled={isAssistant || newEngineAvailability.status === 'unavailable'}
                isMobile={isMobile}
                onChange={(v) => setEngine(v as TaskEngine)}
              />
              <ChipSelect
                ariaLabel="模型"
                label="模型"
                options={modelOptions}
                value={isAssistant ? '' : model}
                disabled={isAssistant}
                isMobile={isMobile}
                onChange={(v) => setModel(v)}
              />
              <button
                type="button"
                aria-label="自动审批"
                aria-pressed={autoApprove}
                onClick={() => setAutoApprove((v) => !v)}
                className={cn(
                  'flex h-9 items-center rounded-full border px-3 text-sm transition-colors',
                  autoApprove
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border/80 bg-card text-muted-foreground',
                )}
              >
                自动审批
              </button>
              <span className="text-xs text-muted-foreground">无人值守时自动放行工具调用（危险操作仍会拒绝）</span>
              <MoreChip
                moreCount={moreCount}
                isMobile={isMobile}
                name={name} setName={setName}
                sourceOptions={sourceOptions}
                sourceSessionId={sourceSessionId} setSourceSessionId={setSourceSessionId}
                contextMode={contextMode} setContextMode={setContextMode}
                remark={remark} setRemark={setRemark}
              />
              <button
                type="button"
                aria-label={submitting ? '创建中，请稍候' : prompt.trim() ? '创建任务' : '提示词为空，暂不能创建'}
                aria-busy={submitting}
                title="创建任务"
                disabled={!canSubmitNewTask(prompt, submitting)}
                onClick={() => void submit()}
                className={cn(
                  'ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90',
                  // 在途时按钮是 disabled 的，但仍要看得见转圈 —— 取名最长 3s，
                  // 没反馈的话用户只会以为没点上，再点一次（正是这条 bug 的成因）。
                  submitting ? 'cursor-wait opacity-70' : 'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {isAssistant && (
            <p className="mt-2 text-xs text-muted-foreground">🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。</p>
          )}
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">{isMobile ? 'Enter 创建 · Shift+Enter 换行' : ''}</span>
            <Button size="sm" variant="ghost" onClick={reset} disabled={submitting}><RotateCcw className="mr-1 h-3.5 w-3.5" />重置</Button>
            <Button size="sm" onClick={onClose} variant="ghost" disabled={submitting}>取消</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MoreChip({
  moreCount, isMobile, name, setName, sourceOptions, sourceSessionId, setSourceSessionId,
  contextMode, setContextMode, remark, setRemark,
}: {
  moreCount: number;
  isMobile: boolean;
  name: string; setName: (v: string) => void;
  sourceOptions: ChipSelectOption[];
  sourceSessionId: string; setSourceSessionId: (v: string) => void;
  contextMode: 'summary' | 'raw'; setContextMode: (v: 'summary' | 'raw') => void;
  remark: string; setRemark: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card px-3 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span>更多</span>
        {moreCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold text-primary-foreground">{moreCount}</span>
        )}
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} align="right" isMobile={isMobile} ariaLabel="更多设置">
        <div className="flex flex-col gap-3 p-1">
          <Field label="名称">
            <Input className="h-9 w-full" placeholder="可选，留空自动提炼" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="上下文来源">
            <select
              className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              value={sourceSessionId}
              onChange={(e) => setSourceSessionId(e.target.value)}
            >
              {sourceOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          {sourceSessionId && (
            <Field label="压缩方式">
              <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
                {(['summary', 'raw'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setContextMode(m)}
                    className={cn('flex-1 rounded-md px-3 py-1.5 text-sm transition-colors', contextMode === m ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {m === 'summary' ? '摘要' : '原文'}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="备注">
            <Input className="h-9 w-full" placeholder="需求来源等，可选" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Field>
        </div>
      </AnchorPopover>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
