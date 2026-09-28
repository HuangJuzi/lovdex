import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SessionRow, SessionsListFilter } from '@/modules/database/repositories/sessions.db.js';

/**
 * Read-only session enumeration ("列出 session") for the operator tool set.
 *
 * Mirrors the operator-delete/move services: the tool handler only forwards
 * args, while all validation, enrichment, status derivation, and pagination
 * live here so the behavior stays unit-testable with injected deps.
 *
 * Deliberately side-effect free — it only reads the session repository, task
 * linkage, project names, and (for the returned page) transcript file stats.
 * It never archives, deletes, or mutates anything.
 */

export type SessionTaskLike = {
  task_id: string;
  title: string;
  status: string;
  sub_status?: string | null;
};

export type ProjectLike = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
};

const DERIVED_STATUSES = ['running', 'in_progress', 'idle', 'failed'] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

const STATUS_FILTER_VALUES = [...DERIVED_STATUSES, 'all'] as const;
export type StatusFilter = (typeof STATUS_FILTER_VALUES)[number];

export type ListSessionsInput = {
  projectPath?: string;
  status?: StatusFilter;
  /** 0 = non-operator only, 1 = operator only. Omitted = return all, tagged. */
  isOperator?: 0 | 1;
  includeDeleted?: boolean;
  /** ISO-8601 datetime or epoch ms (number or digit string). */
  lastActiveBefore?: string | number;
  lastActiveAfter?: string | number;
  /** lastActiveAt sort direction. Default desc (newest first). */
  orderBy?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type ListedSession = {
  sessionId: string;
  projectPath: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  status: DerivedStatus;
  isOperator: number;
  createdAt: string | null;
  lastActiveAt: string | null;
  messageCount: number;
  transcriptPath: string | null;
  transcriptBytes: number;
  sessionDeleted: boolean;
};

export type ListSessionsResult = {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  sessions: ListedSession[];
};

export type OperatorListSessionsDeps = {
  sessionsDb: {
    listSessions: (filter: SessionsListFilter) => SessionRow[];
  };
  tasksDb: {
    getTaskBySessionId: (sessionId: string) => SessionTaskLike | null;
  };
  projectsDb: {
    getProjectPath: (projectPath: string) => ProjectLike | null;
  };
  isSessionRunning?: (sessionId: string) => boolean;
  readTranscriptStats?: (jsonlPath: string) => Promise<{ bytes: number; lineCount: number }>;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseTimestampInput(value: string | number | undefined, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed: Date;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`invalid ${label}: ${String(value)}`);
    parsed = new Date(value);
  } else {
    const str = String(value).trim();
    parsed = /^\d+$/.test(str) ? new Date(Number(str)) : new Date(str);
  }
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid ${label}: ${String(value)}`);
  return parsed.toISOString();
}

/**
 * Streams a transcript jsonl and returns its byte size + line (event) count.
 * Any error (missing file, unreadable, ...) collapses to { 0, 0 } — a stat
 * failure must not fail the whole enumeration.
 */
export async function readTranscriptStats(jsonlPath: string): Promise<{ bytes: number; lineCount: number }> {
  try {
    const stat = await fsp.stat(jsonlPath);
    const bytes = stat.size;
    if (bytes === 0) return { bytes: 0, lineCount: 0 };

    const handle = await fsp.open(jsonlPath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let lineCount = 0;
      let leftover = '';
      let position = 0;
      while (position < bytes) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
        const parts = chunk.split('\n');
        leftover = parts.pop() ?? '';
        lineCount += parts.length;
        position += bytesRead;
      }
      if (leftover.length > 0) lineCount += 1;
      return { bytes, lineCount };
    } finally {
      await handle.close();
    }
  } catch {
    return { bytes: 0, lineCount: 0 };
  }
}

export function createOperatorListSessionsService(deps: OperatorListSessionsDeps) {
  function deriveStatus(task: SessionTaskLike | null, isRunning: boolean): DerivedStatus {
    if (isRunning) return 'running';
    if (!task) return 'idle';
    if (task.status === 'in_progress') return 'in_progress';
    if (task.sub_status === 'failed') return 'failed';
    return 'idle';
  }

  async function listSessions(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.floor(input.offset ?? 0), 0);

    const status: StatusFilter = input.status ?? 'all';
    if (!STATUS_FILTER_VALUES.includes(status)) {
      throw new Error(`invalid status: ${String(status)}`);
    }
    if (input.isOperator !== undefined && input.isOperator !== 0 && input.isOperator !== 1) {
      throw new Error(`invalid isOperator: ${String(input.isOperator)}`);
    }

    const repoFilter: SessionsListFilter = {
      projectPath: input.projectPath || undefined,
      isOperator: input.isOperator,
      includeDeleted: input.includeDeleted === true,
      lastActiveBefore: parseTimestampInput(input.lastActiveBefore, 'lastActiveBefore'),
      lastActiveAfter: parseTimestampInput(input.lastActiveAfter, 'lastActiveAfter'),
      orderBy: input.orderBy === 'asc' ? 'asc' : 'desc',
    };

    const rows = deps.sessionsDb.listSessions(repoFilter);

    const projectNameCache = new Map<string, string | null>();
    const resolveProjectName = (projectPath: string | null): string | null => {
      if (!projectPath) return null;
      const cached = projectNameCache.get(projectPath);
      if (cached !== undefined) return cached;
      const project = deps.projectsDb.getProjectPath(projectPath);
      const custom = typeof project?.custom_project_name === 'string' ? project.custom_project_name.trim() : '';
      const name = custom.length > 0 ? custom : path.basename(projectPath) || projectPath;
      projectNameCache.set(projectPath, name);
      return name;
    };

    const toBase = (row: SessionRow): ListedSession => {
      const task = deps.tasksDb.getTaskBySessionId(row.session_id);
      const isRunning = deps.isSessionRunning ? deps.isSessionRunning(row.session_id) : false;
      return {
        sessionId: row.session_id,
        projectPath: row.project_path,
        projectName: resolveProjectName(row.project_path),
        taskId: task?.task_id ?? null,
        taskTitle: task?.title ?? null,
        taskStatus: task?.status ?? null,
        status: deriveStatus(task, isRunning),
        isOperator: row.is_operator,
        createdAt: row.created_at,
        lastActiveAt: row.updated_at ?? row.created_at,
        messageCount: 0,
        transcriptPath: row.jsonl_path,
        transcriptBytes: 0,
        sessionDeleted: row.isArchived === 1,
      };
    };

    let matched = rows.map(toBase);
    if (status !== 'all') {
      matched = matched.filter((session) => session.status === status);
    }

    const total = matched.length;
    const page = matched.slice(offset, offset + limit);

    // Stat transcripts only for the returned page — the whole point of
    // pagination is to bound the per-call file I/O.
    const readStats = deps.readTranscriptStats ?? readTranscriptStats;
    const sessions = await Promise.all(
      page.map(async (session) => {
        if (!session.transcriptPath) return session;
        const stats = await readStats(session.transcriptPath);
        return { ...session, messageCount: stats.lineCount, transcriptBytes: stats.bytes };
      }),
    );

    return { total, offset, limit, hasMore: offset + page.length < total, sessions };
  }

  return { listSessions };
}

export type OperatorListSessionsService = ReturnType<typeof createOperatorListSessionsService>;
