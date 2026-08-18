import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProjectWithRemote } from '../project-management.service.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function projectRow(overrides: Partial<ProjectRepositoryRow> = {}): ProjectRepositoryRow {
  return {
    project_id: 'p1',
    project_path: '/srv/app',
    custom_project_name: null,
    isStarred: 0,
    isArchived: 0,
    is_explicit: 1,
    ...overrides,
  };
}

test('happy path: stats remote, persists with hostId, returns created', async () => {
  const statCalls: { hostId: string; projectPath: string }[] = [];
  const persistCalls: { projectPath: string; customName: string | null; remoteHostId: string }[] = [];

  const result = await createProjectWithRemote(
    { projectPath: '/srv/app', remoteHostId: 'h1', customName: 'My App' },
    {
      statRemote: async (hostId, projectPath) => {
        statCalls.push({ hostId, projectPath });
        return { exists: true, isDirectory: true };
      },
      persist: (projectPath, customName, remoteHostId): CreateProjectPathResult => {
        persistCalls.push({ projectPath, customName, remoteHostId });
        return { outcome: 'created', project: projectRow({ custom_project_name: 'My App' }) };
      },
    },
  );

  assert.equal(result.outcome, 'created');
  assert.equal(statCalls.length, 1);
  assert.equal(statCalls[0].hostId, 'h1');
  assert.equal(statCalls[0].projectPath, '/srv/app');
  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0].projectPath, '/srv/app');
  assert.equal(persistCalls[0].customName, 'My App');
  assert.equal(persistCalls[0].remoteHostId, 'h1');
  assert.equal(result.project.displayName, 'My App');
});

test('remote path missing / not a directory -> REMOTE_PATH_NOT_DIRECTORY', async () => {
  await assert.rejects(
    () =>
      createProjectWithRemote(
        { projectPath: '/srv/app', remoteHostId: 'h1' },
        {
          statRemote: async () => ({ exists: true, isDirectory: false }),
          persist: () => {
            throw new Error('persist should not run');
          },
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'REMOTE_PATH_NOT_DIRECTORY');
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('non-existent remote path -> REMOTE_PATH_NOT_DIRECTORY', async () => {
  await assert.rejects(
    () =>
      createProjectWithRemote(
        { projectPath: '/srv/app', remoteHostId: 'h1' },
        {
          statRemote: async () => ({ exists: false, isDirectory: false }),
          persist: () => {
            throw new Error('persist should not run');
          },
        },
      ),
    (err: unknown) => err instanceof AppError && err.code === 'REMOTE_PATH_NOT_DIRECTORY',
  );
});

test('missing remoteHostId -> REMOTE_HOST_REQUIRED', async () => {
  await assert.rejects(
    () =>
      createProjectWithRemote(
        { projectPath: '/srv/app', remoteHostId: '' },
        {
          statRemote: async () => {
            throw new Error('statRemote should not run');
          },
          persist: () => {
            throw new Error('persist should not run');
          },
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'REMOTE_HOST_REQUIRED');
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('missing path -> PROJECT_PATH_REQUIRED', async () => {
  await assert.rejects(
    () =>
      createProjectWithRemote(
        { projectPath: '', remoteHostId: 'h1' },
        {
          statRemote: async () => ({ exists: true, isDirectory: true }),
          persist: () => {
            throw new Error('persist should not run');
          },
        },
      ),
    (err: unknown) => err instanceof AppError && err.code === 'PROJECT_PATH_REQUIRED',
  );
});

test('active conflict -> PROJECT_ALREADY_EXISTS 409', async () => {
  await assert.rejects(
    () =>
      createProjectWithRemote(
        { projectPath: '/srv/app', remoteHostId: 'h1' },
        {
          statRemote: async () => ({ exists: true, isDirectory: true }),
          persist: (): CreateProjectPathResult => ({ outcome: 'active_conflict', project: projectRow() }),
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'PROJECT_ALREADY_EXISTS');
      assert.equal(err.statusCode, 409);
      return true;
    },
  );
});
