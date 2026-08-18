export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  isMainAgentWorkspace?: boolean;
  isOperatorWorkspace?: boolean;
  [key: string]: unknown;
}

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
export type SubStatus =
  | 'running'
  | 'failed'
  | 'waiting_answer'
  | 'waiting_plan'
  | 'waiting_approval'
  | 'pending_acceptance'
  | 'done'
  | 'only_plan'
  | 'needs_review'
  | 'blocked';
export type TaskEngine = 'claude' | 'codex' | 'opencode' | 'qoder';
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskLabel = 'bug' | 'feature' | 'optimization' | 'refactor' | 'docs' | 'other' | 'reminder';

export interface Task {
  task_id: string;
  project_path: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  executor_provider: TaskEngine;
  executor_model: string | null;
  position: number;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  ai_summary: string | null;
  /**
   * Fine-grained badge shown at the card's bottom-left, computed by the backend
   * (persisted AI verdict/failed OR realtime derived running / waiting_* / pending_acceptance).
   */
  sub_status: SubStatus | null;
  verdict_reason: string | null;
  verdict_at: string | null;
  priority: TaskPriority;
  deadline: string | null;
  is_operator: number; // 0 | 1 — 1 = Lovdex 助手任务
  label: TaskLabel;
  remark: string | null;
  /** 定时任务来源：关联 scheduled_tasks.schedule_id（由定时任务创建的任务才有值）。 */
  source_schedule_id: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Realtime-only flag (server-decorated, never persisted): true when the linked
   * session currently has a pending tool-approval. Drives the board/detail
   * "等你批准" overlay and is reconstructed on list load and WS reconnect, so a
   * marker that fired while this tab was closed still reappears.
   */
  approval_pending?: boolean;
  /**
   * Realtime-only (server-decorated, never persisted): the toolName the linked
   * session is currently waiting on when `approval_pending` is true. Lets the
   * board classify the wait reason: AskUserQuestion→"等你回答",
   * ExitPlanMode→"等你确认计划", other→"等你批准". Null when not pending.
   */
  pending_tool?: string | null;
  /**
   * Realtime-only (server-decorated, never persisted): true when the task's
   * session_id points at a sessions row that no longer exists (hard-deleted,
   * e.g. by the operator-workspace startup cleanup). The detail page renders a
   * disabled "会话被清理" button instead of "打开会话" so the user isn't sent
   * to a 404.
   */
  session_deleted?: boolean;
}

export type ScheduledTaskScheduleType = 'once' | 'interval' | 'cron';

export interface ScheduledTask {
  schedule_id: string;
  title: string;
  description: string | null;
  project_path: string | null;
  executor_provider: TaskEngine;
  executor_model: string | null;
  priority: TaskPriority;
  label: TaskLabel;
  is_operator: number; // 0 | 1
  auto_run: number;    // 0 | 1
  schedule_type: ScheduledTaskScheduleType;
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  last_task_id: string | null;
  enabled: number;     // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface TaskUpsertedEvent {
  kind: 'task_upserted';
  task: Task;
  actor: 'user' | 'engine';
  approval?: { pending: boolean };
  timestamp: string;
}

export interface TaskDeletedEvent {
  kind: 'task_deleted';
  taskId: string;
  actor: 'user' | 'engine';
  timestamp: string;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}
