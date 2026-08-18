import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, LayoutGrid, Plus, Table, X } from 'lucide-react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useTasks } from '../../hooks/useTasks';
import useLocalStorage from '../../hooks/useLocalStorage';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { cn } from '../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import type {
  Project,
  ProviderModelOption,
  Task,
  TaskEngine,
  TaskLabel,
  TaskPriority,
} from '../../types/app';
import { api, authenticatedFetch } from '../../utils/api';

// Matches the `/api/providers/:provider/models` response consumed by
// useChatProviderState: `{ success, data: { models: { OPTIONS, DEFAULT } } }`.
type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: {
      OPTIONS?: ProviderModelOption[];
      DEFAULT?: string;
    };
  };
};

import { TaskCard } from './TaskCard';
import { HomeButton } from './TaskBackNav';
import { buildTaskChatSend, TASK_RETRY_MESSAGE } from './taskExecution';
import { deriveTaskName } from './taskName';
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER, STATUS_META, STATUS_ORDER, groupByStatus } from './taskStatus';
import { TaskFilterBar } from './TaskFilterBar';
import { ScheduledTasksPanel, type ScheduledTasksPanelHandle } from './ScheduledTasksPanel';
import { TaskTableView } from './TaskTableView';
import { EMPTY_TASK_FILTER, filterTasks, normalizeTaskFilter } from './taskFilter';

export function TaskBoardPage() {
  const navigate = useNavigate();
  const { subscribe, sendMessage } = useWebSocket();
  const { tasks, loading, loadError, refresh, upsert, remove } = useTasks({}, subscribe);
  const [storedFilter, setFilter] = useLocalStorage<unknown>('taskFilter', EMPTY_TASK_FILTER);
  const filter = useMemo(() => normalizeTaskFilter(storedFilter), [storedFilter]);
  const [viewMode, setViewMode] = useLocalStorage<'board' | 'table' | 'scheduled'>('taskViewMode', 'board');
  // 侧边栏「定时任务」入口带 ?view=scheduled 进来时，启动选中定时视图；仅在挂载时读一次。
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('view') === 'scheduled') setViewMode('scheduled');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 移动端强制看板：表格在手机上体验差，且「表格」按钮已隐藏（hidden sm:inline-flex）。
  // 断点 640 与 Tailwind `sm:` 对齐。
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640 });
  const effectiveView = isMobile && viewMode !== 'scheduled' ? 'board' : viewMode;
  // `now` 每分钟刷新一次：避免页面跨午夜且无任务事件时，「今天/本周/本月/今年」的
  // 日期区间边界停留在上次重算值。任务/筛选变化仍会立即重算。
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const filteredTasks = useMemo(() => filterTasks(tasks, filter, now), [tasks, filter, now]);
  const groups = useMemo(() => groupByStatus(filteredTasks), [filteredTasks]);

  // 批量删除选择：跨表格/看板两个视图共享同一份 task_id 集合。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: string[]) => {
    setSelected((prev) => {
      if (ids.length > 0 && ids.every((id) => prev.has(id))) return new Set();
      return new Set(ids);
    });
  };

  const clearSelection = () => setSelected(new Set());

  // 已删/已不存在的任务 id 从选择里剪掉，避免幽灵勾选。
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.task_id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 个任务？此操作不可恢复。`)) return;
    setDeleting(true);
    try {
      const res = await api.tasks.removeMany(ids);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('deleteSelected failed', err?.error?.message ?? res.status);
        return;
      }
      // task_deleted ws 事件会从 useTasks 本地列表移除行；这里兜底本地删 + 清空选择。
      ids.forEach((id) => remove(id));
      clearSelection();
    } catch (err) {
      console.error('deleteSelected failed', err);
    } finally {
      setDeleting(false);
    }
  }

  // Create-task form state.
  const [creating, setCreating] = useState(false);
  // The prompt is the actual content executed by the agent; the name is only a
  // board label. A blank name is distilled from the prompt at submit time.
  const [newPrompt, setNewPrompt] = useState('');
  const [newName, setNewName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newEngine, setNewEngine] = useState<TaskEngine>('claude');
  const [newPriority, setNewPriority] = useState<TaskPriority>('P2');
  const [newDeadline, setNewDeadline] = useState('');
  const [newLabel, setNewLabel] = useState<TaskLabel>('other');
  const [newRemark, setNewRemark] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [newModel, setNewModel] = useState('');
  // Monotonic token so a slow response for a previous engine can't overwrite a
  // newer engine's model list when the user switches quickly.
  const modelsRequestRef = useRef(0);

  // `displayName` can collide across projects while the path stays unique (it is
  // what a task stores as `project_path`). Disambiguate only the names that
  // actually repeat, so the dropdown stays clean when names are unique.
  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of taskFormProjects(projects)) {
      const name = project.displayName || projectPathOf(project);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [projects]);

  // Candidate projects for each todo card's project selector. Same disambiguation
  // rule as the create form / detail page: use the display name, and append the
  // unique path only when the name collides.
  const projectOptions = useMemo(
    () =>
      taskFormProjects(projects).map((project) => {
        const path = projectPathOf(project);
        const name = project.displayName || path;
        const label = duplicateProjectNames.has(name) && name !== path ? `${name} — ${path}` : name;
        return { value: path, label };
      }),
    [projects, duplicateProjectNames],
  );

  // Load the project list once for the create form. The `/api/projects`
  // response JSON is an array of projects; the display name lives in
  // `displayName` and the path in `fullPath` (with `path` as a fallback).
  useEffect(() => {
    let cancelled = false;
    api.projects()
      .then(async (res) => {
        if (!res.ok) {
          console.error('load projects for task create failed', res.status);
          return [];
        }
        const data = (await res.json()) as Project[];
        return Array.isArray(data) ? data : [];
      })
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const formProjects = taskFormProjects(list);
        setNewProjectPath(formProjects.length > 0 ? projectPathOf(formProjects[0]) : ASSISTANT_OPTION_VALUE);
      })
      .catch((err) => console.error('load projects for task create failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Load models for the selected engine whenever the form is open or the engine
  // changes. A Claude model isn't valid for Codex, so the list reloads per
  // provider. Falls back to an empty list (=> default model) on any failure.
  useEffect(() => {
    if (!creating) return;
    const requestId = modelsRequestRef.current + 1;
    modelsRequestRef.current = requestId;
    const engine = newEngine;
    authenticatedFetch(`/api/providers/${engine}/models`)
      .then(async (res) => {
        if (!res.ok) {
          console.error('load models for task create failed', res.status);
          return [] as ProviderModelOption[];
        }
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .then((list) => {
        // Ignore stale responses from a superseded engine selection.
        if (modelsRequestRef.current !== requestId) return;
        setModels(list);
        setNewModel(list.length > 0 ? list[0].value : '');
      })
      .catch((err) => {
        if (modelsRequestRef.current !== requestId) return;
        console.error('load models for task create failed', err);
        setModels([]);
        setNewModel('');
      });
  }, [creating, newEngine]);

  // 创建的任务被当前筛选排除时留存提示；筛选调到能显示它（或手动关闭）后消失。
  const [hiddenCreated, setHiddenCreated] = useState<Task | null>(null);

  function resetCreateForm() {
    setNewPrompt('');
    setNewName('');
    setNewPriority('P2');
    setNewDeadline('');
    setNewLabel('other');
    setNewRemark('');
  }

  function openCreateForm() {
    resetCreateForm();
    setCreating(true);
  }

  function closeCreateForm() {
    resetCreateForm();
    setCreating(false);
  }

  // 全局「新建任务」按钮：定时视图下唤起定时任务表单，其余视图唤起普通任务表单。
  const scheduledPanelRef = useRef<ScheduledTasksPanelHandle>(null);
  function handleHeaderNew() {
    if (effectiveView === 'scheduled') scheduledPanelRef.current?.openNew();
    else openCreateForm();
  }

  async function createTask() {
    const projectPath = newProjectPath;
    const prompt = newPrompt.trim();
    const isAssistant = projectPath === ASSISTANT_OPTION_VALUE || !projectPath;
    if (!prompt) return;
    // Name is optional: fall back to a locally distilled label from the prompt.
    const title = newName.trim() || deriveTaskName(prompt);
    try {
      const res = await api.tasks.create({
        projectPath: isAssistant ? '' : projectPath,
        title,
        description: prompt,
        executorProvider: isAssistant ? 'claude' : newEngine,
        executorModel: isAssistant ? null : (newModel || null),
        status: 'todo',
        priority: newPriority,
        deadline: newDeadline || null,
        isOperator: isAssistant,
        label: newLabel,
        remark: newRemark.trim() || null,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('createTask failed', err?.error?.message ?? res.status);
        return;
      }
      const created = (await res.json()) as Task;
      setCreating(false);
      setNewPrompt('');
      setNewName('');
      setNewPriority('P2');
      setNewDeadline('');
      setNewLabel('other');
      setNewRemark('');
      void refresh();
      // 新任务没被当前筛选（项目/日期范围）落下时，明确提示用户，否则会以为没建上。
      if (filterTasks([created], filter, now).length === 0) setHiddenCreated(created);
    } catch (err) {
      console.error('createTask failed', err);
    }
  }

  async function startExecution(task: Task) {
    try {
      const res = await api.tasks.startExecution(task.task_id);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('startExecution failed', err?.error?.message ?? res.status);
        void refresh();
        return;
      }
      const data = (await res.json()) as { sessionId?: unknown };
      const sessionId = data?.sessionId ? String(data.sessionId) : null;
      if (!sessionId) {
        void refresh();
        return;
      }
      // Kick off the agent over the board's existing socket and stay on the
      // board; the run streams/persists server-side and the card flips to
      // in_progress via the task↔session status linkage. Open it later with
      // "打开会话" to watch or answer an approval prompt.
      sendMessage(buildTaskChatSend(sessionId, task));
    } catch (err) {
      console.error('startExecution failed', err);
    }
  }

  /**
   * Card "开始执行" / "重试" entry. A failed task with a linked session retries
   * in-place: send the retry message so the agent resumes with the existing
   * conversation context, instead of `startExecution` which would create a new
   * session and orphan the old one. Fresh runs (no session) keep the old path.
   */
  function runTask(task: Task) {
    if (task.sub_status === 'failed' && task.session_id) {
      sendMessage(buildTaskChatSend(task.session_id, task, TASK_RETRY_MESSAGE));
      return;
    }
    void startExecution(task);
  }

  async function updateStatus(task: Task, status: Task['status']) {
    try {
      const res = await api.tasks.update(task.task_id, { status });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('updateStatus failed', err?.error?.message ?? res.status);
        return;
      }
      const updated = (await res.json()) as Task;
      upsert(updated);
    } catch (err) {
      console.error('updateStatus failed', err);
    }
  }

  /** Change a todo card's project. Mirrors the detail page: warns when the task
   *  has a linked session (changing project orphans that conversation), then
   *  updates via the API and upserts the returned row into the board. */
  async function changeProject(task: Task, nextPath: string) {
    if (nextPath === task.project_path) return;
    if (task.session_id) {
      const ok = window.confirm('修改项目将删除当前会话及其全部对话记录，此操作不可恢复。是否继续？');
      if (!ok) return;
    }
    try {
      const res = await api.tasks.update(task.task_id, { projectPath: nextPath });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('changeProject failed', err?.error?.message ?? res.status);
        return;
      }
      upsert((await res.json()) as Task);
    } catch (err) {
      console.error('changeProject failed', err);
    }
  }

  // 新建任务仍被筛选排除时展示提示条；筛选调到能显示它之后自动消失。
  const filterStillHidesNewTask = hiddenCreated
    ? filterTasks([hiddenCreated], filter, now).length === 0
    : false;

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <div className="flex rounded-xl border border-border/70 bg-muted/50 p-0.5">
          <button
            type="button"
            aria-pressed={effectiveView === 'board'}
            onClick={() => setViewMode('board')}
            title="看板"
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal transition-all',
              effectiveView === 'board'
                ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5 flex-shrink-0" />
            {/* 移动端（<640px）只留图标；断点与 WorkspaceNav 对齐。 */}
            <span className="hidden sm:inline">看板</span>
          </button>
          <button
            type="button"
            aria-pressed={effectiveView === 'table'}
            onClick={() => setViewMode('table')}
            title="表格"
            className={cn(
              // 表格在手机上体验差，整个按钮只在 sm+ 出现。
              'hidden items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal transition-all sm:flex',
              effectiveView === 'table'
                ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Table className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="hidden sm:inline">表格</span>
          </button>
          <button
            type="button"
            aria-pressed={effectiveView === 'scheduled'}
            onClick={() => setViewMode('scheduled')}
            title="定时任务"
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal transition-all',
              effectiveView === 'scheduled'
                ? 'bg-card text-card-foreground shadow-[0_2px_0_rgba(30,27,50,0.10),0_4px_10px_rgba(35,33,41,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Clock className="h-3.5 w-3.5 flex-shrink-0" />
            {/* 移动端（<640px）只留图标 */}
            <span className="hidden sm:inline">定时</span>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="toolbar" variant="chunkyPrimary" onClick={handleHeaderNew} disabled={creating} title="新建任务" aria-label="新建任务">
            <Plus />
            {/* 移动端（<640px）只留 + 号 */}
            <span className="hidden sm:inline">新建任务</span>
          </Button>
          <HomeButton />
        </div>
      </header>
      <Dialog open={creating} onOpenChange={(open) => { if (!open) closeCreateForm(); }}>
        <DialogContent className="max-h-[85vh] w-full max-w-lg overflow-y-auto">
          <DialogTitle>新建任务</DialogTitle>
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">新建任务</h2>
          </div>
          <div className="p-5">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">任务提示词</label>
                <textarea
                  className="min-h-[64px] w-full resize-y rounded-xl border-2 border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/60"
                  placeholder="发给 agent 执行的内容"
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  rows={2}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">名称</label>
                <Input
                  className="h-9 w-full"
                  placeholder="可选，留空自动提炼"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">项目</label>
                <select
                  className="h-10 w-full rounded-xl border-2 border-border bg-card px-3 py-1.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                >
                  <option value={ASSISTANT_OPTION_VALUE}>🤖 Lovdex助手</option>
                  {taskFormProjects(projects).map((project) => {
                    const path = projectPathOf(project);
                    const name = project.displayName || path;
                    const label =
                      duplicateProjectNames.has(name) && name !== path ? `${name} — ${path}` : name;
                    return (
                      <option key={project.projectId} value={path} title={path}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">执行引擎</label>
                <select
                  className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                  value={newEngine}
                  onChange={(e) => setNewEngine(e.target.value as TaskEngine)}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="opencode">OpenCode</option>
                  <option value="qoder">Qoder</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">模型</label>
                <select
                  className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  disabled={models.length === 0}
                >
                  {models.length === 0 ? (
                    <option value="">默认模型 (default)</option>
                  ) : (
                    models.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label || model.value}
                      </option>
                    ))
                  )}
                </select>
              </div>
              {newProjectPath === ASSISTANT_OPTION_VALUE && (
                <p className="col-span-full text-xs text-muted-foreground">
                  🤖 Lovdex助手任务固定使用 Claude + 默认模型，以上引擎/模型设置将被忽略。
                </p>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">优先级</label>
                <select
                  className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
                >
                  {PRIORITY_ORDER.map((p) => (
                    <option key={p} value={p}>{PRIORITY_META[p].label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">截止日期</label>
                <Input
                  type="date"
                  className="h-9 w-full"
                  value={newDeadline}
                  onChange={(e) => setNewDeadline(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Label</label>
                <select
                  className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value as TaskLabel)}
                >
                  {LABEL_ORDER.map((l) => (
                    <option key={l} value={l}>{LABEL_META[l].label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">备注</label>
                <Input
                  className="h-9 w-full"
                  placeholder="需求来源等，可选"
                  value={newRemark}
                  onChange={(e) => setNewRemark(e.target.value)}
                />
              </div>
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={closeCreateForm}>
                  取消
                </Button>
                <Button size="sm" disabled={!newPrompt.trim()} onClick={() => void createTask()}>
                  创建
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {loading ? (
        <div className="px-3 text-sm text-muted-foreground sm:px-6">加载中…</div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="text-sm text-muted-foreground">加载任务失败</div>
          <button
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            onClick={() => void refresh()}
          >
            重试
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {effectiveView === 'scheduled' ? (
            <ScheduledTasksPanel ref={scheduledPanelRef} projectOptions={projectOptions} />
          ) : (
          <>
          <TaskFilterBar projectOptions={projectOptions} filter={filter} onChange={setFilter} />
          {filterStillHidesNewTask && hiddenCreated && (
            <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-amber-500/10 px-3 py-2 sm:px-4">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                任务「{hiddenCreated.title}」已创建，但当前筛选未包含它，因此列表中没有显示。
              </span>
              <button
                type="button"
                onClick={() => setFilter(EMPTY_TASK_FILTER)}
                className="shrink-0 rounded-lg bg-primary/10 px-2.5 py-1 text-sm font-semibold text-primary hover:bg-primary/20"
              >
                清除筛选
              </button>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setHiddenCreated(null)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {selected.size > 0 && (
            <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 sm:px-4">
              <span className="text-sm font-medium">已选 {selected.size} 项</span>
              <button
                type="button"
                onClick={clearSelection}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                取消选择
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void deleteSelected()}
                className="ml-auto rounded-lg bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400"
              >
                {deleting ? '删除中…' : '删除'}
              </button>
            </div>
          )}
          {effectiveView === 'table' ? (
            <TaskTableView
              tasks={filteredTasks}
              projectOptions={projectOptions}
              onStart={runTask}
              onStatusChange={(task, status) => updateStatus(task, status)}
              onOpenSession={(task) => task.session_id && navigate(`/session/${task.session_id}`)}
              onProjectChange={(task, nextPath) => changeProject(task, nextPath)}
              onOpenTask={(task) => navigate(`/task/${task.task_id}`)}
              selected={selected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3 sm:flex-row sm:gap-3 sm:overflow-x-auto sm:overflow-y-hidden sm:px-4 sm:pb-4">
              {STATUS_ORDER.map((status) => (
                <div
                  key={status}
                  className="flex w-full flex-col rounded-2xl border border-border/70 bg-muted/30 shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)] sm:min-w-64 sm:flex-1"
                >
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: STATUS_META[status].color }}
                    />
                    <span className="text-sm font-semibold text-foreground">
                      {STATUS_META[status].label}
                    </span>
                    <span className="ml-auto rounded-full border border-border/70 bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
                      {groups[status].length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 px-2 pb-2 sm:min-h-0 sm:flex-1 sm:overflow-y-auto">
                    {groups[status].length === 0 && (
                      <div className="py-8 text-center text-xs text-muted-foreground">暂无任务</div>
                    )}
                    {groups[status].map((task) => (
                      <TaskCard
                        key={task.task_id}
                        task={task}
                        onStart={() => runTask(task)}
                        onStatusChange={(s) => updateStatus(task, s)}
                        onOpenSession={() => task.session_id && navigate(`/session/${task.session_id}`)}
                        projectOptions={projectOptions}
                        onProjectChange={(nextPath) => changeProject(task, nextPath)}
                        selected={selected.has(task.task_id)}
                        onToggleSelect={toggleSelect}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
}
