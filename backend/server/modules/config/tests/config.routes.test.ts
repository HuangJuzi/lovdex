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

/** Binds an app on an ephemeral port; server close + tmp dir clean-up are
 * guaranteed even when assertions throw. `t.after` hooks also run on failure. */
function listen(t: ReturnType<typeof test>, cfg: AppConfigApi) {
  const app = buildTestApp(cfg);
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return { server, port };
}

test('GET /api/config returns masked secrets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({ providers: { qoder: { personalAccessToken: 'super-secret-pat' } } });

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  const body = (await res.json()) as { providers: { qoder: { personalAccessToken: string } } };
  assert.strictEqual(res.status, 200);
  assert.match(body.providers.qoder.personalAccessToken, /^••••/);
  assert.doesNotMatch(body.providers.qoder.personalAccessToken, /super-secret/);
});

test('PUT /api/config merges partial and persists', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server: { port: 4444 } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().server.port, 4444);
  assert.strictEqual(cfg.get().server.host, '0.0.0.0');
});

test('PUT treats masked placeholder values as unchanged', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({ providers: { qoder: { personalAccessToken: 'real-token-value' } } });

  const { port } = listen(t, cfg);

  // Client re-sends the masked GET shape back; masked value must NOT overwrite.
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { qoder: { personalAccessToken: '••••value' } } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().providers.qoder.personalAccessToken, 'real-token-value');
});

test('PUT treats masked apiKey (first6****last6) as unchanged', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({ providers: { claude: { apiKey: 'sk-ant-real-key-abcdef' } } });

  const { port } = listen(t, cfg);

  // GET returns first6****last6; re-sending it must NOT overwrite the real key.
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { claude: { apiKey: 'sk-ant****abcdef' } } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().providers.claude.apiKey, 'sk-ant-real-key-abcdef');
});

test('PUT rejects invalid config shapes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '42', // non-object
  });
  assert.strictEqual(res.status, 400);
});

test('PUT rejects JSON array body with the route guard', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { port } = listen(t, cfg);

  // A JSON array passes body-parser and reaches the handler, exercising the
  // route's own Array.isArray guard (a plain non-object like '42' is rejected
  // by body-parser before the route ever sees it).
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([1]),
  });
  assert.strictEqual(res.status, 400);
});
