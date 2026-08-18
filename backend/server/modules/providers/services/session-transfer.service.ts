import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalizeProjectPath } from '@/shared/utils.js';
import { encodeClaudeProjectDirName } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Session transfer ("把任务/会话从 A 项目移到 B 项目") for the operator tool set.
 *
 * Previously re-parenting a task+session was only possible by hand-editing the
 * DB (tasks.project_path + sessions.project_path), because tasksService.updateTask
 * treats a project change as "drop the linked session". This service is the
 * general primitive: validate the target, relocate the provider transcript file
 * (so history keeps resolving and a later full watcher rescan doesn't revert the
 * move), then re-parent both rows.
 *
 * Deliberately conservative:
 * - The target project must already be registered and active — never auto-create.
 * - Operator (is_operator) sessions/tasks are rejected: moving them out of the
 *   Lovdex助手 workspace breaks the "operator workspace payload must contain all
 *   is_operator sessions" invariant.
 * - in_progress / running sessions are rejected: relocating a transcript that a
 *   live agent is still appending to would corrupt history. The operator is told
 *   to stop/settle the run first.
 */

/** Minimal session-row shape the transfer service reads. */
type SessionLike = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  is_operator: number;
};

/** Minimal task-row shape the transfer service reads. */
type TaskLike = {
  task_id: string;
  project_path: string;
  session_id: string | null;
  status: string;
  is_operator: number;
};

type ProjectLike = {
  project_id: string;
  project_path: string;
  isArchived: number;
};

export type MoveSessionToProjectInput = {
  taskId?: string | null;
  sessionId?: string | null;
  targetProjectPath?: string | null;
  targetProjectId?: string | null;
};

export type MoveSessionToProjectResult = {
  alreadyInTarget: boolean;
  taskId: string | null;
  sessionId: string;
  fromProjectPath: string;
  toProjectId: string;
  toProjectPath: string;
  taskUpdated: boolean;
  transcript: {
    moved: boolean;
    fromJsonlPath: string | null;
    toJsonlPath: string | null;
    warnings: string[];
  };
};

type TranscriptMoveOutcome = {
  moved: boolean;
  fromJsonlPath: string | null;
  toJsonlPath: string | null;
  warnings: string[];
};

export type MoveTranscriptFiles = (
  session: SessionLike,
  fromProjectPath: string,
  toProjectPath: string,
) => Promise<TranscriptMoveOutcome>;

type RewriteCwdResult = {
  /** Number of JSONL records carrying a string `cwd` field. */
  totalCwd: number;
  /** Number of those records rewritten from the source project to the target. */
  changed: number;
  /** Number already carrying the target project (idempotent re-run). */
  alreadyNew: number;
};

/**
 * Rewrites the `cwd` field on each JSONL record whose cwd canonicalizes to the
 * source project, setting it to the target project path. This is what makes the
 * move durable: the Claude disk-watcher re-derives a session's project from the
 * transcript's `cwd` (not the directory name), so a moved file whose records
 * still claim the old cwd would be silently re-parented back on the next rescan.
 *
 * Never truncates: the file is only rewritten when at least one record changed,
 * and every untouched line is preserved byte-for-byte.
 */
async function rewriteJsonlCwd(
  filePath: string,
  fromProjectPath: string,
  toProjectPath: string,
): Promise<RewriteCwdResult> {
  const content = await fsp.readFile(filePath, 'utf8');
  const oldCanon = canonicalizeProjectPath(fromProjectPath);
  const newCanon = canonicalizeProjectPath(toProjectPath);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';

  let totalCwd = 0;
  let changed = 0;
  let alreadyNew = 0;

  const lines = content.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return line;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return line;
    }
    if (typeof obj.cwd !== 'string') {
      return line;
    }
    totalCwd += 1;
    const cwdCanon = canonicalizeProjectPath(obj.cwd);
    if (cwdCanon === oldCanon) {
      obj.cwd = toProjectPath;
      changed += 1;
      return JSON.stringify(obj);
    }
    if (cwdCanon === newCanon) {
      alreadyNew += 1;
    }
    return line;
  });

  if (changed > 0) {
    const trailingNewline = content.endsWith('\n') ? newline : '';
    await fsp.writeFile(filePath, out.join(newline) + trailingNewline, 'utf8');
  }

  return { totalCwd, changed, alreadyNew };
}

/**
 * Relocates one Claude session's transcript artifacts from the source project's
 * provider directory to the target project's. Returns where the main transcript
 * now lives so the caller can update `jsonl_path`. On any uncertainty the file
 * is left in place (`moved: false`) — the backend still resolves history via the
 * unchanged absolute `jsonl_path`, so no conversation record is ever lost.
 */
async function moveClaudeTranscriptFiles(
  session: SessionLike,
  fromProjectPath: string,
  toProjectPath: string,
): Promise<TranscriptMoveOutcome> {
  const warnings: string[] = [];
  const noMove = (fromJsonlPath: string | null, warn?: string): TranscriptMoveOutcome => {
    if (warn) warnings.push(warn);
    return { moved: false, fromJsonlPath, toJsonlPath: null, warnings };
  };

  if (!session.provider_session_id) {
    return noMove(session.jsonl_path, 'no provider_session_id yet — transcript not materialized, nothing to move');
  }

  const claudeHome = path.join(os.homedir(), '.claude');
  const fromDir = path.join(claudeHome, 'projects', encodeClaudeProjectDirName(fromProjectPath));
  const toDir = path.join(claudeHome, 'projects', encodeClaudeProjectDirName(toProjectPath));
  if (fromDir === toDir) {
    return noMove(session.jsonl_path, 'source and target projects share the same Claude transcript directory');
  }

  const mainName = `${session.provider_session_id}.jsonl`;
  const derivedFrom = path.join(fromDir, mainName);
  const sourceMain =
    session.jsonl_path && fs.existsSync(session.jsonl_path)
      ? session.jsonl_path
      : fs.existsSync(derivedFrom)
        ? derivedFrom
        : null;
  if (!sourceMain) {
    return noMove(null, `transcript file not found (expected ${derivedFrom}); leaving in place`);
  }

  // Rewrite the embedded cwd (source → target) BEFORE renaming, so whichever
  // chokidar event fires (change on the old path, or add on the new path) reads
  // a transcript that already claims the target project.
  let rewrite: RewriteCwdResult;
  try {
    rewrite = await rewriteJsonlCwd(sourceMain, fromProjectPath, toProjectPath);
  } catch (err) {
    return noMove(sourceMain, `cwd rewrite failed: ${(err as Error).message}`);
  }
  const safeToMove = rewrite.changed > 0 || rewrite.totalCwd === 0 || rewrite.alreadyNew === rewrite.totalCwd;
  if (!safeToMove) {
    return noMove(sourceMain, 'transcript cwd fields do not match the source project — leaving file in place');
  }

  const sourceDir = path.dirname(sourceMain);
  const targetMain = path.join(toDir, mainName);
  try {
    await fsp.mkdir(toDir, { recursive: true });
    await fsp.rename(sourceMain, targetMain);
  } catch (err) {
    return noMove(sourceMain, `transcript rename failed: ${(err as Error).message}`);
  }

  // Best-effort: move the session's subagent transcript directory. Its absence
  // or failure must not fail the transfer — subagent detail is enrichment, and
  // the main conversation records already moved above.
  const subagentsDir = path.join(sourceDir, session.provider_session_id, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    const targetSubagents = path.join(toDir, session.provider_session_id, 'subagents');
    try {
      await fsp.mkdir(path.dirname(targetSubagents), { recursive: true });
      await fsp.rename(subagentsDir, targetSubagents);
    } catch (err) {
      warnings.push(`subagent transcript move failed: ${(err as Error).message}`);
    }
  }

  // Legacy Claude layout stores subagent transcripts as `agent-*.jsonl` siblings
  // of the main file. getSessionMessages reads them from jsonl_path's directory
  // to enrich subagent tool_use; leaving them behind only degrades that detail,
  // not the conversation. Surface them so the operator isn't surprised.
  try {
    const leftover = (await fsp.readdir(sourceDir)).filter(
      (name) => name.startsWith('agent-') && name.endsWith('.jsonl'),
    );
    if (leftover.length > 0) {
      warnings.push(`legacy subagent transcripts left in ${sourceDir}: ${leftover.join(', ')}`);
    }
  } catch {
    // source dir may be gone after moving its only file — nothing to warn about.
  }

  return { moved: true, fromJsonlPath: sourceMain, toJsonlPath: targetMain, warnings };
}

export type SessionTransferDeps = {
  projectsDb: {
    getProjectById: (projectId: string) => ProjectLike | null;
    getProjectPath: (projectPath: string) => ProjectLike | null;
  };
  sessionsDb: {
    getSessionById: (sessionId: string) => SessionLike | null;
    updateSessionProjectPath: (sessionId: string, projectPath: string) => void;
    setSessionJsonlPath: (sessionId: string, jsonlPath: string) => void;
  };
  tasksService: {
    getTask: (taskId: string) => TaskLike | null;
    getTaskBySessionId?: (sessionId: string) => TaskLike | null;
    transferTaskProject: (taskId: string, projectPath: string) => unknown;
  };
  /** Returns true when the session's agent run is still live. */
  isSessionRunning?: (sessionId: string) => boolean;
  /** Injectable for tests; defaults to the real Claude transcript mover. */
  moveTranscriptFiles?: MoveTranscriptFiles;
};

function transferError(message: string): Error {
  return new Error(`session transfer failed: ${message}`);
}

export function createSessionTransferService(deps: SessionTransferDeps) {
  const moveTranscriptFiles = deps.moveTranscriptFiles ?? moveClaudeTranscriptFiles;

  /**
   * Moves one task + its session to a target project. Returns before/after info
   * so the operator can verify the transfer; throws a readable error on any
   * validation failure (fail loudly, never silently create a project).
   */
  async function moveSessionToProject(
    input: MoveSessionToProjectInput,
  ): Promise<MoveSessionToProjectResult> {
    if (!input.taskId && !input.sessionId) {
      throw transferError('taskId or sessionId is required');
    }
    if (!input.targetProjectPath && !input.targetProjectId) {
      throw transferError('targetProjectPath or targetProjectId is required');
    }
    if (input.targetProjectPath && input.targetProjectId) {
      throw transferError('provide only one of targetProjectPath / targetProjectId');
    }

    // Resolve the target project first: it must already be registered + active.
    const targetProject = input.targetProjectId
      ? deps.projectsDb.getProjectById(input.targetProjectId)
      : deps.projectsDb.getProjectPath(canonicalizeProjectPath(input.targetProjectPath as string));
    if (!targetProject) {
      throw transferError(
        `target project not registered: ${input.targetProjectId ?? input.targetProjectPath}`,
      );
    }
    if (targetProject.isArchived) {
      throw transferError(`target project is archived: ${targetProject.project_path}`);
    }

    // Resolve the task (optional) and the session (required).
    let task: TaskLike | null = null;
    let session: SessionLike | null = null;
    if (input.taskId) {
      task = deps.tasksService.getTask(input.taskId);
      if (!task) {
        throw transferError(`task not found: ${input.taskId}`);
      }
      const linkedSessionId = task.session_id;
      if (!linkedSessionId) {
        throw transferError(`task ${input.taskId} has no linked session to transfer`);
      }
      if (input.sessionId && input.sessionId !== linkedSessionId) {
        throw transferError(
          `task ${input.taskId} is linked to session ${linkedSessionId}, not ${input.sessionId}`,
        );
      }
      session = deps.sessionsDb.getSessionById(linkedSessionId);
    } else {
      session = deps.sessionsDb.getSessionById(input.sessionId as string);
      if (session) {
        task = deps.tasksService.getTaskBySessionId?.(session.session_id) ?? null;
      }
    }
    if (!session) {
      throw transferError(`session not found: ${input.sessionId ?? task?.session_id}`);
    }

    const sessionId = session.session_id;
    if (session.is_operator === 1 || (task && task.is_operator === 1)) {
      throw transferError(`session ${sessionId} is an operator assistant session — not transferable`);
    }

    const fromProjectPath = session.project_path?.trim() || '';
    if (!fromProjectPath) {
      throw transferError(`session ${sessionId} has no project association to transfer from`);
    }

    // Idempotency: already in the target project is a no-op, not an error.
    if (canonicalizeProjectPath(fromProjectPath) === canonicalizeProjectPath(targetProject.project_path)) {
      return {
        alreadyInTarget: true,
        taskId: task?.task_id ?? null,
        sessionId,
        fromProjectPath,
        toProjectId: targetProject.project_id,
        toProjectPath: targetProject.project_path,
        taskUpdated: false,
        transcript: { moved: false, fromJsonlPath: session.jsonl_path, toJsonlPath: null, warnings: [] },
      };
    }

    // Running guard: never relocate a transcript a live agent is still writing.
    const taskInProgress = task !== null && task.status === 'in_progress';
    const sessionRunning = deps.isSessionRunning ? deps.isSessionRunning(sessionId) : false;
    if (taskInProgress || sessionRunning) {
      throw transferError(
        `session ${sessionId} is running/in_progress — stop or settle the run before transferring`,
      );
    }

    // Move the transcript BEFORE re-parenting rows, and only point jsonl_path at
    // the new location when the move actually happened. If the move is skipped
    // the old absolute jsonl_path stays valid, so history never dangles.
    const transcript = await moveTranscriptFiles(session, fromProjectPath, targetProject.project_path);

    deps.sessionsDb.updateSessionProjectPath(sessionId, targetProject.project_path);
    if (transcript.moved && transcript.toJsonlPath) {
      deps.sessionsDb.setSessionJsonlPath(sessionId, transcript.toJsonlPath);
    }

    let taskUpdated = false;
    if (task) {
      deps.tasksService.transferTaskProject(task.task_id, targetProject.project_path);
      taskUpdated = true;
    }

    return {
      alreadyInTarget: false,
      taskId: task?.task_id ?? null,
      sessionId,
      fromProjectPath,
      toProjectId: targetProject.project_id,
      toProjectPath: targetProject.project_path,
      taskUpdated,
      transcript,
    };
  }

  return { moveSessionToProject };
}

export type SessionTransferService = ReturnType<typeof createSessionTransferService>;
