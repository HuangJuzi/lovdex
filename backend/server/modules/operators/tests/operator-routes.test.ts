import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { buildOperatorRouter } from '@/modules/operators/operator.routes.js';

/**
 * Boots a fresh in-process Express app exposing only the operator settings
 * router on an ephemeral port. Mirrors the real mount at /api/operator/settings
 * but without the auth middleware so the HTTP contract can be tested in
 * isolation. Returns the base URL callers should `fetch` against.
 */
async function startOperatorSettingsServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use('/api/operator/settings', buildOperatorRouter());
  const server = app.listen(0);
  await new Promise((resolve) => {
    server.on('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function withIsolatedDatabase<T>(
  runTest: () => Promise<T>,
): Promise<T> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'operator-routes-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    return await runTest();
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

test('GET /api/operator/settings returns the default config', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startOperatorSettingsServer();
    try {
      const res = await fetch(`${baseUrl}/api/operator/settings`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.enabled, true);
      assert.equal(body.auto_verdict_enabled, true);
    } finally {
      await close();
    }
  });
});

test('PUT /api/operator/settings persists and a subsequent GET reads it back', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startOperatorSettingsServer();
    try {
      const putRes = await fetch(`${baseUrl}/api/operator/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto_verdict_enabled: false }),
      });
      assert.equal(putRes.status, 200);
      const putBody = (await putRes.json()) as Record<string, unknown>;
      assert.equal(putBody.auto_verdict_enabled, false);

      const getRes = await fetch(`${baseUrl}/api/operator/settings`);
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as Record<string, unknown>;
      assert.equal(getBody.auto_verdict_enabled, false);
    } finally {
      await close();
    }
  });
});
