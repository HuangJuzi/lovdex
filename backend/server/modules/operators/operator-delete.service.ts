import { AppError } from '@/shared/utils.js';

/**
 * Physical session deletion ("删除会话") for the operator tool set.
 *
 * The tasks/board can move a task between statuses and relocate a session
 * between projects, but nothing could hard-delete a session row + its
 * transcript file on disk. This service is the general primitive: validate the
 * target, refuse dangerous deletes, then hard-delete through the injected
 * `deleteSessionHard` (sessionsService.deleteOrArchiveSessionById with
 * force=true + deletedFromDisk=true).
 *
 * Deliberately conservative — every destructive guard defaults to "refuse":
 * - Operator assistant sessions (is_operator=1) are never deletable.
 * - Running / in_progress sessions are rejected: removing a transcript a live
 *   agent is still appending to would corrupt history.
 * - A session still linked to a task is rejected unless the caller passes an
 *   explicit `cascade` confirmation — the task's session_id then becomes a
 *   dangling foreign key and its get_session_transcript reads 404.
 */

/** Minimal session-row shape the delete service reads. */
type SessionLike = {
  session_id: string;
  project_path: string | null;
  is_operator: number;
};

/** Minimal task-row shape the delete service reads. */
type TaskLike = {
  task_id: string;
  title: string;
  status: string;
};

export type DeleteSessionInput = {
  sessionId: string;
  /** Explicitly allow deleting a session still linked to a task. */
  cascade?: boolean;
};

export type DeleteSessionResult = {
  sessionId: string;
  action: 'deleted';
  deletedFromDisk: boolean;
  linkedTaskId: string | null;
};

export type OperatorDeleteDeps = {
  sessionsDb: {
    getSessionById: (sessionId: string) => SessionLike | null;
  };
  tasksDb: {
    getTaskBySessionId: (sessionId: string) => TaskLike | null;
  };
  /** Hard-deletes a session row + transcript file. */
  deleteSessionHard: (
    sessionId: string,
  ) => Promise<{ sessionId: string; action: string; deletedFromDisk: boolean }>;
  /** Returns true when the session's agent run is still live. */
  isSessionRunning?: (sessionId: string) => boolean;
};

export function createOperatorDeleteService(deps: OperatorDeleteDeps) {
  /**
   * Hard-deletes one session (DB row + transcript file), after the safety gates.
   * Idempotent on "not found": throws SESSION_NOT_FOUND (404). Every dangerous
   * case throws a readable AppError with a distinct code so the caller (HTTP
   * route or operator tool) can surface it verbatim.
   */
  async function deleteSession(input: DeleteSessionInput): Promise<DeleteSessionResult> {
    const session = deps.sessionsDb.getSessionById(input.sessionId);
    if (!session) {
      throw new AppError(`session not found: ${input.sessionId}`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Operator assistant sessions are the Lovdex助手's own conversation history —
    // deleting one would break the assistant panel invariant (its workspace
    // payload must contain all is_operator sessions).
    if (session.is_operator === 1) {
      throw new AppError(
        `session ${input.sessionId} is an operator assistant session — not deletable`,
        { code: 'OPERATOR_SESSION_PROTECTED', statusCode: 409 },
      );
    }

    const linkedTask = deps.tasksDb.getTaskBySessionId(input.sessionId);
    const sessionRunning = deps.isSessionRunning ? deps.isSessionRunning(input.sessionId) : false;
    const taskInProgress = linkedTask !== null && linkedTask.status === 'in_progress';
    if (sessionRunning || taskInProgress) {
      throw new AppError(
        `session ${input.sessionId} is running/in_progress — stop or settle the run before deleting`,
        { code: 'SESSION_RUNNING', statusCode: 409 },
      );
    }

    if (linkedTask && !input.cascade) {
      throw new AppError(
        `session ${input.sessionId} is still linked to task ${linkedTask.task_id} (${linkedTask.title}) — pass cascade=true to delete anyway; the task will then no longer be able to read its transcript`,
        { code: 'SESSION_LINKED_TO_TASK', statusCode: 409 },
      );
    }

    if (linkedTask) {
      console.warn(
        '[operator-delete] WARNING: force-deleting a session still linked to a task — the task will no longer be able to read its transcript',
        {
          sessionId: input.sessionId,
          taskId: linkedTask.task_id,
          taskTitle: linkedTask.title,
          taskStatus: linkedTask.status,
        },
      );
    }

    console.warn('[operator-delete] WARNING: deleting session', {
      sessionId: input.sessionId,
      projectPath: session.project_path,
    });

    const result = await deps.deleteSessionHard(input.sessionId);
    return {
      sessionId: input.sessionId,
      action: 'deleted',
      deletedFromDisk: result.deletedFromDisk,
      linkedTaskId: linkedTask?.task_id ?? null,
    };
  }

  return { deleteSession };
}

export type OperatorDeleteService = ReturnType<typeof createOperatorDeleteService>;
