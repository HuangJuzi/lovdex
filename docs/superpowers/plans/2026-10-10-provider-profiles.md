# 多套 baseUrl / API Key 配置档（provider profiles）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个 provider 能存多套命名配置档（baseUrl + apiKey + 模型名），在设置页选中后点保存即切换，密钥全程不经过浏览器。

**Architecture:** 配置档作为**快照**存在 `app.config.json` 的两个新顶层键里（`providerProfiles` / `activeProviderProfiles`）。生效字段 `providers.*` **仍是唯一真源**——`env-sync.ts`、`buildProviderConfigEnv`、`resolveDshProviderEnv`、llm-proxy 一行不改。`PUT /api/config` 多接一条规则：body 里带档标记时，服务端先把该档的**真值**作为生效字段的基底、再让 body 自己的字段覆盖（`deepMerge` 的 `undefined = 未提供` 语义天然实现了"打码 = 不改动"，这条契约因此能跨档复用）。新建/删除档各有一个服务端端点，因为客户端**物理上无法**表达"把那个档的密钥拷过来"（`GET` 打码、`PUT` 丢弃打码串）。

**Tech Stack:** 后端 Node + Express + TypeScript（`@/` alias，tsx 直跑）；测试 `npx tsx --test`。前端 React + TS，测试 `renderToStaticMarkup` SSR（**不跑 effect、无 DOM**，所以逻辑必须抽成纯函数才测得到）。

**设计依据：** `docs/superpowers/specs/2026-10-10-provider-profiles-design.md`

**基线（动手前实测，验收看"零新增"）：**
- `cd backend && npx tsc --noEmit -p server/tsconfig.json` → **13 个** pre-existing 错误
- `cd web && npx tsc --noEmit -p tsconfig.json` → **0 个**

**跑测试的确切命令：**

```bash
# 后端（从 backend/ 跑；TSX_TSCONFIG_PATH=server/tsconfig.json 是全局导出的，别动它）
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/<file>.test.ts

# 前端（必须 unset TSX_TSCONFIG_PATH，否则会误解析后端 tsconfig）
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/settings/<file>.test.ts
```

---

## 文件结构

| 动作 | 文件 | 职责 |
|---|---|---|
| 改 | `backend/server/modules/config/config.ts` | 加两个顶层键；加 `removeProviderProfile()`；`export deepMerge` |
| 新建 | `backend/server/modules/config/provider-profiles.ts` | 白名单表、快照、名称校验、档选择解析（PUT 用）、`buildProviderProfilesRouter`（POST/DELETE） |
| 改 | `backend/server/modules/config/config.routes.ts` | PUT 里调 `applyProfileSelections` |
| 改 | `backend/server/index.js` | 挂新 router（同一鉴权） |
| 改 | `backend/server/modules/config/tests/config.test.ts` | 默认值、`removeProviderProfile` 单测 |
| 改 | `backend/server/modules/config/tests/config.routes.test.ts` | PUT 带档标记的行为测试 |
| 新建 | `backend/server/modules/config/tests/provider-profiles.test.ts` | 领域逻辑单测 |
| 新建 | `backend/server/modules/config/tests/provider-profiles.routes.test.ts` | POST/DELETE 路由测试 |
| 新建 | `web/src/components/settings/providerProfiles.ts` | 前端纯逻辑（档→表单、比对、组装 PUT body） |
| 新建 | `web/src/components/settings/providerProfiles.test.ts` | 上述纯函数单测 |
| 新建 | `web/src/components/settings/ProviderProfileSelector.tsx` | 展示组件：下拉 + 三个按钮 |
| 新建 | `web/src/components/settings/ProviderProfileSelector.test.tsx` | SSR 冒烟 |
| 改 | `web/src/components/settings/ProviderSettingsPage.tsx` | 接入选择器、状态、保存、提示文案 |

**为什么 `providerProfiles.ts` 单独成文件：** 领域规则（白名单、快照、打码合并）与其 HTTP 形状（router）分开，前者能纯函数测，后者能挂 ephemeral server 测。

---

## Task 1: 后端配置模型扩展（两个顶层键 + 删除方法）

**Files:**
- Modify: `backend/server/modules/config/config.ts`
- Test: `backend/server/modules/config/tests/config.test.ts`

**背景（必须知道）：** `cfg.update()` 走 `deepMerge`，而 `deepMerge` **只能加键/覆盖键，永远删不掉一个键**（`{...base}` 会把没在 override 里出现的键原样留下）。所以删除配置档不能走 `update()`，必须给 `AppConfigApi` 加一个独立方法。

另外 `deepMerge` 用 `override ?? base`——**`null` 会被当作"未提供"从而保留旧值**。清空档标记必须用空串 `''`，不能用 `null`。这条在第 4 个测试里钉死。

- [ ] **Step 1: 写失败测试**

追加到 `backend/server/modules/config/tests/config.test.ts` 末尾（该文件已有 `tmpDir()` helper 和 `createAppConfig` import，直接用）：

```ts
test('providerProfiles / activeProviderProfiles default to empty objects', () => {
  const cfg = createAppConfig({ dataDir: tmpDir() });
  assert.deepStrictEqual(cfg.get().providerProfiles, {});
  assert.deepStrictEqual(cfg.get().activeProviderProfiles, {});
});

test('removeProviderProfile deletes the entry and clears a matching active marker', () => {
  const cfg = createAppConfig({ dataDir: tmpDir() });
  cfg.update({
    providerProfiles: {
      claude: {
        p_a: { name: 'A', values: { apiKey: 'sk-a', baseUrl: 'https://a.example' } },
        p_b: { name: 'B', values: { apiKey: 'sk-b' } },
      },
    },
    activeProviderProfiles: { claude: 'p_a' },
  });

  cfg.removeProviderProfile('claude', 'p_a');

  const got = cfg.get();
  assert.strictEqual(got.providerProfiles.claude.p_a, undefined);
  assert.strictEqual(got.providerProfiles.claude.p_b.values.apiKey, 'sk-b');
  // 删掉当前档 → 标记清空（用 '' 而不是 null，见 deepMerge 的 `override ?? base`）
  assert.strictEqual(got.activeProviderProfiles.claude, '');
});

test('removeProviderProfile leaves the non-active marker alone', () => {
  const cfg = createAppConfig({ dataDir: tmpDir() });
  cfg.update({
    providerProfiles: { claude: { p_a: { name: 'A', values: {} }, p_b: { name: 'B', values: {} } } },
    activeProviderProfiles: { claude: 'p_a' },
  });

  cfg.removeProviderProfile('claude', 'p_b');

  assert.strictEqual(cfg.get().activeProviderProfiles.claude, 'p_a');
});

test('masked GET masks apiKey inside providerProfiles (no real key leaks)', () => {
  const cfg = createAppConfig({ dataDir: tmpDir() });
  cfg.update({
    providerProfiles: {
      claude: { p_a: { name: 'A', values: { apiKey: 'sk-ant-real-key-abcdef' } } },
    },
  });

  const masked = cfg.getMasked() as unknown as {
    providerProfiles: { claude: { p_a: { name: string; values: { apiKey: string } } } };
  };
  assert.strictEqual(masked.providerProfiles.claude.p_a.name, 'A');
  assert.strictEqual(masked.providerProfiles.claude.p_a.values.apiKey, 'sk-ant****abcdef');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/config.test.ts
```

Expected: FAIL —`cfg.get().providerProfiles` 是 `undefined`（`deepStrictEqual(undefined, {})` 挂）、`cfg.removeProviderProfile is not a function`。

- [ ] **Step 3: 实现**

在 `backend/server/modules/config/config.ts` 里：

**(a)** 把 `function deepMerge<T>(` 改成 `export function deepMerge<T>(`（第 154 行）。它要被 `provider-profiles.ts` 复用——**这是关键**，不能用对象展开代替（原因见 Task 2）。

**(b)** `DEFAULT_APP_CONFIG` 里，`llmProxy: {...},` 之后、`runtime: {...},` 之前插入：

```ts
  /**
   * 多套凭据「配置档」：某个 provider 的一组凭据字段的命名快照（字段范围见
   * provider-profiles.ts 的 PROFILE_FIELDS）。**纯存储** —— `providers.*` 才
   * 是"实际跑什么"的唯一真源；配置档只有被应用时才改变行为（PUT 带
   * activeProviderProfiles 选择，服务端把该档真值拷进 `providers.*`，所以
   * 密钥从不经过浏览器）。
   *
   * values 里存的是**真密钥**：GET 会打码（maskConfig 按 key 名递归），PUT 会在
   * 合并前丢掉打码占位串，所以客户端把整份 draft 打回来也绝不会覆盖已存的 key。
   */
  providerProfiles: {} as Record<
    string,
    Record<string, { name: string; values: Record<string, unknown> }>
  >,
  /**
   * 每个 provider 的生效字段当前来自哪个档。**仅 UI 标注用**，env-sync / 各
   * runner 从不读它。空串（**不是 null** —— deepMerge 的 `override ?? base` 会把
   * null 当成"未提供"而保留旧值）表示"自定义，不归属任何档"。
   */
  activeProviderProfiles: {} as Record<string, string>,
```

**(c)** `AppConfigApi` 类型（第 216 行附近）加一个成员：

```ts
  /**
   * 删除一个配置档。`update()` 走的 deepMerge 只能加键/覆盖键、删不掉键，
   * 所以删除必须走自己的路径。若该档正是当前档则顺手清空标记（`''`）；
   * **生效字段刻意不动** —— 删档不该改变正在跑的东西。
   */
  removeProviderProfile(provider: string, id: string): AppConfig;
```

**(d)** 在 `createAppConfig` 返回的对象字面量里（`update(...)` 之后）实现：

```ts
    removeProviderProfile(provider: string, id: string): AppConfig {
      const next = structuredClone(current);
      const bucket = next.providerProfiles[provider];
      if (bucket) delete bucket[id];
      if (next.activeProviderProfiles[provider] === id) next.activeProviderProfiles[provider] = '';
      persist(next);
      current = next;
      return current;
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/config.test.ts
```

Expected: PASS，`# fail 0`（12 个旧用例 + 4 个新用例）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/config/config.ts backend/server/modules/config/tests/config.test.ts && git commit -m "feat(provider-profiles): add providerProfiles config store + removeProviderProfile"
```

---

## Task 2: 领域逻辑（白名单 / 快照 / 校验 / 档选择解析）

**Files:**
- Create: `backend/server/modules/config/provider-profiles.ts`
- Test: `backend/server/modules/config/tests/provider-profiles.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/config/tests/provider-profiles.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';
import {
  PROFILE_FIELDS,
  UnknownProfileError,
  applyProfileSelections,
  snapshotProviderFields,
  validateProfileName,
} from '../provider-profiles.js';

function tmpCfg() {
  return createAppConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-pp-')) });
}

test('PROFILE_FIELDS has an entry for every provider we ship profiles for', () => {
  assert.deepStrictEqual(Object.keys(PROFILE_FIELDS).sort(), ['claude', 'codex', 'dsh', 'opencode', 'qoder']);
  assert.deepStrictEqual(PROFILE_FIELDS.claude, [
    'baseUrl', 'apiKey', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel',
  ]);
});

test('snapshotProviderFields copies only whitelisted fields, by value', () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: {
      claude: { baseUrl: 'https://a.example', apiKey: 'sk-real', defaultModel: 'm1' },
    },
  });

  const snap = snapshotProviderFields(cfg.get(), 'claude');

  assert.strictEqual(snap.baseUrl, 'https://a.example');
  assert.strictEqual(snap.apiKey, 'sk-real');
  assert.strictEqual(snap.defaultModel, 'm1');
  // 白名单外的字段一个都不带
  assert.ok(!('cliPath' in snap));
  assert.ok(!('disableThinkingModels' in snap));
});

test('snapshotProviderFields deep-copies (mutating the snapshot does not touch config)', () => {
  const cfg = tmpCfg();
  cfg.update({ providers: { opencode: { apiKeys: { OPENAI_API_KEY: 'sk-o' } } } });

  const snap = snapshotProviderFields(cfg.get(), 'opencode');
  (snap.apiKeys as Record<string, string>).OPENAI_API_KEY = 'mutated';

  assert.strictEqual(cfg.get().providers.opencode.apiKeys.OPENAI_API_KEY, 'sk-o');
});

test('validateProfileName rejects empty/whitespace/too-long names', () => {
  assert.strictEqual(validateProfileName('  主账号  '), null);
  assert.strictEqual(validateProfileName(''), 'name is required');
  assert.strictEqual(validateProfileName('   '), 'name is required');
  assert.strictEqual(validateProfileName(undefined), 'name is required');
  assert.strictEqual(validateProfileName('x'.repeat(41)), 'name must be at most 40 characters');
  assert.strictEqual(validateProfileName('x'.repeat(40)), null);
});

test('applyProfileSelections leaves a body without selections untouched', () => {
  const cfg = tmpCfg();
  const body = { providers: { claude: { baseUrl: 'https://new.example' } } };
  assert.deepStrictEqual(applyProfileSelections(cfg, body), body);
});

test('applyProfileSelections skips empty-string selections (custom)', () => {
  const cfg = tmpCfg();
  const body = {
    providers: { claude: { baseUrl: 'https://new.example' } },
    activeProviderProfiles: { claude: '' },
  };
  assert.deepStrictEqual(applyProfileSelections(cfg, body), body);
});

test("applyProfileSelections uses the profile's REAL key when the body carries the masked one", () => {
  const cfg = tmpCfg();
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

  // 客户端重发 GET 的打码串（含 **** 的已被 stripMaskedPlaceholders 变成 undefined，
  // 这里直接模拟 strip 之后的结果：键在、值是 undefined）。
  const resolved = applyProfileSelections(cfg, {
    providers: { claude: { apiKey: undefined, defaultModel: 'model-i-typed' } },
    activeProviderProfiles: { claude: 'p_a' },
  }) as { providers: { claude: Record<string, unknown> } };

  const claude = resolved.providers.claude;
  assert.strictEqual(claude.apiKey, 'sk-profile-key-aaaaaa'); // 档里的真值勝出（undefined 不覆盖）
  assert.strictEqual(claude.baseUrl, 'https://profile.example'); // body 没提这个字段 → 档值
  assert.strictEqual(claude.defaultModel, 'model-i-typed'); // body 显式给了 → body 勝出
});

test('applyProfileSelections keeps a real key the user typed over the profile one', () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: { claude: { apiKey: 'sk-active-key-zzzzzz' } },
    providerProfiles: { claude: { p_a: { name: 'A', values: { apiKey: 'sk-profile-key-aaaaaa' } } } },
  });

  const resolved = applyProfileSelections(cfg, {
    providers: { claude: { apiKey: 'sk-brand-new-key-bbbbbb' } },
    activeProviderProfiles: { claude: 'p_a' },
  }) as { providers: { claude: { apiKey: string } } };

  assert.strictEqual(resolved.providers.claude.apiKey, 'sk-brand-new-key-bbbbbb');
});

test('applyProfileSelections throws on an unknown profile id (never silently ignores)', () => {
  const cfg = tmpCfg();
  assert.throws(
    () => applyProfileSelections(cfg, { activeProviderProfiles: { claude: 'p_nope' } }),
    (err: unknown) => err instanceof UnknownProfileError && (err as UnknownProfileError).id === 'p_nope',
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/provider-profiles.test.ts
```

Expected: FAIL —`Cannot find module '../provider-profiles.js'`。

- [ ] **Step 3: 实现**

创建 `backend/server/modules/config/provider-profiles.ts`：

```ts
/**
 * 多套凭据「配置档」（provider profiles）。
 *
 * 一个配置档 = 某个 provider 一组凭据字段的命名快照。快照从**当前生效的**
 * `providers.<p>` 字段上取，应用时也由服务端写回 `providers.<p>` —— 密钥
 * 全程不经过浏览器（GET 打码、PUT 丢弃打码占位串，所以客户端物理上表达不出
 * "把那个档的 key 拷到这里"）。
 *
 * 设计见 docs/superpowers/specs/2026-10-10-provider-profiles-design.md。
 */
import crypto from 'node:crypto';
import { Router } from 'express';

import type { AppConfig, AppConfigApi } from './config.js';
import { deepMerge } from './config.js';

/**
 * 一个档快照/写回哪些字段，按 provider 分。
 * 刻意用白名单：它就是"哪些东西属于一组凭据"的定义。
 * 需与设置页表单字段保持一致（web/src/components/settings/providerProfiles.ts）。
 */
export const PROFILE_FIELDS: Record<string, readonly string[]> = {
  claude: ['baseUrl', 'apiKey', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel'],
  codex: ['binPath', 'apiKey'],
  opencode: ['binPath', 'apiKeys'],
  qoder: ['personalAccessToken'],
  // dsh 今天在设置页没有凭据区块（见 2026-10-09 dsh 前端设计：刻意不做），
  // 所以这里支持但 UI 够不着。留着是为了 API 完整 + 以后加区块时不用改后端。
  dsh: ['baseUrl', 'apiKey'],
};

export const PROFILE_NAME_MAX = 40;

/**
 * PUT 里指了一个不存在的档 id。不携带任何 HTTP 语义（由 router 映射成 404），
 * 所以能纯函数测。
 */
export class UnknownProfileError extends Error {
  constructor(public readonly provider: string, public readonly id: string) {
    super(`unknown provider profile: ${provider}/${id}`);
    this.name = 'UnknownProfileError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从生效配置里拷出某个 provider 白名单内的字段（深拷贝）。 */
export function snapshotProviderFields(cfg: AppConfig, provider: string): Record<string, unknown> {
  const fields = PROFILE_FIELDS[provider] ?? [];
  const source =
    (cfg.providers as unknown as Record<string, Record<string, unknown> | undefined>)[provider] ?? {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) out[field] = structuredClone(source[field]);
  }
  return out;
}

/** trim + 校验档名；返回错误消息，通过则返回 null。 */
export function validateProfileName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return 'name is required';
  if (name.length > PROFILE_NAME_MAX) return `name must be at most ${PROFILE_NAME_MAX} characters`;
  return null;
}

export function newProfileId(): string {
  return `p_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 把 PUT body 改写：凡是在 `activeProviderProfiles` 里点了名的 provider，都先以
 * 该档的**真值**作为生效字段的基底，再由 body 自己的字段覆盖。
 *
 * 合并**必须用 `deepMerge`，绝不能用对象展开**：`stripMaskedPlaceholders` 会让
 * 打码字段"键还在、值是 undefined"，展开会把档里的真 key 覆盖成 undefined；
 * `deepMerge` 的 `override ?? base` 把 undefined 当"未提供"从而保住已存值 ——
 * 这正是"打码 = 不改动"那条既有契约，现在被延伸到跨档拷贝上。
 *
 * `''` / 缺失 = "自定义，无档"，原样放过。其它值必须解析到已存在的档，否则抛
 * {@link UnknownProfileError}：静默忽略一个未知 id 会看起来像切换成功了。
 */
export function applyProfileSelections(cfg: AppConfigApi, body: unknown): unknown {
  const b = body as Record<string, unknown>;
  const selections = b.activeProviderProfiles;
  if (!isRecord(selections)) return body;

  const providers = isRecord(b.providers) ? { ...b.providers } : {};
  let touched = false;
  for (const [provider, id] of Object.entries(selections)) {
    if (typeof id !== 'string' || id === '') continue;
    const profile = cfg.get().providerProfiles[provider]?.[id];
    if (!profile) throw new UnknownProfileError(provider, id);
    providers[provider] = deepMerge(structuredClone(profile.values), providers[provider]);
    touched = true;
  }
  return touched ? { ...b, providers } : body;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/provider-profiles.test.ts
```

Expected: PASS，`# fail 0`（10 个用例）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/config/provider-profiles.ts backend/server/modules/config/tests/provider-profiles.test.ts && git commit -m "feat(provider-profiles): profile snapshot, validation and PUT selection resolution"
```

---

## Task 3: 配置档 router（POST 新建 / DELETE 删除）

**Files:**
- Modify: `backend/server/modules/config/provider-profiles.ts`（追加 router builder）
- Test: `backend/server/modules/config/tests/provider-profiles.routes.test.ts`

**HTTP 状态约定（与 spec §4.2/§4.3 一致）：** 未知 provider / 未知档 id → **404**；档名不合法 → **400**；写盘失败 → **500**。

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/config/tests/provider-profiles.routes.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/provider-profiles.routes.test.ts
```

Expected: FAIL —`buildProviderProfilesRouter is not a function`。

- [ ] **Step 3: 实现**

追加到 `backend/server/modules/config/provider-profiles.ts` 末尾：

```ts
/**
 * POST   /provider-profiles            — 用当前生效字段快照出一个新档
 * DELETE /provider-profiles/:provider/:id — 删一个档
 *
 * 两者都**不改变实际跑什么**，所以都不触发 syncProviderEnv / llm-proxy
 * reconcile —— 只有 PUT /api/config 需要。鉴权在挂载点做（见 index.js），
 * 与本 router 无关（与 buildConfigWriteRouter 同构）。
 */
export function buildProviderProfilesRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();

  router.post('/provider-profiles', (req, res) => {
    const body = (req.body ?? {}) as { provider?: unknown; name?: unknown };
    const provider = typeof body.provider === 'string' ? body.provider : '';
    if (!PROFILE_FIELDS[provider]) {
      return res.status(404).json({ error: { message: `unknown provider: ${provider}` } });
    }
    const invalid = validateProfileName(body.name);
    if (invalid) return res.status(400).json({ error: { message: invalid } });
    try {
      const id = newProfileId();
      deps.cfg.update({
        providerProfiles: {
          [provider]: {
            [id]: {
              name: (body.name as string).trim(),
              values: snapshotProviderFields(deps.cfg.get(), provider),
            },
          },
        },
      });
      res.json(deps.cfg.getMasked());
    } catch (err) {
      console.error('provider profile create failed:', err);
      res.status(500).json({ error: 'config write failed' });
    }
  });

  router.delete('/provider-profiles/:provider/:id', (req, res) => {
    const { provider, id } = req.params;
    if (!PROFILE_FIELDS[provider]) {
      return res.status(404).json({ error: { message: `unknown provider: ${provider}` } });
    }
    if (!deps.cfg.get().providerProfiles[provider]?.[id]) {
      return res.status(404).json({ error: { message: `unknown provider profile: ${provider}/${id}` } });
    }
    try {
      deps.cfg.removeProviderProfile(provider, id);
      res.json(deps.cfg.getMasked());
    } catch (err) {
      console.error('provider profile delete failed:', err);
      res.status(500).json({ error: 'config write failed' });
    }
  });

  return router;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/provider-profiles.routes.test.ts
```

Expected: PASS，`# fail 0`（4 个用例）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/config/provider-profiles.ts backend/server/modules/config/tests/provider-profiles.routes.test.ts && git commit -m "feat(provider-profiles): create/delete profile endpoints"
```

---

## Task 4: PUT 接入档选择 + index.js 挂载

**Files:**
- Modify: `backend/server/modules/config/config.routes.ts`
- Modify: `backend/server/index.js`
- Test: `backend/server/modules/config/tests/config.routes.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `backend/server/modules/config/tests/config.routes.test.ts` 末尾（该文件已有 `listen(t, cfg)` / `freshCfg` 风格的 helper——用它自己的 `buildTestApp` + `listen` + `createAppConfig({ dataDir })`）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/config.routes.test.ts
```

Expected: FAIL — 第一个用例的 `claude.apiKey` 会是 `sk-active-key-zzzzzz`（档没被应用）；第二个用例状态是 200 而不是 404。

- [ ] **Step 3: 实现**

**(a)** `backend/server/modules/config/config.routes.ts` 顶部加 import：

```ts
import { UnknownProfileError, applyProfileSelections } from './provider-profiles.js';
```

**(b)** 把 `buildConfigWriteRouter` 里的 `router.put('/', ...)` 换成：

```ts
  router.put('/', (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'config body must be a JSON object' });
    }
    try {
      // 先解析档选择再合并：被选中的档提供客户端表达不出来的真凭据值，body 自己的
      // 字段再覆盖它（打码字段已被 strip 成 undefined，deepMerge 会保住档里的值）。
      const resolved = applyProfileSelections(deps.cfg, stripMaskedPlaceholders(body));
      syncProviderEnv(deps.cfg.update(resolved));
      deps.onWrite?.();
      res.json(deps.cfg.getMasked());
    } catch (err) {
      if (err instanceof UnknownProfileError) {
        // 整个写被拒绝：静默忽略会看起来像切换成功了。
        return res.status(404).json({ error: { message: err.message } });
      }
      console.error('config write failed:', err);
      res.status(500).json({ error: 'config write failed' });
    }
  });
```

**(c)** `backend/server/index.js`：第 89 行的 import 改成

```js
import { buildConfigReadRouter, buildConfigWriteRouter } from './modules/config/config.routes.js';
import { buildProviderProfilesRouter } from './modules/config/provider-profiles.js';
```

第 421 行之后加一行：

```js
app.use('/api/config', authenticateToken, buildProviderProfilesRouter({ cfg: cfgStore }));
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/config.routes.test.ts
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/*.test.ts
```

Expected: 两个都 PASS，`# fail 0`（后者含 config / env-sync / llm-proxy-resolve / provider-profiles / 两个 routes 全部）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/config/config.routes.ts backend/server/index.js backend/server/modules/config/tests/config.routes.test.ts && git commit -m "feat(provider-profiles): resolve profile selections on PUT /api/config"
```

---

## Task 5: 前端纯逻辑模块

**Files:**
- Create: `web/src/components/settings/providerProfiles.ts`
- Test: `web/src/components/settings/providerProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/settings/providerProfiles.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORM_FIELDS,
  NO_PROFILE,
  buildConfigPutBody,
  findNewProfileId,
  isProfileModified,
  profileFormEntries,
  readSelections,
  selectionFor,
  withProfileBuckets,
} from './providerProfiles';

const CLIENT_PROFILE = {
  name: '主账号',
  values: {
    apiKey: 'sk-ant****abcdef',
    baseUrl: 'https://a.example',
    defaultModel: 'm1',
    opusModel: 'm2',
    sonnetModel: 'm3',
    haikuModel: 'm4',
  },
};

test('NO_PROFILE is an empty string, never null (backend deepMerge treats null as absent)', () => {
  assert.strictEqual(NO_PROFILE, '');
});

test('selectionFor falls back to NO_PROFILE for missing/empty markers', () => {
  assert.strictEqual(selectionFor({ claude: 'p_a' }, 'claude'), 'p_a');
  assert.strictEqual(selectionFor({ claude: '' }, 'claude'), NO_PROFILE);
  assert.strictEqual(selectionFor(undefined, 'claude'), NO_PROFILE);
  assert.strictEqual(selectionFor({}, 'codex'), NO_PROFILE);
});

test('readSelections fills every provider key', () => {
  assert.deepStrictEqual(readSelections({ activeProviderProfiles: { claude: 'p_a' } }), {
    claude: 'p_a',
    codex: '',
    opencode: '',
    qoder: '',
  });
  assert.deepStrictEqual(readSelections({}), { claude: '', codex: '', opencode: '', qoder: '' });
});

test('profileFormEntries returns only the form fields the profile carries as strings', () => {
  assert.deepStrictEqual(profileFormEntries(CLIENT_PROFILE, FORM_FIELDS.claude), [
    ['apiKey', 'sk-ant****abcdef'],
    ['baseUrl', 'https://a.example'],
    ['defaultModel', 'm1'],
    ['opusModel', 'm2'],
    ['sonnetModel', 'm3'],
    ['haikuModel', 'm4'],
  ]);
  // opencode 表单只渲染 binPath：apiKeys（对象）不该被塞进表单
  const opencode = { name: 'o', values: { binPath: '/usr/bin/opencode', apiKeys: { OPENAI_API_KEY: 'sk-o' } } };
  assert.deepStrictEqual(profileFormEntries(opencode, FORM_FIELDS.opencode), [['binPath', '/usr/bin/opencode']]);
});

test('isProfileModified compares only the form fields (masked values compare fine)', () => {
  const form = { apiKey: 'sk-ant****abcdef', baseUrl: 'https://a.example', defaultModel: 'm1' };
  assert.strictEqual(isProfileModified(form, CLIENT_PROFILE, FORM_FIELDS.claude), false);
  assert.strictEqual(
    isProfileModified({ ...form, defaultModel: 'typed' }, CLIENT_PROFILE, FORM_FIELDS.claude),
    true,
  );
  // 表单没渲染的字段不参与比对
  assert.strictEqual(isProfileModified(form, CLIENT_PROFILE, ['apiKey']), false);
});

test('buildConfigPutBody echoes the draft and normalises selections to never-null', () => {
  const draft = { providers: { claude: { baseUrl: 'https://x.example' } }, server: { port: 3188 } };
  const body = buildConfigPutBody(draft, { claude: 'p_a', codex: '', opencode: '', qoder: '' });
  assert.deepStrictEqual(body.activeProviderProfiles, { claude: 'p_a', codex: '', opencode: '', qoder: '' });
  assert.deepStrictEqual(body.providers, draft.providers);
  assert.deepStrictEqual(body.server, draft.server);
});

test('withProfileBuckets swaps only the two profile keys (unsaved form edits survive)', () => {
  const draft = { providers: { claude: { baseUrl: 'typed-but-unsaved' } }, server: { port: 1 } };
  const cfg = {
    providerProfiles: { claude: { p_a: { name: 'A', values: {} } } },
    activeProviderProfiles: { claude: 'p_a' },
  };
  const next = withProfileBuckets(draft, cfg) as Record<string, unknown>;
  assert.deepStrictEqual(next.providerProfiles, cfg.providerProfiles);
  assert.deepStrictEqual(next.activeProviderProfiles, cfg.activeProviderProfiles);
  assert.deepStrictEqual(next.providers, draft.providers); // 未保存的编辑还在
  assert.deepStrictEqual(next.server, draft.server);
});

test('findNewProfileId picks the id that was not there before', () => {
  assert.strictEqual(findNewProfileId(['p_a'], ['p_a', 'p_new']), 'p_new');
  assert.strictEqual(findNewProfileId([], ['p_only']), 'p_only');
  assert.strictEqual(findNewProfileId(['p_a'], ['p_a']), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/settings/providerProfiles.test.ts
```

Expected: FAIL —`Cannot find module './providerProfiles'`。

- [ ] **Step 3: 实现**

创建 `web/src/components/settings/providerProfiles.ts`：

```ts
/**
 * 配置档的前端纯逻辑。
 *
 * 单独成模块是为了可测：仓库的 web 测试走 renderToStaticMarkup SSR（不跑
 * effect、无 DOM），只有纯函数测得到。
 *
 * 设计见 docs/superpowers/specs/2026-10-10-provider-profiles-design.md。
 */

export type ProviderKey = 'claude' | 'codex' | 'opencode' | 'qoder';

export type ProviderProfile = { name: string; values: Record<string, unknown> };
export type ProfileBuckets = Record<string, Record<string, ProviderProfile>>;

/**
 * 设置页每个 provider 表单**真实渲染**的字段 —— 决定"选档时往表单填哪些值"和
 * "表单是不是被改过了"的比对范围。
 * opencode 只渲染 binPath（它的 apiKeys 没有 UI，由服务端在保存时整份应用）。
 * 与后端 provider-profiles.ts 的 PROFILE_FIELDS 是两个同心圆：那边是"档里存
 * 什么"，这边是"表单看得见什么"。
 */
export const FORM_FIELDS: Record<ProviderKey, readonly string[]> = {
  claude: ['apiKey', 'baseUrl', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel'],
  codex: ['binPath', 'apiKey'],
  opencode: ['binPath'],
  qoder: ['personalAccessToken'],
};

/**
 * "无档"标记。**必须是空串不是 null**：后端 deepMerge 的 `override ?? base` 会把
 * null 当成"未提供"从而保留旧标记，清不掉。
 */
export const NO_PROFILE = '';

/** 某个 provider 当前选中的档 id（缺省 = 自定义）。 */
export function selectionFor(active: Record<string, string> | undefined, provider: ProviderKey): string {
  return active?.[provider] || NO_PROFILE;
}

/** 从 GET 回来的配置里读出四个 provider 的档选择。 */
export function readSelections(cfg: Record<string, unknown>): Record<ProviderKey, string> {
  const active = (cfg.activeProviderProfiles ?? {}) as Record<string, string>;
  return {
    claude: selectionFor(active, 'claude'),
    codex: selectionFor(active, 'codex'),
    opencode: selectionFor(active, 'opencode'),
    qoder: selectionFor(active, 'qoder'),
  };
}

/** 选档时要填进表单的 (字段, 值) 对：只含表单渲染的字段、且档里是字符串的。 */
export function profileFormEntries(
  profile: ProviderProfile,
  fields: readonly string[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const field of fields) {
    const value = profile.values[field];
    if (typeof value === 'string') out.push([field, value]);
  }
  return out;
}

/**
 * 表单值与档是否还有差别（决定标不标「已修改」）。
 * 打码串也能比：打码由真值决定，值同则码同。
 */
export function isProfileModified(
  providerValues: Record<string, unknown>,
  profile: ProviderProfile,
  fields: readonly string[],
): boolean {
  return fields.some(
    (field) => String(providerValues[field] ?? '') !== String(profile.values[field] ?? ''),
  );
}

/** 组装 PUT body：整份 draft + 每个 provider 的档选择。 */
export function buildConfigPutBody(
  draft: Record<string, unknown>,
  selections: Record<ProviderKey, string>,
): Record<string, unknown> {
  const active: Record<string, string> = {};
  for (const [provider, id] of Object.entries(selections)) active[provider] = id || NO_PROFILE;
  return { ...draft, activeProviderProfiles: active };
}

/** 只换配置档相关的两个键，保留表单里未保存的编辑。 */
export function withProfileBuckets<T extends Record<string, unknown>>(
  draft: T,
  cfg: Record<string, unknown>,
): T {
  return {
    ...draft,
    providerProfiles: (cfg.providerProfiles ?? {}) as ProfileBuckets,
    activeProviderProfiles: (cfg.activeProviderProfiles ?? {}) as Record<string, string>,
  };
}

/** POST 之后找出服务端刚生成的那个档 id（响应里从未出现过的那个）。 */
export function findNewProfileId(before: readonly string[], after: readonly string[]): string {
  return after.find((id) => !before.includes(id)) ?? '';
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/settings/providerProfiles.test.ts
```

Expected: PASS，`# fail 0`（8 个用例）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/settings/providerProfiles.ts web/src/components/settings/providerProfiles.test.ts && git commit -m "feat(provider-profiles): frontend profile helpers"
```

---

## Task 6: `ProviderProfileSelector` 组件

**Files:**
- Create: `web/src/components/settings/ProviderProfileSelector.tsx`
- Test: `web/src/components/settings/ProviderProfileSelector.test.tsx`

组件做成**纯展示**（props 进、回调出，状态都留在 `ProviderSettingsForm` 里），这样 SSR 就测得到。

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/settings/ProviderProfileSelector.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProviderProfileSelector } from './ProviderProfileSelector';

const profiles = {
  p_a: { name: '主账号', values: {} },
  p_b: { name: '备用', values: {} },
};

function render(overrides: Partial<React.ComponentProps<typeof ProviderProfileSelector>> = {}) {
  return renderToStaticMarkup(
    <ProviderProfileSelector
      profiles={profiles}
      selectedId=""
      modified={false}
      onSelect={() => {}}
      onCreate={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      {...overrides}
    />,
  );
}

test('renders the custom option plus every profile name', () => {
  const html = render();
  assert.match(html, /自定义（不归属任何档）/);
  assert.match(html, /主账号/);
  assert.match(html, /备用/);
  assert.match(html, /存为新档/);
  assert.match(html, /重命名/);
  assert.match(html, /删除/);
});

test('marks the selected profile as 已修改 only while modified', () => {
  assert.match(render({ selectedId: 'p_a', modified: true }), /主账号（已修改）/);
  assert.doesNotMatch(render({ selectedId: 'p_a', modified: false }), /已修改/);
  // 没选档时不会把「已修改」挂到任何档名上
  assert.doesNotMatch(render({ selectedId: '', modified: true }), /已修改/);
});

test('disables rename/delete when no profile is selected', () => {
  const none = render({ selectedId: '' });
  assert.match(none, /<button[^>]*disabled[^>]*>重命名/);
  assert.match(none, /<button[^>]*disabled[^>]*>删除/);
  assert.doesNotMatch(render({ selectedId: 'p_a' }), /<button[^>]*disabled[^>]*>删除/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/settings/ProviderProfileSelector.test.tsx
```

Expected: FAIL —`Cannot find module './ProviderProfileSelector'`。

- [ ] **Step 3: 实现**

创建 `web/src/components/settings/ProviderProfileSelector.tsx`：

```tsx
import type { ProviderProfile } from './providerProfiles';

type Props = {
  profiles: Record<string, ProviderProfile>;
  selectedId: string;
  /** 表单值与该档已有差别 —— 下拉里给它加个「（已修改）」后缀。 */
  modified: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
};

const BTN =
  'h-8 flex-shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50';

/** 配置档下拉 + 三个管理按钮。纯展示：状态都在 ProviderSettingsForm 里。 */
export function ProviderProfileSelector({
  profiles,
  selectedId,
  modified,
  disabled = false,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">配置档</span>
      <select
        className="h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground"
        value={selectedId}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="">自定义（不归属任何档）</option>
        {Object.entries(profiles).map(([id, profile]) => (
          <option key={id} value={id}>
            {profile.name}
            {id === selectedId && modified ? '（已修改）' : ''}
          </option>
        ))}
      </select>
      <button type="button" className={BTN} disabled={disabled} onClick={onCreate}>
        存为新档
      </button>
      <button
        type="button"
        className={BTN}
        disabled={disabled || !selectedId}
        onClick={onRename}
      >
        重命名
      </button>
      <button
        type="button"
        className={BTN}
        disabled={disabled || !selectedId}
        onClick={onDelete}
      >
        删除
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/settings/ProviderProfileSelector.test.tsx
```

Expected: PASS，`# fail 0`（3 个用例）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/settings/ProviderProfileSelector.tsx web/src/components/settings/ProviderProfileSelector.test.tsx && git commit -m "feat(provider-profiles): profile selector component"
```

---

## Task 7: 接入设置页

**Files:**
- Modify: `web/src/components/settings/ProviderSettingsPage.tsx`

这个任务没有新单测（该表单靠 effect 加载，SSR 测不到；逻辑已在 Task 5 的纯函数里测过）。验证方式是 `tsc` + `eslint` + 手工跑一次 dev server 看渲染。

- [ ] **Step 1: 改 import 与类型**

`ProviderSettingsPage.tsx` 顶部（`import { Button } from '../../shared/view/ui';` 之后）加：

```tsx
import { ProviderProfileSelector } from './ProviderProfileSelector';
import {
  FORM_FIELDS,
  buildConfigPutBody,
  findNewProfileId,
  isProfileModified,
  profileFormEntries,
  readSelections,
  withProfileBuckets,
  type ProviderKey,
  type ProfileBuckets,
} from './providerProfiles';
```

删掉文件里原来的 `type ProviderKey = 'claude' | 'codex' | 'opencode' | 'qoder';`（现在从上面的模块导入）。

`AppConfig` 类型补两个字段、`LlmProxyConfig` 补一个：

```ts
type LlmProxyConfig = { enabled?: boolean; anthropicUrl?: string };
type AppConfig = {
  providers?: ProvidersConfig;
  server?: ServerConfig;
  llmProxy?: LlmProxyConfig;
  providerProfiles?: ProfileBuckets;
  activeProviderProfiles?: Record<string, string>;
  [k: string]: unknown;
};
```

- [ ] **Step 2: `Section` 支持一行头部附加内容**

`Section`（约 169 行）改成：

```tsx
function Section({
  title,
  provider,
  headerExtra,
  children,
}: {
  title: string;
  provider?: ProviderKey;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {provider && <AuthStatus provider={provider} />}
      </div>
      {headerExtra && <div className="mb-3">{headerExtra}</div>}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}
```

- [ ] **Step 3: 加档选择状态与操作**

在 `ProviderSettingsForm()` 里，`savedMsg` 那段 state 之后加：

```tsx
  const [selections, setSelections] = useState<Record<ProviderKey, string>>({
    claude: '', codex: '', opencode: '', qoder: '',
  });
```

加载成功后同时初始化选择（把 `.then(async (res) => {...})` 里 `setDraft(cfg)` 那处改成）：

```tsx
        const cfg = (await res.json()) as AppConfig;
        if (!cancelled) {
          setDraft(cfg);
          setSelections(readSelections(cfg));
        }
```

`save()` 里的 `api.put('/config', draft)` 改成：

```tsx
      const res = await api.put('/config', buildConfigPutBody(draft, selections));
```

`patchProvider` 之后加这几个函数：

```tsx
  /** 选档：只填表单，不写盘（保存时才生效）。 */
  function selectProfile(provider: ProviderKey, id: string) {
    setSavedMsg(null);
    setSelections((prev) => ({ ...prev, [provider]: id }));
    if (!id || !draft) return;
    const profile = draft.providerProfiles?.[provider]?.[id];
    if (!profile) return;
    // 复用 patchProvider：它已经是这份文件里唯一经过类型检查的"改一个表单字段"写法。
    for (const [field, value] of profileFormEntries(profile, FORM_FIELDS[provider])) {
      patchProvider(provider, field, value);
    }
  }

  /** 存为新档：先把表单落盘（含档选择），再从生效字段快照 —— 存下来的就是屏幕上看到的。 */
  async function createProfile(provider: ProviderKey) {
    if (!draft) return;
    const raw = window.prompt('配置档名称');
    if (raw === null) return;
    const name = raw.trim();
    if (!name) {
      setSaveError('配置档名称不能为空');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      const beforeIds = Object.keys(draft.providerProfiles?.[provider] ?? {});
      const putRes = await api.put('/config', buildConfigPutBody(draft, selections));
      if (!putRes.ok) {
        setSaveError(`保存失败（${putRes.status}）`);
        return;
      }
      const postRes = await api.post('/config/provider-profiles', { provider, name });
      if (!postRes.ok) {
        const err = await postRes.json().catch(() => null);
        setSaveError(err?.error?.message ?? err?.error ?? `新建配置档失败（${postRes.status}）`);
        return;
      }
      const cfg = (await postRes.json()) as AppConfig;
      const newId = findNewProfileId(beforeIds, Object.keys(cfg.providerProfiles?.[provider] ?? {}));
      setDraft((prev) => (prev ? withProfileBuckets(prev, cfg) : cfg));
      setSelections((prev) => ({ ...prev, [provider]: newId || prev[provider] }));
      setSavedMsg(`已存为配置档「${name}」`);
    } catch (err) {
      setSaveError((err as Error).message ?? '新建配置档失败');
    } finally {
      setSaving(false);
    }
  }

  async function renameProfile(provider: ProviderKey) {
    if (!draft) return;
    const id = selections[provider];
    const current = draft.providerProfiles?.[provider]?.[id]?.name ?? '';
    const raw = window.prompt('新的配置档名称', current);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name === current) return;
    setSaveError(null);
    try {
      // 这次 PUT 不带 activeProviderProfiles，所以档标记不变；name 不是密钥，
      // deepMerge 直接改掉。注意它和任何 PUT 一样会触发一次 llm-proxy reconcile。
      const res = await api.put('/config', { providerProfiles: { [provider]: { [id]: { name } } } });
      if (!res.ok) {
        setSaveError(`重命名失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      setDraft((prev) => (prev ? withProfileBuckets(prev, cfg) : cfg));
      setSavedMsg(`已重命名为「${name}」`);
    } catch (err) {
      setSaveError((err as Error).message ?? '重命名失败');
    }
  }

  async function deleteProfile(provider: ProviderKey) {
    if (!draft) return;
    const id = selections[provider];
    const name = draft.providerProfiles?.[provider]?.[id]?.name ?? '';
    if (!window.confirm(`删除配置档「${name}」？（不会改变当前生效的配置）`)) return;
    setSaveError(null);
    try {
      const res = await api.delete(
        `/config/provider-profiles/${provider}/${encodeURIComponent(id)}`,
      );
      if (!res.ok) {
        setSaveError(`删除失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      // 只换配置档两个键 → 表单里未保存的编辑与生效字段都原样保留。
      setDraft((prev) => (prev ? withProfileBuckets(prev, cfg) : cfg));
      setSelections((prev) => (prev[provider] === id ? { ...prev, [provider]: '' } : prev));
      setSavedMsg(`已删除配置档「${name}」`);
    } catch (err) {
      setSaveError((err as Error).message ?? '删除失败');
    }
  }

  function selectorFor(provider: ProviderKey) {
    const profiles = draft?.providerProfiles?.[provider] ?? {};
    const id = selections[provider];
    const modified = id
      ? isProfileModified(
          (draft?.providers?.[provider] ?? {}) as Record<string, unknown>,
          profiles[id] ?? { name: '', values: {} },
          FORM_FIELDS[provider],
        )
      : false;
    return (
      <ProviderProfileSelector
        profiles={profiles}
        selectedId={id}
        modified={modified}
        disabled={saving}
        onSelect={(next) => selectProfile(provider, next)}
        onCreate={() => void createProfile(provider)}
        onRename={() => void renameProfile(provider)}
        onDelete={() => void deleteProfile(provider)}
      />
    );
  }
```

- [ ] **Step 4: 把选择器挂到每个 Section 上，并加提示文案**

四个 Section 都加 `headerExtra={selectorFor('claude')}`（对应 provider 各自换 key），并在每个 Section 的 children **末尾**加一行小字。Claude 段（`<Section title="Claude" provider="claude">`）额外加 llmProxy 警示：

```tsx
      <Section
        title="Claude"
        provider="claude"
        headerExtra={selectorFor('claude')}
      >
        {/* ...原有 6 个字段不动... */}
        {llmProxy.enabled === true && (llmProxy.anthropicUrl ?? '').trim() !== '' && (
          <p className="text-xs text-warning">
            本地代理已显式指定上游（llmProxy.anthropicUrl），它不再跟随这里的 Base URL
            —— 切换配置档只影响直连路径，代理仍打老上游。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          配置档由服务端保管密钥；切换后点保存生效，只影响新会话（运行中的会话沿用启动时的凭据）。
        </p>
      </Section>
```

Codex / OpenCode / Qoder 三段同样加 `headerExtra={selectorFor('codex' | 'opencode' | 'qoder')}`，并在 children 末尾加同一句提示（`<p className="text-xs text-muted-foreground">`）。

- [ ] **Step 5: 类型检查 + lint**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
cd /mnt/b/workdir/github/lovdex/web && npx eslint src/components/settings/
```

Expected: `0`（无输出），以及 eslint 无输出。

如果 `tsc` 报 `providers[provider]` 的赋值错误，说明 `selectorFor` 里那个 cast 不够——改成与 `patchProvider` 完全同形的写法（那是本文件里已被证明能过类型检查的唯一形式）。

- [ ] **Step 6: 手工验证渲染**

```bash
cd /mnt/b/workdir/github/lovdex && ls web/node_modules/.vite >/dev/null 2>&1 && echo "dev server 已在跑（读 web 端口）"
```

打开 `http://<本机 IP>:<web 端口>/settings?tab=providers`（**用 IP 不用 localhost**），确认：四个 provider 段各有一行「配置档 [自定义 ▾] 存为新档 重命名 删除」；未选档时「重命名/删除」是灰的。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/settings/ProviderSettingsPage.tsx && git commit -m "feat(provider-profiles): wire profile selector into provider settings"
```

---

## Task 8: 收尾验证

**Files:** 无（验证任务）

- [ ] **Step 1: 后端全量 config 测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/config/tests/*.test.ts 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `# fail 0`。

- [ ] **Step 2: 后端全量测试（确认没碰坏别处）**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test $(find server -name '*.test.ts' -o -name '*.test.js' | grep -v integration) 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `# fail 0`（若有个别 integration 用例因环境失败，记录它是否在**动手前的基线**里也失败——是则不算回归）。

- [ ] **Step 3: 前端全部测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `# fail 0`。

- [ ] **Step 4: 类型检查零新增**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
```

Expected: 后端 **13**（与基线一致，一个都不新增）、前端 **0**。

- [ ] **Step 5: lint 零新增**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx eslint server/modules/config/ server/index.js
cd /mnt/b/workdir/github/lovdex/web && npx eslint src/components/settings/
```

Expected: 无输出。

- [ ] **Step 6: 确认回归面为零**

```bash
cd /mnt/b/workdir/github/lovdex && git diff --stat 369a931 -- backend/server/modules/config/env-sync.ts backend/server/modules/llm-proxy/ backend/server/modules/remote-agents/ backend/server/modules/providers/
```

（`369a931` 是本计划动手前的 spec 提交，即 Task 1 之前的那个 commit。）

Expected: **空输出** —— 生效链路（env 同步 / 代理 / 远程 / provider runner）一行都没动。

- [ ] **Step 7: 提交（若有遗留改动）**

```bash
cd /mnt/b/workdir/github/lovdex && git status --short
```

Expected: 只有本计划涉及的文件；无遗留则跳过。

---

## 自查记录

- **spec 覆盖**：§3 数据模型 → Task 1；§3.1 白名单 → Task 2；§3.2 打码 → Task 1 第 4 个用例；§4.1 PUT 规则 → Task 4；§4.2 POST → Task 3；§4.3 DELETE（含清标记）→ Task 1 + 3；§4.4 重命名走 PUT → Task 7；§4.5 挂载 → Task 4；§5 UI → Task 6 + 7；§5.4 文案与 llmProxy 警示 → Task 7 Step 4；§5.5 可测性 → Task 5 + 6；§6.1 生效链路 → 无需代码（未改动），Task 8 Step 6 验证；§6.2 边界（'' vs null、未知档 404、name 校验）→ Task 1/2/3/4 用例；§7 错误处理 → Task 3/4；§8 测试与验收 → Task 8。
- **与 spec 的两处细化（不改语义）**：① 未知 provider 在 POST/DELETE 都返回 404（spec §4.2 未规定，与 §4.3 对齐）；② 删除配置档走新方法 `removeProviderProfile()` 而非 `update()`，因为 spec §4.3 没意识到 `deepMerge` 删不掉键。
- **类型一致性**：`ProviderKey` / `ProviderProfile` / `NO_PROFILE` / `selectionFor` / `readSelections` / `profileFormEntries` / `isProfileModified` / `buildConfigPutBody` / `withProfileBuckets` / `findNewProfileId` 在 Task 5 定义、Task 7 使用，签名一致；`applyProfileSelections` / `UnknownProfileError` / `snapshotProviderFields` / `validateProfileName` / `buildProviderProfilesRouter` / `newProfileId` 在 Task 2/3 定义、Task 4 使用，一致。
