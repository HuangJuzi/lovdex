import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

// Shape of `tasks` BEFORE this change: exactly TASKS_TABLE_SCHEMA_SQL minus the
// auto_approve column. Every rebuild gate inside migrateTasksTable stays silent
// on this shape, so the in-place addColumnToTableIfNotExists ALTER is the only
// mechanism that can add the column — which is the real rollout path for an
// already-upgraded production DB.
const TASKS_WITHOUT_AUTO_APPROVE_DDL = `
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
    source_schedule_id TEXT
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

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test('a fresh database gets auto_approve on both tasks and scheduled_tasks, defaulting to 0', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-fresh-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  await initializeDatabase();

  try {
    const db = getConnection();
    assert.ok(columnNames(db, 'tasks').includes('auto_approve'), 'tasks.auto_approve must exist');
    assert.ok(
      columnNames(db, 'scheduled_tasks').includes('auto_approve'),
      'scheduled_tasks.auto_approve must exist',
    );

    db.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
    db.prepare('INSERT INTO tasks (task_id, project_path, title, source_schedule_id) VALUES (?, ?, ?, ?)')
      .run('t1', '/tmp/repo', 'task', 's1');
    const row = db.prepare('SELECT auto_approve FROM tasks WHERE task_id = ?').get('t1') as {
      auto_approve: number;
    };
    assert.equal(row.auto_approve, 0, 'a task created without the flag must default to 0 (never auto-approve)');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('auto_approve is added in place to an existing tasks table without dropping its rows', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(PROJECTS_DDL);
  legacy.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
  legacy.exec(TASKS_WITHOUT_AUTO_APPROVE_DDL);
  legacy.prepare('INSERT INTO tasks (task_id, project_path, title, remark) VALUES (?, ?, ?, ?)')
    .run('t1', '/tmp/repo', 'legacy task', 'keep me');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = columnNames(db, 'tasks');
    assert.ok(cols.includes('auto_approve'), 'expected auto_approve to be added in place');
    // ALTER TABLE ADD COLUMN appends at the END. A rename→recreate rebuild would
    // place it per TASKS_TABLE_SCHEMA_SQL instead, so the ordering proves which
    // mechanism ran.
    assert.ok(
      cols.indexOf('source_schedule_id') < cols.indexOf('auto_approve'),
      'expected auto_approve to be appended at the end (in-place ALTER, not a rebuild)',
    );
    const row = db.prepare('SELECT title, remark, auto_approve FROM tasks WHERE task_id = ?').get('t1') as {
      title: string;
      remark: string | null;
      auto_approve: number;
    };
    assert.equal(row.title, 'legacy task', 'the existing row must survive the migration');
    assert.equal(row.remark, 'keep me');
    assert.equal(row.auto_approve, 0, 'pre-existing tasks must default to 0 — the change must not widen them');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('auto_approve is added in place to an existing scheduled_tasks table', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-sched-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE scheduled_tasks (
      schedule_id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      project_path TEXT,
      executor_provider TEXT NOT NULL DEFAULT 'claude',
      executor_model TEXT,
      priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
      label TEXT NOT NULL DEFAULT 'other' CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
      is_operator INTEGER DEFAULT 0,
      auto_run INTEGER DEFAULT 1,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once','interval','cron')),
      cron_expr TEXT,
      interval_seconds INTEGER,
      run_at DATETIME,
      timezone TEXT DEFAULT 'local',
      next_run_at DATETIME NOT NULL,
      last_run_at DATETIME,
      last_task_id TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy.prepare(
    'INSERT INTO scheduled_tasks (schedule_id, title, schedule_type, next_run_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'nightly', 'cron', '2026-09-22T01:00:00.000Z');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    assert.ok(columnNames(db, 'scheduled_tasks').includes('auto_approve'));
    const row = db.prepare('SELECT title, auto_approve FROM scheduled_tasks WHERE schedule_id = ?').get('s1') as {
      title: string;
      auto_approve: number;
    };
    assert.equal(row.title, 'nightly');
    assert.equal(row.auto_approve, 0, 'existing schedules must keep asking for approval');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('a fresh database gets permission_mode on both tables, defaulting to default', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'perm-mode-fresh-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  await initializeDatabase();

  try {
    const db = getConnection();
    assert.ok(columnNames(db, 'tasks').includes('permission_mode'), 'tasks.permission_mode');
    assert.ok(
      columnNames(db, 'scheduled_tasks').includes('permission_mode'),
      'scheduled_tasks.permission_mode',
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('an existing auto_approve = 1 row is backfilled to the auto-approve mode', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'perm-mode-backfill-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  // Simulate the "previous release already shipped" database: auto_approve
  // exists, permission_mode does not.
  const legacy = new Database(databasePath);
  legacy.exec(PROJECTS_DDL);
  legacy.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
  legacy.exec(TASKS_WITHOUT_AUTO_APPROVE_DDL);
  legacy.exec('ALTER TABLE tasks ADD COLUMN auto_approve INTEGER DEFAULT 0');
  legacy.prepare('INSERT INTO tasks (task_id, project_path, title, auto_approve) VALUES (?, ?, ?, ?)')
    .run('t1', '/tmp/repo', 'on', 1);
  legacy.prepare('INSERT INTO tasks (task_id, project_path, title, auto_approve) VALUES (?, ?, ?, ?)')
    .run('t2', '/tmp/repo', 'off', 0);
  legacy.close();

  await initializeDatabase();

  try {
    const rows = getConnection()
      .prepare('SELECT task_id, permission_mode FROM tasks ORDER BY task_id')
      .all() as { task_id: string; permission_mode: string }[];
    assert.deepEqual(rows, [
      { task_id: 't1', permission_mode: 'autoApprove' },
      { task_id: 't2', permission_mode: 'default' },
    ]);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('re-running the migration does not undo a manual switch back to default', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'perm-mode-idempotent-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  await initializeDatabase();
  // The user switched a task from autoApprove back to default in the UI.
  getConnection()
    .prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
  getConnection()
    .prepare('INSERT INTO tasks (task_id, project_path, title, auto_approve, permission_mode) VALUES (?, ?, ?, ?, ?)')
    .run('t1', '/tmp/repo', 'x', 1, 'default');
  closeConnection();

  // Second migration run: the column already exists, so the whole backfill
  // block must be skipped.
  await initializeDatabase();

  try {
    const row = getConnection()
      .prepare("SELECT permission_mode FROM tasks WHERE task_id = 't1'")
      .get() as { permission_mode: string };
    assert.equal(row.permission_mode, 'default', 'a manual switch must survive a restart');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
