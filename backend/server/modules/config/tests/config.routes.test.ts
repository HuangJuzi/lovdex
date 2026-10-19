import test, { type TestContext } from 'node:test';
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
function listen(t: TestContext, cfg: AppConfigApi) {
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

test('PUT with a profile selection applies the profile real key and lets body fields override', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({
    providers: { claude: { apiKey: 'sk-active-key-zzzzzz', baseUrl: 'https://active.example', defaultModel: 'active-model' } },
    providerProfiles: {
      claude: {
        p_a: {
          name: 'A',
          values: { apiKey: 'sk-profile-key-aaaaaa', baseUrl: 'https://profile.example', defaultModel: 'profile-model' },
        },
      },
    },
  });

  const { port } = listen(t, cfg);

  // 客户端把 GET 回来的打码 apiKey 原样打回来（含 ****，服务端会 strip 成 undefined），
  // 同时手改 defaultModel。
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providers: { claude: { apiKey: 'sk-active****zzzzzz', defaultModel: 'model-i-typed' } },
      activeProviderProfiles: { claude: 'p_a' },
    }),
  });
  assert.strictEqual(res.status, 200);

  const claude = cfg.get().providers.claude;
  assert.strictEqual(claude.apiKey, 'sk-profile-key-aaaaaa'); // 档的真值勝出
  assert.strictEqual(claude.baseUrl, 'https://profile.example'); // body 没提 → 档值
  assert.strictEqual(claude.defaultModel, 'model-i-typed'); // body 显式给了 → body 勝出
  assert.strictEqual(cfg.get().activeProviderProfiles.claude, 'p_a');
});

test('PUT with an unknown profile id is a 404, not a silent no-op', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({ providers: { claude: { baseUrl: 'https://before.example' } } });

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providers: { claude: { baseUrl: 'https://after.example' } },
      activeProviderProfiles: { claude: 'p_nope' },
    }),
  });
  assert.strictEqual(res.status, 404);
  // 整个写被拒绝：连 baseUrl 都没落地
  assert.strictEqual(cfg.get().providers.claude.baseUrl, 'https://before.example');
});

test("PUT with an empty-string selection clears the marker ('' not null)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({
    providerProfiles: { claude: { p_a: { name: 'A', values: { baseUrl: 'https://a.example' } } } },
    activeProviderProfiles: { claude: 'p_a' },
  });

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeProviderProfiles: { claude: '' } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().activeProviderProfiles.claude, '');
});

test('PUT with a null selection keeps the existing marker (deepMerge treats null as absent)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.update({
    providerProfiles: { claude: { p_a: { name: 'A', values: {} } } },
    activeProviderProfiles: { claude: 'p_a' },
  });

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeProviderProfiles: { claude: null } }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(cfg.get().activeProviderProfiles.claude, 'p_a');
});

test('PUT accepts providers.dsh.customModels as a string array', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providers: { dsh: { customModels: ['deepseek-official|glm-5.3', '  ', 'x'] } },
    }),
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(cfg.get().providers.dsh.customModels, [
    'deepseek-official|glm-5.3', '  ', 'x',
  ]);
  // 数组必须整体替换而非逐元素合并：deepMerge 对数组是 override ?? base。
  const res2 = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { dsh: { customModels: [] } } }),
  });
  assert.strictEqual(res2.status, 200);
  assert.deepStrictEqual(cfg.get().providers.dsh.customModels, []);
});

test('PUT rejects providers.dsh.customModels that is not a string array', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-route-'));
  const cfg = createAppConfig({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { port } = listen(t, cfg);

  for (const bad of ['a|b', ['a|b', 42], { '0': 'a|b' }]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { dsh: { customModels: bad } } }),
    });
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  // 被拒绝的写不得落盘
  assert.deepStrictEqual(cfg.get().providers.dsh.customModels, []);
});
