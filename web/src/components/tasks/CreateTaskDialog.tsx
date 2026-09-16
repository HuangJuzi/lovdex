import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, RotateCcw } from 'lucide-react';

import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { cn } from '../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import type { Project, ProviderModelOption, Task, TaskEngine, TaskLabel, TaskPriority } from '../../types/app';
import { api, authenticatedFetch } from '../../utils/api';
import { resolveSessionTitle } from '../../utils/sessionTitle';
import { deriveTaskName } from './taskName';
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects, taskProjectLabel } from './projectOptions';
import { useTaskEngineAvailability } from './useTaskEngineAvailability';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER } from './taskStatus';
import { AnchorPopover } from './AnchorPopover';
import { ChipSelect, type ChipSelectOption } from './ChipSelect';

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: { models?: { OPTIONS?: ProviderModelOption[]; DEFAULT?: string } };
};

/** 「更多…」角标：名称/上下文来源/备注 中已填的数量。 */
export function moreSetCount(name: string, sourceSessionId: string, remark: string): number {
  return [name.trim(), sourceSessionId, remark.trim()].filter((v) => v !== '').length;
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
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const modelsRequestRef = useRef(0);

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

  // 模型随引擎重载（沿用 TaskBoard 的 stale-response 守卫）。
  useEffect(() => {
    if (!open) return;
    const requestId = modelsRequestRef.current + 1;
    modelsRequestRef.current = requestId;
    const eng = engine;
    authenticatedFetch(`/api/providers/${eng}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .then((list) => {
        if (modelsRequestRef.current !== requestId) return;
        setModels(list);
        setModel(list.length > 0 ? list[0].value : '');
      })
      .catch((err) => {
        if (modelsRequestRef.current !== requestId) return;
        console.error('load models for task create failed', err);
        setModels([]);
        setModel('');
      });
  }, [open, engine]);

  function reset() {
    setPrompt('');
    setName('');
    setPriority('P2');
    setDeadline('');
    setLabel('other');
    setRemark('');
    setSourceSessionId('');
    setContextMode('summary');
    setError('');
  }

  async function submit() {
    const p = prompt.trim();
    if (!p) return;
    if (!isAssistant && newEngineAvailability.status === 'unavailable') {
      window.alert(newEngineAvailability.hint);
      return;
    }
    const title = name.trim() || deriveTaskName(p);
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
  const modelOptions: ChipSelectOption[] = models.length === 0
    ? [{ value: '', label: '默认模型' }]
    : models.map((m) => ({ value: m.value, label: m.label || m.value }));
  const sourceOptions: ChipSelectOption[] = [
    { value: '', label: '（无）白纸开始' },
    ...sourceSessionOptions.map((s) => ({ value: s.id ?? '', label: resolveSessionTitle(s) || (s.id ?? '').slice(0, 8) })),
  ];

  const moreCount = moreSetCount(name, sourceSessionId, remark);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
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
                disabled={isAssistant}
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
                aria-label={prompt.trim() ? '创建任务' : '提示词为空，暂不能创建'}
                title="创建任务"
                disabled={!prompt.trim()}
                onClick={() => void submit()}
                className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            </div>
          </div>

          {isAssistant && (
            <p className="mt-2 text-xs text-muted-foreground">🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。</p>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">{isMobile ? 'Enter 创建 · 换行用换行键' : ''}</span>
            <Button size="sm" variant="ghost" onClick={reset}><RotateCcw className="mr-1 h-3.5 w-3.5" />重置</Button>
            <Button size="sm" onClick={onClose} variant="ghost">取消</Button>
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
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{moreCount}</span>
        )}
      </button>
      <AnchorPopover open={open} onOpenChange={setOpen} anchorRef={anchorRef} align="right" isMobile={isMobile} ariaLabel="更多设置">
        <div className="flex flex-col gap-3 p-1">
          <Field label="名称">
            <Input className="h-9 w-full" placeholder="可选，留空自动提炼" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="上下文来源">
            <ChipSelect
              ariaLabel="上下文来源"
              label="上下文来源"
              options={sourceOptions}
              value={sourceSessionId}
              isMobile={isMobile}
              onChange={setSourceSessionId}
            />
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
