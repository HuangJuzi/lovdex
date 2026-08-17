import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isTaskEngine, isTaskStatus, TASK_STATUSES, tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import {
  isTaskDeadline,
  isTaskLabel,
  isTaskPriority,
  type AiVerdict,
  type PersistedSubStatus,
  type SubStatus,
  type TaskLabel,
  type TaskPriority,
} from '@/shared/task-status.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';
import type { TaskEngine, TaskRow, TaskStatus } from '@/shared/types.js';

export const STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export type TaskEvent =
  | {
      kind: 'task_upserted';
      task: TaskRow;
      actor: 'user' | 'engine';
      approval?: { pending: boolean };
      timestamp: string;
    }
  | { kind: 'task_deleted'; taskId: string; actor: 'user' | 'engine'; timestamp: string };

export type TaskBroadcast = (event: TaskEvent) => void;

export type TaskDbLike = Pick<
  typeof tasksDb,
  | 'createTask'
  | 'getTask'
  | 'getTaskBySessionId'
  | 'listTasks'
  | 'updateTask'
  | 'updateTaskStatus'
  | 'updateTaskSubStatus'
  | 'clearVerdictFields'
  | 'linkSession'
  | 'deleteTask'
  | 'moveTask'
  | 'writeSummary'
>;

type CreateTaskInput = {
  projectPath: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  executorProvider?: TaskEngine;
  executorModel?: string | null;
  sessionId?: string | null;
  priority?: TaskPriority;
  deadline?: string | null;
  isOperator?: boolean;
  label?: TaskLabel;
  remark?: string | null;
  sourceScheduleId?: string | null;
};

/**
 * Broadcast payload before the server-generated `timestamp` is attached.
 * Kept as an explicit union so `emit` can stay type-safe across both kinds.
 */
type TaskEventInput =
  | {
      kind: 'task_upserted';
      task: TaskRow;
      actor: 'user' | 'engine';
      approval?: { pending: boolean };
    }
  | { kind: 'task_deleted'; taskId: string; actor: 'user' | 'engine' };

export function createTasksService(
  db: TaskDbLike,
  opts: {
    broadcast: TaskBroadcast;
    deps?: {
      projectsDb?: typeof projectsDb;
      sessionsDb?: typeof sessionsDb;
      deleteSessionHard?: (sessionId: string) => Promise<void>;
    };
    /**
     * Returns the app session ids that currently have a pending tool-approval
     * request, mapped to the toolName each is waiting on. Used to decorate task
     * rows with `approval_pending` + `pending_tool` so the board can reconstruct
     * its "等你回答/等你确认计划/等你批准" overlay on load/reconnect AND classify the
     * wait reason by tool, instead of relying solely on one-shot `task_upserted`
     * events that fire while the tab may be closed. Defaults to an empty map so
     * unit tests that don't care about approvals are unaffected.
     */
    getPendingApprovalSessions?: () => Map<string, string>;
    /**
     * Fired after a linked session transitions to `completed` (after the
     * in_progress → in_review move). The auto-verdict trigger (T9) hooks here
     * to schedule a headless operator run that judges the session and writes a
     * summary + verdict. Optional so unit tests and installs without the
     * trigger are unaffected. `sessionId` may be null when the row has no
     * linked session, in which case the caller typically no-ops.
     */
    onTaskCompleted?: (taskId: string, title: string, sessionId: string | null) => void;
  },
) {
  const resolveDb = db;
  const resolveProject = opts.deps?.projectsDb ?? projectsDb;
  const resolveSession =
    opts.deps?.sessionsDb?.getSessionById
    ?? ((_sessionId: string) => null);

  /**
   * Hard-deletes a session row plus its transcript file. Production default is a
   * lazy import of sessionsService so unit tests (which inject a stub) never pull
   * in the websocket/chat-run-registry dependency chain.
   */
  const deleteSessionHard: (sessionId: string) => Promise<void> =
    opts.deps?.deleteSessionHard
    ?? (async (sessionId) => {
        const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
        await sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true });
      });
  const pendingApprovalSessions = opts.getPendingApprovalSessions ?? (() => new Map<string, string>());

  /**
   * Stamps the realtime approval flags onto a task row and derives the effective
   * layer-2 `sub_status` for the column the task sits in. `sub_status` on the raw
   * row is the persisted tag (failed / done / only_plan / needs_review / blocked)
   * or null; here it is refined per column so the board renders the right badge
   * whether it loaded fresh, reconnected after a WS drop, or received a live
   * upsert:
   * - `approval_pending` / `pending_tool`: the linked session has a pending
   *   tool-approval, classified by tool (AskUserQuestion / ExitPlanMode / other).
   * - `sub_status`: in_progress -> waiting_x/failed/running; in_review ->
   *   pending_acceptance/done. todo/done keep the persisted tag as-is.
   */
  function decorate(row: TaskRow): TaskRow {
    const pendingTool = row.session_id ? pendingApprovalSessions().get(row.session_id as string) ?? null : null;
    const approvalPending = Boolean(row.session_id) && pendingTool !== null;
    let subStatus: SubStatus | null = row.sub_status;
    if (row.status === 'in_progress') {
      if (approvalPending) {
        subStatus = pendingTool === 'AskUserQuestion' ? 'waiting_answer'
          : (pendingTool === 'ExitPlanMode' || pendingTool === 'exit_plan_mode') ? 'waiting_plan'
          : 'waiting_approval';
      } else if (row.sub_status && row.sub_status !== 'done') {
        // failed/only_plan/needs_review/blocked are valid in_progress tags; a
        // stale 'done' (user dragged an AI-done task back) reads as running.
        subStatus = row.sub_status;
      } else {
        subStatus = 'running';
      }
    } else if (row.status === 'in_review') {
      subStatus = row.sub_status === 'done' ? 'done' : 'pending_acceptance';
    } else {
      // todo / done columns carry no tag — a stale persisted sub_status (e.g. a
      // task manually completed while tagged) must not surface on the board.
      subStatus = null;
    }
    return { ...row, approval_pending: approvalPending, pending_tool: pendingTool, sub_status: subStatus };
  }

  function emit(event: TaskEventInput): void {
    if (event.kind === 'task_upserted') {
      opts.broadcast({ ...event, task: decorate(event.task), timestamp: new Date().toISOString() });
    } else {
      opts.broadcast({ ...event, timestamp: new Date().toISOString() });
    }
  }

  function applyStatusChange(taskId: string, status: TaskStatus, actor: 'user' | 'engine'): TaskRow | null {
    if (!isTaskStatus(status)) {
      throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
    }
    const row = resolveDb.getTask(taskId);
    if (!row) return null;
    const changed = row.status !== status;
    resolveDb.updateTaskStatus(taskId, status);
    // A manual status change re-positions the task, so a sub_status tag from the
    // previous state no longer applies — e.g. 标记完成 clears a stale AI tag.
    // Engine transitions manage sub_status explicitly (failed sets it,
    // running/completed/aborted clear it; writeSummary writes the verdict tag).
    if (changed && actor === 'user') {
      resolveDb.updateTaskSubStatus(taskId, null);
    }
    const updated = resolveDb.getTask(taskId) ?? row;
    emit({ kind: 'task_upserted', task: updated, actor });
    return decorate(updated);
  }

  return {
    STATUS_ORDER,

    createTask(input: CreateTaskInput): TaskRow {
      const status = input.status ?? 'todo';
      const provider = input.executorProvider ?? 'claude';
      if (!isTaskStatus(status)) {
        throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (!isTaskEngine(provider)) {
        throw new AppError(`invalid executor_provider: ${String(provider)}`, { code: 'INVALID_EXECUTOR', statusCode: 400 });
      }
      if (input.priority !== undefined && !isTaskPriority(input.priority)) {
        throw new AppError(`invalid priority: ${String(input.priority)}`, { code: 'INVALID_PRIORITY', statusCode: 400 });
      }
      if (input.deadline !== undefined && input.deadline !== null && !isTaskDeadline(input.deadline)) {
        throw new AppError(`invalid deadline: ${String(input.deadline)}`, { code: 'INVALID_DEADLINE', statusCode: 400 });
      }
      if (input.label !== undefined && !isTaskLabel(input.label)) {
        throw new AppError(`invalid label: ${String(input.label)}`, { code: 'INVALID_LABEL', statusCode: 400 });
      }
      const isOperator = input.isOperator === true;
      let projectPath = input.projectPath;
      if (isOperator) {
        if (provider !== 'claude') {
          throw new AppError('operator tasks must use the claude executor', { code: 'INVALID_EXECUTOR', statusCode: 400 });
        }
        const workspace = expandHome(getOperatorConfig().workspace);
        resolveProject.createProjectPath(workspace);
        if (!resolveProject.getProjectPath(workspace)) {
          throw new AppError(`operator workspace not found: ${workspace}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
        projectPath = workspace;
      } else {
        const project = resolveProject.getProjectPath(input.projectPath);
        if (!project) {
          throw new AppError(`project not found: ${input.projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
      }
      if (input.sessionId != null) {
        const session = resolveSession(input.sessionId);
        if (!session) {
          throw new AppError(`session not found: ${input.sessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        if (normalizeProjectPath(session.project_path ?? '') !== normalizeProjectPath(input.projectPath)) {
          throw new AppError('session does not belong to this project', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
        }
        if (resolveDb.getTaskBySessionId(input.sessionId)) {
          throw new AppError('session is already linked to a task', { code: 'SESSION_ALREADY_LINKED', statusCode: 409 });
        }
      }
      const row = resolveDb.createTask({
        projectPath,
        title: input.title,
        description: input.description ?? null,
        status,
        executorProvider: provider,
        executorModel: input.executorModel ?? null,
        sessionId: input.sessionId ?? null,
        priority: input.priority ?? 'P2',
        deadline: input.deadline ?? null,
        isOperator,
        label: input.label ?? 'other',
        remark: input.remark ?? null,
        sourceScheduleId: input.sourceScheduleId ?? null,
      });
      emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return decorate(row);
    },

    getTask(taskId: string): TaskRow | null {
      const row = resolveDb.getTask(taskId);
      return row ? decorate(row) : null;
    },

    getTaskBySessionId(sessionId: string): TaskRow | null {
      const row = resolveDb.getTaskBySessionId(sessionId);
      return row ? decorate(row) : null;
    },

    listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
      if (filter.status !== undefined && !isTaskStatus(filter.status)) {
        throw new AppError(`invalid status: ${String(filter.status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      return resolveDb.listTasks(filter).map(decorate);
    },

    applyStatusChange,

    async updateTask(taskId: string, updates: Parameters<TaskDbLike['updateTask']>[1]): Promise<TaskRow | null> {
      if (updates.executorProvider !== undefined && !isTaskEngine(updates.executorProvider)) {
        throw new AppError(`invalid executor_provider: ${String(updates.executorProvider)}`, {
          code: 'INVALID_EXECUTOR',
          statusCode: 400,
        });
      }
      if (updates.priority !== undefined && !isTaskPriority(updates.priority)) {
        throw new AppError(`invalid priority: ${String(updates.priority)}`, { code: 'INVALID_PRIORITY', statusCode: 400 });
      }
      if (updates.deadline !== undefined && updates.deadline !== null && !isTaskDeadline(updates.deadline)) {
        throw new AppError(`invalid deadline: ${String(updates.deadline)}`, { code: 'INVALID_DEADLINE', statusCode: 400 });
      }
      if (updates.label !== undefined && !isTaskLabel(updates.label)) {
        throw new AppError(`invalid label: ${String(updates.label)}`, { code: 'INVALID_LABEL', statusCode: 400 });
      }
      const current = resolveDb.getTask(taskId);
      if (!current) return null;

      const { projectPath, ...rest } = updates;
      const wantsProjectChange = projectPath !== undefined && projectPath !== current.project_path;

      // Picking the task's current project (with no other changes) is a no-op:
      // no write, no event, no session deletion.
      if (projectPath !== undefined && !wantsProjectChange && Object.keys(rest).length === 0) {
        return decorate(current);
      }

      let effective: Parameters<TaskDbLike['updateTask']>[1] = rest;
      if (wantsProjectChange) {
        if (current.is_operator) {
          throw new AppError('cannot change project for an operator task', { code: 'PROJECT_CHANGE_NOT_ALLOWED', statusCode: 400 });
        }
        if (current.status !== 'todo') {
          throw new AppError('cannot change project for a task that is not todo', {
            code: 'PROJECT_CHANGE_NOT_ALLOWED',
            statusCode: 400,
          });
        }
        if (!resolveProject.getProjectPath(projectPath)) {
          throw new AppError(`project not found: ${projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
        if (current.session_id) {
          try {
            await deleteSessionHard(current.session_id);
          } catch (err) {
            // A session row that is already gone shouldn't block the project
            // change — the outcome (unlink from a dead session) is the same.
            if ((err as AppError)?.code !== 'SESSION_NOT_FOUND') throw err;
          }
        }
        effective = { ...rest, projectPath, sessionId: null };
      }

      const row = resolveDb.updateTask(taskId, effective);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row ? decorate(row) : null;
    },

    deleteTask(taskId: string): void {
      resolveDb.deleteTask(taskId);
      emit({ kind: 'task_deleted', taskId, actor: 'user' });
    },

    moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): TaskRow | null {
      if (!isTaskStatus(status)) {
        throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      const current = resolveDb.getTask(taskId);
      if (!current) return null;
      resolveDb.moveTask(taskId, status, beforeId, afterId);
      if (current.status !== status) {
        // Dragging to a different column re-positions the task: clear its tag.
        resolveDb.updateTaskSubStatus(taskId, null);
      }
      const row = resolveDb.getTask(taskId);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row ? decorate(row) : null;
    },

    startExecution(
      taskId: string,
      createSession: (provider: TaskEngine, projectPath: string, isOperator?: boolean) => string,
    ): { sessionId: string } | null {
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      const sessionId = createSession(row.executor_provider, row.project_path, Boolean(row.is_operator));
      // 用任务标题给新执行会话命名，侧边栏一眼看出这个会话属于哪个任务。
      // 新 app 会话 custom_name 为 NULL；claude/codex 同步器会保留非占位符的 custom_name。
      if (row.title?.trim()) {
        opts.deps?.sessionsDb?.updateSessionCustomName(sessionId, row.title);
      }
      resolveDb.linkSession(taskId, sessionId);
      const updated = resolveDb.getTask(taskId) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor: 'user' });
      return { sessionId };
    },

    onSessionStatus(sessionId: string, state: 'running' | 'completed' | 'failed' | 'aborted'): void {
      const row = resolveDb.getTaskBySessionId(sessionId);
      if (!row) return;
      switch (state) {
        case 'running':
          // A live run means the agent is actively working, so the task must
          // read as in_progress — not just for the initial todo→in_progress
          // start, but whenever work resumes on a task that had settled into
          // in_review (or a done task the user reopened to ask for more). The
          // board should never show "评审中/已完成" while the agent is typing.
          // Clear any persisted `failed` tag: a fresh run supersedes the old
          // failure, so the badge drops back to the running spinner.
          resolveDb.updateTaskSubStatus(row.task_id, null);
          // Drop a stale premature verdict's audit (ai_summary / verdict_reason
          // / verdict_at) so it neither surfaces as a residual tag nor taints the
          // next verdict judge as prior context. A resumed task is being worked
          // on again — any earlier verdict is obsolete.
          resolveDb.clearVerdictFields(row.task_id);
          if (row.status !== 'in_progress') {
            applyStatusChange(row.task_id, 'in_progress', 'engine');
          } else {
            emit({ kind: 'task_upserted', task: resolveDb.getTask(row.task_id) ?? row, actor: 'engine' });
          }
          break;
        case 'completed': {
          // Verdict trigger must align with the task lifecycle. A run that ends
          // while the session is paused on an interactive tool (AskUserQuestion
          // / ExitPlanMode) is a PAUSE waiting for a human decision, NOT a
          // completion. The pending-approval map still holds the tool at this
          // instant (the registry clears it only after this call returns), so
          // we can read it here. Treating such a pause as "completed" would move
          // the task to in_review and fire the auto-verdict on the intermediate
          // "plan ready, how to proceed?" finalOutput — mislabeling in-progress
          // work as failed/only_plan. Skip the in_review move and the verdict
          // hook; the task stays in_progress (the board shows its waiting
          // overlay via decorate). The agent's turn resumes when the human
          // answers, which drives a fresh `running` event.
          const pendingTool = row.session_id
            ? pendingApprovalSessions().get(row.session_id as string) ?? null
            : null;
          const pausedOnInteraction =
            pendingTool === 'AskUserQuestion'
            || pendingTool === 'ExitPlanMode'
            || pendingTool === 'exit_plan_mode';
          if (pausedOnInteraction) {
            // The run ended at a user-decision gate: persist "waiting for human"
            // (waiting_answer / waiting_plan) so the board reads "等你回答 /
            // 等你确认计划" instead of "进行中" — a stopped session must not look
            // like the agent is autonomously working. This is a durable state: it
            // survives the run ending and a backend restart (the in-memory
            // pending-approval overlay is cleared once this call returns, so the
            // persisted tag is what the board reconstructs on reload). Cleared
            // when the user answers and a fresh `running` event fires.
            const waitTag: PersistedSubStatus =
              pendingTool === 'ExitPlanMode' || pendingTool === 'exit_plan_mode' ? 'waiting_plan' : 'waiting_answer';
            resolveDb.updateTaskSubStatus(row.task_id, waitTag);
            emit({ kind: 'task_upserted', task: resolveDb.getTask(row.task_id) ?? row, actor: 'engine' });
            break;
          }
          if (row.status === 'in_progress') applyStatusChange(row.task_id, 'in_review', 'engine');
          // Reset sub_status once work settles: the task now awaits the AI
          // verdict (writeSummary), which will fold done/only_plan/… back in.
          resolveDb.updateTaskSubStatus(row.task_id, null);
          // Fire the auto-verdict hook AFTER the in_review transition. The T9
          // trigger attaches here to schedule a headless operator run. Optional
          // so installs without the trigger (and existing unit tests) are
          // unaffected.
          opts.onTaskCompleted?.(row.task_id, row.title, row.session_id);
          break;
        }
        case 'failed':
          // A failed run does NOT move the task: it keeps its in_progress slot
          // and we persist sub_status='failed' so the board renders the "失败"
          // badge on load/reconnect (not just via a one-shot live event).
          if (row.status === 'in_progress') {
            resolveDb.updateTaskSubStatus(row.task_id, 'failed');
            emit({ kind: 'task_upserted', task: resolveDb.getTask(row.task_id) ?? row, actor: 'engine' });
          }
          break;
        case 'aborted':
          // The human stopped the run: roll back to todo so the board stops
          // reading as "进行中". The linked session is preserved, so the user
          // can still resume it (打开会话) or start a fresh run. Clear any
          // persisted failed tag as part of the rollback.
          resolveDb.updateTaskSubStatus(row.task_id, null);
          if (row.status === 'in_progress') applyStatusChange(row.task_id, 'todo', 'engine');
          break;
        default:
          break;
      }
    },

    /**
     * Surface a pending session permission request as a live "等你批准" overlay on
     * the linked task. Unlike `onSessionStatus`, this deliberately does NOT touch
     * the task's status — the marker is a realtime-only flag that the frontend
     * renders on top of the in_progress column and clears once the human decides.
     */
    onSessionApproval(sessionId: string, pending: boolean): void {
      const row = resolveDb.getTaskBySessionId(sessionId);
      if (!row) return;
      emit({ kind: 'task_upserted', task: row, actor: 'engine', approval: { pending } });
    },

    /**
     * Persist the operator agent's post-run verdict (AI summary + verdict folded
     * into sub_status + optional reason) on a task. Broadcasts a task_upserted so
     * live boards swap the in_review card for the verdict badge the moment the
     * run settles. A non-`done` verdict on an in_review task moves it back to
     * in_progress (there is still work to do); a `done` verdict stays in
     * in_review as a human-acceptance gate. A task the user already dragged out
     * of in_review is left where it is — only its sub_status tag updates.
     */
    writeSummary(
      taskId: string,
      input: { summary: string; verdict: AiVerdict; reason?: string | null },
    ): TaskRow | null {
      // The user's explicit done wins over a late AI verdict: a verdict that
      // lands after the task was marked done (e.g. an in-flight headless run)
      // must not downgrade a finished task's badge or move it off done.
      if (resolveDb.getTask(taskId)?.status === 'done') {
        return resolveDb.getTask(taskId);
      }
      // A verdict that lands while the task is still in_progress is stale: the
      // task resumed (the user answered an AskUserQuestion and a fresh run
      // started) or never settled to in_review. Writing a failed/only_plan tag
      // here is exactly the "执行中 + 执行失败" contradiction — a running task
      // must not be labeled by a verdict about an earlier turn. Leave the row
      // untouched. (The normal flow reaches writeSummary with status=in_review.)
      if (resolveDb.getTask(taskId)?.status === 'in_progress') {
        const current = resolveDb.getTask(taskId);
        return current ? decorate(current) : null;
      }
      const row = resolveDb.writeSummary(taskId, input);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'engine' });
      if (row) {
        const current = resolveDb.getTask(taskId);
        if (current && current.status === 'in_review' && input.verdict !== 'done') {
          // 非 done 判定移回进行中列；done 判定留评审列（人 gate）。
          applyStatusChange(taskId, 'in_progress', 'engine');
        }
        return decorate(resolveDb.getTask(taskId) ?? row);
      }
      return row ? decorate(row) : null;
    },

    /**
     * Mark tasks whose linked session is no longer running as failed. Called on
     * backend startup (and any time the run registry is authoritative) to catch
     * runs that died without delivering a terminal `session_status` — backend
     * restart, crash, SIGKILL. Each orphaned in_progress task gets a persisted
     * sub_status='failed' and a re-emit so live boards surface the badge.
     * Returns the number of tasks changed.
     */
    reconcileFailedTasks(getRunningSessionIds: () => Set<string>): number {
      const running = getRunningSessionIds();
      let changed = 0;
      for (const row of resolveDb.listTasks({})) {
        if (row.status === 'in_progress' && row.session_id && !running.has(row.session_id)) {
          // A task paused at an AskUserQuestion / ExitPlanMode gate ended its
          // run cleanly (a terminal `complete` was delivered) and is legitimately
          // waiting for a human decision — it is NOT an orphaned/crashed run.
          // Reconcile must not overwrite that with 'failed'.
          if (row.sub_status === 'waiting_answer' || row.sub_status === 'waiting_plan') {
            continue;
          }
          resolveDb.updateTaskSubStatus(row.task_id, 'failed');
          // Re-read after the write so the broadcast carries the persisted
          // sub_status (decorate would otherwise render the stale pre-update row
          // as "running" on a board connected during startup reconcile).
          const updated = resolveDb.getTask(row.task_id) ?? row;
          emit({ kind: 'task_upserted', task: updated, actor: 'engine' });
          changed += 1;
        }
      }
      return changed;
    },

    /**
     * 回填：把带会话且会话名空白/占位符的任务，会话 custom_name 设为任务标题。
     * 幂等——只填空白/占位符名，不覆盖用户手动重命名或 AI 已有标题。启动时调用。
     * 返回回填的会话数。
     */
    backfillSessionNames(): number {
      let changed = 0;
      for (const row of resolveDb.listTasks({})) {
        const title = row.title?.trim();
        if (!title || !row.session_id) continue;
        const session = resolveSession(row.session_id);
        if (!session) continue;
        const name = session.custom_name?.trim();
        if (name && name !== 'Untitled Claude Session' && name !== 'Untitled Codex Session') continue;
        try {
          opts.deps?.sessionsDb?.updateSessionCustomName(row.session_id, row.title);
          changed += 1;
        } catch (err) {
          // 单行回填失败不中断整轮：跳过该会话，其余继续。幂等，下轮启动可再补。
          console.error(`[tasks] backfill session name failed for session ${row.session_id}`, err);
        }
      }
      return changed;
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;
