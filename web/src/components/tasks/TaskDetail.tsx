import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { Button } from '../../shared/view/ui';
import { api, authenticatedFetch } from '../../utils/api';
import type {
  Project,
  ProviderModelOption,
  Task,
  TaskEngine,
  TaskLabel,
  TaskPriority,
  TaskStatus,
  TaskUpsertedEvent,
} from '../../types/app';

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

import { buildTaskChatSend, TASK_RETRY_MESSAGE } from './taskExecution';
import { TaskResultPanel } from './TaskResultPanel';
import { pickLastAssistantText } from './taskResult';
import type { TaskResultState } from './taskResult';
import { projectPathOf, taskFormProjects } from './projectOptions';
import { LABEL_META, LABEL_ORDER, PRIORITY_META, PRIORITY_ORDER, STATUS_META, STATUS_ORDER } from './taskStatus';
import { formatAbsoluteTime } from './taskTimestamp';
import { SubStatusBadge } from './SubStatusBadge';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { sendMessage, subscribe } = useWebSocket();
  const [task, setTask] = useState<Task | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loadError, setLoadError] = useState(false);
  const loadSeq = useRef(0);
  const savingRef = useRef(false);
  const [resultState, setResultState] = useState<TaskResultState>('idle');
  const [resultContent, setResultContent] = useState('');
  // Project selector for todo tasks. `projects` mirrors the TaskBoard
  // create-form dropdown; `projectPath` is the pending selection (reverted on
  // cancel/failure).
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const resultSeq = useRef(0);
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [deadline, setDeadline] = useState('');
  const [label, setLabel] = useState<TaskLabel>('other');
  const [remark, setRemark] = useState('');
  const [engine, setEngine] = useState<TaskEngine>('claude');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const modelsRequestRef = useRef(0);

  const load = useCallback(async () => {
    if (!taskId) return;
    const seq = ++loadSeq.current;
    try {
      const res = await api.tasks.get(taskId);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('load task failed', err?.error?.message ?? res.status);
        if (seq === loadSeq.current) setLoadError(true);
        return;
      }
      const data = (await res.json()) as Task;
      if (seq !== loadSeq.current) return;
      setTask(data);
      setTitle(data.title);
      setDescription(data.description ?? '');
      setPriority(data.priority ?? 'P2');
      setDeadline(data.deadline ?? '');
      setLabel(data.label ?? 'other');
      setRemark(data.remark ?? '');
      setEngine(data.executor_provider);
      setModel(data.executor_model ?? '');
      setLoadError(false);
    } catch (err) {
      console.error('load task failed', err);
      if (seq === loadSeq.current) setLoadError(true);
    }
  }, [taskId]);

  // `displayName` can collide across projects while the path stays unique — the
  // same disambiguation the TaskBoard create form uses.
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

  // Keep the pending selection in sync with the task's actual project.
  useEffect(() => {
    if (task) setProjectPath(task.project_path);
  }, [task?.project_path]);

  useEffect(() => {
    let cancelled = false;
    api.projects()
      .then(async (res) => {
        if (!res.ok) return [];
        const data = (await res.json()) as Project[];
        return Array.isArray(data) ? data : [];
      })
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => console.error('load projects for task detail failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the model list for the selected engine so 执行引擎/模型 are editable.
  // Ignore stale responses when the engine is switched quickly.
  useEffect(() => {
    const requestId = ++modelsRequestRef.current;
    const currentEngine = engine;
    authenticatedFetch(`/api/providers/${currentEngine}/models`)
      .then(async (res) => {
        if (!res.ok) return [] as ProviderModelOption[];
        const body = (await res.json()) as ProviderModelsApiResponse;
        const options = body.success ? body.data?.models?.OPTIONS : undefined;
        return Array.isArray(options) ? options : [];
      })
      .then((list) => {
        if (modelsRequestRef.current !== requestId) return;
        setModels(list);
      })
      .catch((err) => {
        if (modelsRequestRef.current !== requestId) return;
        console.error('load models for task detail failed', err);
        setModels([]);
      });
  }, [engine]);

  const loadResult = useCallback(async (sessionId: string) => {
    const seq = ++resultSeq.current;
    setResultState('loading');
    try {
      const res = await api.unifiedSessionMessages(sessionId, 'claude', {});
      if (seq !== resultSeq.current) return;
      if (!res.ok) {
        setResultState('error');
        return;
      }
      const body = (await res.json()) as { data?: { messages?: unknown[] } } | { messages?: unknown[] };
      const messages = Array.isArray((body as { data?: { messages?: unknown[] } })?.data?.messages)
        ? (body as { data: { messages: unknown[] } }).data.messages
        : Array.isArray((body as { messages?: unknown[] }).messages)
          ? (body as { messages: unknown[] }).messages
          : [];
      const text = pickLastAssistantText(messages as { kind: string; role?: string; content?: string }[]);
      if (text) {
        setResultContent(text);
        setResultState('ready');
      } else {
        setResultContent('');
        setResultState('empty');
      }
    } catch (err) {
      console.error('load task result failed', err);
      if (seq === resultSeq.current) setResultState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the result whenever the linked session changes.
  useEffect(() => {
    if (!task?.session_id) {
      setResultState('idle');
      setResultContent('');
      return;
    }
    void loadResult(task.session_id);
  }, [task?.session_id, loadResult]);

  // Live-refresh the result when the engine advances this task's session
  // (running → in_progress, completed → in_review). We deliberately do NOT
  // replace title/description here, to avoid clobbering in-flight edits — but
  // we DO patch the engine-owned fields (status, session_id, approval_pending,
  // lifecycle timestamps) so the "等你批准" overlay and status badge stay live.
  useEffect(() => {
    if (!subscribe || !taskId) return;
    return subscribe((event) => {
      if (event.kind !== 'task_upserted') return;
      const upserted = event as unknown as TaskUpsertedEvent;
      if (!upserted.task || upserted.task.task_id !== taskId) return;
      const next = upserted.task;
      setTask((prev) =>
        prev
          ? {
              ...prev,
              status: next.status,
              session_id: next.session_id,
              approval_pending: next.approval_pending,
              pending_tool: next.pending_tool,
              sub_status: next.sub_status,
              started_at: next.started_at,
              completed_at: next.completed_at,
              ai_summary: next.ai_summary,
              verdict_reason: next.verdict_reason,
              verdict_at: next.verdict_at,
              updated_at: next.updated_at,
              priority: next.priority ?? prev.priority,
              deadline: next.deadline,
              is_operator: next.is_operator,
              label: next.label ?? prev.label,
              remark: next.remark,
            }
          : prev,
      );
      // The backend always broadcasts a complete task row, so sync the
      // controlled edit inputs straight from the payload. Nullable fields are
      // mapped to '' (the input's empty state) so a remote null-clear propagates.
      setPriority(next.priority);
      setDeadline(next.deadline ?? '');
      setLabel(next.label);
      setRemark(next.remark ?? '');
      setEngine(next.executor_provider);
      setModel(next.executor_model ?? '');
      const sid = next.session_id;
      if (!sid) return;
      if (next.status === 'in_progress' || next.status === 'in_review' || next.status === 'done') {
        void loadResult(sid);
      }
    });
  }, [subscribe, taskId, loadResult]);

  const saveFields = useCallback(async () => {
    if (!task) return;
    // Guard against concurrent title/description blur saves racing each other.
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const res = await api.tasks.update(task.task_id, { title, description });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('save task failed', err?.error?.message ?? res.status);
        return;
      }
      setTask(await res.json());
    } catch (err) {
      console.error('save task failed', err);
    } finally {
      savingRef.current = false;
    }
  }, [task, title, description]);

  async function savePriority(nextPriority: TaskPriority) {
    if (!task || nextPriority === task.priority) return;
    setPriority(nextPriority);
    try {
      const res = await api.tasks.update(task.task_id, { priority: nextPriority });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save priority failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save priority failed', err); }
  }

  async function saveDeadline(nextDeadline: string) {
    if (!task) return;
    setDeadline(nextDeadline);
    const value = nextDeadline || null;
    if (value === task.deadline) return;
    try {
      const res = await api.tasks.update(task.task_id, { deadline: value });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save deadline failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save deadline failed', err); }
  }

  async function saveLabel(nextLabel: TaskLabel) {
    if (!task || nextLabel === task.label) return;
    setLabel(nextLabel);
    try {
      const res = await api.tasks.update(task.task_id, { label: nextLabel });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save label failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save label failed', err); }
  }

  async function saveRemark(nextRemark: string) {
    if (!task) return;
    setRemark(nextRemark.trim());
    const value = nextRemark.trim() || null;
    if (value === task.remark) return;
    try {
      const res = await api.tasks.update(task.task_id, { remark: value });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save remark failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save remark failed', err); }
  }

  async function saveEngine(nextEngine: TaskEngine) {
    if (!task || nextEngine === task.executor_provider) return;
    setEngine(nextEngine);
    try {
      const res = await api.tasks.update(task.task_id, { executorProvider: nextEngine });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save engine failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save engine failed', err); }
  }

  async function saveModel(nextModel: string) {
    if (!task || nextModel === (task.executor_model ?? '')) return;
    setModel(nextModel);
    try {
      const res = await api.tasks.update(task.task_id, { executorModel: nextModel || null });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save model failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save model failed', err); }
  }

  async function updateStatus(status: TaskStatus) {
    if (!task) return;
    try {
      const res = await api.tasks.update(task.task_id, { status });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('updateStatus failed', err?.error?.message ?? res.status);
        return;
      }
      setTask(await res.json());
    } catch (err) {
      console.error('updateStatus failed', err);
    }
  }

  async function remove() {
    if (!task) return;
    if (!window.confirm('确定删除该任务？')) return;
    try {
      const res = await api.tasks.remove(task.task_id);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('remove failed', err?.error?.message ?? res.status);
        return;
      }
      navigate('/tasks');
    } catch (err) {
      console.error('remove failed', err);
    }
  }

  async function startExecution() {
    if (!task) return;
    try {
      const res = await api.tasks.startExecution(task.task_id);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('startExecution failed', err?.error?.message ?? res.status);
        return;
      }
      const data = (await res.json()) as { sessionId?: unknown };
      const sessionId = data?.sessionId ? String(data.sessionId) : null;
      if (sessionId) {
        // Run the agent over the shared socket and stay on the detail page; the
        // button flips to "打开会话" once the refetch picks up the linkage.
        sendMessage(buildTaskChatSend(sessionId, task));
      }
      // Refetch so status/session linkage refreshes.
      const refreshed = await api.tasks.get(task.task_id);
      if (!refreshed.ok) {
        const err = await refreshed.json().catch(() => null);
        console.error('startExecution refetch failed', err?.error?.message ?? refreshed.status);
        return;
      }
      setTask(await refreshed.json());
    } catch (err) {
      console.error('startExecution failed', err);
    }
  }

  /**
   * Retry a failed task in its existing session: send the retry message over
   * the socket so the agent resumes with the full conversation context, instead
   * of `startExecution` which would create a brand-new session and orphan the
   * old one. Defensive fallback to `startExecution` if the task somehow has no
   * session (the retry button only renders when `session_id` is set).
   */
  function retryTask() {
    if (!task) return;
    if (task.session_id) {
      sendMessage(buildTaskChatSend(task.session_id, task, TASK_RETRY_MESSAGE));
      return;
    }
    void startExecution();
  }

  async function changeProject(nextPath: string) {
    if (!task || nextPath === task.project_path) return;
    const previous = task.project_path;
    if (task.session_id) {
      const ok = window.confirm('修改项目将删除当前会话及其全部对话记录，此操作不可恢复。是否继续？');
      if (!ok) {
        setProjectPath(previous);
        return;
      }
    }
    setProjectPath(nextPath);
    try {
      const res = await api.tasks.update(task.task_id, { projectPath: nextPath });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('changeProject failed', err?.error?.message ?? res.status);
        setProjectPath(previous);
        return;
      }
      setTask(await res.json());
    } catch (err) {
      console.error('changeProject failed', err);
      setProjectPath(previous);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <div className="text-sm text-muted-foreground">加载任务失败</div>
        <button
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 shadow-[0_2px_0_#1c3fa8]"
          onClick={() => void load()}
        >
          重试
        </button>
      </div>
    );
  }

  if (!task) return <div className="p-8 text-sm text-muted-foreground">加载中…</div>;

  return (
    <div className="h-dvh overflow-y-auto bg-background">
      <div className="mx-auto w-full px-4 pb-6 pt-3 sm:px-8 sm:pb-8 sm:pt-4">
        <div className="flex flex-wrap items-start gap-3">
          <Button
            type="button"
            variant="chunky"
            size="toolbar"
            className="gap-1.5"
            onClick={() => navigate('/tasks')}
            title="任务面板"
            aria-label="任务面板"
          >
            <ClipboardList className="text-amber-500" />
            任务面板
          </Button>
          <div className="min-w-0 flex-1">
            <input
              className="w-full bg-transparent text-xl font-bold text-foreground outline-none"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (title !== task.title) void saveFields();
              }}
            />
            {task.is_operator === 1 && (
              <span className="mt-1 inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-500 dark:text-violet-400">
                🤖 Lovdex助手
              </span>
            )}
            {task.source_schedule_id && (
              <button
                className="mt-1 ml-2 inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
                onClick={() => navigate('/tasks?view=scheduled')}
              >
                ⏰ 定时
              </button>
            )}
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {task.project_path} · {task.task_id.slice(0, 8)}
            </p>
          </div>

          {/* 操作区：手机端换行到标题下方整宽（保持原样）；web 与标题同行靠右，按钮略加宽 */}
          <div className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto">
            {task.session_id ? (
              <button
                className="w-full rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/20 sm:px-6"
                onClick={() => navigate(`/session/${task.session_id}`)}
              >
                打开会话
              </button>
            ) : (
              <button
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:px-6 shadow-[0_2px_0_#1c3fa8]"
                onClick={() => void startExecution()}
              >
                ▶ 开始执行
              </button>
            )}
            <div className="flex w-full gap-2 sm:gap-3">
              {task.status !== 'done' && (
                <button
                  className="flex-1 rounded-md bg-green-500/15 px-4 py-2 text-sm font-semibold text-green-500 hover:bg-green-500/25 dark:text-green-400 sm:w-auto sm:flex-none sm:px-6"
                  onClick={() => updateStatus('done')}
                >
                  ✓ 标记完成
                </button>
              )}
              <button
                className="flex-1 rounded-md bg-red-500/10 px-4 py-2 text-sm text-red-500 hover:bg-red-500/20 dark:text-red-400 sm:w-auto sm:flex-none sm:px-6"
                onClick={remove}
              >
                删除
              </button>
            </div>
          </div>
        </div>

        {/* 状态横幅：失败 / 等你…（有状态才出现） */}
        {task.sub_status === 'failed' && task.session_id && (
          <div className="mt-4 flex flex-col gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />
              <div>
                <div className="text-sm font-semibold text-red-500">执行失败</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  任务执行出错，可以重试或打开会话查看原因。
                </p>
              </div>
            </div>
            <button
              className="w-full shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:w-auto shadow-[0_2px_0_#1c3fa8]"
              onClick={() => retryTask()}
            >
              ↻ 重试
            </button>
          </div>
        )}
        {(task.sub_status === 'waiting_answer' ||
          task.sub_status === 'waiting_plan' ||
          task.sub_status === 'waiting_approval') &&
          task.session_id && (() => {
          let label = '等你批准';
          let desc = '关联会话有一个待审批的权限请求，需要你处理。';
          if (task.sub_status === 'waiting_answer') {
            label = '等你回答';
            desc = 'Lovdex助手在等你回答一个问题，去会话里回复它即可继续。';
          } else if (task.sub_status === 'waiting_plan') {
            label = '等你确认计划';
            desc = 'Lovdex助手已出 plan，等你确认后才会开始执行。';
          }
          return (
            <div className="mt-4 flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
                <div>
                  <div className="text-sm font-semibold text-amber-500">{label}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
                </div>
              </div>
              <button
                className="w-full shrink-0 rounded-md bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-600 transition-colors hover:bg-amber-500/25 dark:text-amber-400 sm:w-auto"
                onClick={() => navigate(`/session/${task.session_id}`)}
              >
                去处理
              </button>
            </div>
          );
        })()}

        <div className="mt-6 flex flex-col gap-6">
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)] p-4">
              <textarea
                className="min-h-[160px] w-full resize-y bg-transparent text-sm text-muted-foreground outline-none"
                value={description}
                placeholder="暂无描述"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (description !== (task.description ?? '')) void saveFields();
                }}
              />
            </div>
            {(task.ai_summary || task.verdict_reason || task.verdict_at) && (
              <div className="rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-xs uppercase tracking-wide text-muted-foreground">完成度</h4>
                  {task.sub_status && ['done', 'only_plan', 'needs_review', 'blocked'].includes(task.sub_status) && (
                    <SubStatusBadge subStatus={task.sub_status} />
                  )}
                </div>
                {task.ai_summary && (
                  <p className="text-sm text-foreground">{task.ai_summary}</p>
                )}
                {task.verdict_reason && (
                  <p className="mt-1 text-xs text-muted-foreground">理由：{task.verdict_reason}</p>
                )}
                {task.verdict_at && (
                  <p className="mt-2 text-xs text-muted-foreground/70">
                    {formatAbsoluteTime(task.verdict_at)}
                  </p>
                )}
              </div>
            )}
            <TaskResultPanel
              state={resultState}
              content={resultContent}
              onRefresh={() => {
                if (task?.session_id) void loadResult(task.session_id);
              }}
            />
          </div>
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)] p-4">
              <h4 className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">属性</h4>
              <div className="flex max-w-xl flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">状态</span>
                  <select
                    className="h-9 w-60 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={task.status}
                    onChange={(e) => updateStatus(e.target.value as TaskStatus)}
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_META[s].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">所属项目</span>
                  {task.status === 'todo' && task.is_operator !== 1 ? (
                    <select
                      className="h-9 w-72 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                      value={projectPath}
                      onChange={(e) => void changeProject(e.target.value)}
                    >
                      {!taskFormProjects(projects).some((p) => projectPathOf(p) === projectPath) && (
                        <option value={projectPath} disabled>{projectPath}</option>
                      )}
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
                  ) : (
                    <div className="text-sm text-foreground">{task.project_path}</div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">执行引擎</span>
                  <select
                    className="h-9 w-72 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={engine}
                    onChange={(e) => void saveEngine(e.target.value as TaskEngine)}
                  >
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="opencode">OpenCode</option>
                    <option value="qoder">Qoder</option>
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">模型</span>
                  <select
                    className="h-9 w-72 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={model}
                    onChange={(e) => void saveModel(e.target.value)}
                  >
                    <option value="">默认模型 (default)</option>
                    {model && !models.some((m) => m.value === model) && (
                      <option value={model} disabled>{model}（不在当前引擎列表）</option>
                    )}
                    {models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label || m.value}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">优先级</span>
                  <select
                    className="h-9 w-60 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={priority}
                    onChange={(e) => void savePriority(e.target.value as TaskPriority)}
                  >
                    {PRIORITY_ORDER.map((p) => (
                      <option key={p} value={p}>{PRIORITY_META[p].label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">截止日期</span>
                  <input
                    type="date"
                    className="h-9 w-60 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={deadline}
                    onChange={(e) => void saveDeadline(e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">Label</span>
                  <select
                    className="h-9 w-60 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={label}
                    onChange={(e) => void saveLabel(e.target.value as TaskLabel)}
                  >
                    {LABEL_ORDER.map((l) => (
                      <option key={l} value={l}>{LABEL_META[l].label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">备注</span>
                  <input
                    className="h-9 w-60 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={remark}
                    placeholder="需求来源等，可留空"
                    onChange={(e) => setRemark(e.target.value)}
                    onBlur={() => { if (remark.trim() !== (task?.remark ?? '')) void saveRemark(remark); }}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">创建时间</span>
                  <div className="text-sm text-foreground">{formatAbsoluteTime(task.created_at)}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">更新时间</span>
                  <div className="text-sm text-foreground">{formatAbsoluteTime(task.updated_at)}</div>
                </div>
                {task.started_at && (
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground">开始时间</span>
                    <div className="text-sm text-foreground">{formatAbsoluteTime(task.started_at)}</div>
                  </div>
                )}
                {task.completed_at && (
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground">完成时间</span>
                    <div className="text-sm text-foreground">{formatAbsoluteTime(task.completed_at)}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
