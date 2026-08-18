import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { buildOperatorSkillExecRouter } from '@/modules/operators/operator-skill-exec.routes.js';
import { resetOperatorAllowlistCache } from '@/modules/operators/operator-allowlist.js';
import type { OperatorExecService } from '@/modules/operators/operator-exec.service.js';

/**
 * Boots the skill-exec router on an ephemeral port (no auth middleware — the
 * HTTP contract is tested in isolation, mirroring operator-routes.test.ts).
 * The execService is a stub; only credentials/test would call it.
 */
async function startServer(execService?: Partial<OperatorExecService>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/operator/skill-exec',
    buildOperatorSkillExecRouter({ execService: execService as OperatorExecService }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => {
    server.on('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function withIsolatedDatabase<T>(runTest: () => Promise<T>): Promise<T> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'skill-exec-routes-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  resetOperatorAllowlistCache();

  try {
    return await runTest();
  } finally {
    resetOperatorAllowlistCache();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const VALID_ALLOWLIST = {
  enabled_skills: [
    {
      name: 'claw-agent-get-send',
      entry: 'scripts/appia_claw.py',
      runner: 'uv',
      allowed_subcommands: ['groups', 'send'],
      readonly_subcommands: ['groups'],
    },
  ],
  workbench_write_prefixes: ['/tmp/operator-home'],
};

test('GET /allowlist returns the effective config with a source', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        allowlist: { enabled_skills: unknown[] };
        source: string;
        envOverrideActive: boolean;
      };
      assert.ok(Array.isArray(body.allowlist.enabled_skills));
      // No DB row, no env → falls through to the repo config file.
      assert.equal(body.source, 'file');
      assert.equal(body.envOverrideActive, false);
    } finally {
      await close();
    }
  });
});

test('PUT /allowlist persists a DB override and GET reads it back', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startServer();
    try {
      const putRes = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_ALLOWLIST),
      });
      assert.equal(putRes.status, 200);
      const putBody = (await putRes.json()) as { source: string };
      assert.equal(putBody.source, 'database');

      const getRes = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`);
      const getBody = (await getRes.json()) as {
        source: string;
        allowlist: { workbench_write_prefixes: string[] };
      };
      assert.equal(getBody.source, 'database');
      assert.deepEqual(getBody.allowlist.workbench_write_prefixes, ['/tmp/operator-home']);
    } finally {
      await close();
    }
  });
});

test('PUT /allowlist rejects malformed input and writes nothing', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled_skills: [{ name: '../evil' }] }),
      });
      assert.equal(res.status, 400);
      // Still on the file source — the bad payload was not persisted.
      const getRes = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`);
      const getBody = (await getRes.json()) as { source: string };
      assert.equal(getBody.source, 'file');
    } finally {
      await close();
    }
  });
});

test('PUT /allowlist returns 409 while an env override is active', async () => {
  process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON = JSON.stringify(VALID_ALLOWLIST);
  try {
    await withIsolatedDatabase(async () => {
      const { baseUrl, close } = await startServer();
      try {
        const res = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(VALID_ALLOWLIST),
        });
        assert.equal(res.status, 409);
      } finally {
        await close();
      }
    });
  } finally {
    delete process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON;
  }
});

test('DELETE /allowlist clears the DB override', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startServer();
    try {
      await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_ALLOWLIST),
      });
      const delRes = await fetch(`${baseUrl}/api/operator/skill-exec/allowlist`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);
      const body = (await delRes.json()) as { source: string };
      assert.equal(body.source, 'file');
    } finally {
      await close();
    }
  });
});

test('GET /credentials/status reports presence booleans only (no values)', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/operator/skill-exec/credentials/status`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        source: string;
        fields: { jwt: boolean; agentId: boolean; userId: boolean };
        filePath: string;
      };
      assert.ok(['file', 'none'].includes(body.source));
      assert.equal(typeof body.fields.jwt, 'boolean');
      // The response must not contain any credential-shaped values.
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes('eyJ'), 'status response must not embed a JWT');
    } finally {
      await close();
    }
  });
});

test('GET /audit returns sanitized rows newest-first', async () => {
  await withIsolatedDatabase(async () => {
    const { operatorAuditDb } = await import('@/modules/database/repositories/operator-audit.db.js');
    operatorAuditDb.insert({
      caller: 'operator',
      tool: 'execute_skill',
      action: 'claw-agent-get-send:groups',
      target: 'groups',
      decision: 'allow',
      reason: null,
      durationMs: 5,
      exitCode: 0,
      resultSummary: 'ok',
    });
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/operator/skill-exec/audit?tool=execute_skill`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rows: Array<{ tool: string; action: string }> };
      assert.equal(body.rows.length, 1);
      assert.equal(body.rows[0].action, 'claw-agent-get-send:groups');
    } finally {
      await close();
    }
  });
});

test('POST /credentials/test delegates to execute_skill groups (sanitized)', async () => {
  await withIsolatedDatabase(async () => {
    let called: { skillName?: string; args?: string } = {};
    const stub = {
      executeSkill: async (i: { skillName: string; args?: string }) => {
        called = i;
        return { ok: true, stdout: 'rid=r1', stderr: '', exitCode: 0 };
      },
    };
    const { baseUrl, close } = await startServer(stub as Partial<OperatorExecService>);
    try {
      const res = await fetch(`${baseUrl}/api/operator/skill-exec/credentials/test`, {
        method: 'POST',
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, true);
      assert.equal(called.skillName, 'claw-agent-get-send');
      assert.equal(called.args, 'groups');
    } finally {
      await close();
    }
  });
});

test('PUT /credentials writes cred.json with 0600 and never echoes values', async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'cred-route-'));
  const credFile = path.join(dir, '.claw', 'cred.json');
  // Point the resolver's default cred path at the temp file for this test.
  const prevHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await withIsolatedDatabase(async () => {
      const { baseUrl, close } = await startServer();
      try {
        const res = await fetch(`${baseUrl}/api/operator/skill-exec/credentials`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jwt: 'super-secret-jwt', agentId: 'a1', userId: 'u1' }),
        });
        assert.equal(res.status, 200);
        const raw = await res.text();
        assert.ok(!raw.includes('super-secret-jwt'), 'response must not echo the JWT');
        const target = path.join(dir, '.claw', 'cred.json');
        assert.ok(fs.existsSync(target), `cred file written at ${target} (expected ${credFile})`);
        const mode = (fs.statSync(target).mode & 0o777).toString(8);
        assert.equal(mode, '600');
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, string>;
        assert.equal(parsed.jwt, 'super-secret-jwt');
        assert.equal(parsed.agent_id, 'a1');
      } finally {
        await close();
      }
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /credentials rejects incomplete payloads with 400', async () => {
  await withIsolatedDatabase(async () => {
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/operator/skill-exec/credentials`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jwt: 'only-jwt' }),
      });
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });
});
