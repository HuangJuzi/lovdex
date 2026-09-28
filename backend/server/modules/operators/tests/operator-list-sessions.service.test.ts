import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { createOperatorListSessionsService } from '@/modules/operators/operator-list-sessions.service.js';

type Row = {
  session_id: string;
  project_path: string | null;
  jsonl_path: string | null;
  is_operator: number;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

function fakeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    session_id: id,
    project_path: '/p',
    jsonl_path: null,
    is_operator: 0,
    isArchived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

type Filter = {
  projectPath?: string;
  isOperator?: number;
  includeDeleted?: boolean;
  lastActiveBefore?: string;
  lastActiveAfter?: string;
  orderBy?: string;
};

function buildHarness(rows: Row[], overrides: Record<string, unknown> = {}) {
  const calls: Filter[] = [];
  const service = createOperatorListSessionsService({
    sessionsDb: {
      listSessions: (f: Filter) => {
        calls.push(f);
        return rows;
      },
    },
    tasksDb: { getTaskBySessionId: () => null },
    projectsDb: { getProjectPath: () => null },
    isSessionRunning: () => false,
    readTranscriptStats: async () => ({ bytes: 0, lineCount: 0 }),
    ...overrides,
  } as never);
  return { service, calls };
}

test('listSessions clamps limit to 1..200 (default 50) and reports hasMore', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => fakeRow(`s${i}`));
  const { service } = buildHarness(rows);

  const page1 = await service.listSessions({ limit: 2 });
  assert.equal(page1.limit, 2);
  assert.equal(page1.offset, 0);
  assert.equal(page1.total, 3);
  assert.equal(page1.sessions.length, 2);
  assert.equal(page1.hasMore, true);

  const page2 = await service.listSessions({ limit: 2, offset: 2 });
  assert.equal(page2.sessions.length, 1);
  assert.equal(page2.hasMore, false);

  assert.equal((await service.listSessions({ limit: 9999 })).limit, 200);
  assert.equal((await service.listSessions({})).limit, 50);
});

test('listSessions tags every session with isOperator and forwards an explicit filter', async () => {
  const rows = [fakeRow('s-op', { is_operator: 1 }), fakeRow('s-plain', { is_operator: 0 })];
  const { service, calls } = buildHarness(rows);

  const all = await service.listSessions({});
  assert.equal(all.total, 2);
  assert.deepEqual(all.sessions.map((s) => [s.sessionId, s.isOperator]).sort(), [
    ['s-op', 1],
    ['s-plain', 0],
  ]);

  await service.listSessions({ isOperator: 1 });
  assert.equal(calls[1].isOperator, 1);
});

test('listSessions forwards filters and normalizes lastActive timestamps to ISO', async () => {
  const { service, calls } = buildHarness([]);

  await service.listSessions({
    projectPath: '/proj',
    includeDeleted: true,
    lastActiveBefore: '2026-07-01T00:00:00Z',
    lastActiveAfter: 1720000000000,
    orderBy: 'asc',
  });

  const f = calls[0];
  assert.equal(f.projectPath, '/proj');
  assert.equal(f.includeDeleted, true);
  assert.equal(f.lastActiveBefore, '2026-07-01T00:00:00.000Z');
  assert.equal(f.lastActiveAfter, new Date(1720000000000).toISOString());
  assert.equal(f.orderBy, 'asc');
});

test('listSessions rejects an unparseable lastActive timestamp', async () => {
  const { service } = buildHarness([]);
  await assert.rejects(() => service.listSessions({ lastActiveBefore: 'not-a-date' }), /invalid lastActiveBefore/);
});

test('listSessions derives status and filters by it', async () => {
  const running = new Set(['s-run']);
  const tasks: Record<string, { task_id: string; title: string; status: string; sub_status?: string | null }> = {
    's-inprogress': { task_id: 't1', title: 'wip', status: 'in_progress' },
    's-failed': { task_id: 't2', title: 'boom', status: 'done', sub_status: 'failed' },
    's-idle': { task_id: 't3', title: 'rest', status: 'done' },
  };
  const rows = ['s-run', 's-inprogress', 's-failed', 's-idle', 's-orphan'].map((id) => fakeRow(id));
  const { service } = buildHarness(rows, {
    isSessionRunning: (id: string) => running.has(id),
    tasksDb: { getTaskBySessionId: (id: string) => tasks[id] ?? null },
  });

  const all = await service.listSessions({});
  const byId = new Map(all.sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId.get('s-run')?.status, 'running');
  assert.equal(byId.get('s-inprogress')?.status, 'in_progress');
  assert.equal(byId.get('s-failed')?.status, 'failed');
  assert.equal(byId.get('s-idle')?.status, 'idle');
  assert.equal(byId.get('s-orphan')?.status, 'idle');

  const failedOnly = await service.listSessions({ status: 'failed' });
  assert.deepEqual(failedOnly.sessions.map((s) => s.sessionId), ['s-failed']);

  const idleOnly = await service.listSessions({ status: 'idle' });
  assert.deepEqual(idleOnly.sessions.map((s) => s.sessionId).sort(), ['s-idle', 's-orphan']);
});

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'list-sessions-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('listSessions against a real DB is read-only and honors project + lastActive filters', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('s-recent', 'claude', '/workspace/proj', 'Recent', undefined, '2026-09-01T00:00:00Z');
    sessionsDb.createSession('s-stale', 'claude', '/workspace/proj', 'Stale', undefined, '2026-01-01T00:00:00Z');
    sessionsDb.createSession('s-other', 'claude', '/workspace/elsewhere', 'Other', undefined, '2026-09-01T00:00:00Z');

    const service = createOperatorListSessionsService({
      sessionsDb,
      tasksDb,
      projectsDb,
      isSessionRunning: () => false,
      readTranscriptStats: async () => ({ bytes: 0, lineCount: 0 }),
    } as never);

    const result = await service.listSessions({
      projectPath: '/workspace/proj',
      lastActiveBefore: '2026-07-01T00:00:00Z',
    });
    assert.deepEqual(result.sessions.map((s) => s.sessionId), ['s-stale']);
    assert.equal(result.sessions[0].sessionDeleted, false);
    assert.equal(result.sessions[0].isOperator, 0);
    assert.equal(result.total, 1);

    assert.deepEqual(
      sessionsDb.getAllSessions().map((s) => s.session_id).sort(),
      ['s-other', 's-recent', 's-stale'],
    );
    assert.equal(sessionsDb.getArchivedSessions().length, 0);
    assert.equal(sessionsDb.getSessionById('s-recent')?.custom_name, 'Recent');
  });
});
