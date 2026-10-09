import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

// Shape of `tasks` BEFORE the dsh engine was added: the executor CHECK lists
// only the four older engines, while every OTHER column (including the ones
// later migrations added in place: context_source_session_id, auto_approve,
// permission_mode, parent_task_id, dispatch_depth) is already present.
//
// This is the exact shape that makes the dsh rebuild gate dangerous: its marker
// is "the DDL has no 'dsh'", which is true of EVERY pre-existing database, so
// the gate runs even on modern DBs. A hardcoded copy column list would silently
// drop the values of any column it forgot.
const TASKS_WITHOUT_DSH_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','in_review','done','archived')),
    executor_provider TEXT NOT NULL DEFAULT 'claude'
                      CHECK (executor_provider IN ('claude','codex','opencode','qoder')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary        TEXT,
    sub_status        TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked','waiting_answer','waiting_plan')),
    verdict_reason    TEXT,
    verdict_at        DATETIME,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    remark            TEXT,
    context_summary   TEXT,
    context_source_session_id TEXT,
    context_mode      TEXT NOT NULL DEFAULT 'none'
                      CHECK (context_mode IN ('none','summary','raw')),
    context_status    TEXT
                      CHECK (context_status IS NULL OR context_status IN ('pending','ready','failed')),
    context_raw       TEXT,
    source_schedule_id TEXT,
    auto_approve      INTEGER DEFAULT 0,
    permission_mode   TEXT DEFAULT 'default',
    parent_task_id    TEXT,
    dispatch_depth    INTEGER NOT NULL DEFAULT 0
);
`;

const PROJECTS_DDL = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  custom_project_name TEXT DEFAULT NULL,
  isStarred BOOLEAN DEFAULT 0,
  isArchived BOOLEAN DEFAULT 0
);
`;

async function withLegacyDb(run: (db: Database.Database) => void): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-engine-migration-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(PROJECTS_DDL);
  legacy.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
  legacy.exec(TASKS_WITHOUT_DSH_DDL);
  legacy.close();

  try {
    await initializeDatabase();
    run(getConnection());
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('the dsh migration rebuilds the executor CHECK so a dsh task is accepted', async () => {
  await withLegacyDb((db) => {
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    assert.ok(ddl.includes("'dsh'"), 'the rebuilt tasks DDL must accept the dsh executor');

    // The whole point of the migration: this INSERT used to fail the CHECK.
    db.prepare('INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES (?, ?, ?, ?)')
      .run('t-dsh', '/tmp/repo', 'dsh task', 'dsh');
    const row = db.prepare('SELECT executor_provider FROM tasks WHERE task_id = ?').get('t-dsh') as {
      executor_provider: string;
    };
    assert.equal(row.executor_provider, 'dsh');
  });
});

test('the dsh migration preserves every pre-existing column value', async () => {
  // Seed the legacy row BEFORE initializeDatabase so it survives the rebuild.
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-engine-preserve-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(PROJECTS_DDL);
  legacy.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
  legacy.exec(TASKS_WITHOUT_DSH_DDL);
  legacy.prepare(`
    INSERT INTO tasks (task_id, project_path, title, executor_provider, executor_model,
      context_source_session_id, context_mode, context_status, context_raw, auto_approve,
      permission_mode, parent_task_id, dispatch_depth, label, ai_summary, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    't1', '/tmp/repo', 'legacy', 'qoder', 'm1',
    'src-session-1', 'raw', 'ready', 'RAW-PAYLOAD', 1,
    'bypassPermissions', 'parent-1', 3, 'reminder', 'SUMMARY-KEEP', 'keep me',
  );
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('t1') as Record<string, unknown>;

    // Every one of these lives in a column that a hardcoded copy list would
    // plausibly have omitted. Losing any of them is silent data loss.
    assert.equal(row.executor_provider, 'qoder');
    assert.equal(row.executor_model, 'm1');
    assert.equal(row.context_source_session_id, 'src-session-1');
    assert.equal(row.context_mode, 'raw');
    assert.equal(row.context_status, 'ready');
    assert.equal(row.context_raw, 'RAW-PAYLOAD');
    assert.equal(row.auto_approve, 1);
    assert.equal(row.permission_mode, 'bypassPermissions');
    assert.equal(row.parent_task_id, 'parent-1');
    assert.equal(row.dispatch_depth, 3);
    assert.equal(row.label, 'reminder');
    assert.equal(row.ai_summary, 'SUMMARY-KEEP');
    assert.equal(row.remark, 'keep me');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the dsh migration is idempotent and skips a database that already accepts dsh', async () => {
  // A fresh DB is created from TASKS_TABLE_SCHEMA_SQL, which already carries
  // 'dsh' in the executor CHECK — so the gate must be a no-op there.
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-engine-idempotent-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  try {
    await initializeDatabase();
    const db = getConnection();
    db.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
    db.prepare('INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES (?, ?, ?, ?)')
      .run('t-dsh', '/tmp/repo', 'fresh dsh task', 'dsh');

    // Re-running must not rebuild the table out from under the row.
    closeConnection();
    await initializeDatabase();
    const after = getConnection().prepare('SELECT executor_provider FROM tasks WHERE task_id = ?').get('t-dsh') as {
      executor_provider: string;
    };
    assert.equal(after.executor_provider, 'dsh');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
