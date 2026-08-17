import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';

// runMigrations ALTERs `users` and assumes every other base table can be
// created by itself via CREATE TABLE IF NOT EXISTS, so the only table that must
// pre-exist is `users` (same pattern as provider-rename-migration.test.ts).
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

// Minimal mirror of SCHEDULED_TASKS_TABLE_SCHEMA_SQL: the rename migration only
// updates scheduled_tasks.executor_provider, so only that column (plus a
// minimal PK to satisfy the schema) is needed to exercise it.
const createMinimalScheduledTasks = (db: Database.Database): void => {
  db.exec(`CREATE TABLE scheduled_tasks (
    schedule_id       TEXT PRIMARY KEY NOT NULL,
    title             TEXT NOT NULL,
    executor_provider TEXT NOT NULL DEFAULT 'claude'
  )`);
};

test('migration renames scheduled_tasks executor_provider sophcode → opencode (idempotent)', () => {
  const db = new Database(':memory:');
  createUsersBase(db);
  createMinimalScheduledTasks(db);
  db.prepare(`INSERT INTO scheduled_tasks (schedule_id, title, executor_provider) VALUES ('sch-1','daily','sophcode')`).run();
  db.prepare(`INSERT INTO scheduled_tasks (schedule_id, title, executor_provider) VALUES ('sch-2','hourly','claude')`).run();

  runMigrations(db);

  // sophcode row renamed; claude row untouched.
  let rows = db
    .prepare(`SELECT schedule_id, executor_provider FROM scheduled_tasks ORDER BY schedule_id`)
    .all() as { schedule_id: string; executor_provider: string }[];
  assert.deepEqual(rows, [
    { schedule_id: 'sch-1', executor_provider: 'opencode' },
    { schedule_id: 'sch-2', executor_provider: 'claude' },
  ]);

  // Idempotent: a second run leaves the renamed rows stable.
  runMigrations(db);
  rows = db
    .prepare(`SELECT schedule_id, executor_provider FROM scheduled_tasks ORDER BY schedule_id`)
    .all() as { schedule_id: string; executor_provider: string }[];
  assert.deepEqual(rows, [
    { schedule_id: 'sch-1', executor_provider: 'opencode' },
    { schedule_id: 'sch-2', executor_provider: 'claude' },
  ]);
});

test('scheduled_tasks rename is a no-op when the table is absent (fresh db)', () => {
  const db = new Database(':memory:');
  createUsersBase(db);

  runMigrations(db);

  // runMigrations never creates scheduled_tasks itself (it lives in the
  // combined schema only), so a fresh db has no such table and the guarded
  // migration must no-op without error.
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'`)
    .get();
  assert.equal(exists, undefined);
});