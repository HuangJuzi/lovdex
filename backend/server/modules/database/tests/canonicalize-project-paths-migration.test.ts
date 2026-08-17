import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { canonicalizeProjectPathsMigration } from '@/modules/database/migrations.js';

async function withIsolatedDatabase(runTest: (dir: string, real: string, link: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'canon-migrate-'));
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  await mkdir(real, { recursive: true });
  await symlink(real, link);
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir, real, link);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('merges symlink-path project into its real-path duplicate', async () => {
  await withIsolatedDatabase(async (_dir, real, link) => {
    const db = getConnection();

    // Raw inserts bypass the repo's canonicalization to simulate legacy data.
    db.prepare(
      "INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit) VALUES ('symlink-id', ?, 'symlink-name', 1, 0, 1)"
    ).run(link);
    db.prepare(
      "INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit) VALUES ('real-id', ?, NULL, 0, 0, 0)"
    ).run(real);
    db.prepare(
      "INSERT INTO sessions (session_id, provider, project_path) VALUES ('sess-1', 'claude', ?)"
    ).run(link);

    canonicalizeProjectPathsMigration(db);

    const projects = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown>>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project_id, 'real-id');
    assert.equal(projects[0].project_path, real);
    assert.equal(projects[0].custom_project_name, 'symlink-name');
    assert.equal(projects[0].isStarred, 1);
    assert.equal(projects[0].is_explicit, 1);

    const session = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get('sess-1') as { project_path: string };
    assert.equal(session.project_path, real);
  });
});

test('renames in place when no real-path duplicate exists', async () => {
  await withIsolatedDatabase(async (_dir, real, link) => {
    const db = getConnection();
    db.prepare(
      "INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit) VALUES ('only-id', ?, NULL, 0, 0, 1)"
    ).run(link);
    db.prepare(
      "INSERT INTO sessions (session_id, provider, project_path) VALUES ('sess-2', 'claude', ?)"
    ).run(link);

    canonicalizeProjectPathsMigration(db);

    const projects = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown>>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project_path, real);

    const session = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get('sess-2') as { project_path: string };
    assert.equal(session.project_path, real);
  });
});
