import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  DEFAULT_OPERATOR_CONFIG,
  getOperatorConfig,
  setOperatorConfig,
} from '@/modules/operators/operator.config.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'operator-config-'));
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

test('default config has safe automation defaults', () => {
  const c = DEFAULT_OPERATOR_CONFIG;
  assert.equal(c.enabled, true);
  assert.equal(c.auto_verdict_enabled, true);
  assert.equal(c.interactive_chat_enabled, true);
  assert.equal(c.max_concurrent, 2);
});

test('getOperatorConfig returns defaults when nothing stored', async () => {
  await withIsolatedDatabase(() => {
    const c = getOperatorConfig();
    assert.deepEqual(c, DEFAULT_OPERATOR_CONFIG);
  });
});

test('setOperatorConfig persists and getOperatorConfig reads back', async () => {
  await withIsolatedDatabase(() => {
    setOperatorConfig({ auto_verdict_enabled: false });
    const c = getOperatorConfig();
    assert.equal(c.auto_verdict_enabled, false);
  });
});
