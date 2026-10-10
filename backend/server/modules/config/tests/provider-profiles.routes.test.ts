import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAppConfig } from '../config.js';
import type { AppConfigApi } from '../config.js';
import { buildProviderProfilesRouter } from '../provider-profiles.js';

/** 把 profiles router 挂起来；鉴权在挂载点做（同 index.js），这里不重复。 */
function listen(t: ReturnType<typeof test>, cfg: AppConfigApi) {
  const app = express();
  app.use(express.json());
  app.use('/api/config', buildProviderProfilesRouter({ cfg }));
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return { port };
}

function freshCfg(t: ReturnType<typeof test>): AppConfigApi {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-ppr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createAppConfig({ dataDir: dir });
}

test('POST /provider-profiles snapshots the effective fields with the REAL key', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providers: {
      claude: { apiKey: 'sk-ant-real-key-abcdef', baseUrl: 'https://a.example', defaultModel: 'm1' },
    },
  });
  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', name: ' 主账号 ' }),
  });
  assert.strictEqual(res.status, 200);

  // 响应是 masked 配置：档名可见、key 打码
  const body = (await res.json()) as {
    providerProfiles: Record<string, Record<string, { name: string; values: Record<string, string> }>>;
  };
  const ids = Object.keys(body.providerProfiles.claude);
  assert.strictEqual(ids.length, 1);
  assert.strictEqual(body.providerProfiles.claude[ids[0]].name, '主账号'); // trim 过
  assert.strictEqual(body.providerProfiles.claude[ids[0]].values.apiKey, 'sk-ant****abcdef');

  // 落盘的是真值
  const stored = cfg.get().providerProfiles.claude[ids[0]];
  assert.strictEqual(stored.values.apiKey, 'sk-ant-real-key-abcdef');
  assert.strictEqual(stored.values.baseUrl, 'https://a.example');
});

test('POST /provider-profiles rejects a blank name and an unknown provider', async (t) => {
  const cfg = freshCfg(t);
  const { port } = listen(t, cfg);

  const blank = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', name: '   ' }),
  });
  assert.strictEqual(blank.status, 400);

  const bogus = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'nope', name: 'x' }),
  });
  assert.strictEqual(bogus.status, 404);
});

test('DELETE /provider-profiles/:provider/:id removes the profile and clears its marker', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providerProfiles: { claude: { p_a: { name: 'A', values: { apiKey: 'sk-a' } } } },
    activeProviderProfiles: { claude: 'p_a' },
  });
  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_a`, {
    method: 'DELETE',
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { providerProfiles: Record<string, unknown>; activeProviderProfiles: Record<string, string> };
  assert.deepStrictEqual(body.providerProfiles.claude, {});
  assert.strictEqual(body.activeProviderProfiles.claude, '');
  assert.strictEqual(cfg.get().activeProviderProfiles.claude, '');
});

test('DELETE /provider-profiles/:provider/:id 404s on an unknown id', async (t) => {
  const cfg = freshCfg(t);
  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_nope`, {
    method: 'DELETE',
  });
  assert.strictEqual(res.status, 404);
});
