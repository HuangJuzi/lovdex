import test, { type TestContext } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAppConfig } from '../config.js';
import type { AppConfigApi } from '../config.js';
import { buildProviderProfilesRouter } from '../provider-profiles.js';

/** 把 profiles router 挂起来；鉴权在挂载点做（同 index.js），这里不重复。 */
function listen(t: TestContext, cfg: AppConfigApi) {
  const app = express();
  app.use(express.json());
  app.use('/api/config', buildProviderProfilesRouter({ cfg }));
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return { port };
}

function freshCfg(t: TestContext): AppConfigApi {
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

test('POST /provider-profiles does NOT touch the effective provider fields', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providers: { claude: { apiKey: 'sk-ant-real-key-abcdef', baseUrl: 'https://a.example' } },
  });
  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', name: 'A' }),
  });
  assert.strictEqual(res.status, 200);

  // 建档只是把生效值拷进存储；生效字段本身与 activeProviderProfiles 都不该动
  const claude = cfg.get().providers.claude;
  assert.strictEqual(claude.apiKey, 'sk-ant-real-key-abcdef');
  assert.strictEqual(claude.baseUrl, 'https://a.example');
  assert.deepStrictEqual(cfg.get().activeProviderProfiles, {});
});

test('PUT /provider-profiles/:provider/:id renames without touching values or effective fields', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providers: { claude: { apiKey: 'sk-active-key-zzzzzz', baseUrl: 'https://active.example' } },
    providerProfiles: {
      claude: { p_a: { name: '旧名', values: { apiKey: 'sk-profile-key-aaaaaa' } } },
    },
    activeProviderProfiles: { claude: 'p_a' },
  });
  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_a`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ' 新名 ' }),
  });
  assert.strictEqual(res.status, 200);

  const stored = cfg.get().providerProfiles.claude.p_a;
  assert.strictEqual(stored.name, '新名'); // trim 过
  assert.strictEqual(stored.values.apiKey, 'sk-profile-key-aaaaaa'); // values 原样
  assert.strictEqual(cfg.get().providers.claude.apiKey, 'sk-active-key-zzzzzz'); // 生效字段没被带跑
  assert.strictEqual(cfg.get().activeProviderProfiles.claude, 'p_a'); // 标记没动

  const body = (await res.json()) as {
    providerProfiles: { claude: { p_a: { name: string } } };
  };
  assert.strictEqual(body.providerProfiles.claude.p_a.name, '新名');
});

test('PUT /provider-profiles/:provider/:id rejects a blank name and 404s on an unknown id', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providerProfiles: { claude: { p_a: { name: 'A', values: {} } } },
  });
  const { port } = listen(t, cfg);

  const blank = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_a`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '   ' }),
  });
  assert.strictEqual(blank.status, 400);
  assert.strictEqual(cfg.get().providerProfiles.claude.p_a.name, 'A'); // 没被改

  const missing = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_nope`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X' }),
  });
  assert.strictEqual(missing.status, 404);
});

test('POST /provider-profiles rejects a duplicate name within the same provider', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({ providerProfiles: { claude: { p_a: { name: '主账号', values: {} } } } });
  const { port } = listen(t, cfg);

  const res = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', name: '  主账号  ' }), // trim 后同名
  });
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { error: { message: string } };
  assert.strictEqual(body.error.message, 'a profile with this name already exists');
  assert.deepStrictEqual(Object.keys(cfg.get().providerProfiles.claude), ['p_a']); // 没建出来

  // 同名只限同一个 provider：另一个 provider 可以叫同一个名字
  const other = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'qoder', name: '主账号' }),
  });
  assert.strictEqual(other.status, 200);
});

test('PUT /provider-profiles/:provider/:id rejects a name another profile already uses', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providerProfiles: { claude: { p_a: { name: '甲', values: {} }, p_b: { name: '乙', values: {} } } },
  });
  const { port } = listen(t, cfg);

  const dup = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_b`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '甲' }),
  });
  assert.strictEqual(dup.status, 400);
  assert.strictEqual(cfg.get().providerProfiles.claude.p_b.name, '乙'); // 没被改

  // 改成自己当前的名字是无副作用的 no-op，不该被自己判重
  const self = await fetch(`http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_b`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '乙' }),
  });
  assert.strictEqual(self.status, 200);
});

test('POST /provider-profiles/:provider/:id/snapshot overwrites values in place', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providers: {
      claude: { apiKey: 'sk-new-real-key-abcdef', baseUrl: 'https://new.example', defaultModel: 'm-new' },
    },
    providerProfiles: {
      claude: {
        p_a: {
          name: '主账号',
          values: { apiKey: 'sk-old-key-111111', baseUrl: 'https://old.example', defaultModel: 'm-old' },
        },
      },
    },
    activeProviderProfiles: { claude: 'p_a' },
  });
  const { port } = listen(t, cfg);

  const res = await fetch(
    `http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_a/snapshot`,
    { method: 'POST' },
  );
  assert.strictEqual(res.status, 200);

  const stored = cfg.get().providerProfiles.claude.p_a;
  assert.strictEqual(stored.name, '主账号'); // name 不变
  assert.strictEqual(stored.values.apiKey, 'sk-new-real-key-abcdef'); // 生效里的真值被覆盖进来
  assert.strictEqual(stored.values.baseUrl, 'https://new.example');
  assert.strictEqual(stored.values.defaultModel, 'm-new');
  assert.deepStrictEqual(Object.keys(cfg.get().providerProfiles.claude), ['p_a']); // 没多出档
  assert.strictEqual(cfg.get().activeProviderProfiles.claude, 'p_a'); // 标记没动

  // 响应仍是 masked
  const body = (await res.json()) as {
    providerProfiles: { claude: { p_a: { values: { apiKey: string } } } };
  };
  assert.strictEqual(body.providerProfiles.claude.p_a.values.apiKey, 'sk-new****abcdef');
});

test('snapshot clears a value that is empty in the effective config', async (t) => {
  const cfg = freshCfg(t);
  cfg.update({
    providers: { claude: { apiKey: 'sk-k-1111111111', baseUrl: 'https://a.example', defaultModel: '' } },
    providerProfiles: { claude: { p_a: { name: 'A', values: { defaultModel: 'stale-model' } } } },
  });
  const { port } = listen(t, cfg);

  const res = await fetch(
    `http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_a/snapshot`,
    { method: 'POST' },
  );
  assert.strictEqual(res.status, 200);
  // '' 不是打码串，deepMerge 的 `'' ?? base` = ''，所以能真的清掉旧值
  assert.strictEqual(cfg.get().providerProfiles.claude.p_a.values.defaultModel, '');
});

test('POST /provider-profiles/:provider/:id/snapshot 404s on an unknown id and provider', async (t) => {
  const cfg = freshCfg(t);
  const { port } = listen(t, cfg);

  const unknown = await fetch(
    `http://127.0.0.1:${port}/api/config/provider-profiles/claude/p_nope/snapshot`,
    { method: 'POST' },
  );
  assert.strictEqual(unknown.status, 404);

  const bogus = await fetch(
    `http://127.0.0.1:${port}/api/config/provider-profiles/nope/p_a/snapshot`,
    { method: 'POST' },
  );
  assert.strictEqual(bogus.status, 404);
});
