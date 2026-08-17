import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import {
  getArchivedProjectsWithSessions,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: (dir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'projects-explicit-'));
  const explicitDir = path.join(dir, 'explicit');
  const discoveredDir = path.join(dir, 'discovered');
  await mkdir(explicitDir, { recursive: true });
  await mkdir(discoveredDir, { recursive: true });
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

test('getProjectsWithSessions only returns explicit projects', async () => {
  await withIsolatedDatabase(async (dir) => {
    projectsDb.createProjectPath(path.join(dir, 'explicit'), null, true);
    projectsDb.createProjectPath(path.join(dir, 'discovered'));

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const paths = projects.map((p) => p.fullPath);
    assert.ok(paths.includes(path.join(dir, 'explicit')));
    assert.ok(!paths.includes(path.join(dir, 'discovered')));
  });
});

test('getArchivedProjectsWithSessions only returns explicit projects', async () => {
  await withIsolatedDatabase(async (dir) => {
    projectsDb.createProjectPath(path.join(dir, 'explicit-archived'), null, true);
    projectsDb.createProjectPath(path.join(dir, 'discovered-archived'));
    projectsDb.updateProjectIsArchivedById(
      projectsDb.getProjectPath(path.join(dir, 'explicit-archived'))!.project_id,
      true,
    );
    projectsDb.updateProjectIsArchivedById(
      projectsDb.getProjectPath(path.join(dir, 'discovered-archived'))!.project_id,
      true,
    );

    const archived = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    const paths = archived.map((p) => p.fullPath);
    assert.ok(paths.includes(path.join(dir, 'explicit-archived')));
    assert.ok(!paths.includes(path.join(dir, 'discovered-archived')));
  });
});
