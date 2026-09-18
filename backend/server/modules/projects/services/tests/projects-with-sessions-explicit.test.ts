import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
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

test('getProjectsWithSessions attaches remoteHostName for remote-bound projects and null for local', async () => {
  await withIsolatedDatabase(async (dir) => {
    const db = getConnection();
    db.prepare(
      'INSERT INTO remote_hosts (host_id, name, host, port, ssh_user, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('host-1', 'dev-box', '10.0.0.7', 22, 'root', 'online');

    const localPath = path.join(dir, 'local-proj');
    const remotePath = path.join(dir, 'remote-proj');
    projectsDb.createProjectPath(localPath, null, true);
    projectsDb.createProjectPath(remotePath, null, true, 'host-1');

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const local = projects.find((p) => p.fullPath === localPath);
    const remote = projects.find((p) => p.fullPath === remotePath);

    assert.equal(local?.remoteHostName, null);
    assert.equal(remote?.remoteHostName, 'dev-box');
  });
});

test('getProjectsWithSessions includes a requested non-explicit project via includePath', async () => {
  await withIsolatedDatabase(async (dir) => {
    const discovered = path.join(dir, 'discovered');
    const otherDiscovered = path.join(dir, 'other-discovered');
    projectsDb.createProjectPath(discovered);
    projectsDb.createProjectPath(otherDiscovered);
    projectsDb.createProjectPath(path.join(dir, 'explicit'), null, true);

    // Baseline: auto-discovered projects stay out of the payload.
    const before = await getProjectsWithSessions({ skipSynchronization: true });
    assert.ok(!before.some((p) => p.fullPath === discovered));

    // Naming it surfaces that one project — and only that one. This is what
    // makes a `?project=<path>` deep link resolve for a project the user never
    // added explicitly (e.g. the Tasks page jumping into its workspace).
    const after = await getProjectsWithSessions({ skipSynchronization: true, includePath: discovered });
    const paths = after.map((p) => p.fullPath);
    assert.ok(paths.includes(discovered));
    assert.ok(!paths.includes(otherDiscovered));
  });
});

test('getProjectsWithSessions ignores an includePath that matches no project', async () => {
  await withIsolatedDatabase(async (dir) => {
    projectsDb.createProjectPath(path.join(dir, 'explicit'), null, true);

    const projects = await getProjectsWithSessions({
      skipSynchronization: true,
      includePath: path.join(dir, 'not-registered'),
    });

    assert.equal(projects.length, 1);
    assert.equal(projects[0].fullPath, path.join(dir, 'explicit'));
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
