# DSH 自定义模型（customModels）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH provider 的模型下拉可经 `app.config providers.dsh.customModels` 扩展自定义 `[route, model]` 条目，换供应商时无需改源码。

**Architecture:** 配置文件扩展——`customModels: string[]`（每条 `route|model[|label]`），后端 `DshProviderModels.getSupportedModels()` 在 4 个预定义条目后追加解析结果；`value` 沿用 `JSON.stringify([route, model])` 线格式所以 runner 零改动；dsh 加入 `UNCACHED_PROVIDERS` 避开 72h 缓存；设置页 textarea 编辑；前后端 profile 白名单同步收录该字段。

**Tech Stack:** Node.js + tsx（`node:test`）、Express、React 设置页（无新增测试框架）。

**Spec:** `docs/superpowers/specs/2026-10-19-dsh-custom-models-design.md`

---

## 环境备忘（执行前必读）

- 后端测试命令（在 `/mnt/b/workdir/github/lovdex/backend` 下）：`npx tsx --tsconfig server/tsconfig.json --test <file>`。全局 `TSX_TSCONFIG_PATH` 已是 `server/tsconfig.json`，但显式传 `--tsconfig` 更稳（见记忆 lovdex-tsx-env-gotcha）。
- typecheck 基线不干净（**2026-10-19 实测 baseline：backend 6 个 error TS、web 0 个**，全与本计划无关）——验收标准是**零新增**：`cd backend && npm run typecheck` 后对比这个数。
- 不要切分支、不要动工作区里其他未提交改动（llm-proxy VLM 移除的 WIP，与本次无关）。commit 只 `git add` 本任务清单里的文件。
- 用户偏好：commit message 英文、不加 Co-Authored-By 署名行；回复用中文。
- 除非用户明说，**不重启后端**（重启会杀所有活跃会话）。

## 文件结构

| 动作 | 文件 | 职责 |
|---|---|---|
| Modify | `backend/server/modules/config/config.ts` | DEFAULT_APP_CONFIG 加 `dsh.customModels: []` |
| Modify | `backend/server/modules/config/config.routes.ts` | PUT 校验 customModels 类型 |
| Modify | `backend/server/modules/config/provider-profiles.ts` | PROFILE_FIELDS.dsh 白名单 |
| Modify | `backend/server/modules/providers/list/dsh/dsh-models.provider.ts` | 解析 customModels 追加条目 |
| Modify | `backend/server/modules/providers/services/provider-models.service.ts` | dsh 加入 UNCACHED_PROVIDERS |
| Modify | `web/src/components/settings/providerProfiles.ts` | 前端 FORM_FIELDS.dsh |
| Modify | `web/src/components/settings/ProviderSettingsPage.tsx` | DeepSeek Section 加 textarea |
| Create | `backend/server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts` | 解析逻辑测试（hermetic config） |
| Modify | `backend/server/modules/config/tests/config.routes.test.ts` | PUT 校验测试 |
| Modify | `backend/server/modules/config/tests/provider-profiles.test.ts` | 白名单/快照测试 |

---

### Task 1: config 默认值 + PUT 类型校验

**Files:**
- Modify: `backend/server/modules/config/config.ts`（DEFAULT_APP_CONFIG，dsh 段约 :66-102）
- Modify: `backend/server/modules/config/config.routes.ts`（buildConfigWriteRouter）
- Test: `backend/server/modules/config/tests/config.routes.test.ts`

- [ ] **Step 1: 写失败测试（PUT 校验两条 + 正常路径一条）**

在 `backend/server/modules/config/tests/config.routes.test.ts` 末尾追加（该文件已 import fetch/express/createAppConfig 等，直接用）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/config.routes.test.ts
```

预期：两个新测试 FAIL（tsc 层面 `customModels` 不在类型上会直接编译报错；即使跑起来，非数组写法会返回 200 而非 400）。

- [ ] **Step 3: config.ts 加默认值**

在 `backend/server/modules/config/config.ts` 的 `DEFAULT_APP_CONFIG.providers.dsh`（`toolApprovalTimeoutMs: 60000` 之后、`},` 之前）追加：

```ts
      // Extra picker entries for deployments whose endpoint serves model ids
      // that differ from DeepSeek's own. Each entry is `route|model` or
      // `route|model|label`; parsed into a `["route","model"]` wire-format
      // option by DshProviderModels (see dsh-models.provider.ts). APPENDED to
      // the predefined list, never replacing it.
      customModels: [],
```

- [ ] **Step 4: config.routes.ts 加校验**

在 `backend/server/modules/config/config.routes.ts` 的 PUT handler 里，`applyProfileSelections` 调用之前加类型守卫（body 校验在最前面，失败早退）：

```ts
    const custom = (body as { providers?: { dsh?: { customModels?: unknown } } })
      ?.providers?.dsh?.customModels;
    if (custom !== undefined
      && (!Array.isArray(custom) || custom.some((v) => typeof v !== 'string'))) {
      return res.status(400).json({ error: 'providers.dsh.customModels must be an array of strings' });
    }
```

插入位置（现有代码上下文）：

```ts
  router.put('/', (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'config body must be a JSON object' });
    }
    // ← 插在这里
    try {
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/config.routes.test.ts
```

预期：全部 PASS（原有 + 新增 2 个）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/config/config.ts backend/server/modules/config/config.routes.ts backend/server/modules/config/tests/config.routes.test.ts
git commit -m "feat(dsh): add providers.dsh.customModels config field with PUT type validation"
```

---

### Task 2: DshProviderModels 解析 customModels

**Files:**
- Modify: `backend/server/modules/providers/list/dsh/dsh-models.provider.ts`
- Create: `backend/server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts`。隔离手法照抄 `claude-models-config.test.ts`：动态 import + `LOVDEX_DATA_DIR` 指向临时目录（app.config 单例在首次 `appConfig()` 时读它；静态 import 链会在设 env 前触发模块加载，必须用 `await import`）：

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Hermetic config: point the app.config singleton at a temp dir BEFORE the
// provider module is imported (mirrors claude-models-config.test.ts; each
// node --test file runs in its own process).
const dataDir = mkdtempSync(path.join(tmpdir(), 'lovdex-dsh-cfg-'));
process.env.LOVDEX_DATA_DIR = dataDir;

const { appConfig } = await import('@/modules/config/config.js');
const { DshProviderModels, DSH_PREDEFINED_MODELS } = await import('../dsh-models.provider.js');

test('customModels entries are appended after the predefined list', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: { customModels: ['deepseek-official|glm-5.3', 'sophnet|kimi-k2|Kimi K2'] },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  const values = def.OPTIONS.map((o) => o.value);

  // 预定义 4 项在前、顺序不变
  assert.deepStrictEqual(
    values.slice(0, DSH_PREDEFINED_MODELS.OPTIONS.length),
    DSH_PREDEFINED_MODELS.OPTIONS.map((o) => o.value),
  );
  // 自定义条目用同款线格式，runner 原样下发
  assert.ok(values.includes('["deepseek-official","glm-5.3"]'));
  assert.ok(values.includes('["sophnet","kimi-k2"]'));

  const glm = def.OPTIONS.find((o) => o.value === '["deepseek-official","glm-5.3"]');
  assert.ok(glm, 'expected the glm-5.3 option');
  assert.strictEqual(glm.label, 'glm-5.3'); // 无第三段 → label 缺省用 model 名
  assert.strictEqual(glm.description, 'deepseek-official');
  assert.deepStrictEqual(glm.effort?.values.map((v) => v.value), ['off', 'low', 'high', 'max']);

  const kimi = def.OPTIONS.find((o) => o.value === '["sophnet","kimi-k2"]');
  assert.ok(kimi, 'expected the kimi-k2 option');
  assert.strictEqual(kimi.label, 'Kimi K2'); // 第三段 → 自定义 label
  assert.strictEqual(kimi.description, 'sophnet');

  // DEFAULT 不受 customModels 影响
  assert.strictEqual(def.DEFAULT, 'default');
});

test('malformed customModels entries are skipped, not fatal', async () => {
  const cfg = appConfig();
  cfg.update({
    providers: {
      dsh: {
        customModels: [
          '',                    // 空行
          'only-one-segment',    // 少于 2 段
          '|model-no-route',     // route 段为空
          'route-no-model|',     // model 段为空
          'deepseek-official|fine-model', // 合法
        ],
      },
    },
  });

  const def = await new DshProviderModels().getSupportedModels();
  const values = def.OPTIONS.map((o) => o.value);

  assert.ok(values.includes('["deepseek-official","fine-model"]'));
  assert.ok(!values.some((v) => v.includes('only-one-segment')));
  assert.ok(!values.some((v) => v.includes('model-no-route')));
  assert.ok(!values.some((v) => v.includes('route-no-model')));
  // 垃圾条目不改变预定义列表
  assert.ok(values.includes('["deepseek-official","deepseek-v4-pro"]'));
});

test('config save changes the list immediately — no restart', async () => {
  const cfg = appConfig();
  cfg.update({ providers: { dsh: { customModels: ['deepseek-official|glm-5.3'] } } });
  const before = await new DshProviderModels().getSupportedModels();
  assert.ok(before.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));

  cfg.update({ providers: { dsh: { customModels: ['sophnet|kimi-k2'] } } });
  const after = await new DshProviderModels().getSupportedModels();
  assert.ok(!after.OPTIONS.some((o) => o.value === '["deepseek-official","glm-5.3"]'));
  assert.ok(after.OPTIONS.some((o) => o.value === '["sophnet","kimi-k2"]'));
});

test('an empty or absent customModels leaves exactly the predefined list', async () => {
  const cfg = appConfig();
  cfg.update({ providers: { dsh: { customModels: [] } } });
  const def = await new DshProviderModels().getSupportedModels();
  assert.deepStrictEqual(
    def.OPTIONS.map((o) => o.value),
    DSH_PREDEFINED_MODELS.OPTIONS.map((o) => o.value),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts
```

预期：FAIL（`providers.dsh.customModels` 类型上不存在 → 编译错误；或解析逻辑不存在 → 断言失败）。

- [ ] **Step 3: 实现 dsh-models.provider.ts**

在 `backend/server/modules/providers/list/dsh/dsh-models.provider.ts` 做三处修改：

(a) 文件顶部 import 区（现有 `@/modules/config` 相关 import 若无则新增）：

```ts
import { appConfig } from '@/modules/config/config.js';
```

(b) 在 `DSH_PREDEFINED_MODELS` 定义之后新增解析函数（导出以便将来复用/单测直调）：

```ts
/**
 * Parse a `route|model[|label]` customModels entry into a picker option whose
 * value is the same `["route","model"]` wire format the predefined entries
 * use, so the runner forwards it unchanged. Malformed entries (fewer than two
 * segments, empty route/model) are skipped silently — dropping one line in the
 * settings textarea must not take the whole list down.
 */
export function buildDshCustomModelOptions(customModels: readonly string[] | undefined): ProviderModelOption[] {
  const out: ProviderModelOption[] = [];
  for (const raw of customModels ?? []) {
    const parts = raw.split('|').map((p) => p.trim());
    const [route, model, label] = parts;
    if (!route || !model) continue;
    out.push({
      value: JSON.stringify([route, model]),
      label: label || model,
      description: route,
      effort: DSH_EFFORT,
    });
  }
  return out;
}
```

(c) `getSupportedModels()` 改为合并：

```ts
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const custom = appConfig().get().providers.dsh.customModels;
    return {
      OPTIONS: [
        ...DSH_PREDEFINED_MODELS.OPTIONS,
        ...buildDshCustomModelOptions(custom),
      ],
      DEFAULT: DSH_PREDEFINED_MODELS.DEFAULT,
    };
  }
```

注意 `getCurrentActiveModel` 仍走 `buildDefaultProviderCurrentActiveModel(DSH_PREDEFINED_MODELS)`——它只需要 DEFAULT 槽位语义，自定义条目不改变"冷路径当前模型"的回答。保持不动。

- [ ] **Step 4: 跑测试确认通过（含原有 dsh-models.test.ts 回归）**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts server/modules/providers/list/dsh/tests/dsh-models.test.ts
```

预期：全部 PASS（新 4 个 + 原 4 个）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-models.provider.ts backend/server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts
git commit -m "feat(dsh): append customModels entries to the model picker catalog"
```

---

### Task 3: dsh 加入 UNCACHED_PROVIDERS

**Files:**
- Modify: `backend/server/modules/providers/services/provider-models.service.ts:21`
- Test: 新增用例进 `backend/server/modules/providers/services/tests/resolve-resume-model.test.ts` 同目录的合适位置——该目录没有 service 本体的直接测试文件，**新建** `backend/server/modules/providers/services/tests/provider-models-cache.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/providers/services/tests/provider-models-cache.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderModelsService } from '../provider-models.service.js';

test('dsh model lookups bypass the cache (config-derived, must reflect saves at once)', async (t) => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'lovdex-models-cache-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const cachePath = path.join(cacheDir, 'provider-models-cache.json');

  let callCount = 0;
  const service = createProviderModelsService({
    cachePath,
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => {
          callCount += 1;
          return { OPTIONS: [], DEFAULT: 'default' };
        },
      },
    }) as never,
  });

  await service.getProviderModels('dsh');
  await service.getProviderModels('dsh');
  assert.strictEqual(callCount, 2, 'dsh must hit the provider on every call');

  // 且不落盘：缓存文件不应被写出来
  assert.ok(!existsSync(cachePath), 'dsh lookups must not persist a cache entry');

  // 对照组：codex 仍走缓存（第二次调用复用第一次结果）
  let codexCalls = 0;
  const codexService = createProviderModelsService({
    cachePath,
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => {
          codexCalls += 1;
          return { OPTIONS: [], DEFAULT: 'default' };
        },
      },
    }) as never,
  });
  await codexService.getProviderModels('codex');
  await codexService.getProviderModels('codex');
  assert.strictEqual(codexCalls, 1, 'codex stays cached');
});
```

需要在文件顶部 import 里补 `existsSync`：

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
```

注意：对照组用独立的 `createProviderModelsService` 实例（内存缓存是实例级的），但 `cachePath` 同目录——codex 落盘的缓存文件不影响 dsh 断言（断言在 codex 之前执行）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/services/tests/provider-models-cache.test.ts
```

预期：FAIL——`callCount` 是 1 不是 2（dsh 当前走缓存），且 cachePath 文件被写出。

- [ ] **Step 3: 修改 UNCACHED_PROVIDERS**

`backend/server/modules/providers/services/provider-models.service.ts:21`：

```ts
// claude/dsh 的列表是从 app.config 每次重算的廉价本地计算（槽位/customModels），
// 缓存反而会让保存后的新列表 72h 不生效（TTL 见 PROVIDER_MODELS_CACHE_TTL_MS）。
// 其余 provider 的列表要 spawn CLI 探测，缓存才是收益。
const UNCACHED_PROVIDERS = new Set<LLMProvider>(['claude', 'dsh']);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/services/tests/provider-models-cache.test.ts server/modules/providers/services/tests/resolve-resume-model.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/services/provider-models.service.ts backend/server/modules/providers/services/tests/provider-models-cache.test.ts
git commit -m "feat(dsh): serve model lookups uncached so customModels edits apply immediately"
```

---

### Task 4: 配置档白名单（后端 + 前端）

**Files:**
- Modify: `backend/server/modules/config/provider-profiles.ts:32`
- Modify: `web/src/components/settings/providerProfiles.ts:37`
- Test: `backend/server/modules/config/tests/provider-profiles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/server/modules/config/tests/provider-profiles.test.ts` 追加两个用例：

```ts
test('dsh PROFILE_FIELDS includes customModels (dropping it would silently lose the list per-profile)', () => {
  assert.deepStrictEqual(PROFILE_FIELDS.dsh, ['baseUrl', 'apiKey', 'customModels']);
});

test('snapshotProviderFields carries dsh customModels by value', () => {
  const cfg = tmpCfg();
  cfg.update({
    providers: { dsh: { baseUrl: 'https://x', customModels: ['deepseek-official|glm-5.3'] } },
  });

  const snap = snapshotProviderFields(cfg.get(), 'dsh');
  assert.deepStrictEqual(snap.customModels, ['deepseek-official|glm-5.3']);

  (snap.customModels as string[]).push('mutated');
  assert.deepStrictEqual(
    cfg.get().providers.dsh.customModels,
    ['deepseek-official|glm-5.3'],
    'snapshot must be a copy, not a reference',
  );
});
```

同时把既有断言 `PROFILE_FIELDS` 的第一条测试（:24 只断言 claude）不动——dsh 的断言由新用例覆盖。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/provider-profiles.test.ts
```

预期：新用例 FAIL（`PROFILE_FIELDS.dsh` 还是 `['baseUrl', 'apiKey']`）。

- [ ] **Step 3: 改后端白名单**

`backend/server/modules/config/provider-profiles.ts:32`：

```ts
  // dsh（DeepSeek Harness）在设置页有自己的凭据区块（2026-10-12 加入，
  // 见 web/src/components/settings/ProviderSettingsPage.tsx 的 DeepSeek Section）。
  // customModels（2026-10-19）跟 baseUrl 一样随供应商走，属于一组凭据。
  dsh: ['baseUrl', 'apiKey', 'customModels'],
```

- [ ] **Step 4: 改前端 FORM_FIELDS**

`web/src/components/settings/providerProfiles.ts:37`：

```ts
  dsh: ['baseUrl', 'apiKey', 'customModels'],
```

注意该文件头注释的契约："这里必须是表单字段的全集且 ⊆ 后端的 PROFILE_FIELDS"——Task 5 会在表单渲染 customModels，两边同步完成。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/provider-profiles.test.ts
```

预期：全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/config/provider-profiles.ts web/src/components/settings/providerProfiles.ts backend/server/modules/config/tests/provider-profiles.test.ts
git commit -m "feat(dsh): include customModels in provider profile field whitelist"
```

---

### Task 5: 设置页 textarea

**Files:**
- Modify: `web/src/components/settings/ProviderSettingsPage.tsx`（DeepSeek Section :602-625；类型声明 :51；`patchProvider` :241）

前端无 DOM 测试环境（web 测试只覆盖纯函数，textarea 是直通渲染），本任务以 typecheck 为验收。

- [ ] **Step 1: 类型声明放宽 patchProvider + AppConfig**

(a) `:51` 的 dsh 类型：

```ts
  dsh?: { baseUrl?: string; apiKey?: string; customModels?: string[] };
```

(b) `patchProvider`（:241）签名放宽为 `string | string[]`（值仍是整字段替换，数组走 textarea 的行数组）：

```ts
  function patchProvider(provider: ProviderKey, field: string, value: string | string[]) {
```

函数体不变（`{ ...(providers[provider] ?? {}), [field]: value }` 对数组值同样成立）。

- [ ] **Step 2: DeepSeek Section 加 textarea**

在 `ProviderSettingsPage.tsx` 的 DeepSeek Section（`baseUrl` 的 TextField 之后、说明 `<p>` 之前）插入：

```tsx
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            自定义模型（customModels，每行一条 route|model[|label]）
          </label>
          <textarea
            className="min-h-[72px] w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={(dsh.customModels ?? []).join('\n')}
            placeholder={'deepseek-official|glm-5.3\nsophnet|kimi-k2|Kimi K2'}
            onChange={(e) =>
              patchProvider('dsh', 'customModels', e.target.value.split('\n'))
            }
          />
          <p className="mt-1 text-xs text-muted-foreground">
            追加到内置列表之后；route 如 deepseek-official，model 填端点实际服务的
            模型名。格式不对的行保存后会被忽略。
          </p>
        </div>
```

注意 split('\n') 保留空行（后端解析跳过；整体 PUT 后存的就是所见行数组，无静默过滤）。

- [ ] **Step 3: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck
cd ../backend && npm run typecheck
```

预期：两边报错数与改动前持平（baseline 不干净，零新增即可）。

- [ ] **Step 4: 手动冒烟（可选，用户在场时）**

改一行 customModels → 保存 → 打开聊天模型弹窗（dsh 会话）确认新条目出现。这步需要后端运行新代码；不主动重启，交给用户决定。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/settings/ProviderSettingsPage.tsx
git commit -m "feat(dsh): settings textarea for customModels picker entries"
```

---

### Task 6: 回归 + 收尾

**Files:** 无新改动（只跑验证）

- [ ] **Step 1: 后端相关模块全量回归**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/config/tests/config.routes.test.ts \
  server/modules/config/tests/config.test.ts \
  server/modules/config/tests/provider-profiles.test.ts \
  server/modules/config/tests/provider-profiles.routes.test.ts \
  server/modules/providers/list/dsh/tests/dsh-models.test.ts \
  server/modules/providers/list/dsh/tests/dsh-models-custom.test.ts \
  server/modules/providers/services/tests/provider-models-cache.test.ts \
  server/modules/providers/services/tests/resolve-resume-model.test.ts
```

预期：全部 PASS。

- [ ] **Step 2: typecheck 零新增确认**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | grep -c "error TS"
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | grep -c "error TS"
```

预期：backend ≤ 6、web = 0（2026-10-19 实测 baseline）。

- [ ] **Step 3: 更新 spec 状态（可选）**

`docs/superpowers/specs/2026-10-19-dsh-custom-models-design.md` 状态行改为"已实现"（参照 git-panel spec 的做法，如用户希望保持记录习惯）。

- [ ] **Step 4: 最终 commit（如有 spec 状态更新）**

```bash
cd /mnt/b/workdir/github/lovdex
git add docs/superpowers/specs/2026-10-19-dsh-custom-models-design.md
git commit -m "docs(dsh): mark customModels spec implemented"
```
