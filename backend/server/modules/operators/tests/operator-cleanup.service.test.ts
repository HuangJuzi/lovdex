import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { cleanOperatorWorkspaceLegacySessions } from '@/modules/operators/operator-cleanup.service.js';

async function withTempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const previousWorkspace = process.env.LOVDEX_OPERATOR_WORKSPACE;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'op-clean-'));
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

test('cleanOperatorWorkspaceLegacySessions deletes only non-operator sessions in the workspace', async () => {
  await withTempWorkspace(async (workspace) => {
    // 工作区内：一个非 operator 残留（带 transcript 文件）+ 一个 operator 会话（保留）
    const orphanFile = path.join(workspace, 'orphan.jsonl');
    await writeFile(orphanFile, '{}');
    sessionsDb.createSession('orphan-provider-1', 'claude', workspace, 'Orphan', undefined, undefined, orphanFile);
    sessionsDb.createAppSession('keeper-1', 'claude', workspace, true);
    // 工作区外：一个普通会话（不受影响）
    sessionsDb.createAppSession('outside-1', 'claude', path.join(path.dirname(workspace), 'regular'), false);

    const result = await cleanOperatorWorkspaceLegacySessions();

    assert.deepEqual(result.sessionIds, ['orphan-provider-1']);
    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    assert.equal(sessionsDb.getSessionById('orphan-provider-1'), null);
    assert.equal(sessionsDb.getSessionById('keeper-1')?.is_operator, 1);
    assert.ok(sessionsDb.getSessionById('outside-1'));
    // transcript 文件也被删除
    await assert.rejects(stat(orphanFile));
  });
});
