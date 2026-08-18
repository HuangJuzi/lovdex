import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-db-remote-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('create-as-remote writes remote_host_id and is recoverable via listPathsWithRemoteHost', async () => {
  await withIsolatedDatabase(() => {
    const created = projectsDb.createProjectPath('/r/one', 'App One', true, 'h1');
    assert.equal(created.outcome, 'created');

    assert.deepEqual(projectsDb.listPathsWithRemoteHost(), [{ project_path: '/r/one', remote_host_id: 'h1' }]);
  });
});

test('remote create over an archived row rebinds to the new host', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/r/rebind', null, true, 'h1');
    projectsDb.updateProjectIsArchived('/r/rebind', true);

    // an archived remote row is not part of the live host→path index
    assert.deepEqual(projectsDb.listPathsWithRemoteHost(), []);

    const rebound = projectsDb.createProjectPath('/r/rebind', null, true, 'h2');
    assert.equal(rebound.outcome, 'reactivated_archived');
    assert.deepEqual(projectsDb.listPathsWithRemoteHost(), [{ project_path: '/r/rebind', remote_host_id: 'h2' }]);
  });
});

test('local create over an archived remote row clears the stale remote binding', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/r/clear', null, true, 'h1');
    projectsDb.updateProjectIsArchived('/r/clear', true);

    // an explicit local create (isExplicit=1, no remoteHostId) must un-hijack
    // the archived remote row: kept reactivated but with remote_host_id cleared
    const reused = projectsDb.createProjectPath('/r/clear', 'Local Name', true);
    assert.equal(reused.outcome, 'reactivated_archived');
    assert.deepEqual(projectsDb.listPathsWithRemoteHost(), []);
  });
});

test('remote create must not hijack an active auto-discovered local row', async () => {
  await withIsolatedDatabase(() => {
    const discovered = projectsDb.createProjectPath('/r/discovered');
    assert.equal(discovered.project?.is_explicit, 0);

    const conflict = projectsDb.createProjectPath('/r/discovered', null, true, 'h1');
    assert.equal(conflict.outcome, 'active_conflict');
    // the active local row must not have been stamped with a remote binding
    assert.deepEqual(projectsDb.listPathsWithRemoteHost(), []);
  });
});

test('listPathsWithRemoteHost excludes non-remote and archived rows', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/r/remote', 'Remote', true, 'h1');
    projectsDb.createProjectPath('/local/one', 'Local'); // discovered local, no remote binding
    projectsDb.createProjectPath('/local/two', 'Local 2', true); // explicit local
    projectsDb.createProjectPath('/r/archived', 'Arch', true, 'h2');
    projectsDb.updateProjectIsArchived('/r/archived', true);

    assert.deepEqual(projectsDb.listPathsWithRemoteHost(), [{ project_path: '/r/remote', remote_host_id: 'h1' }]);
  });
});