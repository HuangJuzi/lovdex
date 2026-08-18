import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { operatorAuditDb } from '@/modules/database/repositories/operator-audit.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'operator-audit-'));
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

test('audit insert + list round-trips allow and deny records', async () => {
  await withIsolatedDatabase(() => {
    operatorAuditDb.insert({
      caller: 'operator',
      tool: 'execute_skill',
      action: 'claw-agent-get-send:groups',
      target: 'groups --json',
      decision: 'allow',
      reason: null,
      durationMs: 123,
      exitCode: 0,
      resultSummary: 'redacted summary',
    });
    operatorAuditDb.insert({
      caller: 'operator',
      tool: 'workbench',
      action: 'copy',
      target: '/home/a -> /other-project/b',
      decision: 'deny',
      reason: 'copy destination outside allowed write prefixes: /other-project/b',
      durationMs: 3,
      exitCode: null,
      resultSummary: null,
    });

    const all = operatorAuditDb.list();
    assert.equal(all.length, 2);
    // Newest first: the deny record comes back first.
    assert.equal(all[0].decision, 'deny');
    assert.equal(all[0].tool, 'workbench');
    assert.equal(all[0].exitCode, null);
    assert.equal(all[1].decision, 'allow');
    assert.equal(all[1].durationMs, 123);

    const denied = operatorAuditDb.list({ decision: 'deny' });
    assert.equal(denied.length, 1);
    const skillOnly = operatorAuditDb.list({ tool: 'execute_skill' });
    assert.equal(skillOnly.length, 1);
    assert.equal(skillOnly[0].action, 'claw-agent-get-send:groups');
  });
});

test('audit rows never store raw credential material (caller contract + clip)', async () => {
  await withIsolatedDatabase(() => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1OTk5In0.dummy';
    // Simulate a caller that followed the contract: summary pre-sanitized.
    operatorAuditDb.insert({
      caller: 'operator',
      tool: 'execute_skill',
      action: 'claw-agent-get-send:groups',
      target: 'groups',
      decision: 'allow',
      reason: null,
      durationMs: 1,
      exitCode: 0,
      resultSummary: 'eyJ***REDACTED***',
    });
    const rows = operatorAuditDb.list();
    assert.ok(!JSON.stringify(rows).includes(jwt));
    assert.ok(rows[0].resultSummary!.includes('***REDACTED***'));
  });
});
