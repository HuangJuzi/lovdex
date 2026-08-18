import { isAiVerdict, type AiVerdict, isTaskPriority, type TaskPriority } from '@/shared/task-status.js';
import type { TaskEngine } from '@/shared/types.js';

/**
 * Dependencies injected into the operator tool set so handlers are testable
 * without touching the real services/databases. T8 (SDK wiring) will inject
 * the real `tasksService`, `projectsDb`, `sessionsService`, and the
 * `createSession` SessionCreator used by the tasks router.
 *
 * `projects`, `sessions`, and `createSession` are optional so pure-logic
 * handlers (`create_task`, `write_task_summary`) can be unit-tested with only
 * a fake `tasks` service. Handlers that reference an optional dep use a
 * non-null assertion — they are wired in production by T8 and a missing dep
 * at call time is a wiring bug, not a recoverable runtime state.
 *
 * REAL method names (grepped from the codebase):
 *  - projectsDb.getProjectPaths()           → list active projects
 *  - projectsDb.getProjectPathById(id)      → resolve project dir from projectId
 *  - sessionsService.fetchHistory(id, opts) → returns { messages, total, hasMore, ... }
 *  - SessionCreator = (provider: TaskEngine, projectPath: string) => string
 *    (defined in server/modules/tasks/tasks.routes.ts, passed to
 *    tasksService.startExecution)
 */
export type OperatorToolDeps = {
  tasks: {
    createTask: (i: {
      projectPath: string;
      title: string;
      description?: string | null;
      status?: string;
      priority?: TaskPriority;
      isOperator?: boolean;
    }) => unknown;
    listTasks: (f: { projectPath?: string; status?: string }) => unknown[];
    getTask: (id: string) => unknown;
    writeSummary: (
      id: string,
      i: { summary: string; verdict: AiVerdict; reason?: string | null },
    ) => unknown;
    startExecution: (
      id: string,
      createSession: (provider: TaskEngine, projectPath: string) => string,
    ) => unknown;
    updateTask: (id: string, u: Record<string, unknown>) => Promise<unknown>;
    moveTask: (
      id: string,
      status: string,
      before: string | null,
      after: string | null,
    ) => unknown;
  };
  projects?: {
    /** List active (non-archived) projects. Real name: projectsDb.getProjectPaths */
    getProjectPaths: () => unknown[];
    /** Resolve project directory from a projectId. Real name: projectsDb.getProjectPathById */
    getProjectPathById: (projectId: string) => string | null;
  };
  sessions?: {
    /**
     * Fetch a session's persisted message history. Real name:
     * sessionsService.fetchHistory — returns { messages, total, hasMore, offset, limit }.
     * Supports pagination via limit/offset so the operator can read large
     * transcripts in chunks instead of blowing the token budget.
     */
    fetchHistory: (
      sessionId: string,
      options?: { limit?: number | null; offset?: number },
    ) => Promise<unknown>;
  };
  /**
   * Allocates a new app-facing session id for a provider+project. Real type:
   * SessionCreator from tasks.routes.ts. Injected here so start_task_execution
   * can dispatch a task without hardcoding the session-creation strategy.
   */
  createSession?: (provider: TaskEngine, projectPath: string) => string;
  /**
   * Kick off the agent run for a task's just-created session headlessly
   * (no browser socket). Injected from index.js so start_task_execution can
   * dispatch a task that actually runs — without it the tool only creates the
   * session and the task sits idle in todo. Optional so pure-logic unit tests
   * that only assert session-creation pass-through can omit it.
   */
  startTaskRun?: (taskId: string, sessionId: string) => boolean;
  contextProjectPath?: string | null;
  /**
   * True when `contextProjectPath` is the Lovdex助手 (operator) workspace —
   * the interactive assistant's context. Makes `create_task` fall back to the
   * workspace and mark the task `is_operator` so the task board's「🤖 Lovdex
   * 助手」filter (matches task.is_operator === 1) can surface it; without this,
   * an omitted projectPath falls through to '' and createTask rejects it with
   * PROJECT_NOT_FOUND.
   */
  contextIsOperatorWorkspace?: boolean;
  /**
   * Scheduled-task CRUD (optional, wired from index.js). The assistant manages
   * 定时任务 templates via list/get/create/update/delete. The shape matches the
   * scheduler.service's list/get/create/update/remove so the real service is
   * injected directly without an adapter.
   */
  scheduledTasks?: {
    list: (f: { projectPath?: string; enabled?: boolean }) => unknown[];
    get: (scheduleId: string) => unknown;
    create: (i: Record<string, unknown>) => unknown;
    update: (scheduleId: string, u: Record<string, unknown>) => Promise<unknown> | unknown;
    remove: (scheduleId: string) => void;
  };
};

/**
 * Newest assistant text message in a normalized message list, or null. The
 * verdict agent judges completion primarily from this "final output", so it is
 * surfaced separately (and untruncated) rather than buried in the transcript.
 */
export function lastAssistantText(messages: unknown[]): string | null {
  let last: string | null = null;
  for (const msg of messages) {
    const m = msg as { role?: string; kind?: string; content?: string };
    if ((m.role ?? m.kind ?? 'message') !== 'assistant') continue;
    const text = (m.content ?? '').trim();
    if (text) last = text;
  }
  return last;
}

export function buildOperatorTools(deps: OperatorToolDeps) {
  return {
    list_projects: {
      description: 'List all projects',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => deps.projects!.getProjectPaths(),
    },
    list_tasks: {
      description: 'List tasks, optional projectPath/status filter',
      inputSchema: {
        type: 'object',
        properties: { projectPath: { type: 'string' }, status: { type: 'string' } },
      },
      handler: async (i: { projectPath?: string; status?: string }) =>
        deps.tasks.listTasks({ projectPath: i.projectPath, status: i.status }),
    },
    get_task: {
      description: 'Get a single task by id',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (i: { taskId: string }) => deps.tasks.getTask(i.taskId),
    },
    get_session_transcript: {
      description:
        "Read a session transcript as compact text (user prompts, assistant text, tool_use names + truncated results) to judge task completion. Paginates — pass limit/offset for large sessions. Returns { total, offset, limit, hasMore, transcript, finalOutput } where transcript is plain text and finalOutput is the session's newest assistant text message — the decisive output to judge completion against.",
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number', description: 'max messages per page (default 40)' },
          offset: { type: 'number', description: 'message offset for pagination (default 0)' },
        },
        required: ['sessionId'],
      },
      handler: async (i: { sessionId: string; limit?: number; offset?: number }) => {
        const limit = typeof i.limit === 'number' && i.limit > 0 ? i.limit : 40;
        const offset = typeof i.offset === 'number' && i.offset >= 0 ? i.offset : 0;
        const result = (await deps.sessions!.fetchHistory(i.sessionId, { limit, offset })) as {
          messages?: unknown[];
          total?: number;
          hasMore?: boolean;
        };
        const messages = Array.isArray(result?.messages) ? result.messages : [];
        // finalOutput always reflects the session's NEWEST assistant text, even
        // when paginating older pages — so the verdict agent gets the decisive
        // final-output signal up front regardless of which page it requested.
        let finalOutput: string | null;
        if (offset === 0) {
          finalOutput = lastAssistantText(messages);
        } else {
          const tail = (await deps.sessions!.fetchHistory(i.sessionId, { limit: 10, offset: 0 })) as {
            messages?: unknown[];
          };
          finalOutput = lastAssistantText(Array.isArray(tail?.messages) ? tail.messages : []);
        }
        // Compact each message to plain text so we don't blow the token budget
        // with raw provider payloads. The operator only needs the gist of what
        // the agent did, not every byte.
        const lines: string[] = [];
        for (const msg of messages) {
          const m = msg as {
            role?: string;
            kind?: string;
            content?: string;
            commandName?: string;
            toolName?: string;
            toolResult?: string;
            isLocalCommand?: boolean;
          };
          const role = m.role ?? m.kind ?? 'message';
          if (m.isLocalCommand && m.commandName) {
            lines.push(`[${role}] /${m.commandName}`);
            continue;
          }
          if (role === 'tool' || m.kind === 'tool') {
            const res = typeof m.toolResult === 'string' ? m.toolResult : '';
            lines.push(`[tool ${m.toolName ?? ''}] ${res.slice(0, 300)}`);
            continue;
          }
          const text = (m.content ?? '').trim();
          if (text) {
            lines.push(`[${role}] ${text.slice(0, 1200)}`);
          }
        }
        return {
          total: result?.total ?? messages.length,
          offset,
          limit,
          hasMore: Boolean(result?.hasMore),
          transcript: lines.join('\n\n') || '(empty transcript)',
          finalOutput: finalOutput ? finalOutput.slice(0, 2000) : null,
        };
      },
    },
    create_task: {
      description:
        'Create a task (defaults to todo). Uses contextProjectPath if projectPath omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
          priority: {
            type: 'string',
            enum: ['P0', 'P1', 'P2', 'P3'],
            description: 'Task priority (P0 highest). Defaults to P2 when omitted.',
          },
        },
        required: ['title'],
      },
      handler: async (i: {
        projectPath?: string;
        title: string;
        description?: string;
        status?: string;
        priority?: TaskPriority;
      }) => {
        if (i.priority !== undefined && !isTaskPriority(i.priority)) {
          throw new Error(`invalid priority: ${String(i.priority)}`);
        }
        const projectPath = i.projectPath ?? deps.contextProjectPath ?? '';
        // No explicit target in the assistant context: default to the Lovdex助手
        // workspace and mark `is_operator` so the task lands in the「🤖 Lovdex
        // 助手」board filter (task.is_operator === 1) instead of erroring with
        // PROJECT_NOT_FOUND on the empty path.
        // Note: gate on the RAW input (`!i.projectPath`), not the merged
        // `projectPath` — the latter already contains `deps.contextProjectPath`
        // via `??`, so `!projectPath` would be false whenever the operator
        // workspace is set and the is_operator flag would never be emitted.
        const fallbackToAssistantWorkspace =
          !i.projectPath && Boolean(deps.contextProjectPath && deps.contextIsOperatorWorkspace);
        return deps.tasks.createTask({
          projectPath: fallbackToAssistantWorkspace
            ? (deps.contextProjectPath as string)
            : projectPath,
          title: i.title,
          description: i.description ?? null,
          status: i.status ?? 'todo',
          priority: i.priority,
          isOperator: fallbackToAssistantWorkspace ? true : undefined,
        });
      },
    },
    start_task_execution: {
      description: 'Dispatch a task: create its session and start the run',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (i: { taskId: string }) => {
        const result = deps.tasks.startExecution(i.taskId, deps.createSession!) as
          | { sessionId?: string }
          | null;
        // Now actually start the agent run headlessly. The interactive path
        // does this by sending a `chat.send` WebSocket frame from the browser;
        // the operator runs server-side with no socket, so it calls the
        // injected launcher instead. A launch failure is swallowed — the
        // session is already created and linked, so the operator can still
        // inspect it; crashing the tool would just hide the sessionId.
        if (result?.sessionId && deps.startTaskRun) {
          try {
            deps.startTaskRun(i.taskId, result.sessionId);
          } catch (e) {
            console.error('[start_task_execution] headless run failed', e);
          }
        }
        return result;
      },
    },
    update_task: {
      description:
        'Update task fields. Use move_task for status changes; update_task is for title/description/executor/priority.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          executorProvider: { type: 'string' },
          executorModel: { type: 'string' },
          priority: {
            type: 'string',
            enum: ['P0', 'P1', 'P2', 'P3'],
            description: 'Task priority (P0 highest).',
          },
        },
        required: ['taskId'],
      },
      handler: async (i: {
        taskId: string;
        title?: string;
        description?: string;
        executorProvider?: string;
        executorModel?: string;
        priority?: TaskPriority;
      }) => {
        if (i.priority !== undefined && !isTaskPriority(i.priority)) {
          throw new Error(`invalid priority: ${String(i.priority)}`);
        }
        const { taskId, ...rest } = i;
        return deps.tasks.updateTask(taskId, rest);
      },
    },
    move_task: {
      description: 'Move a task to a status',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' }, status: { type: 'string' } },
        required: ['taskId', 'status'],
      },
      handler: async (i: { taskId: string; status: string }) =>
        deps.tasks.moveTask(i.taskId, i.status, null, null),
    },
    write_task_summary: {
      description:
        'Write AI summary + verdict onto a task. verdict ∈ done | only_plan | needs_review | blocked',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          summary: { type: 'string' },
          verdict: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['taskId', 'summary', 'verdict'],
      },
      handler: async (i: {
        taskId: string;
        summary: string;
        verdict: string;
        reason?: string;
      }) => {
        if (!isAiVerdict(i.verdict)) throw new Error(`invalid verdict: ${i.verdict}`);
        return deps.tasks.writeSummary(i.taskId, {
          summary: i.summary,
          verdict: i.verdict as AiVerdict,
          reason: i.reason,
        });
      },
    },
    create_scheduled_task: {
      description:
        'Create a scheduled-task template. On each trigger it creates a real task (seen in list_tasks). autoRun=1 dispatches the agent run immediately; autoRun=0 creates a todo/reminder only. scheduleType: once (runAt) | interval (intervalSeconds) | cron (cronExpr). projectPath empty = Lovdex 助手 workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title created on each trigger' },
          description: { type: 'string' },
          projectPath: { type: 'string', description: 'Project path; empty = Lovdex 助手 workspace' },
          scheduleType: { type: 'string', enum: ['once', 'interval', 'cron'] },
          cronExpr: { type: 'string', description: 'cron expression when scheduleType=cron, e.g. "0 9 * * 1-5"' },
          intervalSeconds: { type: 'number', description: 'seconds between runs when scheduleType=interval' },
          runAt: { type: 'string', description: 'ISO datetime when scheduleType=once' },
          autoRun: { type: 'number', description: '1 = auto-execute, 0 = reminder only' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          label: { type: 'string' },
          executorModel: { type: 'string' },
        },
        required: ['title', 'scheduleType'],
      },
      handler: async (i: Record<string, unknown>) => deps.scheduledTasks!.create(i),
    },
    list_scheduled_tasks: {
      description:
        'List scheduled-task templates (optional projectPath/enabled filter). Returns next_run_at and schedule_type for each.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string' },
          enabled: { type: 'number', description: '1 = enabled only, 0 = disabled only' },
        },
      },
      handler: async (i: { projectPath?: string; enabled?: number }) =>
        deps.scheduledTasks!.list({
          projectPath: i.projectPath,
          // Omitted → no enabled filter (mirrors GET /api/scheduled-tasks). A bare
          // `i.enabled === 1` would wrongly map `undefined` to `false` and return
          // only disabled templates.
          enabled: i.enabled === undefined ? undefined : i.enabled === 1,
        }),
    },
    get_scheduled_task: {
      description: 'Get a single scheduled-task template by scheduleId.',
      inputSchema: {
        type: 'object',
        properties: { scheduleId: { type: 'string' } },
        required: ['scheduleId'],
      },
      handler: async (i: { scheduleId: string }) => deps.scheduledTasks!.get(i.scheduleId),
    },
    update_scheduled_task: {
      description:
        'Update a scheduled-task template (schedule field changes recompute next_run_at).',
      inputSchema: {
        type: 'object',
        properties: {
          scheduleId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          cronExpr: { type: 'string' },
          intervalSeconds: { type: 'number' },
          runAt: { type: 'string' },
          autoRun: { type: 'number' },
          priority: { type: 'string' },
          label: { type: 'string' },
          enabled: { type: 'number', description: '0 = disable' },
        },
        required: ['scheduleId'],
      },
      handler: async (i: Record<string, unknown>) => {
        const { scheduleId, ...rest } = i;
        return deps.scheduledTasks!.update(String(scheduleId), rest);
      },
    },
    delete_scheduled_task: {
      description: 'Delete a scheduled-task template (already-created tasks are kept).',
      inputSchema: {
        type: 'object',
        properties: { scheduleId: { type: 'string' } },
        required: ['scheduleId'],
      },
      handler: async (i: { scheduleId: string }) => {
        deps.scheduledTasks!.remove(i.scheduleId);
        return { success: true };
      },
    },
  };
}
