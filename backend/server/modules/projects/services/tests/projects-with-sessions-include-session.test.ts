import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: (dir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'projects-include-session-'));
  const projectDir = path.join(dir, 'proj');
  const otherDir = path.join(dir, 'other');
  await mkdir(projectDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('includeSessionId surfaces the owning project even when it is non-explicit and the session is old', async () => {
  await withIsolatedDatabase(async (dir) => {
    const projectDir = path.join(dir, 'proj');
    const otherDir = path.join(dir, 'other');
    // `proj` is auto-discovered (non-explicit) — normally dropped from the
    // payload; `other` is explicit so it survives either way.
    projectsDb.createProjectPath(projectDir);
    projectsDb.createProjectPath(otherDir, null, true);

    // 25 sessions in `proj`, newest first ordering. The deep-linked session is
    // the OLDEST — far outside the default top-20 page.
    const oldDate = '2026-01-01 00:00:00';
    const newDate = '2026-10-12 00:00:00';
    const targetSessionId = sessionsDb.createSession(
      'provider-target', 'claude', projectDir, 'target', oldDate, oldDate, null, 'target summary'
    );
    for (let i = 0; i < 25; i += 1) {
      sessionsDb.createSession(
        `provider-${i}`, 'claude', projectDir, `recent-${i}`, newDate, newDate, null, `recent ${i}`
      );
    }
    sessionsDb.createSession('provider-other', 'claude', otherDir, 'other', newDate, newDate, null, 'other');

    const projects = await getProjectsWithSessions({ skipSynchronization: true, includeSessionId: targetSessionId });

    const paths = projects.map((p) => p.fullPath);
    assert.ok(paths.includes(projectDir), 'non-explicit owning project must be surfaced');
    assert.ok(paths.includes(otherDir), 'explicit projects unaffected');

    const project = projects.find((p) => p.fullPath === projectDir)!;
    const ids = project.sessions.map((s) => s.id);
    assert.ok(
      ids.includes(targetSessionId),
      'deep-linked session must be present even outside the newest-first top-20'
    );
    assert.equal(ids[0], targetSessionId, 'deep-linked session is prepended to the page');
    assert.equal(project.sessionMeta.total, 26, 'total still counts every session');
  });
});

test('includeSessionId with an unknown or archived session behaves like no parameter', async () => {
  await withIsolatedDatabase(async (dir) => {
    const projectDir = path.join(dir, 'proj');
    projectsDb.createProjectPath(projectDir);
    const sessionId = sessionsDb.createSession(
      'provider-x', 'claude', projectDir, 'x', '2026-10-12 00:00:00', '2026-10-12 00:00:00', null, 'x'
    );
    getConnection().prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?').run(sessionId);

    const unknown = await getProjectsWithSessions({ skipSynchronization: true, includeSessionId: 'no-such-session' });
    assert.ok(!unknown.some((p) => p.fullPath === projectDir), 'unknown session surfaces nothing');

    const archived = await getProjectsWithSessions({ skipSynchronization: true, includeSessionId: sessionId });
    assert.ok(
      !archived.some((p) => p.fullPath === projectDir),
      'archived session is ignored (never belongs in the live sidebar)'
    );
  });
});

test('includeSessionId does not duplicate a session already inside the page', async () => {
  await withIsolatedDatabase(async (dir) => {
    const projectDir = path.join(dir, 'proj');
    projectsDb.createProjectPath(projectDir, null, true);
    const newDate = '2026-10-12 00:00:00';
    const targetSessionId = sessionsDb.createSession(
      'provider-newest', 'claude', projectDir, 'newest', newDate, newDate, null, 'newest summary'
    );

    const projects = await getProjectsWithSessions({ skipSynchronization: true, includeSessionId: targetSessionId });
    const project = projects.find((p) => p.fullPath === projectDir)!;
    const occurrences = project.sessions.filter((s) => s.id === targetSessionId).length;
    assert.equal(occurrences, 1, 'no duplicate row when the session is already in the page');
  });
});
