import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { TASKS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

// runMigrations ALTERs `users` (git_name / git_email / has_completed_onboarding)
// and assumes every other base table can be created by itself via
// CREATE TABLE IF NOT EXISTS, so the only table that must pre-exist is `users`.
const createUsersBase = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
  )`);
};

const seedLegacyDb = (): Database.Database => {
  const db = new Database(':memory:');
  // Mirror production: better-sqlite3 compiles SQLite with FK enforcement ON and
  // the real tasks table carries orphan project_path rows (no matching projects
  // row), so the rebuild gates must not re-validate the copy into a boot-block.
  db.exec('PRAGMA foreign_keys = ON');
  createUsersBase(db);
  // better-sqlite3 compiles SQLite with foreign keys ON, and the rebuilt tasks
  // table references projects(project_path), so the legacy path must exist.
  db.exec(`CREATE TABLE projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
  )`);
  db.prepare(`INSERT INTO projects (project_id, project_path) VALUES ('p1','/tmp/legacy-repo')`).run();
  // Legacy schema: tasks table that only accepts 'sophcode' but not 'opencode'/'qoder'
  db.exec(`CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL DEFAULT '',
    title TEXT, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex','sophcode')),
    executor_model TEXT, position INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, started_at TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT,
    ai_summary TEXT, sub_status TEXT, verdict_reason TEXT, verdict_at TEXT,
    priority TEXT, deadline TEXT, is_operator INTEGER NOT NULL DEFAULT 0,
    label TEXT, remark TEXT, source_schedule_id TEXT
  )`);
  db.prepare(`INSERT INTO tasks (task_id, project_path, title, label, priority, executor_provider, source_schedule_id) VALUES ('t1','/tmp/legacy-repo','legacy task','other','P2','sophcode','sch-1')`).run();
  // Orphan FK row: project_path '/tmp/orphan-missing' has no row in projects;
  // must survive the rebuilds instead of tripping SQLITE_CONSTRAINT_FOREIGNKEY.
  db.prepare(`INSERT INTO tasks (task_id, project_path, title, label, priority, executor_provider) VALUES ('t-orphan','/tmp/orphan-missing','orphan task','other','P2','sophcode')`).run();
  db.exec(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'claude',
    provider_session_id TEXT, project_path TEXT NOT NULL DEFAULT '',
    custom_name TEXT, summary TEXT, created_at TEXT, updated_at TEXT
  )`);
  db.prepare(`INSERT INTO sessions (session_id, provider, provider_session_id) VALUES ('s1','sophcode','op-id-1')`).run();
  return db;
};

test('migration renames sophcode rows and accepts opencode/qoder executor engines', () => {
  const db = seedLegacyDb();
  // FK enforcement ON before the migration (mirrors prod); the orphan row below
  // genuinely reproduces the failure the rebuild gates' FK toggling must avoid.
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  runMigrations(db);

  const session = db.prepare(`SELECT provider FROM sessions WHERE session_id='s1'`).get() as { provider: string };
  assert.equal(session.provider, 'opencode');

  const task = db.prepare(`SELECT executor_provider, source_schedule_id FROM tasks WHERE task_id='t1'`).get() as { executor_provider: string; source_schedule_id: string | null };
  assert.equal(task.executor_provider, 'opencode');
  // source_schedule_id (a column the legacy table already had) must survive the
  // rename→recreate→copy rebuilds unchanged, not be silently NULLed.
  assert.equal(task.source_schedule_id, 'sch-1');

  // The orphan FK row survives every rebuild with its project_path intact.
  const orphan = db.prepare(`SELECT executor_provider, project_path FROM tasks WHERE task_id='t-orphan'`).get() as { executor_provider: string; project_path: string };
  assert.equal(orphan.executor_provider, 'opencode');
  assert.equal(orphan.project_path, '/tmp/orphan-missing');

  // FK enforcement restored after the migration completes.
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  // CHECK now accepts opencode and qoder; rejects nothing it used to reject
  db.prepare(`INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES ('t2','/tmp/legacy-repo','t2','qoder')`).run();
  db.prepare(`INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES ('t3','/tmp/legacy-repo','t3','opencode')`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES ('t4','/tmp/legacy-repo','t4','bogus')`).run(),
    /CHECK/i
  );
});

test('migration is idempotent on a fresh db', () => {
  const db = new Database(':memory:');
  createUsersBase(db);
  runMigrations(db);
  runMigrations(db);

  // SQLite normalizes the stored DDL: it strips `IF NOT EXISTS` and the
  // trailing `;\n`, so the sqlite_master text is TASKS_TABLE_SCHEMA_SQL with
  // exactly those two edits.
  const expectedSql = TASKS_TABLE_SCHEMA_SQL
    .trimStart()
    .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE')
    .replace(/;\s*$/, '');
  assert.equal(
    (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as { sql: string }).sql,
    expectedSql,
  );

  // The rebuilt CHECK accepts opencode + qoder (and still rejects bogus ids).
  assert.match(resultsSql(db), /CHECK \(executor_provider IN \('claude','codex','opencode','qoder'\)\)/);
  db.prepare(`INSERT INTO projects (project_id, project_path) VALUES ('p-x','/p')`).run();
  db.prepare(`INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES ('x1','/p','t','qoder')`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO tasks (task_id, project_path, title, executor_provider) VALUES ('x2','/p','t','bogus')`).run(),
    /CHECK/i,
  );
});

const resultsSql = (db: Database.Database): string =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as { sql: string }).sql;
