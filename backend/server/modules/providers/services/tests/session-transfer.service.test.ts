import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionTransferService,
  type MoveTranscriptFiles,
} from '@/modules/providers/services/session-transfer.service.js';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  is_operator: number;
};

type TaskRow = {
  task_id: string;
  project_path: string;
  session_id: string | null;
  status: string;
  is_operator: number;
};

type ProjectRow = {
  project_id: string;
  project_path: string;
  isArchived: number;
};

function makeProjectsDb(rows: ProjectRow[]) {
  return {
    getProjectById: (id: string) => rows.find((r) => r.project_id === id) ?? null,
    getProjectPath: (p: string) => rows.find((r) => r.project_path === p) ?? null,
  };
}

function makeSessionsDb(initial: SessionRow[]) {
  const state = new Map(initial.map((s) => [s.session_id, s]));
  return {
    getSessionById: (id: string) => state.get(id) ?? null,
    updateSessionProjectPath: (id: string, p: string) => {
      const s = state.get(id);
      if (s) state.set(id, { ...s, project_path: p });
    },
    setSessionJsonlPath: (id: string, p: string) => {
      const s = state.get(id);
      if (s) state.set(id, { ...s, jsonl_path: p });
    },
    rows: () => [...state.values()],
  };
}

function makeTasksService(initial: TaskRow[]) {
  const state = new Map(initial.map((t) => [t.task_id, t]));
  return {
    getTask: (id: string) => state.get(id) ?? null,
    getTaskBySessionId: (sid: string) => [...state.values()].find((t) => t.session_id === sid) ?? null,
    transferTaskProject: (id: string, p: string) => {
      const t = state.get(id);
      if (t) state.set(id, { ...t, project_path: p });
    },
    rows: () => [...state.values()],
  };
}

const projectA: ProjectRow = { project_id: 'pa', project_path: '/proj/a', isArchived: 0 };
const projectB: ProjectRow = { project_id: 'pb', project_path: '/proj/b', isArchived: 0 };

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 's1',
    provider: 'claude',
    provider_session_id: 'prov-1',
    project_path: '/proj/a',
    jsonl_path: '/home/u/.claude/projects/-proj-a/prov-1.jsonl',
    is_operator: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: 't1',
    project_path: '/proj/a',
    session_id: 's1',
    status: 'todo',
    is_operator: 0,
    ...overrides,
  };
}

const movedTranscript: MoveTranscriptFiles = async () => ({
  moved: true,
  fromJsonlPath: '/home/u/.claude/projects/-proj-a/prov-1.jsonl',
  toJsonlPath: '/home/u/.claude/projects/-proj-b/prov-1.jsonl',
  warnings: [],
});

test('moves task + session to the target project and reports before/after', async () => {
  const projectsDb = makeProjectsDb([projectA, projectB]);
  const sessionsDb = makeSessionsDb([makeSession()]);
  const tasksService = makeTasksService([makeTask()]);
  const svc = createSessionTransferService({
    projectsDb,
    sessionsDb,
    tasksService,
    moveTranscriptFiles: movedTranscript,
  });

  const result = await svc.moveSessionToProject({ taskId: 't1', targetProjectPath: '/proj/b' });

  assert.equal(result.alreadyInTarget, false);
  assert.equal(result.taskId, 't1');
  assert.equal(result.sessionId, 's1');
  assert.equal(result.fromProjectPath, '/proj/a');
  assert.equal(result.toProjectPath, '/proj/b');
  assert.equal(result.taskUpdated, true);
  assert.equal(result.transcript.moved, true);
  assert.equal(result.transcript.toJsonlPath, '/home/u/.claude/projects/-proj-b/prov-1.jsonl');

  // Both rows re-parented; jsonl_path repointed to the moved file.
  assert.equal(sessionsDb.rows()[0].project_path, '/proj/b');
  assert.equal(sessionsDb.rows()[0].jsonl_path, '/home/u/.claude/projects/-proj-b/prov-1.jsonl');
  assert.equal(tasksService.rows()[0].project_path, '/proj/b');
});

test('locates by sessionId and moves its linked task too', async () => {
  const projectsDb = makeProjectsDb([projectA, projectB]);
  const sessionsDb = makeSessionsDb([makeSession()]);
  const tasksService = makeTasksService([makeTask()]);
  const svc = createSessionTransferService({
    projectsDb,
    sessionsDb,
    tasksService,
    moveTranscriptFiles: movedTranscript,
  });

  const result = await svc.moveSessionToProject({ sessionId: 's1', targetProjectId: 'pb' });

  assert.equal(result.taskId, 't1');
  assert.equal(result.toProjectPath, '/proj/b');
  assert.equal(tasksService.rows()[0].project_path, '/proj/b');
  assert.equal(sessionsDb.rows()[0].project_path, '/proj/b');
});

test('target project must be registered — fails loudly, never auto-creates', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([makeTask()]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ taskId: 't1', targetProjectPath: '/proj/missing' }),
    /target project not registered/,
  );
});

test('archived target project is rejected', async () => {
  const archived = { project_id: 'pz', project_path: '/proj/z', isArchived: 1 };
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, archived]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([makeTask()]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ taskId: 't1', targetProjectPath: '/proj/z' }),
    /archived/,
  );
});

test('task not found fails loudly', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ taskId: 'nope', targetProjectPath: '/proj/b' }),
    /task not found/,
  );
});

test('session not found fails loudly', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([]),
    tasksService: makeTasksService([]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ sessionId: 'nope', targetProjectPath: '/proj/b' }),
    /session not found/,
  );
});

test('missing taskId/sessionId and target args are rejected', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([makeTask()]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(() => svc.moveSessionToProject({ targetProjectPath: '/proj/b' }), /taskId or sessionId/);
  await assert.rejects(() => svc.moveSessionToProject({ sessionId: 's1' }), /targetProjectPath or targetProjectId/);
  await assert.rejects(
    () => svc.moveSessionToProject({ sessionId: 's1', targetProjectPath: '/proj/b', targetProjectId: 'pb' }),
    /only one of targetProjectPath/,
  );
});

test('already in target project is an idempotent no-op (not an error)', async () => {
  let moveCalls = 0;
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([makeTask()]),
    moveTranscriptFiles: async () => {
      moveCalls += 1;
      return { moved: true, fromJsonlPath: null, toJsonlPath: null, warnings: [] };
    },
  });

  const result = await svc.moveSessionToProject({ taskId: 't1', targetProjectPath: '/proj/a' });

  assert.equal(result.alreadyInTarget, true);
  assert.equal(result.taskUpdated, false);
  assert.equal(moveCalls, 0, 'no transcript move for an idempotent no-op');
});

test('in_progress task is rejected with a settle-first message', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([makeTask({ status: 'in_progress' })]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ taskId: 't1', targetProjectPath: '/proj/b' }),
    /running\/in_progress/,
  );
});

test('live-running session (isSessionRunning) is rejected even when the task is not in_progress', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession()]),
    tasksService: makeTasksService([makeTask({ status: 'todo' })]),
    isSessionRunning: () => true,
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ sessionId: 's1', targetProjectPath: '/proj/b' }),
    /running\/in_progress/,
  );
});

test('operator session is rejected', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession({ is_operator: 1 })]),
    tasksService: makeTasksService([]),
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ sessionId: 's1', targetProjectPath: '/proj/b' }),
    /operator/,
  );
});

test('mismatched taskId/sessionId is rejected', async () => {
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb: makeSessionsDb([makeSession(), makeSession({ session_id: 's2', provider_session_id: 'prov-2' })]),
    tasksService: makeTasksService([makeTask()]), // t1 → s1
    moveTranscriptFiles: movedTranscript,
  });

  await assert.rejects(
    () => svc.moveSessionToProject({ taskId: 't1', sessionId: 's2', targetProjectPath: '/proj/b' }),
    /linked to session s1, not s2/,
  );
});

test('transcript move skipped still re-parents rows and keeps jsonl_path untouched', async () => {
  const sessionsDb = makeSessionsDb([makeSession()]);
  const tasksService = makeTasksService([makeTask()]);
  const svc = createSessionTransferService({
    projectsDb: makeProjectsDb([projectA, projectB]),
    sessionsDb,
    tasksService,
    moveTranscriptFiles: async () => ({
      moved: false,
      fromJsonlPath: '/home/u/.claude/projects/-proj-a/prov-1.jsonl',
      toJsonlPath: null,
      warnings: ['no provider_session_id yet'],
    }),
  });

  const result = await svc.moveSessionToProject({ taskId: 't1', targetProjectPath: '/proj/b' });

  assert.equal(result.transcript.moved, false);
  assert.equal(result.transcript.warnings.length, 1);
  // project association moved, transcript file left in place (still resolvable).
  assert.equal(sessionsDb.rows()[0].project_path, '/proj/b');
  assert.equal(sessionsDb.rows()[0].jsonl_path, '/home/u/.claude/projects/-proj-a/prov-1.jsonl');
  assert.equal(tasksService.rows()[0].project_path, '/proj/b');
});
