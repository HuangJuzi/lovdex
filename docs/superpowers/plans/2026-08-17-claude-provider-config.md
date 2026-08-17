# Claude Provider 全量配置化 + 实时生效 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claude provider 的 ANTHROPIC_BASE_URL / authToken / 模型别名全部收进 app.config.json，Web 设置页可改，保存对新会话实时生效，config 为唯一来源。

**Architecture:** 配置文件 `~/.lovdex/data/app.config.json` 增加 5 个 claude 字段，`syncProviderEnv` 升级为权威语义（非空写 / 空删除）并导出所拥有的 env key 表；supervisor 启动时过滤这些 key 不再注入；模型列表从"模块加载时读 env 快照"改为"每次调用从 config 重建"；Web 设置页拆出表单组件并新增字段，从侧边栏以模态浮层打开（复用现有 Dialog 原语）。

**Tech Stack:** Node.js (node:test + node --test --import tsx) 后端；React/React Router 前端（无前端单测框架，用 typecheck/build 验证）。

**工作目录:** 后端命令在 `backend/` 下执行，前端在 `web/` 下执行，仓库根为 `/mnt/b/workdir/github/lovdex/lovdex`。

---

## 文件结构

- `backend/server/modules/config/config.ts` — 配置 schema（+5 字段）
- `backend/server/modules/config/env-sync.ts` — 权威 env 同步 + `OWNED_ANTHROPIC_ENV`
- `backend/server/modules/config/tests/env-sync.test.ts` / `config.test.ts` — 测试（扩展）
- `supervisor/env-filter.mjs` — 过滤函数（新文件，可测）
- `supervisor/env-filter.test.mjs` — 过滤测试（新文件）
- `supervisor/supervisor.mjs` — 应用过滤
- `backend/server/modules/providers/list/claude/claude-models.provider.ts` — 动态模型列表
- `backend/server/modules/providers/list/claude/tests/claude-models-config.test.ts` — 新测试（新文件，自包含 dataDir）
- `backend/server/claude-sdk.js` — 引用 `getClaudeFallbackModels()`
- `web/src/components/settings/ProviderSettingsPage.tsx` — 拆 `<ProviderSettingsForm>` + 新字段
- `web/src/hooks/useSettingsDialog.tsx` — 模态状态 Context（新文件，仿 useTerminalDrawer）
- `web/src/components/settings/SettingsDialog.tsx` — 模态壳（新文件）
- `web/src/App.tsx` — 挂 Provider + `<SettingsDialog />`
- `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx` — 齿轮改开模态

---

## Task 1: config schema 增加 5 个 claude provider 字段

**Files:**
- Modify: `backend/server/modules/config/config.ts:28-36`
- Test: `backend/server/modules/config/tests/config.test.ts`

- [ ] **Step 1.1: 写失败测试**

在 `backend/server/modules/config/tests/config.test.ts` 末尾追加：

```ts
test('claude provider defaults include baseUrl and model alias fields', () => {
  const cfg = createAppConfig({ dataDir: tmpDir() });
  const claude = cfg.get().providers.claude;
  assert.strictEqual(claude.baseUrl, '');
  assert.strictEqual(claude.defaultModel, '');
  assert.strictEqual(claude.haikuModel, '');
  assert.strictEqual(claude.opusModel, '');
  assert.strictEqual(claude.sonnetModel, '');
});

test('claude model alias fields survive deep merge and persist', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({
    providers: { claude: { baseUrl: 'https://proxy.example/anthropic', defaultModel: 'm-default', sonnetModel: 'm-sonnet' } },
  });
  assert.strictEqual(cfg.get().providers.claude.baseUrl, 'https://proxy.example/anthropic');
  assert.strictEqual(cfg.get().providers.claude.sonnetModel, 'm-sonnet');
  // sibling untouched by partial update
  assert.strictEqual(cfg.get().providers.claude.haikuModel, '');
  // persisted to disk
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'app.config.json'), 'utf8'));
  assert.strictEqual(onDisk.providers.claude.defaultModel, 'm-default');
});
```

- [ ] **Step 1.2: 运行确认失败**

Run (cwd=`backend/`): `node --test --import tsx server/modules/config/tests/config.test.ts`
Expected: FAIL — `claude.baseUrl` is `undefined`（`ERR_ASSERTION`）.

- [ ] **Step 1.3: 实现**

在 `backend/server/modules/config/config.ts`（约 29-36 行）的 `providers.claude` 增加 `baseUrl`、`defaultModel`、`haikuModel`、`opusModel`、`sonnetModel`（保留原有字段、注释与顺序）：

```ts
    claude: {
      cliPath: 'claude',
      apiKey: '',
      authToken: '',
      baseUrl: '',
      defaultModel: '',
      haikuModel: '',
      opusModel: '',
      sonnetModel: '',
      oneMillionModels: '',
      streamCloseTimeoutMs: 10000,
      toolApprovalTimeoutMs: 60000,
    },
```

- [ ] **Step 1.4: 运行确认通过**

Run: `node --test --import tsx server/modules/config/tests/config.test.ts`
Expected: PASS, `# pass 8`

- [ ] **Step 1.5: 提交**

```bash
git add backend/server/modules/config/config.ts backend/server/modules/config/tests/config.test.ts
git commit -m "feat(config): add claude baseUrl + model alias fields to schema"
```

---

## Task 2: env-sync 权威语义 + OWNED_ANTHROPIC_ENV

**Files:**
- Modify: `backend/server/modules/config/env-sync.ts`
- Test: `backend/server/modules/config/tests/env-sync.test.ts`

设计要点：新增字段（baseUrl/authToken/defaultModel/别名）与 cliPath 用"非空写 / 空删除"权威语义；`apiKey` 保持旧的"非空才写"（避免覆盖 `opencode.apiKeys` 容器里共享的 `ANTHROPIC_API_KEY`，见原文件注释）。`OWNED_ANTHROPIC_ENV` 导出后 supervisor 用。

- [ ] **Step 2.1: 写失败测试**

替换 `backend/server/modules/config/tests/env-sync.test.ts` 的 `TOUCHED_KEYS` 并追加测试（保留原有两段 import 与第一个测试不变，`TOUCHED_KEYS` 换为下面这行）：

```ts
const TOUCHED_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CLI_PATH',
  'QODER_PERSONAL_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENCODE_BIN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
];
```

在文件末尾追加（注意顶部 import 要加 `OWNED_ANTHROPIC_ENV`）：

```ts
test('claude baseUrl/model fields write env authoritatively (+_NAME mirrors)', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir });
    cfg.update({
      providers: {
        claude: {
          baseUrl: 'https://proxy.example/anthropic',
          authToken: 'tok-1',
          defaultModel: 'model-default',
          haikuModel: 'model-haiku',
          opusModel: 'model-opus',
          sonnetModel: 'model-sonnet',
        },
      },
    });
    syncProviderEnv(cfg.get());

    assert.strictEqual(process.env.ANTHROPIC_BASE_URL, 'https://proxy.example/anthropic');
    assert.strictEqual(process.env.ANTHROPIC_AUTH_TOKEN, 'tok-1');
    assert.strictEqual(process.env.ANTHROPIC_MODEL, 'model-default');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'model-haiku');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, 'model-haiku');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'model-opus');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'model-opus');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'model-sonnet');
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'model-sonnet');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('cleared claude fields DELETE owned env (config is the only source)', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.ANTHROPIC_BASE_URL = 'stale';
    process.env.ANTHROPIC_AUTH_TOKEN = 'stale';
    process.env.ANTHROPIC_MODEL = 'stale';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'stale';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = 'stale';
    process.env.CLAUDE_CLI_PATH = 'stale';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir }); // all claude fields default ''
    syncProviderEnv(cfg.get());

    assert.strictEqual(process.env.ANTHROPIC_BASE_URL, undefined);
    assert.strictEqual(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.strictEqual(process.env.ANTHROPIC_MODEL, undefined);
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.strictEqual(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
    assert.strictEqual(process.env.CLAUDE_CLI_PATH, undefined);

    // apiKey is legacy non-empty-only: host value survives an empty config
    process.env.ANTHROPIC_API_KEY = 'host-key';
    syncProviderEnv(cfg.get());
    assert.strictEqual(process.env.ANTHROPIC_API_KEY, 'host-key');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('claude cliPath: custom value writes CLAUDE_CLI_PATH, default deletes', () => {
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir });
    cfg.update({ providers: { claude: { cliPath: '/opt/claude/bin/claude' } } });
    syncProviderEnv(cfg.get());
    assert.strictEqual(process.env.CLAUDE_CLI_PATH, '/opt/claude/bin/claude');

    cfg.update({ providers: { claude: { cliPath: 'claude' } } });
    syncProviderEnv(cfg.get());
    assert.strictEqual(process.env.CLAUDE_CLI_PATH, undefined);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('OWNED_ANTHROPIC_ENV lists all claude-owned env keys incl _NAME mirrors', () => {
  const expected = [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL', 'CLAUDE_CLI_PATH',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  ];
  assert.deepStrictEqual([...OWNED_ANTHROPIC_ENV].sort(), [...expected].sort());
  assert.strictEqual(OWNED_ANTHROPIC_ENV.length, 11);
});
```

- [ ] **Step 2.2: 运行确认失败**

Run (cwd=`backend/`): `node --test --import tsx server/modules/config/tests/env-sync.test.ts`
Expected: FAIL — 新测试 `undefined !== 'https://proxy.example/anthropic'` 等（旧的 1 个测试仍通过）。

- [ ] **Step 2.3: 实现**

`env-sync.ts` 顶部注释改为（替换原顶部 JSDoc）：

```ts
/**
 * Syncs provider credentials from app.config back into process.env.
 *
 * SDK subprocesses (claude/codex/opencode/qoder CLIs) receive credentials by
 * inheriting process.env (`sdkOptions.env = { ...process.env }`). Config is the
 * SINGLE source of truth for the claude provider's runtime knobs, so the
 * claude section below makes process.env match app.config authoritatively:
 * non-empty values are (trimmed and) written, empty values DELETE their env
 * var — a cleared field really turns the knob off, overriding hostenv (e.g.
 * .bashrc injected by the supervisor). providers.claude.apiKey is the
 * exception (legacy non-empty-only) so an empty field never clobbers an
 * ANTHROPIC_API_KEY another provider shares via opencode.apiKeys. Everything
 * else (codex/opencode/qoder) keeps the legacy non-empty-only semantics.
 */
```

导入处保持 `import type { AppConfig } from './config.js';`，然后在 import 后追加：

```ts
/** Every env var owned by `providers.claude` config. The supervisor filters
 * exactly this set out of the shell env it injects so config stays the sole
 * source — keep in sync with supervisor/env-filter.mjs. */
export const OWNED_ANTHROPIC_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CLI_PATH',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
] as const;
```

替换 `syncProviderEnv` 整个函数体为：

```ts
export function syncProviderEnv(cfg: AppConfig): void {
  const { providers } = cfg;

  // opencode — a per-env credential map that can reference keys shared with
  // other providers (e.g. ANTHROPIC_API_KEY). Process it FIRST so the
  // dedicated per-provider fields below (qoder.PAT, ...) always take
  // precedence on a key collision. Values are trimmed so whitespace-only
  // entries don't become junk env keys the auth logic (which trims) won't
  // believe in. (Legacy: non-empty only, never deletes.)
  for (const [key, value] of Object.entries(providers.opencode.apiKeys)) {
    if (value?.trim()) process.env[key] = value.trim();
  }

  // claude — authoritative: process.env matches config exactly.
  const c = providers.claude;
  setOrDelete('ANTHROPIC_BASE_URL', c.baseUrl);
  // apiKey keeps legacy non-empty-only semantics: an empty field must not
  // clobber an ANTHROPIC_API_KEY another provider shares via opencode.apiKeys.
  if (c.apiKey?.trim()) process.env.ANTHROPIC_API_KEY = c.apiKey.trim();
  setOrDelete('ANTHROPIC_AUTH_TOKEN', c.authToken);
  setOrDelete('ANTHROPIC_MODEL', c.defaultModel);
  // Alias aliases write BOTH the MODEL and MODEL_NAME mirrors (the CLI reads
  // the _NAME variant on new versions and the plain one on old; both must
  // point at the same real model id).
  setOrDelete('ANTHROPIC_DEFAULT_HAIKU_MODEL', c.haikuModel);
  setOrDelete('ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', c.haikuModel);
  setOrDelete('ANTHROPIC_DEFAULT_OPUS_MODEL', c.opusModel);
  setOrDelete('ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', c.opusModel);
  setOrDelete('ANTHROPIC_DEFAULT_SONNET_MODEL', c.sonnetModel);
  setOrDelete('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', c.sonnetModel);
  // cliPath: the default 'claude' means "resolve from PATH" — never leave an
  // env override pointing at a stale path.
  setOrDelete('CLAUDE_CLI_PATH', c.cliPath && c.cliPath.trim() !== 'claude' ? c.cliPath : '');

  // qoder (legacy, non-empty only)
  if (providers.qoder.personalAccessToken?.trim()) {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = providers.qoder.personalAccessToken.trim();
  }
  // binaries (legacy, non-empty only)
  if (providers.codex.binPath?.trim() && providers.codex.binPath.trim() !== 'codex') {
    process.env.CODEX_PATH_OVERRIDE = providers.codex.binPath.trim();
  }
  if (providers.opencode.binPath?.trim() && providers.opencode.binPath.trim() !== 'opencode') {
    process.env.OPENCODE_BIN = providers.opencode.binPath.trim();
  }
}

/** Writes a trimmed value, or deletes the env var when the value is empty. */
function setOrDelete(key: string, value: string | undefined): void {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v) process.env[key] = v;
  else delete process.env[key];
}
```

- [ ] **Step 2.4: 运行确认通过**

Run: `node --test --import tsx server/modules/config/tests/env-sync.test.ts`
Expected: PASS, `# pass 5`

Run 全配置测试做回归：`node --test --import tsx server/modules/config/tests/config.test.ts` → PASS `# pass 7`

- [ ] **Step 2.5: 提交**

```bash
git add backend/server/modules/config/env-sync.ts backend/server/modules/config/tests/env-sync.test.ts
git commit -m "feat(config): authoritative env-sync for claude knobs + OWNED_ANTHROPIC_ENV"
```

---

## Task 3: supervisor 过滤 env（独立模块 + 测试）

**Files:**
- Create: `supervisor/env-filter.mjs`
- Create: `supervisor/env-filter.test.mjs`
- Modify: `supervisor/supervisor.mjs`（SHELL_ENV 注释、childEnv、import）

- [ ] **Step 3.1: 写失败测试**

新建 `supervisor/env-filter.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert'
import { filterOwnedAnthropicEnv, OWNED_ANTHROPIC_ENV } from './env-filter.mjs'

test('filter removes owned ANTHROPIC_* keys but keeps everything else', () => {
  const input = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'keep',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_BASE_URL: 'drop',
    ANTHROPIC_MODEL: 'drop',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'drop',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'drop',
    CLAUDE_CLI_PATH: 'drop',
  }
  const out = filterOwnedAnthropicEnv(input)
  assert.strictEqual(out.PATH, '/usr/bin')
  assert.strictEqual(out.OPENAI_API_KEY, 'keep')
  assert.strictEqual(out.DISABLE_AUTOUPDATER, '1')
  for (const key of Object.keys(input)) {
    if (!['PATH', 'OPENAI_API_KEY', 'DISABLE_AUTOUPDATER'].includes(key)) {
      assert.strictEqual(out[key], undefined, `expected ${key} to be filtered`)
    }
  }
})

test('OWNED_ANTHROPIC_ENV has 11 keys including _NAME mirrors', () => {
  assert.strictEqual(OWNED_ANTHROPIC_ENV.length, 11)
  assert.ok(OWNED_ANTHROPIC_ENV.includes('ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'))
  assert.ok(OWNED_ANTHROPIC_ENV.includes('ANTHROPIC_BASE_URL'))
  assert.ok(OWNED_ANTHROPIC_ENV.includes('CLAUDE_CLI_PATH'))
})
```

- [ ] **Step 3.2: 运行确认失败**

Run (cwd 仓库根): `node --test --import tsx supervisor/env-filter.test.mjs`
Expected: FAIL — `Cannot find module './env-filter.mjs'`。

- [ ] **Step 3.3: 实现**

新建 `supervisor/env-filter.mjs`：

```js
// Env keys owned by backend app.config providers.claude — mirror of
// backend/server/modules/config/env-sync.ts OWNED_ANTHROPIC_ENV (keep in sync).
// The supervisor strips these from the shell env it injects into children so
// app.config.json is the single source of truth; a cleared config field really
// clears, and editing ~/.bashrc no longer affects the lovdex services.
export const OWNED_ANTHROPIC_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CLI_PATH',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
]

export function filterOwnedAnthropicEnv(env) {
  const owned = new Set(OWNED_ANTHROPIC_ENV)
  const out = { ...env }
  for (const key of Object.keys(out)) {
    if (owned.has(key)) delete out[key]
  }
  return out
}
```

修改 `supervisor/supervisor.mjs`：

1. import 区（第 5 行后）追加：`import { filterOwnedAnthropicEnv } from './env-filter.mjs'`
2. 把第 24-32 行注释块更新为：

```js
// systemd user services never source ~/.bashrc, and since the backend config
// (app.config.json) is now the single source of truth for the claude provider
// (base URL / auth token / model aliases — see env-sync), we no longer inject
// those here at all. The `.bashrc`/cc() exports still matter for interactive
// `claude` in a terminal; the lovdex children just don't need them. We still
// capture the rest of the shell env (PATH, OPENAI_* for codex/opencode,
// DISABLE_AUTOUPDATER, ...) because some of it used to live in .bashrc.
```

3. 修改 `childEnv()` 的合并：

```js
function childEnv() {
  // Shell-captured env supplies non-claude host settings (PATH, OPENAI_*, ...)
  // but the ANTHROPIC_* / CLAUDE_CLI_PATH owned by app.config are always
  // stripped, whether they came from the shell or from our own process.env,
  // so the backend boots clean and config alone decides.
  const base = Object.keys(SHELL_ENV).length > 0
    ? filterOwnedAnthropicEnv({ ...process.env, ...SHELL_ENV })
    : filterOwnedAnthropicEnv(process.env)
  const prev = base.PATH || ''
  return { ...base, PATH: prev.includes(nodeBin) ? prev : `${nodeBin}:${prev}` }
}
```

- [ ] **Step 3.4: 运行确认通过**

Run: `node --test --import tsx supervisor/env-filter.test.mjs`
Expected: PASS, `# pass 2`

语法检查：`node --check supervisor/supervisor.mjs` → 无输出（exit 0）。

- [ ] **Step 3.5: 提交**

```bash
git add supervisor/env-filter.mjs supervisor/env-filter.test.mjs supervisor/supervisor.mjs
git commit -m "feat(supervisor): strip app.config-owned ANTHROPIC_* env from children"
```

---

## Task 4: 模型列表动态化（每次调用从 config 重建）

**Files:**
- Modify: `backend/server/modules/providers/list/claude/claude-models.provider.ts`
- Modify: `backend/server/claude-sdk.js`（5 处引用 + import）
- Create: `backend/server/modules/providers/list/claude/tests/claude-models-config.test.ts`

- [ ] **Step 4.1: 写失败测试**

新建 `backend/server/modules/providers/list/claude/tests/claude-models-config.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Hermetic config: point the app.config singleton at a temp dir BEFORE the
// provider module is imported (its module top level must not touch appConfig —
// enforced by this test). Each node --test file runs in its own process.
const dataDir = mkdtempSync(path.join(tmpdir(), 'lovdex-claude-cfg-'));
process.env.LOVDEX_DATA_DIR = dataDir;

const { createAppConfig } = await import('@/modules/config/config.js');
const { getClaudeFallbackModels, ClaudeProviderModels } = await import('../claude-models.provider.js');

test('model options rebuild from current app.config on each call', async () => {
  const cfg = createAppConfig();
  cfg.update({
    providers: {
      claude: {
        defaultModel: 'model-a',
        opusModel: 'opus-b',
        sonnetModel: 'sonnet-c',
        haikuModel: 'haiku-d',
      },
    },
  });

  const first = getClaudeFallbackModels();
  const values = new Set(first.OPTIONS.map((o) => o.value));
  assert.ok(values.has('default'));
  assert.ok(values.has('opus'));
  assert.ok(values.has('sonnet'));
  assert.ok(values.has('haiku'));
  assert.ok(values.has('model-a')); // trailing "Custom model" entry for defaultModel
  assert.strictEqual(first.OPTIONS.find((o) => o.value === 'opus')?.label, 'opus-b');
  assert.strictEqual(first.OPTIONS.find((o) => o.value === 'haiku')?.label, 'haiku-d');
  assert.strictEqual(first.DEFAULT, 'default');

  // same dynamic source drives getSupportedModels (what the UI dropdown hits)
  const provider = new ClaudeProviderModels();
  const supported = await provider.getSupportedModels();
  assert.strictEqual(supported.OPTIONS.find((o) => o.value === 'sonnet')?.label, 'sonnet-c');

  // a config save changes the list immediately — no restart/reload
  cfg.update({ providers: { claude: { sonnetModel: 'sonnet-9' } } });
  const after = getClaudeFallbackModels();
  assert.strictEqual(after.OPTIONS.find((o) => o.value === 'sonnet')?.label, 'sonnet-9');
});
```

- [ ] **Step 4.2: 运行确认失败**

Run (cwd=`backend/`): `node --test --import tsx server/modules/providers/list/claude/tests/claude-models-config.test.ts`
Expected: FAIL — `SyntaxError`（`getClaudeFallbackModels` 未导出，或顶层读出 env 旧实现导致断言失败）。

- [ ] **Step 4.3: 实现（claude-models.provider.ts）**

把 `claude-models.provider.ts` 顶部（第 25-128 行之间）的 env 读取与静态 `CLAUDE_FALLBACK_MODELS` 全部替换为：

```ts
// Model options now come from app.config providers.claude (env is driven by
// config authoritatively — see env-sync). Built per call so a settings-page
// save shows up immediately in the model dropdown and effort validation
// without a restart.
function buildClaudeModelOptions(): ProviderModelOption[] {
  const cfg = appConfig().get().providers.claude;
  const oneMillion = new Set(
    (cfg.oneMillionModels ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  const tag1m = (real: string | null): string =>
    real && oneMillion.has(real) ? ' [1m]' : '';
  const envDefault = cfg.defaultModel?.trim() || null;
  const envOpus = cfg.opusModel?.trim() || null;
  const envSonnet = cfg.sonnetModel?.trim() || null;
  const envHaiku = cfg.haikuModel?.trim() || null;

  const options: ProviderModelOption[] = [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: envDefault
        ? `Use the default model (currently ${envDefault}${tag1m(envDefault)})`
        : 'Use the Claude Code default model',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus',
      label: `${envOpus ?? 'Opus'}${tag1m(envOpus)}`,
      description: envOpus ? 'Custom Opus model' : 'Opus (未配置)',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet',
      label: `${envSonnet ?? 'Sonnet'}${tag1m(envSonnet)}`,
      description: envSonnet ? 'Custom Sonnet model' : 'Sonnet (未配置)',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'haiku',
      label: `${envHaiku ?? 'Haiku'}${tag1m(envHaiku)}`,
      description: envHaiku ? 'Custom Haiku model' : 'Haiku (未配置)',
    },
  ];

  // Trailing "Custom model" entry for defaultModel (mirrors CLI item 5).
  if (envDefault) {
    options.push({
      value: envDefault,
      label: `${envDefault}${tag1m(envDefault)}`,
      description: 'Custom model',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    });
  }
  return options;
}

export function getClaudeFallbackModels(): ProviderModelsDefinition {
  return { OPTIONS: buildClaudeModelOptions(), DEFAULT: 'default' };
}
```

删除上面的 `CLAUDE_FALLBACK_MODELS` / `loadOneMillionModels` / `tag1m` / `resolveEnvModel` / `envDefault` 等旧常量的同时，更新这两处引用：

- `findClaudeModelOption` 内：`return CLAUDE_FALLBACK_MODELS.OPTIONS.find(...)` → `return getClaudeFallbackModels().OPTIONS.find(...)`（第 130-137 行处）
- `getSupportedModels` 内：`return CLAUDE_FALLBACK_MODELS;` → `return getClaudeFallbackModels();`（第 260 行处）

- [ ] **Step 4.4: 实现（claude-sdk.js 引用更新）**

`backend/server/claude-sdk.js` 5 处 + import：

1. 第 23 行：`import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';` → `import { getClaudeFallbackModels } from './modules/providers/list/claude/claude-models.provider.js';`
2. 第 53 行：`function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {` → `function resolveClaudeEffort(model, effort, modelsDefinition = getClaudeFallbackModels()) {`
3. 第 217 行：`sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;` → `sdkOptions.model = options.model || getClaudeFallbackModels().DEFAULT;`
4. 第 222 行：`options.effortModels || CLAUDE_FALLBACK_MODELS,` → `options.effortModels || getClaudeFallbackModels(),`
5. 第 559 行：`let effortModels = CLAUDE_FALLBACK_MODELS;` → `let effortModels = getClaudeFallbackModels();`
6. 第 1203 行：`model: cfg.model || CLAUDE_FALLBACK_MODELS.DEFAULT,` → `model: cfg.model || getClaudeFallbackModels().DEFAULT,`

- [ ] **Step 4.5: 运行确认通过**

Run: `node --test --import tsx server/modules/providers/list/claude/tests/claude-models-config.test.ts` → PASS `# pass 1`
Run 回归: `node --test --import tsx server/modules/providers/list/claude/tests/claude-models.test.ts` → PASS `# pass 2`
Run: `npm run typecheck`（cwd=`backend/`）→ exit 0

- [ ] **Step 4.6: 提交**

```bash
git add backend/server/modules/providers/list/claude/claude-models.provider.ts backend/server/claude-sdk.js backend/server/modules/providers/list/claude/tests/claude-models-config.test.ts
git commit -m "feat(providers): rebuild claude model list from app.config per call"
```

---

## Task 5: Web — 抽取 ProviderSettingsForm + 新增字段

**Files:**
- Modify: `web/src/components/settings/ProviderSettingsPage.tsx`

- [ ] **Step 5.1: 改写文件**

顶层注释更新为（保留原语义 + 模态说明）：

```tsx
/**
 * Provider 凭据 + 运行参数设置。
 *
 * 表单主体是 <ProviderSettingsForm />：既被 /settings/providers 路由页渲染，
 * 也被侧边栏齿轮打开的模态 <SettingsDialog /> 渲染，两个入口共用同一份
 * draft 加载/保存逻辑。
 *
 * 后端 `GET /api/config`（匿名、密钥打码）读、`PUT /api/config`（需登录）写。
 * GET 回来的密钥是打码占位（`••••abcd`）；PUT 时后端 `stripMaskedPlaceholders`
 * 会丢弃任何以 `••••` 开头的字段，因此这里可以把整个 draft 原样 PUT。
 *
 * 保存后后端 re-sync process.env（权威语义），模型 / Base URL / 凭据对新起的
 * session 立即生效；端口 / host / 数据库路径需重启后端才生效。
 */
```

然后在 Types 处把 `ProvidersConfig` 扩展为：

```tsx
type ProvidersConfig = {
  claude?: {
    cliPath?: string;
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
    defaultModel?: string;
    haikuModel?: string;
    opusModel?: string;
    sonnetModel?: string;
    oneMillionModels?: string;
  };
  codex?: { binPath?: string; apiKey?: string };
  opencode?: { binPath?: string };
  qoder?: { personalAccessToken?: string };
};
```

保存成功文案（原第 233 行）改为：

```tsx
setSavedMsg('已保存。模型 / Base URL / 凭据对新会话立即生效；端口 / 数据库路径 / host 修改需重启后端生效。');
```

页面主体结构改为（见 Step 5.2 完整文件）：`ProviderSettingsPage` 只保留页面壳并渲染 `<ProviderSettingsForm />`；原 `draft`/load/save 全套逻辑移进 `ProviderSettingsForm`；loadError 分支改为内联小容器（模态里不适合 h-dvh 全屏）。Claude 区块在 authToken 之后、oneMillionModels 之前插入 5 个字段：

```tsx
<TextField
  label="Base URL (baseUrl)"
  value={claude.baseUrl ?? ''}
  placeholder="https://api.anthropic.com"
  onChange={(v) => patchProvider('claude', 'baseUrl', v)}
/>
<TextField
  label="默认模型 (defaultModel)"
  value={claude.defaultModel ?? ''}
  placeholder="DeepSeek-V4-Flash-0731"
  onChange={(v) => patchProvider('claude', 'defaultModel', v)}
/>
<TextField
  label="Opus 模型 (opusModel)"
  value={claude.opusModel ?? ''}
  placeholder="DeepSeek-V4-Pro-0813"
  onChange={(v) => patchProvider('claude', 'opusModel', v)}
/>
<TextField
  label="Sonnet 模型 (sonnetModel)"
  value={claude.sonnetModel ?? ''}
  placeholder="claude-opus-4-8"
  onChange={(v) => patchProvider('claude', 'sonnetModel', v)}
/>
<TextField
  label="Haiku 模型 (haikuModel)"
  value={claude.haikuModel ?? ''}
  placeholder="DeepSeek-V4-Flash-0731"
  onChange={(v) => patchProvider('claude', 'haikuModel', v)}
/>
```

- [ ] **Step 5.2: 完整新文件内容**

`web/src/components/settings/ProviderSettingsPage.tsx` 全部内容替换为：

```tsx
import { useEffect, useState, type ReactNode } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';
import { BackToTasksButton } from '../tasks/TaskBackNav';

/**
 * Provider 凭据 + 运行参数设置。
 *
 * 表单主体是 <ProviderSettingsForm />：既被 /settings/providers 路由页渲染，
 * 也被侧边栏齿轮打开的模态 <SettingsDialog /> 渲染，两个入口共用同一份
 * draft 加载/保存逻辑。
 *
 * 后端 `GET /api/config`（匿名、密钥打码）读、`PUT /api/config`（需登录）写。
 * GET 回来的密钥是打码占位（`••••abcd`）；PUT 时后端 `stripMaskedPlaceholders`
 * 会丢弃任何以 `••••` 开头的字段，因此这里可以把整个 draft 原样 PUT。
 *
 * 保存后后端 re-sync process.env（权威语义），模型 / Base URL / 凭据对新起的
 * session 立即生效；端口 / host / 数据库路径需重启后端才生效。
 */

const MASK_PREFIX = '••••';

// ---- config shape (partial; we only touch what the page edits) ----
type ProvidersConfig = {
  claude?: {
    cliPath?: string;
    apiKey?: string;
    authToken?: string;
    baseUrl?: string;
    defaultModel?: string;
    haikuModel?: string;
    opusModel?: string;
    sonnetModel?: string;
    oneMillionModels?: string;
  };
  codex?: { binPath?: string; apiKey?: string };
  opencode?: { binPath?: string };
  qoder?: { personalAccessToken?: string };
};
type ServerConfig = { port?: number; host?: string; corsOrigin?: string };
type AppConfig = {
  providers?: ProvidersConfig;
  server?: ServerConfig;
  [k: string]: unknown;
};

type ProviderKey = 'claude' | 'codex' | 'opencode' | 'qoder';

type AuthStatusData = {
  installed?: boolean;
  authenticated?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
};

/** 单个 provider 的实时认证状态行；自带 useEffect 拉取。 */
function AuthStatus({ provider }: { provider: ProviderKey }) {
  const [status, setStatus] = useState<AuthStatusData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/providers/${provider}/auth/status`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const json = await res.json();
        // envelope: { data: { installed, authenticated, ... } } 或裸对象
        const data = (json?.data ?? json) as AuthStatusData;
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (failed) {
    return <span className="text-xs text-muted-foreground">认证状态未知</span>;
  }
  if (!status) {
    return <span className="text-xs text-muted-foreground">检测中…</span>;
  }
  if (status.authenticated) {
    const detail = status.method || status.email;
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        已认证{detail ? `（${detail}）` : ''}
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      {status.error ?? '未认证'}
    </span>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <input
        className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  const isMasked = value.startsWith(MASK_PREFIX);
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type={show ? 'text' : 'password'}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
          value={value}
          placeholder={isMasked ? '已配置（留空不变）' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="h-9 flex-shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted"
        >
          {show ? '隐藏' : '显示'}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  provider,
  children,
}: {
  title: string;
  provider?: ProviderKey;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {provider && <AuthStatus provider={provider} />}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** 设置表单主体：路由页与模态共用（draft 加载 / 保存 / 渲染）。 */
export function ProviderSettingsForm() {
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/config')
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const cfg = (await res.json()) as AppConfig;
        if (!cancelled) setDraft(cfg);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Patch a nested provider field, cloning along the way so state stays immutable.
  function patchProvider(provider: ProviderKey, field: string, value: string) {
    setSavedMsg(null);
    setDraft((prev) => {
      if (!prev) return prev;
      const providers = { ...(prev.providers ?? {}) };
      providers[provider] = { ...(providers[provider] ?? {}), [field]: value };
      return { ...prev, providers };
    });
  }

  function patchServer(field: keyof ServerConfig, value: string | number) {
    setSavedMsg(null);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, server: { ...(prev.server ?? {}), [field]: value } };
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      // Send the whole draft as-is: the backend strips `••••`-prefixed masked
      // values so real secrets are preserved. No client-side masking handling.
      const res = await api.put('/config', draft);
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error?.message ?? err?.error ?? `保存失败（${res.status}）`);
        return;
      }
      const cfg = (await res.json()) as AppConfig;
      setDraft(cfg);
      setSavedMsg('已保存。模型 / Base URL / 凭据对新会话立即生效；端口 / 数据库路径 / host 修改需重启后端生效。');
    } catch (err) {
      setSaveError((err as Error).message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <div className="text-sm text-muted-foreground">加载配置失败</div>
        <Button size="sm" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }
  if (!draft) {
    return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  const claude = draft?.providers?.claude ?? {};
  const codex = draft?.providers?.codex ?? {};
  const opencode = draft?.providers?.opencode ?? {};
  const qoder = draft?.providers?.qoder ?? {};
  const server = draft?.server ?? {};

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-muted-foreground">
        密钥以打码形式显示（<code>••••</code> 开头）；留空或保持打码占位则不改动真实值。
        Base URL / 凭据 / 模型保存后对新会话立即生效；某字段留空并保存 = 清除该配置
        （回退到 claude 自身认证链）。
      </p>

      <Section title="Claude" provider="claude">
        <TextField
          label="CLI 路径 (cliPath)"
          value={claude.cliPath ?? ''}
          placeholder="claude"
          onChange={(v) => patchProvider('claude', 'cliPath', v)}
        />
        <SecretField
          label="API Key (apiKey)"
          value={claude.apiKey ?? ''}
          onChange={(v) => patchProvider('claude', 'apiKey', v)}
        />
        <SecretField
          label="Auth Token (authToken)"
          value={claude.authToken ?? ''}
          onChange={(v) => patchProvider('claude', 'authToken', v)}
        />
        <TextField
          label="Base URL (baseUrl)"
          value={claude.baseUrl ?? ''}
          placeholder="https://api.anthropic.com"
          onChange={(v) => patchProvider('claude', 'baseUrl', v)}
        />
        <TextField
          label="默认模型 (defaultModel)"
          value={claude.defaultModel ?? ''}
          placeholder="DeepSeek-V4-Flash-0731"
          onChange={(v) => patchProvider('claude', 'defaultModel', v)}
        />
        <TextField
          label="Opus 模型 (opusModel)"
          value={claude.opusModel ?? ''}
          placeholder="DeepSeek-V4-Pro-0813"
          onChange={(v) => patchProvider('claude', 'opusModel', v)}
        />
        <TextField
          label="Sonnet 模型 (sonnetModel)"
          value={claude.sonnetModel ?? ''}
          placeholder="claude-opus-4-8"
          onChange={(v) => patchProvider('claude', 'sonnetModel', v)}
        />
        <TextField
          label="Haiku 模型 (haikuModel)"
          value={claude.haikuModel ?? ''}
          placeholder="DeepSeek-V4-Flash-0731"
          onChange={(v) => patchProvider('claude', 'haikuModel', v)}
        />
        <TextField
          label="百万上下文模型 (oneMillionModels)"
          value={claude.oneMillionModels ?? ''}
          placeholder="逗号分隔的模型名，留空关闭"
          onChange={(v) => patchProvider('claude', 'oneMillionModels', v)}
        />
      </Section>

      <Section title="Codex" provider="codex">
        <TextField
          label="可执行路径 (binPath)"
          value={codex.binPath ?? ''}
          placeholder="codex"
          onChange={(v) => patchProvider('codex', 'binPath', v)}
        />
        <SecretField
          label="API Key (apiKey)"
          value={codex.apiKey ?? ''}
          onChange={(v) => patchProvider('codex', 'apiKey', v)}
        />
      </Section>

      <Section title="OpenCode" provider="opencode">
        <TextField
          label="可执行路径 (binPath)"
          value={opencode.binPath ?? ''}
          placeholder="opencode"
          onChange={(v) => patchProvider('opencode', 'binPath', v)}
        />
      </Section>

      <Section title="Qoder" provider="qoder">
        <SecretField
          label="Personal Access Token (personalAccessToken)"
          value={qoder.personalAccessToken ?? ''}
          onChange={(v) => patchProvider('qoder', 'personalAccessToken', v)}
        />
      </Section>

      <Section title="运行参数">
        <p className="-mt-1 text-xs text-muted-foreground">
          端口 / host 修改需重启后端才生效。
        </p>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">端口 (server.port)</label>
          <input
            type="number"
            min={1}
            max={65535}
            className="h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            value={server.port ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              patchServer('port', Number.isFinite(n) ? n : 0);
            }}
          />
        </div>
        <TextField
          label="Host (server.host)"
          value={server.host ?? ''}
          placeholder="0.0.0.0"
          onChange={(v) => patchServer('host', v)}
        />
        <TextField
          label="CORS Origin (server.corsOrigin)"
          value={server.corsOrigin ?? ''}
          placeholder="*"
          onChange={(v) => patchServer('corsOrigin', v)}
        />
      </Section>

      {/* 保存栏 */}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {savedMsg && !saveError && (
          <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>
        )}
        {saveError && <span className="text-xs text-red-500">{saveError}</span>}
      </div>
    </div>
  );
}

/** 路由页入口：/settings/providers（深链 / 返回按钮保留）。 */
export function ProviderSettingsPage() {
  return (
    <div className="h-dvh overflow-y-auto bg-background">
      <header className="pwa-header-safe sticky top-0 z-10 flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
        <BackToTasksButton />
        <h1 className="ml-2 text-sm font-semibold text-foreground">Provider 设置</h1>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6 sm:p-6">
        <ProviderSettingsForm />
      </div>
    </div>
  );
}

export default ProviderSettingsPage;
```

注意：请以上面代码块里的提示文案为准（无需再改动）。

- [ ] **Step 5.3: 验证**

Run (cwd=`web/`): `npm run typecheck` → exit 0
Run (cwd=`web/`): `npm run lint` → exit 0

- [ ] **Step 5.4: 提交**

```bash
git add web/src/components/settings/ProviderSettingsPage.tsx
git commit -m "feat(web): extract ProviderSettingsForm, add claude baseUrl + model fields"
```

---

## Task 6: Web — 模态弹层 SettingsDialog + 侧边栏触发

**Files:**
- Create: `web/src/hooks/useSettingsDialog.tsx`
- Create: `web/src/components/settings/SettingsDialog.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`

- [ ] **Step 6.1: 建状态 Context（仿 useTerminalDrawer）**

新建 `web/src/hooks/useSettingsDialog.tsx`：

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type SettingsDialogContextValue = {
  /** 模态是否打开。 */
  open: boolean;
  openSettings: () => void;
  closeSettings: () => void;
};

const SettingsDialogContext = createContext<SettingsDialogContextValue | null>(null);

export function SettingsDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSettings = useCallback(() => setOpen(true), []);
  const closeSettings = useCallback(() => setOpen(false), []);
  const value = useMemo<SettingsDialogContextValue>(
    () => ({ open, openSettings, closeSettings }),
    [open, openSettings, closeSettings],
  );
  return <SettingsDialogContext.Provider value={value}>{children}</SettingsDialogContext.Provider>;
}

export function useSettingsDialog(): SettingsDialogContextValue {
  const context = useContext(SettingsDialogContext);
  if (!context) throw new Error('useSettingsDialog must be used within SettingsDialogProvider');
  return context;
}
```

- [ ] **Step 6.2: 建模态组件**

新建 `web/src/components/settings/SettingsDialog.tsx`：

```tsx
import { X } from 'lucide-react';

import { Dialog, DialogContent } from '../../shared/view/ui/Dialog';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';
import { ProviderSettingsForm } from './ProviderSettingsPage';

/**
 * Provider 设置模态浮层。挂在 App 根部，覆盖所有页面；复用 shared/view/ui/Dialog
 * 原语（Escape / 遮罩点击关闭、focus trap、body 滚动锁定），内部渲染与
 * /settings/providers 路由页同一份 <ProviderSettingsForm />。
 */
export function SettingsDialog() {
  const { open, closeSettings } = useSettingsDialog();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeSettings(); }}>
      <DialogContent className="max-w-3xl">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
          <h2 className="text-sm font-semibold text-foreground">Provider 设置</h2>
          <button
            type="button"
            onClick={closeSettings}
            title="关闭"
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[80dvh] overflow-y-auto p-4">
          <ProviderSettingsForm />
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6.3: 挂 Provider + 渲染模态**

`web/src/App.tsx`：

1. import 区追加（`useTerminalDrawer` import 附近）：

```tsx
import { SettingsDialogProvider } from './hooks/useSettingsDialog';
import { SettingsDialog } from './components/settings/SettingsDialog';
```

2. 在 `<Router>` 内、`<Routes>` 外套 Provider，并在 Provider 内放 `<SettingsDialog />`（使其覆盖所有页面；注意 Provider 必须在 Dialog 组件之上）：

```tsx
            <Router basename={routerBasename}>
              <SettingsDialogProvider>
                <TerminalDrawerProvider>
                  <Routes>
                    <Route path="/" element={<AppContent />} />
                    <Route path="/session/:sessionId" element={<AppContent />} />
                    <Route path="/tasks" element={<TaskBoardPage />} />
                    <Route path="/task/:taskId" element={<TaskDetailPage />} />
                    <Route path="/assistant" element={<AssistantPanel />} />
                    <Route path="/settings/operator" element={<OperatorSettingsPage />} />
                    <Route path="/settings/providers" element={<ProviderSettingsPage />} />
                  </Routes>
                  <SettingsDialog />
                </TerminalDrawerProvider>
              </SettingsDialogProvider>
            </Router>
```

- [ ] **Step 6.4: 侧边栏齿轮改为开模态**

`web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx`：

1. import 区（`useNavigate` 之上）追加：

```tsx
import { useSettingsDialog } from '../../../../hooks/useSettingsDialog';
```

2. 组件内（拿到 openSettings）：在 `SidebarFooter` 函数体中已有 hook 调用的地方旁追加

```tsx
const { openSettings } = useSettingsDialog();
```

3. 齿轮按钮（原第 117-127 行）改为不路由、直接开模态：

```tsx
      {/* Provider 凭据 + 运行参数设置（模态浮层打开）。 */}
      <div className="px-2 pb-1.5 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openSettings}
          title="Provider 设置"
          aria-label="Provider 设置"
          className="w-full justify-start px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          <Settings2 />
          <span className="truncate">Provider 设置</span>
        </Button>
      </div>
```

> 若 `useNavigate` 在该文件仅被齿轮一处使用，删除其 import 与 `const navigate = useNavigate()` 以避免 lint unused 报错；否则保留。

- [ ] **Step 6.5: 验证**

Run (cwd=`web/`): `npm run typecheck` → exit 0
Run (cwd=`web/`): `npm run lint` → exit 0
Run: `npm run build` → exit 0（vite build 无错误）

- [ ] **Step 6.6: 提交**

```bash
git add web/src/hooks/useSettingsDialog.tsx web/src/components/settings/SettingsDialog.tsx web/src/App.tsx web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx
git commit -m "feat(web): open provider settings as in-app modal from sidebar"
```

---

## Task 7: 端到端手工验证（迁移 + 实时生效）

> 生产服务由 `systemctl --user lovdex.service`（supervisor.mjs）拉起；`~/.lovdex/supervisor` 与仓库 `supervisor/` 目录内容需保持一致（历史做法：手动同步，见 dc19d60）。以下步骤以仓库代码为准，先同步再重启。

**Files:** 无代码改动（仅操作验证）。

- [ ] **Step 7.1: 同步 supervisor 到部署目录**

```bash
cp supervisor/supervisor.mjs supervisor/env-filter.mjs /home/zhijuhuang/.lovdex/supervisor/
```

- [ ] **Step 7.2: 重启服务并确认 env 已清空**

```bash
systemctl --user restart lovdex
sleep 2
bp=$(ps -ef | grep -E "lovdex-backend.*server/index|dist-server.*server/index" | grep -v grep | awk '{print $2}' | head -1)
tr '\0' '\n' < /proc/$bp/environ | grep -c "^ANTHROPIC_\|^CLAUDE_CLI_PATH" || true
```

Expected: 输出 `0`（config 为空 → 不再有 ANTHROPIC_* 注入）。

- [ ] **Step 7.3: 通过设置页填写并验证实时生效**

1. 打开 `<http://localhost:3188>`，侧边栏底部齿轮 → 弹出 Provider 设置模态
2. 填 Base URL、Auth Token、默认模型（与之前 .bashrc 一致的 sophnet 值），保存 → 提示保存成功
3. 再开一个新会话，确认能正常跑
4. 切回设置页把默认模型改成另一个模型名，保存 → 打开新会话，模型下拉框已显示新模型（同一会话内无需刷新列表），发消息走新模型

> 验证辅助命令（后端已运行）：`curl -s http://localhost:3188/api/config | grep -E 'baseUrl|defaultModel|authToken'` 应显示新值（authToken 打码）。

- [ ] **Step 7.4: 回归确认 .bashrc 改动不再影响服务**

```bash
# 不动 app.config，临时改 .bashrc 里的 ANTHROPIC_MODEL，重启服务，确认后端 env 里仍是配置值
systemctl --user restart lovdex
```

Expected: 重启后新会话用的仍是设置页配置的模型，而不是 .bashrc 的值。
（验证完可把 .bashrc 改动还原。）

---

## Self-Review 结果

- **Spec 覆盖**：5 字段（T1、T5）；权威 env-sync（T2）；OWNED_ANTHROPIC_ENV + supervisor 过滤（T2+T3）；模型列表动态化（T4）；设置页表单字段（T5）；模态（T6）；迁移/端到端（T7）。
- **类型一致性**：`defaultModel/haikuModel/opusModel/sonnetModel/baseUrl` 命名在 config.ts → env-sync.ts → claude-models.provider.ts → ProviderSettingsPage.tsx 各处一致；`getClaudeFallbackModels()` 在 claude-models.provider.ts 定义、claude-sdk.js 6 处调用（含 import）。
- **占位符扫描**：无 TBD/TODO；每步含完整代码或精确替换文本。