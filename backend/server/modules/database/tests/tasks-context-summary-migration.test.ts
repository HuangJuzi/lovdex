import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

// Pre-sub_status legacy tasks shape (also missing priority/deadline/is_operator/label/remark cols).
const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo',
    executor_provider TEXT NOT NULL DEFAULT 'claude',
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// Current production schema shape MINUS the context_summary column: sub_status,
// the opencode/qoder executor CHECK, source_schedule_id, the waiting_*
// sub_status CHECK, the reminder label CHECK, and the archived status are all
// present. Every rebuild gate inside migrateTasksTable (two-layer status,
// executor engines, opencode, waiting_*, label reminder, archived) stays silent,
// so the ONLY mechanism that adds the column on such a table is the in-place
// addColumnToTableIfNotExists(..., 'context_summary', ...) ALTER — exactly the
// real rollout path for an already-upgraded DB.
const CURRENT_SHAPE_WITHOUT_CONTEXT_SUMMARY_DDL = `
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
    ai_summary       TEXT,
    sub_status       TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked','waiting_answer','waiting_plan')),
    verdict_reason   TEXT,
    verdict_at       DATETIME,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    remark            TEXT,
    source_schedule_id TEXT
);
`;

function columnNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name),
  );
}

test('context_summary column exists after runMigrations on a legacy tasks table', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ctx-summary-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  // Seed the raw DB file with the legacy tasks shape before the singleton opens
  // it: initializeDatabase() then runs INIT_SCHEMA_SQL whose "CREATE TABLE IF
  // NOT EXISTS tasks" is a no-op, so migrateTasksTable sees the legacy shape and
  // must add/rebuild up to the current schema (including context_summary).
  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(LEGACY_TASKS_DDL);
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    assert.ok(columnNames(db).has('context_summary'), 'expected context_summary column to be added');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('context_summary added in place via ALTER when table is at current schema shape (no rebuild)', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ctx-summary-alter-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  // Seed a DB that matches the CURRENT schema shape except for the missing
  // context_summary column. All rebuild gates in migrateTasksTable are silent,
  // so the addColumnToTableIfNotExists('context_summary') ALTER is the sole
  // mechanism — the production rollout path for an already-upgraded DB.
  // SQLite ALTER TABLE ADD COLUMN appends the new column at the END, so the
  // column ORDER (source_schedule_id before context_summary) proves the in-place
  // ALTER ran instead of a rename→recreate rebuild (which would place
  // context_summary between remark and source_schedule_id per TASKS_TABLE_SCHEMA_SQL).
  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT DEFAULT NULL,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0
    );
  `);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.exec(CURRENT_SHAPE_WITHOUT_CONTEXT_SUMMARY_DDL);
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, remark) VALUES (?, ?, ?, ?)`).run('t1', '/tmp/example-repo', 'task', 'legacy remark');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('context_summary'), 'expected context_summary column to be added in place');
    // context_summary appended by ALTER → comes AFTER source_schedule_id.
    // A rebuild would order it before source_schedule_id.
    assert.ok(
      cols.indexOf('source_schedule_id') < cols.indexOf('context_summary'),
      'expected context_summary to be appended at the end (in-place ALTER, not a rebuild)',
    );
    const row = db.prepare('SELECT task_id, title, remark, context_summary FROM tasks WHERE task_id = ?').get('t1') as {
      task_id: string; title: string; remark: string | null; context_summary: string | null;
    };
    assert.equal(row.title, 'task');
    assert.equal(row.remark, 'legacy remark');
    assert.equal(row.context_summary, null);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});


test('updateTaskContextSummary writes context_summary and getTask reads it back', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ctx-summary-writeback-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  await initializeDatabase();

  try {
    const db = getConnection();
    db.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
    const task = tasksDb.createTask({
      projectPath: '/tmp/example-repo',
      title: 'summary task',
      executorProvider: 'claude',
    });
    assert.equal(task.context_summary, null);

    tasksDb.updateTaskContextSummary(task.task_id, 'compressed source-session context');
    const reloaded = tasksDb.getTask(task.task_id);
    assert.equal(reloaded?.context_summary, 'compressed source-session context');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});