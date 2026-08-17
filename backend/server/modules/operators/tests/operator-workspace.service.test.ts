import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { isOperatorWorkspacePath } from '@/modules/operators/operator-workspace.service.js';

async function withTempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const previousWorkspace = process.env.LOVDEX_OPERATOR_WORKSPACE;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'op-ws-'));
  const workspace = path.join(dir, 'operator-workspace');
  await mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.LOVDEX_OPERATOR_WORKSPACE = workspace;
  await initializeDatabase();

  try {
    await run(workspace);
  } finally {
    closeConnection();
    if (previousWorkspace === undefined) delete process.env.LOVDEX_OPERATOR_WORKSPACE;
    else process.env.LOVDEX_OPERATOR_WORKSPACE = previousWorkspace;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('isOperatorWorkspacePath matches the configured workspace and rejects a sibling path', async () => {
  await withTempWorkspace(async (workspace) => {
    assert.equal(await isOperatorWorkspacePath(workspace), true);
    assert.equal(await isOperatorWorkspacePath(path.join(path.dirname(workspace), 'other')), false);
  });
});

test('isOperatorWorkspacePath returns false for empty or unset paths', async () => {
  await withTempWorkspace(async () => {
    assert.equal(await isOperatorWorkspacePath(''), false);
    assert.equal(await isOperatorWorkspacePath('/definitely/not/exists'), false);
  });
});
