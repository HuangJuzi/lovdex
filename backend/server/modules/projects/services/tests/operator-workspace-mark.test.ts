import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withTempWorkspace(run: (workspace: string, regular: string) => Promise<void>): Promise<void> {
  const previousWorkspace = process.env.LOVDEX_OPERATOR_WORKSPACE;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'op-mark-'));
  const workspace = path.join(dir, 'operator-workspace');
  const regular = path.join(dir, 'regular-project');
  await mkdir(workspace, { recursive: true });
  await mkdir(regular, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.LOVDEX_OPERATOR_WORKSPACE = workspace;
  await initializeDatabase();

  try {
    await run(workspace, regular);
  } finally {
    closeConnection();
    if (previousWorkspace === undefined) delete process.env.LOVDEX_OPERATOR_WORKSPACE;
    else process.env.LOVDEX_OPERATOR_WORKSPACE = previousWorkspace;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('getProjectsWithSessions marks the operator workspace project', async () => {
  await withTempWorkspace(async (workspace, regular) => {
    projectsDb.createProjectPath(workspace, null, true);
    projectsDb.createProjectPath(regular, null, true);

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const byPath = new Map(projects.map((p) => [p.fullPath, p]));

    assert.equal(byPath.get(workspace)?.isOperatorWorkspace, true);
    assert.equal(byPath.get(regular)?.isOperatorWorkspace, false);
  });
});

test('non-explicit operator workspace is still listed and carries task sessions', async () => {
  await withTempWorkspace(async (workspace, regular) => {
    // Auto-registered rows (disk scan / session creation) are not explicit, yet
    // the workspace must stay resolvable: /session/:id opens from the task
    // board/detail resolve the owning project through this payload, and the
    // task execution sessions are non-operator rows inside the workspace.
    projectsDb.createProjectPath(workspace);
    projectsDb.createProjectPath(regular);

    sessionsDb.createAppSession('ws-assistant', 'claude', workspace, true);
    sessionsDb.createAppSession('ws-task', 'claude', workspace, false);
    sessionsDb.createAppSession('regular-1', 'claude', regular, false);

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const byPath = new Map(projects.map((p) => [p.fullPath, p]));

    assert.ok(byPath.has(workspace), 'operator workspace appears despite is_explicit = 0');
    assert.ok(!byPath.has(regular), 'non-workspace non-explicit project stays hidden');

    const sessionIds = (byPath.get(workspace)?.sessions ?? []).map((s) => s.id).sort();
    assert.deepEqual(sessionIds, ['ws-assistant', 'ws-task']);
  });
});