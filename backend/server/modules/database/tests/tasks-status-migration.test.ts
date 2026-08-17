import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'backlog'
                      CHECK (status IN ('backlog','todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    verdict          TEXT CHECK (verdict IS NULL OR verdict IN ('done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME
);
`;

test('migrateTasksTable rebuilds: backlog→todo, verdict→sub_status, drops verdict column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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
  legacy.exec(LEGACY_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  const ins = legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status, verdict, verdict_reason) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('t1', '/tmp/example-repo', 'backlogged', 'backlog', null, null);
  ins.run('t2', '/tmp/example-repo', 'judged-done', 'in_review', 'done', 'all good');
  ins.run('t3', '/tmp/example-repo', 'judged-blocked', 'in_review', 'blocked', 'broke');
  ins.run('t4', '/tmp/example-repo', 'plain-review', 'in_review', null, null);
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const rows = db.prepare('SELECT task_id, status, sub_status, verdict_reason FROM tasks ORDER BY task_id').all() as {
      task_id: string; status: string; sub_status: string | null; verdict_reason: string | null;
    }[];
    const byId = Object.fromEntries(rows.map((r) => [r.task_id, r]));

    assert.equal(byId['t1'].status, 'todo');            // backlog → todo
    assert.equal(byId['t1'].sub_status, null);
    assert.equal(byId['t2'].status, 'in_review');       // done 判定留评审列
    assert.equal(byId['t2'].sub_status, 'done');
    assert.equal(byId['t2'].verdict_reason, 'all good');
    assert.equal(byId['t3'].status, 'in_progress');     // 非 done 判定移回进行中
    assert.equal(byId['t3'].sub_status, 'blocked');
    assert.equal(byId['t3'].verdict_reason, 'broke');
    assert.equal(byId['t4'].status, 'in_review');       // 无判定留评审列
    assert.equal(byId['t4'].sub_status, null);

    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'sub_status'));
    assert.ok(!cols.some((c) => c.name === 'verdict')); // verdict 列已删
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

const INTERMEDIATE_TASKS_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    sub_status       TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME
);
`;

test('migrateTasksTable adds priority/deadline/is_operator/label/remark', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-cols-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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
  legacy.exec(LEGACY_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status) VALUES (?, ?, ?, ?)`).run('t1', '/tmp/example-repo', 'task', 'todo');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    for (const col of ['priority', 'deadline', 'is_operator', 'label', 'remark', 'source_schedule_id']) {
      assert.ok(cols.includes(col), `missing column ${col}`);
    }
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string };
    assert.match(row.sql, /CHECK \(priority IN \('P0','P1','P2','P3'\)\)/);
    assert.match(row.sql, /CHECK \(label IN \('bug','feature','optimization','refactor','docs','other','reminder'\)\)/);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('migrateTasksTable adds columns in-place on sub_status-present table (no rebuild)', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-intermediate-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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
  legacy.exec(INTERMEDIATE_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title, status) VALUES (?, ?, ?, ?)`).run('t1', '/tmp/example-repo', 'existing', 'todo');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();

    // All five columns present (added in place via ALTER TABLE ADD COLUMN)
    // plus source_schedule_id (present via the schema's current shape).
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    for (const col of ['priority', 'deadline', 'is_operator', 'label', 'remark', 'source_schedule_id']) {
      assert.ok(cols.includes(col), `missing column ${col}`);
    }
    // No rebuild happened: the table keeps its inline sub_status shape (no standalone verdict column added back)
    const rowSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    assert.match(rowSql, /sub_status/);

    // Pre-existing row backfilled with column defaults
    const existing = db.prepare('SELECT priority, deadline, is_operator, label, remark FROM tasks WHERE task_id = ?').get('t1') as {
      priority: string; deadline: string | null; is_operator: number; label: string; remark: string | null;
    };
    assert.equal(existing.priority, 'P2');
    assert.equal(existing.is_operator, 0);
    assert.equal(existing.label, 'other');
    assert.equal(existing.deadline, null);
    assert.equal(existing.remark, null);

    // CHECK constraints are enforced on new writes (even via ADD COLUMN)
    assert.throws(
      () => db.prepare(`INSERT INTO tasks (task_id, project_path, title, priority) VALUES (?, ?, ?, ?)`).run('t-bad-p', '/tmp/example-repo', 'bad', 'P9'),
      /CHECK/i,
    );
    assert.throws(
      () => db.prepare(`INSERT INTO tasks (task_id, project_path, title, label) VALUES (?, ?, ?, ?)`).run('t-bad-l', '/tmp/example-repo', 'bad', 'nope'),
      /CHECK/i,
    );

    // Full-field insert round-trips
    db.prepare(`INSERT INTO tasks (task_id, project_path, title, status, priority, deadline, is_operator, label, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t-full', '/tmp/example-repo', 'full', 'todo', 'P0', '2026-08-31', 1, 'feature', 'needs attention');
    const full = db.prepare('SELECT priority, deadline, is_operator, label, remark FROM tasks WHERE task_id = ?').get('t-full') as {
      priority: string; deadline: string; is_operator: number; label: string; remark: string;
    };
    assert.equal(full.priority, 'P0');
    assert.equal(full.deadline, '2026-08-31');
    assert.equal(full.is_operator, 1);
    assert.equal(full.label, 'feature');
    assert.equal(full.remark, 'needs attention');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('fresh install creates tasks table with sub_status and no verdict column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-fresh-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'sub_status'));
    assert.ok(cols.some((c) => c.name === 'source_schedule_id'));
    assert.ok(!cols.some((c) => c.name === 'verdict'), 'verdict column must not exist on fresh installs');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// Sophcode-era shape: sub_status present, 'sophcode' in the executor CHECK, no
// source_schedule_id column, label CHECK still the OLD 6-value list (no
// 'reminder'), and the sub_status CHECK without waiting_answer / waiting_plan.
// This DDL trips ONLY the opencode provider rebuild: the executor gate fires
// because 'opencode' is absent from the CHECK, renaming sophcode → opencode
// inside its INSERT...SELECT. That rebuild re-creates tasks from the current
// TASKS_TABLE_SCHEMA_SQL (which already carries 'waiting_answer' and
// 'reminder'), so the waiting_*/reminder CHECKs ride along with the new DDL and
// the down-chain waiting/label gates re-fetch it → no-ops. The row assertions
// below confirm every column, including executor_provider mutated to
// 'opencode', survives the rename→recreate→copy chain.
const SOPHCODE_ERA_TASKS_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','in_review','done')),
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex','sophcode')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary       TEXT,
    sub_status       TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked')),
    verdict_reason   TEXT,
    verdict_at       DATETIME,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other')),
    remark            TEXT
);
`;

test('migrateTasksTable rebuilds label CHECK to include reminder and adds source_schedule_id (idempotent)', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrate-tasks-reminder-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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
  legacy.exec(SOPHCODE_ERA_TASKS_DDL);
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.prepare(`
    INSERT INTO tasks (
      task_id, project_path, title, description, status, executor_provider, executor_model,
      position, session_id, started_at, completed_at, created_at, updated_at, ai_summary,
      sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    't-rem', '/tmp/example-repo', 'scheduled notice', 'a description', 'done', 'sophcode', 'soph-2',
    3, 'sess-rem', '2026-01-02 03:04:05', '2026-01-02 04:04:05', '2026-01-02 03:04:05', '2026-01-02 04:04:05', 'sum-text',
    'failed', 'because reasons', '2026-01-02 04:04:05', 'P1', '2026-12-31', 1, 'bug', 'note-remark',
  );
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();

    // source_schedule_id column added (via addColumn, then preserved by rebuild).
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('source_schedule_id'), 'missing source_schedule_id column');

    // The reminder rebuild fired: label CHECK now includes 'reminder'.
    const rowSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    assert.match(rowSql, /CHECK \(label IN \('bug','feature','optimization','refactor','docs','other','reminder'\)\)/);

    // Pre-existing row survived with every field intact.
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('t-rem') as Record<string, unknown>;
    assert.equal(row.title, 'scheduled notice');
    assert.equal(row.description, 'a description');
    assert.equal(row.status, 'done');
    assert.equal(row.executor_provider, 'opencode'); // sophcode renamed by the opencode provider migration
    assert.equal(row.executor_model, 'soph-2');
    assert.equal(row.position, 3);
    assert.equal(row.session_id, 'sess-rem');
    assert.equal(row.started_at, '2026-01-02 03:04:05');
    assert.equal(row.completed_at, '2026-01-02 04:04:05');
    assert.equal(row.created_at, '2026-01-02 03:04:05');
    assert.equal(row.updated_at, '2026-01-02 04:04:05');
    assert.equal(row.ai_summary, 'sum-text');
    assert.equal(row.sub_status, 'failed');
    assert.equal(row.verdict_reason, 'because reasons');
    assert.equal(row.verdict_at, '2026-01-02 04:04:05');
    assert.equal(row.priority, 'P1');
    assert.equal(row.deadline, '2026-12-31');
    assert.equal(row.is_operator, 1);
    assert.equal(row.label, 'bug');
    assert.equal(row.remark, 'note-remark');
    assert.equal(row.source_schedule_id, null);

    // Idempotent: a second initializeDatabase() is clean and leaves the row intact.
    await initializeDatabase();
    const cols2 = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols2.includes('source_schedule_id'), 'missing source_schedule_id column on second run');
    const rowSql2 = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    assert.match(rowSql2, /CHECK \(label IN \('bug','feature','optimization','refactor','docs','other','reminder'\)\)/);
    const row2 = db.prepare('SELECT title, label, remark, is_operator, ai_summary FROM tasks WHERE task_id = ?').get('t-rem') as Record<string, unknown>;
    assert.equal(row2.title, 'scheduled notice');
    assert.equal(row2.label, 'bug');
    assert.equal(row2.remark, 'note-remark');
    assert.equal(row2.is_operator, 1);
    assert.equal(row2.ai_summary, 'sum-text');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
