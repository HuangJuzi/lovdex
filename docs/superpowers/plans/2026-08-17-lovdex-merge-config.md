# Lovdex 单仓整合 + 全配置化 + Provider 配置页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 lovdex-cli（前端）+ lovdex-backend 合并进 `/mnt/b/workdir/github/lovdex/lovdex` 单 git 仓库，后端业务配置全部迁入 `~/.lovdex/data/app.config.json`，前端新增 `/settings/providers` 配置页。

**Architecture:** 目标目录下 `web/`（前端）+ `backend/`（后端）+ `supervisor/`/`docs/`/`systemd/`（附随）。后端新增 `server/modules/config/`：`config.ts` 单例装载 JSON 配置（深度合并默认值、缺文件首启自动生成、原子写）、`config.routes.ts` 提供 `GET/PUT /api/config`（GET 脱敏匿名可读、PUT 需登录）。所有 `process.env.X` 业务读取点改为读 `appConfig`；provider 凭据在加载时回填 `process.env`，让 SDK 子进程的 `{...process.env}` 转发不受影响。前端移除 `VITE_*`，新增运行时配置拉取与 Provider 设置页（复用 OperatorSettingsPage 的 UI 模式）。

**Tech Stack:** Express 4 + better-sqlite3 + zod（后端已有）、React 18 + React Router 6 + Tailwind（前端已有）、Vite 7、tsx。

**关联 spec:** `~/.lovdex/docs/superpowers/specs/2026-08-17-lovdex-merge-config-design.md`

**关键事实（预读）：**
- 拷贝源用 `~/.lovdex`（`/mnt/b/workdir/github/lovdex` 下那份 backend 落后一个 commit `f650ff8`，不用）。
- 后端测试命令：`npx tsx --test`（在 backend 目录，需先 `npm install` 或复用 ~/.lovdex 的 node_modules——按 Tab1 处理）。
- 后端 dev：`npx tsx --tsconfig server/tsconfig.json server/index.js`。
- `AUTH_ENABLED=false` 是唯一保留的 env 逃生阀（`server/modules/auth/auth.config.ts:isAuthEnabled`）。
- SDK 子进程路径：`claude-sdk.js:170` `sdkOptions.env = { ...process.env }`、`claude-sdk.js:1171` 同、`opencode-runner.js` 与 `qoder-runner.js` 均依赖 process.env 传递——**配置回填 process.env 是必须环节**。

---

## Phase 1：单仓合并（纯文件操作，无 TDD）

### Task 1: 拷贝两项目源码到合并根目录

**Files:**
- Source: `~/.lovdex/lovdex-cli/` → `Target: /mnt/b/workdir/github/lovdex/lovdex/web/`
- Source: `~/.lovdex/lovdex-backend/` → `Target: /mnt/b/workdir/github/lovdex/lovdex/backend/`

- [ ] **Step 1: 创建根目录并拷贝前端**

```bash
ROOT=/mnt/b/workdir/github/lovdex/lovdex
mkdir -p "$ROOT"
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.env' --exclude '.superpowers' \
  ~/.lovdex/lovdex-cli/ "$ROOT/web/"
```

- [ ] **Step 2: 拷贝后端**

```bash
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist-server' --exclude '.env' \
  ~/.lovdex/lovdex-backend/ "$ROOT/backend/"
```

- [ ] **Step 3: 校验拷贝完整性（无 .git / node_modules / dist / .env 进入）**

```bash
cd "$ROOT"
echo "== 不应存在 =="; ls -d web/.git backend/.git web/node_modules backend/node_modules web/dist backend/dist-server 2>&1 | grep -v 'No such' || true
echo "== 文件计数 =="; find web -type f | wc -l; find backend -type f | wc -l
```
Expected: 前端 ≈317（src）无关紧要，关键是 `.git`/`node_modules`/`dist` 均报 "No such file or directory"。

- [ ] **Step 4: 确认两份 .env 未拷贝（凭据不进代码）**

```bash
ls "$ROOT"/web/.env "$ROOT"/backend/.env 2>&1
```
Expected: 两行 No such file。

### Task 2: 初始化单 git 仓库 + 根 .gitignore

**Files:**
- Create: `/mnt/b/workdir/github/lovdex/lovdex/.gitignore`

- [ ] **Step 1: 写根 .gitignore**

```bash
cat > /mnt/b/workdir/github/lovdex/lovdex/.gitignore <<'EOF'
node_modules/
dist/
dist-server/
dist-ssr/
*.log
.env
.env.*
!.env.example
data/
*.db
*.sqlite
*.sqlite3
.DS_Store
EOF
```

- [ ] **Step 2: git init + 首个 commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git init -b main
git add -A
git status --short | head -20
```
Expected: 无 `.env`、无 `node_modules`、无 `dist` 出现在列表。
```bash
git commit -m "chore: merge web + backend into single lovdex repo"
```

- [ ] **Step 3: 提交后核对两子目录 .git 未混入**

```bash
ls -d web/.git backend/.git 2>&1 | grep -v 'No such' || echo "OK: no nested .git"
```

### Task 3: 附随目录拷贝 + supervisor/systemd 路径更新

**Files:**
- Source: `~/.lovdex/supervisor/` → `Target: $ROOT/supervisor/`（排除 run.pid/run.state.json/logs）
- Source: `~/.lovdex/docs/` → `Target: $ROOT/docs/`
- Source: `~/.lovdex/systemd/` → `Target: $ROOT/systemd/`
- Modify: `$ROOT/supervisor/services.mjs`

- [ ] **Step 1: 拷贝三目录**

```bash
ROOT=/mnt/b/workdir/github/lovdex/lovdex
rsync -a --exclude 'run.pid' --exclude 'run.state.json' --exclude 'logs' ~/.lovdex/supervisor/ "$ROOT/supervisor/"
rsync -a ~/.lovdex/docs/ "$ROOT/docs/"
rsync -a ~/.lovdex/systemd/ "$ROOT/systemd/"
```

- [ ] **Step 2: 更新 supervisor/services.mjs 路径（关键改动）**

编辑 `$ROOT/supervisor/services.mjs`，把两处 `resolve(root, 'lovdex-backend')` → `resolve(root, 'backend')`、`resolve(root, 'lovdex-cli')` → `resolve(root, 'web')`。全文改为：

```js
export const services = [
  {
    name: 'backend',
    cwd: resolve(root, 'backend'),
    dev:  { cmd: 'npm', args: ['run', 'dev'] },
    prod: { cmd: 'npm', args: ['run', 'dev'] },
    port: 3188,
    needsBuild: false,
    distDir: resolve(root, 'backend', 'dist-server'),
  },
  {
    name: 'frontend',
    cwd: resolve(root, 'web'),
    dev:  { cmd: 'npm', args: ['run', 'dev'] },
    prod: { cmd: 'npm', args: ['run', 'preview', '--', '--host', '0.0.0.0', '--port', '5188', '--strictPort'] },
    port: 5188,
    needsBuild: true,
    distDir: resolve(root, 'web', 'dist'),
  },
]
```

- [ ] **Step 3: 校验 services.mjs 无残留旧路径**

```bash
grep -n "lovdex-cli\|lovdex-backend" /mnt/b/workdir/github/lovdex/lovdex/supervisor/services.mjs
```
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add -A
git commit -m "chore: copy supervisor/docs/systemd, repoint services to web/backend"
```

### Task 4: 全新 README.md

**Files:**
- Create: `/mnt/b/workdir/github/lovdex/lovdex/README.md`

- [ ] **Step 1: 写全新 README（只介绍 Lovdex 自己，不涉迁移历史）**

```markdown
# Lovdex

Lovdex 是一个面向 Claude Code / Codex / OpenCode / Qoder 编码代理的 Web 管理工作台：可视化会话、任务（Task Board）、Operator 助手、文件浏览与终端、Git 面板，并提供各 provider 的凭据与运行参数配置。

## 布局

- `web/` — React 前端（Vite）。`npm install && npm run dev`（:5188），`/api`、`/ws` 代理到后端。
- `backend/` — Express API + WebSocket 后端。`npm install && npm run dev`（:3188）。
- `supervisor/` — 守护进程，可同时拉起前后端（systemd user unit 见 `systemd/`）。
- `docs/` — 设计/计划文档。

## 配置

配置集中存放在 `~/.lovdex/data/app.config.json`，首次启动后端自动生成（含随机 JWT 密钥）。Web UI 侧边栏「设置 → Providers」可视化编辑；敏感字段（API key/token）以掩码展示，写入走 `PUT /api/config`（需登录）。

唯一保留的环境变量为 `AUTH_ENABLED`（逃生阀）：设 `false` 进入免登录本地模式。

## 开发

```bash
cd backend && npm run dev      # API + WS，:3188
cd web && npm run dev          # UI，:5188
```
```

- [ ] **Step 2: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add README.md
git commit -m "docs: add intro README"
```

---

## Phase 2：后端配置系统（TDD）

### Task 5: `app.config` 模块：默认值 + 装载 + 自动生成 + 原子写

**Files:**
- Create: `backend/server/modules/config/config.ts`
- Create: `backend/server/modules/config/tests/config.test.ts`
- Test: `backend/server/modules/config/tests/config.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/config/tests/config.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';

const DEFAULT_CFG = {
  server: {
    host: '0.0.0.0', port: 3188, corsOrigin: '*', contextWindow: null,
    isPlatform: false, workflowsEnabled: true, ultracodeKeywordTrigger: '',
  },
  database: { path: path.join(os.homedir(), '.sophcode', 'auth.db') },
  workspaces: { root: '~', mainWorkspace: '' },
  auth: { enabled: true, email: null, code: null, jwtSecret: '' },
  providers: {
    claude: { cliPath: 'claude', apiKey: '', authToken: '', oneMillionModels: '',
              streamCloseTimeoutMs: 10000, toolApprovalTimeoutMs: 60000 },
    codex: { binPath: 'codex' },
    opencode: { binPath: 'opencode', apiKeys: {} },
    qoder: { personalAccessToken: '', toolApprovalTimeoutMs: 60000 },
  },
  operator: { enabled: true, autoVerdictEnabled: true, model: '', workspace: '',
              maxConcurrent: 2 },
  runtime: { fsConcurrency: 64 },
};

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-cfg-')); }

test('loads defaults when file missing, generated on first access', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  const got = cfg.get();
  // server defaults present
  assert.strictEqual(got.server.port, 3188);
  assert.strictEqual(got.server.isPlatform, false);
  // db defaults to user-level sophcode path
  assert.strictEqual(got.database.path, DEFAULT_CFG.database.path);
  // auto-generated jwtSecret is random
  assert.ok(got.auth.jwtSecret.length >= 32);
});

test('persists to app.config.json with atomic write', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ providers: { qoder: { personalAccessToken: 'pat-123' } } });
  const file = path.join(dir, 'app.config.json');
  assert.ok(fs.existsSync(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.providers.qoder.personalAccessToken, 'pat-123');
  // merge keeps unrelated defaults
  assert.strictEqual(onDisk.server.port, 3188);
});

test('deep merge: partial update does not clobber siblings', () => {
  const dir = tmpDir();
  const cfg = createAppConfig({ dataDir: dir });
  cfg.update({ server: { port: 4000 } });
  const got = cfg.get();
  assert.strictEqual(got.server.port, 4000);
  assert.strictEqual(got.server.host, '0.0.0.0');
  assert.strictEqual(got.server.isPlatform, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex/backend
ls node_modules 2>/dev/null || ln -s ~/.lovdex/lovdex-backend/node_modules node_modules
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/config.test.ts
```
Expected: FAIL — `Cannot find module '../config.js'`（或 createAppConfig is not a function）。

- [ ] **Step 3: 实现 config.ts**

`backend/server/modules/config/config.ts`:

```ts
/**
 * Central app configuration.
 *
 * Single source of truth for all backend runtime settings and provider
 * credentials. Lives at <DATA_DIR>/app.config.json (default ~/.lovdex/data),
 * auto-generated on first load with deep-merged defaults. Writes are atomic
 * (tmp + rename) so a crash can never corrupt the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_APP_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 3188,
    corsOrigin: '*',
    contextWindow: null as number | null,
    isPlatform: false,
    workflowsEnabled: true,
    ultracodeKeywordTrigger: '',
  },
  database: { path: path.join(os.homedir(), '.sophcode', 'auth.db') },
  workspaces: { root: '~', mainWorkspace: '' },
  auth: { enabled: true, email: null as string | null, code: null as string | null, jwtSecret: '' },
  providers: {
    claude: {
      cliPath: 'claude',
      apiKey: '',
      authToken: '',
      oneMillionModels: '',
      streamCloseTimeoutMs: 10000,
      toolApprovalTimeoutMs: 60000,
    },
    codex: { binPath: 'codex' },
    opencode: { binPath: 'opencode', apiKeys: {} as Record<string, string> },
    qoder: { personalAccessToken: '', toolApprovalTimeoutMs: 60000 },
  },
  operator: {
    enabled: true,
    autoVerdictEnabled: true,
    model: '',
    workspace: '',
    maxConcurrent: 2,
  },
  runtime: { fsConcurrency: 64 },
};

export type AppConfig = typeof DEFAULT_APP_CONFIG;

/** Keys whose values are secrets; masked when serialized for the API. */
const SENSITIVE_KEYS = new Set([
  'apiKey', 'authToken', 'personalAccessToken', 'jwtSecret', 'code',
]);

function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      const b = (base as Record<string, unknown>)[k];
      out[k] = deepMerge(b, v);
    }
    return out as T;
  }
  return (override ?? base) as T;
}

export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/** Recursively replaces sensitive leaf values with a masked marker. */
export function maskConfig(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => maskConfig(v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskConfig(v, k);
    }
    return out;
  }
  if (key && SENSITIVE_KEYS.has(key)) return maskSecret(value);
  return value;
}

export type AppConfigApi = {
  /** Returns the full merged config (runtime use). */
  get(): AppConfig;
  /** Returns a masked copy for the HTTP API. */
  getMasked(): AppConfig;
  /** Deep-merges a partial update and atomically persists. */
  update(partial: unknown): AppConfig;
  /** The config file path. */
  filePath: string;
};

export function createAppConfig(options?: {
  dataDir?: string;
  filePath?: string;
}): AppConfigApi {
  // Overridable data dir enables isolated E2E/data-dir tests while defaulting
  // to the stable user-level location (~/.lovdex/data).
  const dir = options?.dataDir ?? process.env.LOVDEX_DATA_DIR ?? path.join(os.homedir(), '.lovdex', 'data');
  const filePath = options?.filePath ?? path.join(dir, 'app.config.json');
  const jwtSecret = crypto.randomBytes(48).toString('hex');

  function load(): AppConfig {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const cfg = deepMerge(structuredClone(DEFAULT_APP_CONFIG), parsed) as AppConfig;
      if (!cfg.auth.jwtSecret) cfg.auth.jwtSecret = jwtSecret;
      return cfg;
    } catch {
      // Missing or malformed → generate defaults and persist (idempotent).
      const cfg = structuredClone(DEFAULT_APP_CONFIG) as AppConfig;
      cfg.auth.jwtSecret = jwtSecret;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      return cfg;
    }
  }

  function persist(cfg: AppConfig): void {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  let current = load();

  return {
    get: () => current,
    getMasked: () => maskConfig(current) as AppConfig,
    update(partial: unknown): AppConfig {
      const next = deepMerge(structuredClone(current), partial) as AppConfig;
      if (!next.auth.jwtSecret) next.auth.jwtSecret = current.auth.jwtSecret;
      persist(next);
      current = next;
      return current;
    },
    filePath,
  };
}

/** Process-wide singleton (call once at server boot). */
let singleton: AppConfigApi | null = null;
export function appConfig(): AppConfigApi {
  if (!singleton) singleton = createAppConfig();
  return singleton;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/config.test.ts
```
Expected: PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add backend/server/modules/config
git commit -m "feat(config): app config module with defaults, atomic writes, masking"
```

### Task 6: `/api/config` 路由（GET 脱敏 / PUT 部分更新）

**Files:**
- Create: `backend/server/modules/config/config.routes.ts`
- Test: `backend/server/modules/config/tests/config.routes.test.ts`
- Modify: `backend/server/index.js`（挂载路由）

- [ ] **Step 1: 写失败测试**

`backend/server/modules/config/tests/config.routes.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAppConfig } from '../config.js';
import { buildConfigReadRouter, buildConfigWriteRouter } from '../config.routes.js';

/** Mounts read (GET, anonymous) + write (PUT, behind a fake auth) routers. */
function buildTestApp(cfg) {
  const app = express();
  app.use(express.json());
  app.use('/api/config', buildConfigReadRouter({ cfg }));
  // Fake JWT gate: sets req.user like the real authenticateToken would.
  app.use('/api/config', (req, _res, next) => { req.user = { id: 1, username: 'test' }; next(); });
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
  const body = await res.json();
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/config.routes.test.ts
```
Expected: FAIL — `Cannot find module '../config.routes.js'`。

- [ ] **Step 3: 实现 config.routes.ts**

`backend/server/modules/config/config.routes.ts`:

```ts
import { Router } from 'express';

import { maskConfig } from './config.js';
import type { AppConfigApi } from './config.js';

/**
 * Config HTTP API.
 *   GET /api/config — masked config, ANONYMOUS (login page needs it).
 *   PUT /api/config — partial update, requires JWT auth (authenticateToken
 *   middleware applied at mount time in server/index.js).
 */

/** GET / — masked view of the whole config. */
export function buildConfigReadRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(maskConfig(deps.cfg.get()));
  });
  return router;
}

/** PUT / — deep-merge a partial update, persist atomically, return masked. */
export function buildConfigWriteRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();
  router.put('/', (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'config body must be a JSON object' });
    }
    try {
      const next = deps.cfg.update(body);
      res.json(maskConfig(next));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/config.routes.test.ts
```
Expected: PASS（2 tests）。

- [ ] **Step 5: 挂载到 server/index.js**

在 `server/index.js` 顶部 import（按现有 import 列表风格追加）：

```js
import { appConfig as getAppConfig } from './modules/config/config.js';
import { buildConfigReadRouter, buildConfigWriteRouter } from './modules/config/config.routes.js';
```

挂载点放在 `/api/auth` 挂载之后（保证 `express.json()` 已 `app.use` 在更早处）：

```js
const cfgStore = getAppConfig();
app.use('/api/config', buildConfigReadRouter({ cfg: cfgStore }));
app.use('/api/config', authenticateToken, buildConfigWriteRouter({ cfg: cfgStore }));
```

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add backend/server/modules/config backend/server/index.js
git commit -m "feat(config): GET /api/config (masked, anonymous) + PUT /api/config (auth required)"
```

---

## Phase 3：env → config 迁移

### Task 7: 服务器级参数迁移（port/host/cors/contextWindow/workspaces/fsConcurrency）

**Files:**
- Modify: `backend/server/index.js`
- Modify: `backend/server/constants/config.js`
- Modify: `backend/server/shared/utils.ts`
- Modify: `backend/server/utils/runtime-paths.js`

- [ ] **Step 1: 防回归断言（迁移前应失败）**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex/backend
if grep -qn "process.env" server/index.js server/constants/config.js; then
  echo "PRE-MIGRATION STATE: env reads still present (expected before Task 7)"
fi
```
Expected: 输出 `PRE-MIGRATION STATE: ...`——确认当前仍读 env，为后续 grep 清零留基线。

- [ ] **Step 2: 替换 index.js 中 env 读取**

`server/index.js`:
- `const SERVER_PORT = process.env.SERVER_PORT || 3001;` → `const SERVER_PORT = cfg.server.port;`（在文件顶部 `const cfg = getAppConfig().get();` 之后）
- `process.env.HOST` 读取点 → `cfg.server.host`
- `cors()` 配置里 CORS_ORIGIN → `cfg.server.corsOrigin`（原为 `process.env.CORS_ORIGIN || '*'`）
- `const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);` → `typeof cfg.server.contextWindow === 'number' ? cfg.server.contextWindow : undefined`
- `DEFAULT_FS_CONCURRENCY` / `parsedFsConcurrency` → `cfg.runtime.fsConcurrency`
- `console.log('SERVER_PORT from env:', ...)` 行删除或改读 cfg。

在 index.js 顶部（`import` 之后、`const cfg = ...` 处）加：

```js
import { appConfig as getAppConfig } from './modules/config/config.js';
const cfg = getAppConfig().get();
```

- [ ] **Step 3: 替换 constants/config.js 的 IS_PLATFORM**

`backend/server/constants/config.js` 整个文件替换为：

```js
/**
 * Platform mode flag — now sourced from app.config.json (server.isPlatform),
 * not the VITE_IS_PLATFORM environment variable.
 */
import { appConfig } from '../modules/config/config.js';

export const IS_PLATFORM = appConfig().get().server.isPlatform;
```

- [ ] **Step 4: 替换 shared/utils.ts 的 WORKSPACES_ROOT**

`server/shared/utils.ts:122`:
`export const WORKSPACES_ROOT = resolveWorkspaceRoot(process.env.WORKSPACES_ROOT ?? '~');`
→
```ts
import { appConfig } from '../modules/config/config.js';
export const WORKSPACES_ROOT = resolveWorkspaceRoot(appConfig().get().workspaces.root);
```

- [ ] **Step 5: 替换 runtime-paths.js 的 LOVDEX_MAIN_WORKSPACE**

`server/utils/runtime-paths.js` 中 `getMainAgentWorkspace()`：
```ts
export function getMainAgentWorkspace() {
  const ws = appConfig().get().workspaces.mainWorkspace;
  return ws ? path.resolve(ws) : path.dirname(getAppRoot());
}
```

- [ ] **Step 6: 后端测试集回归**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test 2>&1 | tail -5
```
Expected: 存量测试全部通过（约 200+ 个，约 2s）。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add backend/server
git commit -m "refactor(config): migrate server-level env to app.config"
```

### Task 8: claude.js 的 contextWindow / workflows / ultracode

**Files:**
- Modify: `backend/server/claude-sdk.js`

- [ ] **Step 1: 迁移 claude-sdk.js 三处 env**

`server/claude-sdk.js`:
- `if (process.env.WORKFLOWS_ENABLED !== undefined)` 块 → 读 `cfg.server.workflowsEnabled`：
  ```js
  const cfg = getAppConfig().get();
  if (cfg.server.workflowsEnabled) sdkOptions.enableWorkflows = true;
  ```
- `if (process.env.ULTRACODE_KEYWORD_TRIGGER !== undefined)` 块 → `cfg.server.ultracodeKeywordTrigger`（设置 `sdkOptions.workflowKeywordTriggerEnabled = cfg.server.ultracodeKeywordTrigger !== ''`）
- 两处 `const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;` → `const contextWindow = cfg.server.contextWindow ?? 160000;`（顶部一次取值）

在文件顶部加 import：`import { appConfig as getAppConfig } from './modules/config/config.js';`

- [ ] **Step 2: 回归测试**

```bash
npx tsx --tsconfig server/tsconfig.json --test 2>&1 | tail -5
```
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git commit -am "refactor(config): migrate claude-sdk context window and workflow flags to app.config"
```

### Task 9: Provider 凭据迁移 + process.env 回填（关键）

**Files:**
- Create: `backend/server/modules/config/env-sync.ts`
- Modify: `backend/server/modules/providers/list/claude/claude-auth.provider.ts`
- Modify: `backend/server/modules/providers/list/qoder/qoder-auth.provider.ts`
- Modify: `backend/server/modules/providers/list/opencode/opencode-auth.provider.ts`
- Modify: `backend/server/modules/providers/list/claude/claude-models.provider.ts`
- Modify: `backend/server/index.js`（启动时调用 env 回填）

- [ ] **Step 1: 写失败测试（env-sync 回填）**

`backend/server/modules/config/tests/env-sync.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppConfig } from '../config.js';
import { syncProviderEnv } from '../env-sync.js';

const TOUCHED_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CLI_PATH',
  'QODER_PERSONAL_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENCODE_BIN',
];

test('syncProviderEnv puts non-empty credentials into process.env', () => {
  // Snapshot and restore process.env so stray host variables can't flake this.
  const saved = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-env-'));
    const cfg = createAppConfig({ dataDir: dir });
    cfg.update({
      providers: {
        claude: { apiKey: 'sk-ant-123', authToken: 'tok-456' },
        qoder: { personalAccessToken: 'qoder-pat' },
        opencode: { apiKeys: { ANTHROPIC_API_KEY: 'oc-key' } },
      },
    });
    delete process.env.OPENAI_API_KEY;
    syncProviderEnv(cfg.get());

    assert.strictEqual(process.env.ANTHROPIC_API_KEY, 'sk-ant-123');
    assert.strictEqual(process.env.ANTHROPIC_AUTH_TOKEN, 'tok-456');
    assert.strictEqual(process.env.QODER_PERSONAL_ACCESS_TOKEN, 'qoder-pat');
    // Only the key present in config.apiKeys gets written; others stay clear.
    assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/env-sync.test.ts
```
Expected: FAIL — module not found。

- [ ] **Step 3: 实现 env-sync.ts**

`backend/server/modules/config/env-sync.ts`:

```ts
/**
 * Syncs provider credentials from app.config back into process.env.
 *
 * SDK subprocesses (claude/codex/opencode/qoder CLIs) receive credentials by
 * inheriting process.env (`sdkOptions.env = { ...process.env }`). Once the
 * source of truth moved to app.config.json we must re-surface values on
 * process.env at boot so child processes keep working unchanged. Empty values
 * are never written, so existing hostenv (e.g. ANTHROPIC_AUTH_TOKEN injected
 * by systemd) stays authoritative when config leaves it blank.
 */
import type { AppConfig } from './config.js';

export function syncProviderEnv(cfg: AppConfig): void {
  const { providers } = cfg;
  // claude
  if (providers.claude.apiKey) process.env.ANTHROPIC_API_KEY = providers.claude.apiKey;
  if (providers.claude.authToken) process.env.ANTHROPIC_AUTH_TOKEN = providers.claude.authToken;
  if (providers.claude.cliPath && providers.claude.cliPath !== 'claude') {
    process.env.CLAUDE_CLI_PATH = providers.claude.cliPath;
  }
  // qoder
  if (providers.qoder.personalAccessToken) {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = providers.qoder.personalAccessToken;
  }
  // opencode — multiple per-env credential keys
  for (const [key, value] of Object.entries(providers.opencode.apiKeys)) {
    if (value) process.env[key] = value;
  }
  // binaries
  if (providers.codex.binPath && providers.codex.binPath !== 'codex') {
    process.env.CODEX_PATH_OVERRIDE = providers.codex.binPath;
  }
  if (providers.opencode.binPath && providers.opencode.binPath !== 'opencode') {
    process.env.OPENCODE_BIN = providers.opencode.binPath;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/env-sync.test.ts
```
Expected: PASS。

- [ ] **Step 5: 启动时调用 syncProviderEnv**

`server/index.js`：在 `const cfg = getAppConfig().get();` 附近调用 `syncProviderEnv(cfg);`，import 加 `import { syncProviderEnv } from './modules/config/env-sync.js';`。

- [ ] **Step 6: provider-auth 改读 config（claude）**

`server/modules/providers/list/claude/claude-auth.provider.ts` 的 `checkCredentials()` 开头插入 config 优先逻辑：

```ts
import { appConfig } from '@/modules/config/config.js';
// inside checkCredentials():
const cfg = appConfig().get().providers.claude;
if (cfg.apiKey?.trim()) {
  return { authenticated: true, email: 'API Key Auth', method: 'config' };
}
if (cfg.authToken?.trim()) {
  return { authenticated: true, email: 'Auth Token', method: 'config' };
}
```
（置顶，优先级最高；原 env/credentials 逻辑保留为回退。）

- [ ] **Step 7: provider-auth 改读 config（qoder）**

`qoder-auth.provider.ts` `checkCredentials()` 顶部加：

```ts
import { appConfig } from '@/modules/config/config.js';
// inside checkCredentials():
const pat = appConfig().get().providers.qoder.personalAccessToken?.trim();
if (pat) return { authenticated: true, email: 'personal-access-token', method: 'config' };
```
（移除/降级原 `process.env.QODER_PERSONAL_ACCESS_TOKEN` 逻辑——若仍保留也无害，但两侧重复需注释说明 config 优先。）

- [ ] **Step 8: provider-auth 改读 config（opencode）**

`opencode-auth.provider.ts` 的 `OPENCODE_ENV_CREDENTIAL_KEYS` 检查前插入：

```ts
import { appConfig } from '@/modules/config/config.js';
// inside checkCredentials():
const apiKeys = appConfig().get().providers.opencode.apiKeys ?? {};
const configuredKey = OPENCODE_ENV_CREDENTIAL_KEYS.find((k) => apiKeys[k]?.trim());
if (configuredKey) {
  return { authenticated: true, email: configuredKey, method: 'config' };
}
```

- [ ] **Step 9: claude-models 的 1M models 读 config**

`server/modules/providers/list/claude/claude-models.provider.ts` 中 `env1mModels`（模块级 `new Set(...)`）改为从 config 读：

```ts
import { appConfig } from '@/modules/config/config.js';
function loadOneMillionModels(): Set<string> {
  return new Set(
    (appConfig().get().providers.claude.oneMillionModels ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
}
```
（调用处用 `loadOneMillionModels()` 替换原先的 `env1mModels` 引用。）

- [ ] **Step 10: 回归测试**

```bash
npx tsx --tsconfig server/tsconfig.json --test 2>&1 | tail -5
```
Expected: PASS（含 opencode-auth / qoder 相关既有测试——若既有测试依赖 env 读取而新逻辑短路，检查测试是否注入 config；若有断言方法串 `method:'environment'` 冲突的旧测试，按其断言更新为新期望 `method:'config'`）。

- [ ] **Step 11: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add -A backend/server
git commit -m "feat(config): sync provider credentials to env at boot; auth reads app.config first"
```

### Task 10: operator 配置来源切换

**Files:**
- Modify: `backend/server/modules/operators/operator.config.ts`

- [ ] **Step 1: 迁移 operator 默认值**

`server/modules/operators/operator.config.ts` 中 `DEFAULT_OPERATOR_CONFIG` 的 env 读取改为 config：

```ts
import { appConfig } from '@/modules/config/config.js';
const opCfg = appConfig().get().operator;
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  enabled: true,
  auto_verdict_enabled: true,
  model: opCfg.model ?? '',
  workspace: opCfg.workspace || `${os.homedir()}/.lovdex/operator-workspace`,
  max_concurrent: opCfg.maxConcurrent ?? 2,
  verdict_prompt_override: null,
  interactive_chat_enabled: true,
};
```
同时 `getOperatorConfig()` 中的 `process.env.LOVDEX_OPERATOR_WORKSPACE?.trim()` 覆盖保留为 env 兜底或改读 config（保持与设计一致：config 为唯一来源，env 兜底仅限例外；此处统一改 config：`const workspace = opCfg.workspace || DEFAULT_OPERATOR_CONFIG.workspace;`）。

- [ ] **Step 2: 回归测试**

```bash
npx tsx --tsconfig server/tsconfig.json --test 2>&1 | tail -5
```
Expected: PASS（operator 相关测试若断言 env 默认值，用 config 读取后的同一默认更新断言）。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git commit -am "refactor(config): read operator defaults from app.config"
```

### Task 11: 收尾 env 清理（唯一保留 AUTH_ENABLED）

**Files:**
- Modify: `backend/server/load-env.js`
- Modify: `backend/server/modules/auth/auth.config.ts`

- [ ] **Step 1: load-env.js 降级为仅逃生阀**

`server/load-env.js`：保留 DATABASE_PATH 兜底逻辑但改为优先读 config：

```js
// AUTH_ENABLED is the sole remaining env surface (safety valve to fully open
// auth). Everything else now lives in ~/.lovdex/data/app.config.json.
```
删除整个 `.env` 读取循环与 `DATABASE_PATH` 注入（数据库路径已由 config.database.path 承担，见 Task 7 Step 4 的 connection.ts 兜底——若 connection.ts 仍读 process.env.DATABASE_PATH，改为读 config 或保留该兜底但不注入）。在 `server/modules/database/connection.ts` 中把 `process.env.DATABASE_PATH || resolveLegacyDatabasePath()` 改为：

```ts
import { appConfig } from '@/modules/config/config.js';
// inside:
return appConfig().get().database.path || resolveLegacyDatabasePath();
```

- [ ] **Step 2: 确认 auth 逃生阀仍在**

`server/modules/auth/auth.config.ts` 的 `isAuthEnabled()` 保持现状（`!IS_PLATFORM && process.env.AUTH_ENABLED !== 'false'`）。这是唯一有意的 env 读取。

- [ ] **Step 3: 全仓 grep 断言**

```bash
cd backend
grep -rn "process.env." server --include=*.ts --include=*.js \
  | grep -v "AUTH_ENABLED" \
  | grep -v "HOME\|PATH\|SHELL" \
  | grep -v "NODE_ENV" \
  | grep -v "LOVDEX_DATA_DIR" \
  | grep -v "/tests/\|test" \
  ; echo "--- exit $? (0 = clean, 1 = no matches above) ---"
```
Expected: 输出为空（`--- exit 1`，grep 没有匹配到残留业务 env）。若仍有业务键出现，逐个审查——允许例外：`CLAUDE_CLI_PATH` 与 `ANTHROPIC_*` 在 `env-sync.ts` 中是 env 回填通道（注释标注），`openai-codex.js`/`opencode-runner.js`/`qoder-runner.js` 的 `process.env` 读取若属 SDK 子进程继承所需，保留并在注释标注"config→env 回填通道"。

- [ ] **Step 4: 回归测试**

```bash
npx tsx --tsconfig server/tsconfig.json --test 2>&1 | tail -5
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git commit -am "refactor(config): drop .env loading; database path from app.config; keep AUTH_ENABLED only"
```

---

## Phase 4：前端配置

### Task 12: 前端去除 VITE_*，运行时拉取配置

**Files:**
- Modify: `web/src/constants/config.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/auth/AuthGate.tsx`

- [ ] **Step 1: 改 constants/config.ts**

`web/src/constants/config.ts` 替换为：

```ts
/**
 * Runtime config — sourced from GET /api/config at startup instead of build
 * time env vars (VITE_IS_PLATFORM / VITE_API_BASE_URL are gone).
 */
export const API_BASE_URL = '';

type RuntimeConfig = {
  isPlatform: boolean;
};

let runtimeConfig: RuntimeConfig = { isPlatform: false };

export const IS_PLATFORM = () => runtimeConfig.isPlatform;

/** Fetches server config once; safe when called outside a fetch context. */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/config`);
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    const cfg = (await res.json()) as { server?: { isPlatform?: boolean } };
    runtimeConfig = { isPlatform: cfg.server?.isPlatform === true };
  } catch {
    runtimeConfig = { isPlatform: false };
  }
  return runtimeConfig;
}

export const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: '',
  path: '',
};
```

- [ ] **Step 2: 更新所有 IS_PLATFORM 使用点为函数调用**

`IS_PLATFORM` 从 const 值变函数，全仓替换调用语法。受影响的文件（grep 已确认）：`web/src/constants/config.ts` 内部、`web/src/components/auth/AuthGate.tsx`、`web/src/components/sidebar/view/subcomponents/SidebarHeader.tsx:116,210`、`web/src/components/sidebar/view/subcomponents/SidebarFooter.tsx:114`、`web/src/components/file-tree/hooks/useFileTreeUpload.ts:123`。逐文件把 `IS_PLATFORM` → `IS_PLATFORM()`。

- [ ] **Step 3: App.tsx 启动时先取配置**

`web/src/App.tsx` 的 `App()` 内、渲染 Router 之前：

```tsx
import { loadRuntimeConfig } from './constants/config';

export default function App() {
  const [configReady, setConfigReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadRuntimeConfig().then(() => { if (!cancelled) setConfigReady(true); });
    return () => { cancelled = true; };
  }, []);
  const routerBasename = detectRouterBasename();
  if (!configReady) return null; // 或轻量 loading，避免闪错

  return (/* 原有 JSX */);
}
```
（需在 App.tsx 顶部补 `useEffect, useState` 的 react import。）

- [ ] **Step 4: AuthGate 兼容（IS_PLATFORM() 调用）**

`AuthGate.tsx` 中 `IS_PLATFORM` 引用改为 `IS_PLATFORM()` 即可（configReady 由 App 保证已加载）。

- [ ] **Step 5: vite.config.js 默认端口改 5188 / proxy 3188**

`web/vite.config.js` 两处改默认值（去掉对 `VITE_PORT` / `SERVER_PORT`/`PORT` env 的依赖，直接落到配置化常量）：

```js
  // const serverPort = env.SERVER_PORT || env.PORT || 3001   → 删掉，替换为：
  const serverPort = 3188

  server: {
    host,
    // port: parseInt(env.VITE_PORT) || 5180  → 替换为：
    port: 5188,
    strictPort: true,
```

保留 `host` 沿用 env.HOST 的既有逻辑不改（或一并改 —— 若 config.server.host 已是唯一来源则删 env.HOST 读取，简单起见此处只改两处端口默认值，host 保持现状以最小改动）。

- [ ] **Step 6: 前端 typecheck + build**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex/web
ls node_modules 2>/dev/null || ln -s ~/.lovdex/lovdex-cli/node_modules node_modules
npm run typecheck; npm run build
```
Expected: typecheck 通过、build 产出 dist/。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add web
git commit -m "refactor(web): load runtime config from /api/config; drop VITE_* env"
```

### Task 13: Provider 设置页（UI + 保存）

**Files:**
- Create: `web/src/components/settings/ProviderSettingsPage.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/sidebar/...`（侧边栏入口，具体见 Step 2）

- [ ] **Step 1: 实现 ProviderSettingsPage**

`web/src/components/settings/ProviderSettingsPage.tsx`（完整组件）:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../utils/api';
import { Button } from '../../shared/view/ui';

type MaskedConfig = Record<string, unknown>;

const PROVIDERS = [
  { key: 'claude', label: 'Claude', fields: [
      { k: 'cliPath', label: 'CLI 路径' },
      { k: 'apiKey', label: 'API Key', secret: true },
      { k: 'authToken', label: 'Auth Token', secret: true },
      { k: 'oneMillionModels', label: '1M Context 模型（逗号分隔）' },
  ], hasAuth: true },
  { key: 'codex', label: 'Codex', fields: [
      { k: 'binPath', label: '可执行路径' },
      { k: 'apiKey', label: 'API Key', secret: true },
  ], hasAuth: true },
  { key: 'opencode', label: 'OpenCode', fields: [
      { k: 'binPath', label: '可执行路径' },
  ], apiKeysEntry: true, hasAuth: true },
  { key: 'qoder', label: 'Qoder', fields: [
      { k: 'personalAccessToken', label: 'Personal Access Token', secret: true },
  ], hasAuth: true },
];

function Field({ label, value, secret, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <label className="flex flex-col gap-1 py-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
          type={secret && !show ? 'password' : 'text'}
          value={value}
          placeholder={secret && value.startsWith('••••') ? '已配置（留空不变）' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && (
          <button type="button" onClick={() => setShow(!show)} className="text-xs text-muted-foreground">
            {show ? '隐藏' : '显示'}
          </button>
        )}
      </div>
    </label>
  );
}

export function ProviderSettingsPage() {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/api/config')
      .then((res) => res.json())
      .then((data) => { setCfg(data); setDraft(data); });
  }, []);

  if (!cfg) return <div className="p-6 text-sm text-muted-foreground">加载配置…</div>;

  const setPath = (section: string, key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [section]: { ...(d[section] as object), [key]: value } }));

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const res = await api.put('/api/config', { body: JSON.stringify(draft) });
      const saved = await res.json();
      setCfg(saved); setDraft(saved);
      setMsg('已保存。端口 / 数据库路径 / host 修改需重启后端生效。');
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-lg font-semibold mb-1">Providers 与运行配置</h1>
      <p className="text-xs text-muted-foreground mb-4">
        凭据写入 ~/.lovdex/data/app.config.json（掩码显示，留空表示保持原值）。
      </p>

      {PROVIDERS.map((p) => (
        <section key={p.key} className="mb-4 rounded border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">{p.label}</h2>
          {p.hasAuth && (
            <p className="text-xs text-muted-foreground mb-2">
              认证状态：<AuthStatus provider={p.key} />
            </p>
          )}
          {p.fields.map((f) => (
            <Field
              key={f.k}
              label={f.label}
              secret={f.secret}
              value={String((draft.providers?.[p.key]?.[f.k] ?? cfg.providers?.[p.key]?.[f.k] ?? ''))}
              onChange={(v) => setPath('providers', p.key, { ...(draft.providers?.[p.key]), [f.k]: v })}
            />
          ))}
        </section>
      ))}

      <div className="mb-4 rounded border border-border p-4">
        <h2 className="text-sm font-semibold mb-2">运行参数</h2>
        {[
          { k: 'port', label: '端口', section: 'server' },
          { k: 'host', label: 'Host', section: 'server' },
          { k: 'corsOrigin', label: 'CORS Origin', section: 'server' },
        ].map((f) => (
          <Field key={f.k} label={f.label}
            value={String((draft.server?.[f.k] ?? cfg.server?.[f.k] ?? ''))}
            onChange={(v) => setPath('server', f.k, v)} />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        {msg && <span className="text-xs">{msg}</span>}
      </div>
    </div>
  );
}

/** Fetches provider auth status via existing endpoint. */
function AuthStatus({ provider }: { provider: string }) {
  const [status, setStatus] = useState('…');
  useEffect(() => {
    api.get(`/api/providers/${provider}/auth/status`)
      .then((res) => res.json())
      .then((d) => {
        const s = d.data ?? d;
        setStatus(s.authenticated ? `已认证（${s.method ?? ''}）` : (s.error ?? '未认证'));
      })
      .catch(() => setStatus('未登录或不可用'));
  }, [provider]);
  return <span>{status}</span>;
}
```

> 注：`api` 封装（`web/src/utils/api.js`）已导出 `authenticatedFetch`；若它没有 `get/put` 快捷方法，则补两个小封装 `api.get = (u) => authenticatedFetch(u)`、`api.put = (u, o) => authenticatedFetch(u, { method:'PUT', ...o })` 加在 `utils/api.js` 末尾。

- [ ] **Step 2: 补 api 快捷方法（如无）**

`web/src/utils/api.js` 末尾追加（若 `api` 对象已存在类似方法则跳过）：

```js
export const api = {
  get: (url) => authenticatedFetch(url),
  put: (url, options = {}) =>
    authenticatedFetch(url, { method: 'PUT', ...options }),
  post: (url, options = {}) =>
    authenticatedFetch(url, { method: 'POST', ...options }),
};
```
（若文件已有同结构 api 对象，直接在其上加 get/put。）

- [ ] **Step 3: 路由 + 侧边栏入口**

`web/src/App.tsx` Routes 内加：

```tsx
<Route path="/settings/providers" element={<ProviderSettingsPage />} />
```

`web/src/components/sidebar/` 下找现有菜单项（如 `OperatorSettingsPage` 入口），仿照加一项"设置 → Providers"，href `/settings/providers`。具体文件与菜单项结构以实际代码为准（实现时阅读 sidebar 现有入口实现并仿写）。

- [ ] **Step 4: 前端 typecheck + build**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex/web
npm run typecheck; npm run build
```
Expected: PASS, dist/ 生成。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git add web
git commit -m "feat(web): provider & runtime settings page backed by /api/config"
```

---

## Phase 5：E2E 验证 + README 校对

### Task 14: 端到端验证（后端首启自动生成 + 配置页生效）

**Files:**
- None (verification)

- [ ] **Step 1: 隔离数据目录 + 独立端口预写配置，起测试后端**

线上后端正占 3001/5187（旧 supervisor dev；合并目录默认已是 3188/5188），E2E 必须用独立实例。用 `LOVDEX_DATA_DIR` 隔离配置目录、`AUTH_ENABLED=false` 逃生阀免登录（config.server.port 改 3101 避开冲突）：

```bash
cd /mnt/b/workdir/github/lovdex/lovdex/backend
E2E_DIR=/tmp/lovdex-e2e-data
rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"
LOVDEX_DATA_DIR="$E2E_DIR" AUTH_ENABLED=false \
  npx tsx --tsconfig server/tsconfig.json server/index.js > /tmp/lovdex-boot.log 2>&1 &
BOOT_PID=$!
sleep 4
grep -n "Server URL" /tmp/lovdex-boot.log | head -2
# 停机，改端口再起（默认 3188 不会碰线上，仍用 3101 彻底隔离）
kill $BOOT_PID; wait $BOOT_PID 2>/dev/null
```
Expected: 日志出现 `Server URL ... 3188`（首启默认），且 `$E2E_DIR/app.config.json` 已生成含随机 jwtSecret。

- [ ] **Step 2: 改写端口为 3101 后重启，验证 GET 匿名 + PUT 生效**

```bash
E2E_DIR=/tmp/lovdex-e2e-data
sed -i 's/"port": 3188/"port": 3101/' "$E2E_DIR/app.config.json"
cd /mnt/b/workdir/github/lovdex/lovdex/backend
LOVDEX_DATA_DIR="$E2E_DIR" AUTH_ENABLED=false \
  npx tsx --tsconfig server/tsconfig.json server/index.js > /tmp/lovdex-boot2.log 2>&1 &
BOOT_PID=$!
sleep 4
echo "== GET /api/config (匿名) =="
curl -s http://127.0.0.1:3101/api/config | head -c 300; echo
echo "== PUT 保存 qoder PAT =="
curl -s -X PUT http://127.0.0.1:3101/api/config -H 'Content-Type: application/json' \
  -d '{"providers":{"qoder":{"personalAccessToken":"e2e-pat"}}}' | grep -o "e2e-pat" || echo "（掩码，预期不出现明文）"
echo "== 配置持久化断言 =="
grep -c "e2e-pat" "$E2E_DIR/app.config.json"     # 1：明文落盘（这是配置文件，允许明文）
grep -n "e2e-pat" /tmp/lovdex-boot2.log | wc -l  # 0：不泄露到日志
kill $BOOT_PID; wait $BOOT_PID 2>/dev/null
```
Expected: GET 返回含 `••••` 掩码的 JSON；PUT 返回掩码结果（不含明文）；配置文件中明文 PAT 落盘 1 行；日志无泄露。

> 若需验证"PUT 在 AUTH_ENABLED=true 下需登录"：`AUTH_ENABLED=true` 重启，`curl -X PUT ...` 应返回 `未登录或登录已过期`（可选步骤）。

- [ ] **Step 3: 前端配置页浏览器 E2E（可选但推荐）**

用既有 recipe：`lovdex-cli` 的 puppeteer-core + 缓存 chromium 连 :5188 live dev server，登录凭据在 `auth.config.json`。流程：登录 → 侧边栏进"设置 → Providers" → 填 qoder PAT → 保存 → 重启后端 → 会话栏 Qoder 显示已认证。

（执行器若无浏览器环境可跳过此步，标注未执行。）

- [ ] **Step 4: README 表达式核对 + 提交**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex
git status --short
```
Expected: 工作区干净（无遗留 node_modules/.env 被跟踪）。

```bash
git log --oneline | head -12
```
确认提交链完整。若 Step 3 跳过：`git commit -m "docs: note E2E browser check pending"` 不创建空提交——直接保持现状即可。

---

## Self-Review 结论（写完后自查）

- **Spec 覆盖**：✓ 目录结构（T1-3）、✓ README 全新（T4）、✓ config 模块+自动生成（T5）、✓ GET/PUT + 脱敏 + 匿名/鉴权分界（T6）、✓ env 全迁移仅留 AUTH_ENABLED（T7-11）、✓ 前端去 VITE + runtime config（T12）、✓ 配置页（T13）、✓ 验证（T14）。spec 中的"no workspace 改造"已遵守。
- **类型一致性**：`createAppConfig` / `appConfig()` / `getMasked()` / `update(partial)` / `syncProviderEnv(cfg)` / `buildConfigReadRouter` / `buildConfigWriteRouter` 全程同名复用；前端 `IS_PLATFORM()` 函数形式在 T12/13 一致。
- **env 回填通道**：SDK 子进程继续经 `{ ...process.env }` 获取凭据，由 T9 env-sync 保证——这是整条链路最易漏的点，T9 断言测试固化。