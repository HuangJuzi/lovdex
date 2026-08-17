import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAppConfig } from '../config.js';
import type { AppConfigApi } from '../config.js';
import { buildConfigReadRouter, buildConfigWriteRouter } from '../config.routes.js';

/** Mounts read (GET, anonymous) + write (PUT, behind a fake auth) routers. */
function buildTestApp(cfg: AppConfigApi) {
  const app = express();
  app.use(express.json());
  app.use('/api/config', buildConfigReadRouter({ cfg }));
  // Fake JWT gate: sets req.user like the real authenticateToken would.
  app.use('/api/config', (req: express.Request & { user?: unknown }, _res, next) => {
    req.user = { id: 1, username: 'test' };
    next();
  });
  app.use('/api/config', buildConfigWriteRouter({ cfg }));
  return app;
}

test('GET /api/config returns masked secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ providers: { qoder: { personalAccessToken: 'super-secret-pat' } } });

  const app = buildTestApp(cfg);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };

  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  const body = (await res.json()) as { providers: { qoder: { personalAccessToken: string } } };
  assert.strictEqual(res.status, 200);
  assert.match(body.providers.qoder.personalAccessToken, /^••••/);
  assert.doesNotMatch(body.providers.qoder.personalAccessToken, /super-secret/);
  server.close();
});

test('PUT /api/config merges partial and persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });

  const app = buildTestApp(cfg);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server: { port: 4444 } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().server.port, 4444);
  assert.strictEqual(cfg.get().server.host, '0.0.0.0');
  server.close();
});

test('PUT treats masked placeholder values as unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ providers: { qoder: { personalAccessToken: 'real-token-value' } } });

  const app = buildTestApp(cfg);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };

  // Client re-sends the masked GET shape back; masked value must NOT overwrite.
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { qoder: { personalAccessToken: '••••value' } } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().providers.qoder.personalAccessToken, 'real-token-value');
  server.close();
});

test('PUT rejects invalid config shapes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });

  const app = buildTestApp(cfg);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '42', // non-object
  });
  assert.strictEqual(res.status, 400);
  server.close();
});