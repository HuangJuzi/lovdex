import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

// 当前生产 schema，唯独缺 4 个 context 新列（context_summary 已存在）。
// 所有 rebuild 门都不触发，唯一加列机制是末尾的 addColumnToTableIfNotExists(ALTER)。
const CURRENT_SHAPE_WITHOUT_CONTEXT_MODE_DDL = `
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
    context_summary   TEXT,
    source_schedule_id TEXT
);
`;

function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
}

test('context_mode/status/raw + source session columns added in place via ALTER', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ctx-mode-'));
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
  legacy.prepare(`INSERT INTO projects (project_id, project_path) VALUES (?, ?)`).run('p1', '/tmp/example-repo');
  legacy.exec(CURRENT_SHAPE_WITHOUT_CONTEXT_MODE_DDL);
  legacy.prepare(`INSERT INTO tasks (task_id, project_path, title) VALUES (?, ?, ?)`).run('t1', '/tmp/example-repo', 'task');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = columnNames(db);
    for (const col of ['context_source_session_id', 'context_mode', 'context_status', 'context_raw']) {
      assert.ok(cols.includes(col), `expected ${col} column to be added in place`);
    }
    assert.ok(
      cols.indexOf('source_schedule_id') < cols.indexOf('context_source_session_id'),
      'expected context columns appended after source_schedule_id (in-place ALTER)',
    );
    const row = db.prepare('SELECT context_mode, context_status, context_source_session_id, context_raw FROM tasks WHERE task_id = ?').get('t1') as {
      context_mode: string; context_status: string | null; context_source_session_id: string | null; context_raw: string | null;
    };
    assert.equal(row.context_mode, 'none');
    assert.equal(row.context_status, null);
    assert.equal(row.context_source_session_id, null);
    assert.equal(row.context_raw, null);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
