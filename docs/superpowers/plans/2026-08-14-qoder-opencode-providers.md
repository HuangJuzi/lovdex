# Qoder + opencode Provider 移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 向 lovdex 移植 claudecodeui 的 Qoder 与 opencode provider 全栈支持，并把现有 `sophcode`（opencode v0.3.0 fork）统一重命名为 `opencode`，最终支持 claude / codex / opencode / qoder 四种 provider。

**Architecture:** lovdex-backend 与 claudecodeui 共用同一套 provider 模块架构（`server/modules/providers/list/<provider>/` 七面 facets + `provider.registry.ts` 注册）。opencode 走"重命名"路线：`list/sophcode/` → `list/opencode/` + DB 行迁移 + 登记点改名 + 增补 claudecodeui 的 auth/models/skills/mcp facet；qoder 走"照搬"路线：从 claudecodeui 复制 7 面 facet + 重写运行时为 lovdex 的 runner 约定（`server/<provider>-runner.js` + `index.js` spawnFns/abortFns）。前端同步改类型、常量、组件与 Logo。

**Tech Stack:** TypeScript + better-sqlite3（backend，tsx 直跑）、React + Vite（lovdex-cli）、node:test。测试命令：后端 `npx tsx --test --tsconfig server/tsconfig.json <File(s)>`；前端 `npx tsx --test <File(s)>`（先 `unset TSX_TSCONFIG_PATH`；tsx 不支持目录发现，必须显式文件或用 `$(find ...)` glob）。

**Spec:** `docs/superpowers/specs/2026-08-14-qoder-opencode-providers-design.md`

**源码参考（复制来源）：** 所有 `C: /home/zhijuhuang/workdir/claudecodeui/...` 标注的文件为照搬来源。

---

## 阶段 0：约定与前置

**各处 git 仓库：** lovdex-backend 在 `~/.lovdex/lovdex-backend`（git），lovdex-cli 在 `~/.lovdex/lovdex-cli`（git）。每次 commit 只在此工作目录下 git add/commit，不跨仓。docs 不在 git。

**测试运行（后端）：**
```bash
cd ~/.lovdex/lovdex-backend
npx tsx --test --tsconfig server/tsconfig.json <test文件/glob> 2>&1 | tail -20
```
**测试运行（前端）：** 全局有 `TSX_TSCONFIG_PATH=server/tsconfig.json` 残留，会破坏前端 tsx：
```bash
cd ~/.lovdex/lovdex-cli
unset TSX_TSCONFIG_PATH
npx tsx --test <test文件/glob> 2>&1 | tail -20
```

**typecheck 基线：** `cd ~/.lovdex/lovdex-backend && npx tsc --noEmit -p server/tsconfig.json` 当前有 4 个 pre-existing 错误，验收"零新增"。

**完成时必须无 `sophcode` 残留：** `grep -rn "sophcode" server/ src/` 只允许命中第三方/注释；代码与 DB 中 provider id 全部改为 `opencode`。

---

## Task 1: 后端枚举类型 + DB 迁移（sophcode→opencode + 扩大 executor CHECK）

**Files:**
- Modify: `server/shared/types.ts`（L77 LLMProvider、L904 TaskEngine）
- Modify: `server/modules/database/schema.ts`（L133 EXECUTOR_PROVIDERS）
- Modify: `server/modules/database/repositories/tasks.db.ts`（L8 TASK_ENGINES）
- Modify: `server/modules/database/migrations.ts`（新增 migration，追加进 `runMigrations`）
- Test: `server/modules/database/tests/provider-rename-migration.test.ts`（新建）

- [ ] **Step 1: 先改枚举类型（编译前提）**

`server/shared/types.ts`：
```ts
// L77
export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder';
// L904
export type TaskEngine = 'claude' | 'codex' | 'opencode' | 'qoder';
```
`server/modules/database/schema.ts` L133：
```ts
const EXECUTOR_PROVIDERS = ['claude', 'codex', 'opencode', 'qoder'] as const;
```
`server/modules/database/repositories/tasks.db.ts` L8：
```ts
export const TASK_ENGINES: readonly TaskEngine[] = ['claude', 'codex', 'opencode', 'qoder'];
```

- [ ] **Step 2: 写失败的迁移测试**

新建 `server/modules/database/tests/provider-rename-migration.test.ts`（镜像 `tasks-status-migration.test.ts` 的建库方式）：
```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { TASKS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const seedLegacyDb = () => {
  const db = new Database(':memory:');
  // Legacy schema: tasks table that only accepts 'sophcode' but not 'opencode'/'qoder'
  db.exec(`CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL DEFAULT '',
    title TEXT, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    executor_provider TEXT NOT NULL DEFAULT 'claude' CHECK (executor_provider IN ('claude','codex','sophcode')),
    executor_model TEXT, position INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, started_at TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT,
    ai_summary TEXT, sub_status TEXT, verdict_reason TEXT, verdict_at TEXT,
    priority TEXT, deadline TEXT, is_operator INTEGER NOT NULL DEFAULT 0,
    label TEXT, remark TEXT
  )`);
  db.prepare(`INSERT INTO tasks (task_id, executor_provider) VALUES ('t1', 'sophcode')`).run();
  db.exec(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'claude',
    provider_session_id TEXT, project_path TEXT NOT NULL DEFAULT '',
    custom_name TEXT, summary TEXT, created_at TEXT, updated_at TEXT
  )`);
  db.prepare(`INSERT INTO sessions (session_id, provider, provider_session_id) VALUES ('s1','sophcode','op-id-1')`).run();
  return db;
};

test('migration renames sophcode rows and accepts opencode/qoder executor engines', () => {
  const db = seedLegacyDb();
  runMigrations(db);

  const session = db.prepare(`SELECT provider FROM sessions WHERE session_id='s1'`).get() as { provider: string };
  assert.equal(session.provider, 'opencode');

  const task = db.prepare(`SELECT executor_provider FROM tasks WHERE task_id='t1'`).get() as { executor_provider: string };
  assert.equal(task.executor_provider, 'opencode');

  // CHECK now accepts opencode and qoder; rejects nothing it used to reject
  db.prepare(`INSERT INTO tasks (task_id, executor_provider) VALUES ('t2','qoder')`).run();
  db.prepare(`INSERT INTO tasks (task_id, executor_provider) VALUES ('t3','opencode')`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO tasks (task_id, executor_provider) VALUES ('t4','bogus')`).run(),
    /CHECK/i
  );
});

test('migration is idempotent on a fresh db', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  runMigrations(db);
  assert.equal(
    (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as { sql: string }).sql,
    'CREATE TABLE tasks ' + TASKS_TABLE_SCHEMA_SQL.trimStart().replace(/^\(/, '(')
  );
});
```
> 若断言与 `TASKS_TABLE_SCHEMA_SQL` 拼接不完全一致，以首个测试（行为断言）为准，第二个测试改为只断言"再次跑不抛错且 t1 行仍为 opencode"。

- [ ] **Step 3: 跑测试确认失败**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/provider-rename-migration.test.ts 2>&1 | tail -15
```
Expected: FAIL（provider 仍是 `sophcode`，`qoder` 插入触发 CHECK）。

- [ ] **Step 4: 实现迁移**

在 `server/modules/database/migrations.ts` 的 `runMigrations` 内、现有 sophcode CHECK 重建（L479-497）之后追加。复用现成模式（`ALTER TABLE tasks RENAME TO tasks_legacy_engine;` + `TASKS_TABLE_SCHEMA_SQL` + 全列 INSERT FROM … SELECT …; `DROP TABLE tasks_legacy_engine;`），代码：
```ts
// Rename provider id 'sophcode' -> 'opencode' across sessions and tasks,
// and rebuild the tasks CHECK to accept opencode + qoder engines.
db.prepare(`UPDATE sessions SET provider='opencode' WHERE provider='sophcode'`).run();
db.prepare(`UPDATE tasks SET executor_provider='opencode' WHERE executor_provider='sophcode'`).run();
const tasksSqlForOpenCode =
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
if (!tasksSqlForOpenCode.includes("'opencode'")) {
  console.log('Running migration: rebuild tasks table to accept opencode + qoder executors');
  try {
    db.exec('BEGIN');
    db.exec('ALTER TABLE tasks RENAME TO tasks_legacy_engine;');
    db.exec(TASKS_TABLE_SCHEMA_SQL);
    db.exec(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark)
      SELECT task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, created_at, updated_at, ai_summary, sub_status, verdict_reason, verdict_at, priority, deadline, is_operator, label, remark
      FROM tasks_legacy_engine
    `);
    db.exec('DROP TABLE tasks_legacy_engine;');
    db.exec('COMMIT');
  } catch (rebuildError) {
    db.exec('ROLLBACK');
    throw rebuildError;
  }
}
// Re-run AFTER rebuild for the unlikely case CREATE TABLE already produced
// 'opencode' data (idempotent).
db.prepare(`UPDATE tasks SET executor_provider='opencode' WHERE executor_provider='sophcode'`).run();
```
> 注意：不能删除既有 sophcode 重建逻辑（老库可能还处在 sophcode CHECK 状态），新 gate 沿用 `tasksSqlForEngine` 判断即可共存。

- [ ] **Step 5: 跑测试确认通过**

Run: 同 Step 3。Expected: PASS（2 个测试）。

- [ ] **Step 6: 跑全库测试回归**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json $(find server/modules/database/tests -name '*.test.ts' | sort) 2>&1 | tail -15
```
Expected: 现有 database 测试全绿（tasks-status-migration.test 等若断言 `['claude','codex','sophcode']` 需同步改为新枚举——立即修）。

- [ ] **Step 7: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add server/shared/types.ts server/modules/database/schema.ts server/modules/database/repositories/tasks.db.ts server/modules/database/migrations.ts server/modules/database/tests/provider-rename-migration.test.ts && git commit -m "feat(providers): rename sophcode->opencode and add qoder to executor engines"
```

---

## Task 2: opencode provider 包重命名

**Files:**
- Rename: `server/modules/providers/list/sophcode/*.ts` → `server/modules/providers/list/opencode/*.ts`（`sophcode-*.ts` → `opencode-*.ts`）
- Modify: 各 facet 文件的类名 `Sophcode*`→`OpenCode*`、字符串 id `'sophcode'`→`'opencode'`、import 路径

- [ ] **Step 1: 重命名目录与文件**

```bash
cd ~/.lovdex/lovdex-backend/server/modules/providers/list
git mv sophcode opencode
cd opencode
for f in sophcode-auth.provider.ts sophcode-models.provider.ts sophcode-mcp.provider.ts sophcode-skills.provider.ts sophcode-sessions.provider.ts sophcode-session-synchronizer.provider.ts sophcode.provider.ts; do
  git mv "$f" "${f/sophcode/opencode}"
done
```

- [ ] **Step 2: 逐个文件改名（类名/id/import/注释）**

对 7 个文件做全局替换：
```bash
cd ~/.lovdex/lovdex-backend/server/modules/providers/list/opencode
sed -i 's/Sophcode/OpenCode/g; s/sophcode/opencode/g' *.ts
```
> 之后人工检查：`sophcode.provider.ts → opencode.provider.ts` 里对齐 `AbstractProvider` import、各 facet import 路径；`opencode-session-synchronizer.provider.ts` 的 `PROVIDER = 'opencode'`、write 到 sessionsDb 的 provider 参数已是 `'opencode'`。**不要动** DB 查询字段（`opencode.db` 表名、`directory`/`path` 列）。

- [ ] **Step 3: 更新测试（跟随重命名）**

```bash
cd ~/.lovdex/lovdex-backend
for f in server/modules/providers/tests/sophcode-auth.test.ts server/modules/providers/tests/sophcode-synchronizer.test.ts server/modules/providers/tests/sophcode-sessions.test.ts server/modules/providers/tests/sophcode-models.test.ts; do
  git mv "$f" "${f/sophcode/opencode}"
done
sed -i 's/Sophcode/OpenCode/g; s/sophcode/opencode/g' server/modules/providers/tests/opencode-auth.test.ts server/modules/providers/tests/opencode-synchronizer.test.ts server/modules/providers/tests/opencode-sessions.test.ts server/modules/providers/tests/opencode-models.test.ts
```
保留一个例外断言：opencode synchronizer 测试里构造的 opencode.db（`directory` 列）与目录列修复的断言原样保留。

- [ ] **Step 4: 跑 provider 测试**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json $(find server/modules/providers/tests -name '*.test.ts' | sort) 2>&1 | tail -20
```
Expected: 重命名后 FAIL 的地方限于仍在引用 `sophcode` id 的注册点（Task 5 修）。`websocket/tests/` 的 runner 测试在 Task 3 跟随 runner 改名，本 Task 不碰。

- [ ] **Step 5: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A server/modules/providers && git commit -m "refactor(providers): rename sophcode provider package to opencode"
```

---

## Task 3: opencode-runner.js（运行时重命名 + 二进制回退）

**Files:**
- Rename: `server/sophcode-runner.js` → `server/opencode-runner.js`
- Modify: 函数名 `Sophcode`→`OpenCode`、spawn 二进制解析
- Test: `server/modules/websocket/tests/opencode-runner.test.js`

- [ ] **Step 1: 重命名 runner + 改二进制解析**

```bash
cd ~/.lovdex/lovdex-backend && git mv server/sophcode-runner.js server/opencode-runner.js
```
`server/opencode-runner.js` 内：
- 全局 `sophcode`→`opencode`、`Sophcode`→`OpenCode`（函数/变量/注释/错误文案）。
- **spawn 二进制解析**（新增导出，供测试；按 spec 决策 3：`OPENCODE_BIN` env → 真实 `opencode` → 缺失回退 `sophcode` fork）：
```js
export function probeOpenCodeInstalled() {
  try {
    const r = spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
export function resolveOpenCodeBinary(opts = {}) {
  const envBin = opts.bin !== undefined ? opts.bin : process.env.OPENCODE_BIN;
  if (envBin && envBin.trim()) {
    return envBin.trim();
  }
  const available = opts.opencodeAvailable !== undefined ? opts.opencodeAvailable : probeOpenCodeInstalled();
  return available ? 'opencode' : 'sophcode';
}
```
`queryOpenCode` 内 spawn 处改为：
```js
const child = spawn(resolveOpenCodeBinary(), args, { ... });
```
- 其余保持 sophcode-runner.js 的既有逻辑（NDJSON 解析、`resolveSophcodeCwd`→`resolveOpenCodeCwd`、session_created 上报、abort/active 集合）。**保留** opencode.db 的 `directory` 列优先逻辑（在 `resolveOpenCodeCwd`）。

- [ ] **Step 2: 更新 runner 测试**

`server/modules/websocket/tests/sophcode-runner.test.js` → `opencode-runner.test.js`，全局替换 id/函数名，并在测试文件新增用例（用注入参数，避免本机真实探测歧义）：
```ts
import { probeOpenCodeInstalled, resolveOpenCodeBinary } from '../../../opencode-runner.js';
test('resolveOpenCodeBinary: env > opencode probe > sophcode fallback', () => {
  assert.equal(resolveOpenCodeBinary({ bin: '/opt/opencode/bin/opencode' }), '/opt/opencode/bin/opencode');
  assert.equal(resolveOpenCodeBinary({ bin: undefined, opencodeAvailable: true }), 'opencode');
  assert.equal(resolveOpenCodeBinary({ bin: undefined, opencodeAvailable: false }), 'sophcode');
});
```
> `probeOpenCodeInstalled()` 用真实 `spawnSync('opencode')` 探测，本机无 opencode 二进制，正常返回 false（这是预期）。若 `sophcode` 二进制缺失回退也不可用，queryOpenCode 会在 spawn 后走既有的 127/not-installed 错误路径（该路径沿用 sophcode-runner 现状，不改）。若测试文件当前用 `sophcode` 字符串 mock spawn，把 spawn mock 的二进制参数断言改成按 `resolveOpenCodeBinary()` 结果断言。

- [ ] **Step 3: 跑测试**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/opencode-runner.test.js 2>&1 | tail -15
```
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A server/opencode-runner.js server/modules/websocket/tests/opencode-runner.test.js && git commit -m "refactor(providers): rename sophcode runner to opencode with binary fallback"
```

---

## Task 4: opencode facet 增量合并（auth/models/skills/mcp）

**Files:**
- Copy from: `C: /home/zhijuhuang/workdir/claudecodeui/server/modules/providers/list/opencode/opencode-auth.provider.ts`
- Copy from: `C: .../opencode/opencode-models.provider.ts`
- Copy from: `C: .../opencode/opencode-skills.provider.ts`
- Copy from: `C: .../opencode/opencode-mcp.provider.ts`
- Overwrite: `server/modules/providers/list/opencode/opencode-auth.provider.ts` 等 4 个文件
- Keep (不改动): `opencode-sessions.provider.ts`、`opencode-session-synchronizer.provider.ts`（保留 lovdex 的 `directory` 列修复）

- [ ] **Step 1: auth 合并（保留 lovdex 风格，补 claudecodeui 环境变量回退）**

覆盖 `opencode-auth.provider.ts`：以 claudecodeui 版本为基底，但把 `import { readFile } from 'node:fs/promises'` 等按 lovdex 代码风格排布；关键新增内容（claudecodeui 有、当前 sophcode auth 无的）：
```ts
const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];
// 在 auth.json 解析未命中时回退：任一 env key 有值 => authenticated (method: 'environment')
```
`checkInstalled()` 的探测二进制仍是 `opencode`（不再 `sophcode`）。

- [ ] **Step 2: models 合并**

覆盖 `opencode-models.provider.ts`：以 claudecodeui 版本为基底（预置 `opencode/*` OpenCode Zen 目录 + 动态 `opencode models --verbose`），**改默认值**：
```ts
export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  // 本机沿用 sophcode 的默认：真实 fork 用的模型
  OPTIONS: [{ value: 'opencode/deepseek-v4-flash-free', label: 'opencode/deepseek-v4-flash-free' }],
  DEFAULT: 'opencode/deepseek-v4-flash-free',
};
```
> 若 claudecodeui 的 models provider 有"读 session 的 active model"逻辑且引用了 `@/shared/utils.js` 里不存在的 helper，按 lovdex `sophcode-models.provider.ts` 现有实现对齐（它已实现同样的 getCurrentActiveModel 契约）。

- [ ] **Step 3: skills 合并**

覆盖 `opencode-skills.provider.ts`：以 claudecodeui 版本为基底（user roots `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`；project roots cwd→topmost-git-root 下的 `.opencode/skills`、`.claude/skills`、`.agents/skills`；去重；前缀 `/`）。确认 claudecodeui 用到的 helper（`findTopmostGitRoot`、`addUniqueProviderSkillSource`、`SkillsProvider`）在 lovdex `server/shared/utils.ts` / `server/modules/providers/shared/skills/skills.provider.ts` 中存在；缺则从 claudecodeui 对应位置复制补齐。

- [ ] **Step 4: mcp 合并**

覆盖 `opencode-mcp.provider.ts`：以 claudecodeui 版本为基底（user config `~/.config/opencode/opencode.json`，`.jsonc` 存在时读取；project workspace `opencode.json`/`opencode.jsonc`；scope `['user','project']`，transport `['stdio','http']`）。对比 lovdex `sophcode-mcp.provider.ts` 的 `McpProvider` 基类签名（`readScopedServers`/`writeScopedServers`/`buildServerConfig`/`normalizeServerConfig`）若基类一致则基本照搬。

- [ ] **Step 5: 跑 opencode 相关测试**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/opencode-auth.test.ts server/modules/providers/tests/opencode-models.test.ts server/modules/providers/tests/mcp.test.ts server/modules/providers/tests/skills.test.ts 2>&1 | tail -20
```
Expected: PASS。若 claudecodeui 行为与 lovdex 既有测试断言冲突（如 mcp 配置文件路径），**以 lovdex 现有测试的组织方式为准**，把断言补进对应测试。

- [ ] **Step 6: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A server/modules/providers/list/opencode && git commit -m "feat(providers): merge opencode auth/models/skills/mcp facets from claudecodeui"
```

---

## Task 5: 后端登记点（registry / routes / capabilities / synchronizer / commands / index）

**Files:**
- Modify: `server/modules/providers/provider.registry.ts`
- Modify: `server/modules/providers/provider.routes.ts`（~L287）
- Modify: `server/modules/providers/services/provider-capabilities.service.ts`（~L55）
- Modify: `server/modules/providers/services/session-synchronizer.service.ts`（~L20）
- Modify: `server/routes/commands.js`（L18-24）
- Modify: `server/index.js`（L95-113 spawnFns/abortFns、~L1158 token 分支）

- [ ] **Step 1: registry（延后到 Task 6 一起改）**

`provider.registry.ts` 的 `providers: Record<LLMProvider, IProvider>` 需要 4 个键齐全才能编译，而 `QoderProvider` 要到 Task 6 才存在。**本 Task 不改 registry**；Task 6 Step 3 统一替换为：
```ts
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  opencode: new OpenCodeProvider(),
  qoder: new QoderProvider(),
};
```

- [ ] **Step 2: provider.routes.ts parseProvider**

`server/modules/providers/provider.routes.ts` 约 L285-289：
```ts
  normalized === 'claude'
  || normalized === 'codex'
  || normalized === 'opencode'
  || normalized === 'qoder'
```

- [ ] **Step 3: capabilities**

`server/modules/providers/services/provider-capabilities.service.ts`：把 `sophcode` entry 改名 `opencode`（`provider: 'opencode'`），并新增：
```ts
  qoder: {
    provider: 'qoder',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
```
（按 claudecodeui qoder capabilities 的字段可比照现有 sophcode 的 `supportsX` 设定。）

- [ ] **Step 4: session-synchronizer.service**

`Record<LLMProvider, number>` → `{ claude: 0, codex: 0, opencode: 0, qoder: 0 }`。若该 service 里有 provider→path/扫描配置，按 `server/modules/providers/services/sessions-watcher.service.ts` 的 `PROVIDER_WATCH_PATHS`（目前只有 claude/codex 的目录）保持一致——opencode 继续不挂 watcher（其数据在 opencode.db，由全量同步覆盖）；qoder 也可不挂（进程启动全量同步 + 打开时兜底）。

- [ ] **Step 5: commands.js**

```ts
const MODEL_PROVIDERS = ["claude", "codex", "opencode", "qoder"];
const MODEL_PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
};
```

- [ ] **Step 6: index.js**

```js
const spawnFns = {
    claude: queryClaudeSDK,
    codex: queryCodex,
    opencode: queryOpenCode,   // 来自 Task 3 的 server/opencode-runner.js
};
const abortFns = {
    claude: abortClaudeSDKSession,
    codex: abortCodexSession,
    opencode: abortOpenCodeSession,
};
// qoder 的 spawn/abort 键在 Task 7（qoder-runner.js 完成后）补上。
```
token-usage 浏览分支（~L1158）：`if (provider === 'sophcode')` → `if (provider === 'opencode')`，错误文案 Sophcode→OpenCode。qoder 的 token 浏览分支留到 Task 7 一起处理（qoder 无 opencode.db）。

- [ ] **Step 7: 测试**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json $(find server/modules/providers/tests -name '*.test.ts' | sort) server/routes/tests/commands.test.js 2>&1 | tail -20
```
Expected: PASS（commands.test 若 Whitelist 断言修改为 `['claude','codex','opencode','qoder']` 需同步）。

- [ ] **Step 8: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A server/modules/providers server/routes/commands.js server/index.js && git commit -m "feat(providers): register opencode (renamed) across backend provider surface + shape for qoder"
```

---

## Task 6: qoder provider 包（7 面 facets）

**Files:**
- Copy from: `C: /home/zhijuhuang/workdir/claudecodeui/server/modules/providers/list/qoder/{qoder.provider.ts,qoder-auth.provider.ts,qoder-models.provider.ts,qoder-mcp.provider.ts,qoder-skills.provider.ts,qoder-sessions.provider.ts,qoder-session-synchronizer.provider.ts}`
- Create: `server/modules/providers/list/qoder/` 同名 7 个文件
- Test: `server/modules/providers/tests/qoder-synchronizer.test.ts`（新建）

- [ ] **Step 1: 复制 7 面 facets**

```bash
mkdir -p ~/.lovdex/lovdex-backend/server/modules/providers/list/qoder
cp /home/zhijuhuang/workdir/claudecodeui/server/modules/providers/list/qoder/qoder{,-auth,-models,-mcp,-skills,-sessions,-session-synchronizer}.provider.ts \
   ~/.lovdex/lovdex-backend/server/modules/providers/list/qoder/
```
Import 路径差异修复：claudecodeui 用 `@/modules/...`、`@/shared/...`，lovdex 的 provider 包内 import 同款（`@/` 别名下为 `server/`），所以**一般无需改动 import**。逐个确认：
- `qoder-session-synchronizer.provider.ts` 用到的 `findFilesRecursivelyCreatedAfter`、`normalizeSessionName`、`readFileTimestamps`、`sessionsDb` 在 lovdex `server/shared/utils.ts`、`server/modules/database/index.js` 存在（sophcode synchronizer 已用同款）。
- `qoder-sessions.provider.ts` 用到 `sliceTailPage`、`generateMessageId` → 确认 `server/shared/utils.ts` 有；没有就从 claudecodeui 同文件补 import/导出。
- `qoder-mcp.provider.ts` 的 `McpProvider` 基类与 lovdex 版本接口一致（读 `server/modules/providers/shared/mcp/mcp.provider.ts` 比对 `super('qoder', ...)` 签名）。
- `qoder.provider.ts` 的 `AbstractProvider`、各 facet import 路径确认。

- [ ] **Step 2: 写 qoder synchronizer 测试**

新建 `server/modules/providers/tests/qoder-synchronizer.test.ts`，沿用 `opencode-synchronizer.test.ts`（Task 2 改名所得）的两件套——`patchHomeDir(nextHomeDir)` mock `os.homedir()` + `withIsolatedLovdexDb(runTest)`（临时 `DATABASE_PATH`，`closeConnection()` + `initializeDatabase()` 隔离，避免写真库）。测试体（注意 mock 后 `os.homedir()` 指向临时目录，故 `projectsRoot` 用 `~/.qoder/projects` 的等价路径）：
```ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QoderSessionSynchronizer } from '@/modules/providers/list/qoder/qoder-session-synchronizer.provider.js';

// patchHomeDir / withIsolatedLovdexDb 从 opencode-synchronizer.test.ts 原样复制

test('qoder synchronizer indexes only top-level session jsonl (skips agent-*)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-sync-'));
  const restoreHome = patchHomeDir(home);
  await withIsolatedLovdexDb(async () => {
    const projectsRoot = path.join(home, '.qoder', 'projects');
    const cwdDir = path.join(projectsRoot, '-mnt-app');
    await fs.mkdir(path.join(cwdDir, 'agent-sub'), { recursive: true });
    const sessionFile = path.join(cwdDir, 'abc-123.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({ cwd: '/mnt/app' }) + '\n' + JSON.stringify({ message: { role: 'user', content: 'hello' } }) + '\n');
    await fs.writeFile(path.join(cwdDir, 'agent-x.jsonl'), JSON.stringify({ type: 'text' }) + '\n');
    await fs.writeFile(path.join(cwdDir, 'agent-sub', 'nested.jsonl'), '{"type":"text"}\n');

    const sync = new QoderSessionSynchronizer();
    assert.equal(await sync.synchronizeFile(sessionFile), 'abc-123');
    assert.equal(await sync.synchronizeFile(path.join(cwdDir, 'agent-x.jsonl')), null);
    assert.equal(await sync.synchronizeFile(path.join(cwdDir, 'agent-sub', 'nested.jsonl')), null);
  });
  restoreHome();
});
```
> 若 `withIsolatedLovdexDb` 在 opencode-synchronizer.test.ts 里是 module 级复用（非导出），本文件复制一份即可。断言 `synchronizeFile` 返回值：对照 `qoder-session-synchronizer.provider.ts` 的实际签名（返回 sessionId 或 null），如与 `'abc-123'` 形式不符按实际调整断言。

- [ ] **Step 3: 补 registry / routes / capabilities / commands 的 qoder 键（承接 Task 5 占位）**

回到 `provider.registry.ts`、`provider.routes.ts`、`capabilities`、`commands.js`、`index.js`：把 Task 5 预留的 qoder 键/import 真正接上（编译通过）。

- [ ] **Step 4: 跑 qoder 测试 + provider 全套**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json $(find server/modules/providers/tests -name '*.test.ts' | sort) 2>&1 | tail -20
```
Expected: 全部 PASS（含新 qoder-synchronizer）。

- [ ] **Step 5: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A server/modules/providers && git commit -m "feat(providers): add qoder provider facets (auth/models/mcp/skills/sessions/synchronizer)"
```

---

## Task 7: qoder-runner.js（运行时）

**Files:**
- Create: `server/qoder-runner.js`（由 claudecodeui `qoder-runtime.provider.js` 改写成 lovdex runner 约定）
- Modify: `server/index.js`（把 Task 5 预留的 `qoder` spawn/abort 接上对 `queryQoder/abortQoderSession`）
- Test: `server/modules/websocket/tests/qoder-runner.test.js`（新建）

- [ ] **Step 1: 起草 qoder-runner.js**

以 claudecodeui `C: /home/zhijuhuang/workdir/claudecodeui/server/modules/providers/list/qoder/qoder-runtime.provider.js` 为基底，把 `context.*` 全去掉，对齐 lovdex `sophcode-runner.js` 约定：

- `queryQoder(command, options = {}, ws)` 签名（不再收 context）：
```js
export async function queryQoder(command, options = {}, ws) {
  const {
    sessionId = null,       // provider-native session id（chat 网关已传，见 chat-websocket.service runtimeOptions.sessionId）
    model, effort,
    permissionMode = 'default',
    cwd = process.cwd(),
    projectPath,
    images = [],
    files = [],
    mcpConfigPath,
  } = options;
```
- `context.resolveProviderSessionId(sessionId)` → 直接用 `sessionId`（chat 网关传的已是 provider 原生 id；task 启动路径 headless-task-run.service 也传 `session.provider_session_id`）。
- `context.resolveResumeModel(...)` → 保持 `model`（同 sophcode-runner 现行为；如需从 session 恢复活动模型，参照 `server/modules/providers/services/provider-models.service.ts` 的 resolve 逻辑后补）。
- `context.normalizeMessage(event, sessionId)` → `new QoderSessionsProvider().normalizeMessage(event, sessionId)`（import 自 `@/modules/providers/list/qoder/qoder-sessions.provider.js`）。
- `context.isProviderInstalled()` → `providerAuthService.getProviderAuthStatus('qoder')` 后取 `.installed`（sophcode-runner 已这样 import `providerAuthService`）。
- 通知 import 改 `./services/notification-orchestrator.js`（`notifyRunFailed/notifyRunStopped`）。
- 消息构造函数改 `createNormalizedMessage/createCompleteMessage/flattenPromptForWindowsShell` 自 `./shared/utils.js`（sophcode-runner 同款）。
- spawn 二进制为 `qodercli`，参数向量保留 claudecodeui 的 `buildQoderArgs`（`-p -o stream-json --cwd ... --resume ... --model ... --reasoning-effort ... --permission-mode ... --attachment ...`）与 `resolveQoderPermissionOptions`/`readQoderSessionId`，导出给测试。
- 活跃进程集合 `activeQoderProcesses`、`abortQoderSession/isQoderSessionActive/getActiveQoderSessions`。

- [ ] **Step 2: 写失败的 runner 单测**

新建 `server/modules/websocket/tests/qoder-runner.test.js`（仿 `opencode-runner.test.js` 的纯函数测试组织，不 spawn 真 CLI）：
```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQoderArgs, readQoderSessionId, resolveQoderPermissionOptions } from '../../../qoder-runner.js';

test('buildQoderArgs assembles qodercli resume + model + permission vector', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp/work',
    providerSessionId: 'sess-1',
    model: 'auto',
    effort: 'high',
    permissionMode: 'acceptEdits',
    attachments: ['/tmp/a.png'],
    prompt: 'hello',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--resume') && args.includes('sess-1'));
  assert.ok(args.includes('--permission-mode') && args.includes('accept_edits'));
  assert.ok(args.includes('--reasoning-effort') && args.includes('high'));
  assert.deepEqual(resolveQoderPermissionOptions('bypassPermissions'), { args: ['--permission-mode', 'bypass_permissions'], env: {} });
  assert.equal(readQoderSessionId({ session_id: 's1' }), 's1');
  assert.equal(readQoderSessionId({ sessionID: 's2' }), 's2');
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/qoder-runner.test.js 2>&1 | tail -15
```
Expected: FAIL（模块不存在 / 函数未导出）。

- [ ] **Step 4: 实现（把 Step 1 起草的文件落盘）**

写完 `server/qoder-runner.js` 全量实现（含导出 `buildQoderArgs/readQoderSessionId/resolveQoderPermissionOptions`），并在 `server/index.js` 把 import 与 spawnFns/abortFns 的 `qoder` 键接到 `queryQoder/abortQoderSession`。

- [ ] **Step 5: 跑测试确认通过**

Run: 同 Step 3。Expected: PASS。

- [ ] **Step 6: token-usage 浏览分支（index.js）**

把 Task 5 遗留的 `if (provider === 'qoder')` 过渡分支按 qoder 凭据来源完善：qoder 无本地 sqlite，直接返回空 token 结构（`{ tokens: { inputTokens: 0, outputTokens: 0 }, provider: 'qoder' }`）。若 claudecodeui 在 `sessions` facet 的 fetchHistory 自带 token usage（`aggregateOpenCodeSessionTokenUsage` 类似物），把该 helper 一并移植到 `qoder-sessions.provider.ts` 并在浏览分支复用（以 claudecodeui 实现为准）。

- [ ] **Step 7: 全量后端测试**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json $(find server/modules/providers/tests server/modules/websocket/tests server/modules/database/tests server/routes/tests \( -name '*.test.ts' -o -name '*.test.js' \) | sort) 2>&1 | tail -25
```
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A server/qoder-runner.js server/modules/websocket/tests/qoder-runner.test.js server/index.js && git commit -m "feat(providers): add qoder live runtime (qoder-runner) and wire spawn/abort"
```

---

## Task 8: 后端收尾（grep 残留 + typecheck + 全量回归）

- [ ] **Step 1: sophcode 残留清理**

```bash
cd ~/.lovdex/lovdex-backend && grep -rn "sophcode" server/ --include="*.ts" --include="*.js" | grep -v node_modules | grep -v "list/sophcode\|sophcode-" 
```
逐条处理：残留的 `'sophcode'` id → `'opencode'`；文件/目录名 → 改名；注释可改文案但无功能。

**T1 遗留项也在此处理：**
1. `scheduled_tasks` 表行迁移：scheduler 的 dispatch 把 `schedule.executor_provider` 直接传给 `createTask`（无 isTaskEngine 校验），老库若有 `executor_provider='sophcode'` 的定时任务会撞新 CHECK 硬失败。在 `migrations.ts` 加一条带守卫的迁移：`if (tableExists(db,'scheduled_tasks')) db.prepare("UPDATE scheduled_tasks SET executor_provider='opencode' WHERE executor_provider='sophcode'").run();`（放进 `runMigrations`，列名以 `scheduled_tasks` 实际 schema 为准）。
2. 修 `server/modules/database/tests/tasks-status-migration.test.ts` L258-261 的过时注释：SOPHCODE_ERA 形状现在实际上会触发 opencode 重建（而非"不触发任何重建直接测 reminder gate"），按新行为改注释。
3. （可选）`migrations.ts` 的 waiting/label gate 注释补一句"legacy-conservative：只有当表 DDL 是 opencode 时代但缺 waiting_answer/reminder 列时才触发"。

- [ ] **Step 2: typecheck**

```bash
cd ~/.lovdex/lovdex-backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -20
```
Expected: 与基线一致（4 个 pre-existing，无新增）。

- [ ] **Step 3: 全量测试**

```bash
cd ~/.lovdex/lovdex-backend && npx tsx --test --tsconfig server/tsconfig.json $(find server \( -name '*.test.ts' -o -name '*.test.js' \) | sort) 2>&1 | tail -25 || true
```
（若全目录跑有 fixture/路径问题，回退到各 tests 目录批量跑。）Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
cd ~/.lovdex/lovdex-backend && git add -A && git commit -m "chore(providers): remove sophcode residue after rename to opencode"
```

---

## Task 9: 前端 —— 类型 / effort / convertToTaskPayload

**Files:**
- Modify: `src/types/app.ts`（L1 LLMProvider、L90 TaskEngine）
- Modify: `src/components/chat/constants/providerEffort.ts`
- Modify: `src/components/chat/view/subcomponents/convertToTaskPayload.ts`
- Modify: `src/components/chat/view/subcomponents/convertToTaskPayload.test.ts`

- [ ] **Step 1: 改类型**

`src/types/app.ts`：
```ts
export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder';
// 约 L90
export type TaskEngine = 'claude' | 'codex' | 'opencode' | 'qoder';
```

- [ ] **Step 2: effort**

`src/components/chat/constants/providerEffort.ts`：
```ts
export const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  qoder: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};
```
（删 `sophcode` 键；`opencode` 已是 final。）

- [ ] **Step 3: convertToTaskPayload**

`src/components/chat/view/subcomponents/convertToTaskPayload.ts`：
- `FALLBACK_DEFAULT_MODEL` 去 `sophcode`，补 `qoder: 'auto'`，opencode 默认 `opencode/deepseek-v4-flash-free`：
```ts
const FALLBACK_DEFAULT_MODEL: Partial<Record<LLMProvider, string>> = {
  claude: 'default',
  codex: 'gpt-5.4',
  opencode: 'opencode/deepseek-v4-flash-free',
  qoder: 'auto',
};
```
- provider 判空守卫 `isTaskEngine` 的 checked 枚举改 `['claude','codex','opencode','qoder']`。

- [ ] **Step 4: 同步测试 + 跑**

更新 `convertToTaskPayload.test.ts`：现有 `sophcode: 'opencode/deepseek-v4-flash-free'` 断言改 `opencode`；补 `qoder` 用例。
```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/chat/view/subcomponents/convertToTaskPayload.test.ts 2>&1 | tail -15
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd ~/.lovdex/lovdex-cli && git add src/types/app.ts src/components/chat/constants/providerEffort.ts src/components/chat/view/subcomponents/convertToTaskPayload.ts src/components/chat/view/subcomponents/convertToTaskPayload.test.ts && git commit -m "feat(chat): opencode/qoder provider types, effort and task payload mapping"
```

---

## Task 10: 前端 —— useChatProviderState + ProviderSelectionEmptyState + 对话组件

**Files:**
- Modify: `src/components/chat/hooks/useChatProviderState.ts`
- Modify: `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- Modify: `src/components/chat/view/subcomponents/ChatMessagesPane.tsx`
- Modify: `src/components/chat/view/subcomponents/MessageComponent.tsx`
- Modify: `src/components/chat/view/subcomponents/CommandResultModal.tsx`
- Modify: `src/components/chat/view/ChatInterface.tsx`
- Modify: `src/components/chat/hooks/useChatComposerState.ts`

- [ ] **Step 1: useChatProviderState**

- `PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder']`
- `FALLBACK_DEFAULT_MODEL`：删 `sophcode` 与 `cursor`，`opencode: 'opencode/deepseek-v4-flash-free'`，`qoder: 'auto'`
- localStorage key：删 `sophcode-model` 分支与 `sophcode` state；`opencodeModel` 沿用现有 `opencode-model` key（保持 `readStoredProvider` 兼容）；新增 `qoderModel`（`qoder-model` key）
- permissionModes：`opencode`/`qoder` → `['default','acceptEdits','bypassPermissions','plan']`
- `pickStoredOrCurrent` 与 catalog 同步 effects：删 cursor/sophcode，加 qoder（照 claudecodeui qoder 分支补 `providerModelCatalog.qoder`）
- 返回的 providerModelCatalog 对象只含 4 个 provider 键

- [ ] **Step 2: ProviderSelectionEmptyState**

- `PROVIDER_META` 改为仅 `[{id:'claude',name:'Anthropic'},{id:'codex',name:'OpenAI'},{id:'opencode',name:'OpenCode'},{id:'qoder',name:'Qoder'}]`；模型选择分支把 `sophcode` 分支改名为 `opencode`（读 `opencodeModel` props 与 `providerModelCatalog.opencode`），新增 `qoder` 分支（读 `qoderModel` props 与 `providerModelCatalog.qoder`）。同步更新该文件顶层 props 类型里的 `sophcodeModel`/`opencodeModel` 字段（删 sophcode、保 opencode、加 qoderModel）。

- [ ] **Step 3: 对话组件分支**

对 `ChatMessagesPane.tsx`、`MessageComponent.tsx`、`CommandResultModal.tsx`、`ChatInterface.tsx`、`useChatComposerState.ts`：删 `sophcode` 分支，保留/新增 `opencode` 与 `qoder` 分支（若分支仅是"非 claude/codex 兜底"，通常直接把判断变量换名即可；qoder 需要与 sophcode/opencode 相同的特殊处理时分支共享）。

- [ ] **Step 4: 前端类型检查 + 现有前端测试**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test $(find src/components/chat src/components/tasks -name "*.test.ts" -o -name "*.test.tsx" | sort) 2>&1 | tail -20
```
Expected: 无新增 tsc 错误；既有测试全绿。

- [ ] **Step 5: Commit**

```bash
cd ~/.lovdex/lovdex-cli && git add src/components/chat && git commit -m "feat(chat): surface opencode/qoder in provider state, empty state and chat components"
```

---

## Task 11: 前端 —— Logo（QoderLogo）

**Files:**
- Copy from: `C: /home/zhijuhuang/workdir/claudecodeui/src/components/llm-logo-provider/QoderLogo.tsx`
- Create: `src/components/llm-logo-provider/QoderLogo.tsx`
- Modify: `src/components/llm-logo-provider/SessionProviderLogo.tsx`

- [ ] **Step 1: 复制 QoderLogo**

```bash
cp /home/zhijuhuang/workdir/claudecodeui/src/components/llm-logo-provider/QoderLogo.tsx ~/.lovdex/lovdex-cli/src/components/llm-logo-provider/QoderLogo.tsx
```
若无默认导出或为 `export const QoderLogo = ...`，在 `SessionProviderLogo` 里匹配其导出形态（照 claudecodeui 用法）。

- [ ] **Step 2: SessionProviderLogo**

`src/components/llm-logo-provider/SessionProviderLogo.tsx`：
```tsx
import QoderLogo from './QoderLogo';
// ...
if (provider === 'opencode') {
  return <OpenCodeLogo className={className} />;
}
if (provider === 'qoder') {
  return <QoderLogo className={className} />;
}
// 删除 sophcode 分支；可删除 SophcodeLogo.tsx 文件
```

- [ ] **Step 3: typecheck**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10
```
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
cd ~/.lovdex/lovdex-cli && git add src/components/llm-logo-provider && git commit -m "feat(chat): qoder logo and session provider logo support"
```

---

## Task 12: 前端 —— 任务组件

**Files:**
- Modify: `src/components/tasks/TaskCard.tsx`
- Modify: `src/components/tasks/TaskBoard.tsx`
- Modify: `src/components/tasks/TaskTableView.tsx`
- Modify: `src/components/tasks/TaskDetail.tsx`
- Modify: `src/components/tasks/TaskDetail.test.tsx`（如有涉及）

- [ ] **Step 1: 逐组件替换**

对 4 个任务组件：`sophcode`/`SophCode`/`SophCode` 文案与分支 → `opencode`/`OpenCode`；`TaskDetail.tsx` L696-698 的下拉 `<option value="sophcode">SophCode</option>` 改为 `opencode` + 新增 `qoder` option：
```tsx
<option value="opencode">OpenCode</option>
<option value="qoder">Qoder</option>
```
若组件里用 `TASK_ENGINES`/`isTaskEngine` 判空，改随类型自动生效。

- [ ] **Step 2: 测试**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test $(find src/components/tasks -name "*.test.ts" -o -name "*.test.tsx" | sort) 2>&1 | tail -15
```
Expected: 全绿（涉及 provider 文案的断言同步改）。

- [ ] **Step 3: Commit**

```bash
cd ~/.lovdex/lovdex-cli && git add src/components/tasks && git commit -m "feat(tasks): opencode/qoder executor engines in task components"
```

---

## Task 13: 前端收尾（残留 + 全量验证）

- [ ] **Step 1: sophcode + cursor 残留清理**

```bash
cd ~/.lovdex/lovdex-cli && grep -rn -E "sophcode|cursor" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```
逐条处理为 opencode（sophcode）；cursor 是 claudecodeui 残留（lovdex 无 cursor provider），一律删除对应分支/键/组件引用（含 `src/components/main-content/view/subcomponents/MainContentTitle.tsx` 的 `__provider === 'cursor'` 判断）。

- [ ] **Step 2: 全量前端测试**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | sort) 2>&1 | tail -20
```
Expected: 全部 PASS（基线 234 个，改动后复跑确认数量/无失败）。

- [ ] **Step 3: typecheck**

```bash
cd ~/.lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
cd ~/.lovdex/lovdex-cli && git add -A && git commit -m "chore: remove sophcode residue after opencode rename"
```

---

## Task 14: 端到端验收（需用户确认后重启后端）

> **强约束：任何后端重启（systemctl 或 kill 子进程）必须先征得用户同意。** 本任务前半是只读检查，后半的运行时验证需要重启，务必先确认。

- [ ] **Step 1: 只读检查**

```bash
# 残留
cd ~/.lovdex/lovdex-backend && grep -rn "sophcode" server/ --include="*.ts" --include="*.js" | grep -v node_modules || echo "CLEAN-BACKEND"
cd ~/.lovdex/lovdex-cli && grep -rn "sophcode" src/ || echo "CLEAN-FRONTEND"

# opencode.db 中在库会话归属（重启前只读，不写）
sqlite3 ~/.local/share/opencode/opencode.db "SELECT count(*) FROM session" 2>/dev/null || true
```

- [ ] **Step 2: 与用户确认重启**

向用户说明：后端需要 reload 加载新 provider（sophcode→opencode + qoder）。征得同意后执行最小重启：
```bash
pgrep -af "tsx server/index.js"    # 找到后端子进程
kill -TERM <pid>                    # supervisor 会自动拉起
```

- [ ] **Step 3: 运行时冒烟**

- 打开 lovdex-cli，确认 provider 选择出现 OpenCode 与 Qoder。
- 新建 Qoder 会话发一条消息：流式输出、完成、token 用量正常；abort 正常。
- 打开既有 opencode（原 sophcode fork）会话：历史正常、可续聊。
- 任务的 executor 下拉可选 OpenCode / Qoder。
- 后端 `ls -la ~/.sophcode/auth.db` 查询旧会话 provider 已为 `opencode`：
```bash
sqlite3 ~/.sophcode/auth.db "SELECT provider, count(*) FROM sessions GROUP BY provider"
```

- [ ] **Step 4: 上线状态记录**

跑通后把结果按事实汇报；若有失败项如实说明，不回填。

---

## Self-Review 记录

- **Spec 覆盖**：9/9 —— spec §4.1 迁移 → Task 1；§4.2 重命名 → Task 2-3、5；§4.3 facet 合并 → Task 4（含"保留 directory 列修复"显式步骤）；§4.4 qoder 包 → Task 6；§4.5 qoder runner → Task 7；§4.6 注册点 → Task 5+6；§5 前端 → Task 9-12；§6 测试 → 各 Task 内联 + Task 8/13 全量；§7 验收 → Task 8/13/14；§8 风险 → Task 14 重启确认 + Task 3 二进制回退 + Task 6 目录列保留。
- **Placeholder scan**：无 TBD/TODO；代码块均为具体实现/具体复制来源。Task 7 qoder-runner 的完整实现以 claudecodeui 源文件为蓝本 + 适配清单（不重复粘贴 400 行原码，属明确的复制来源，非占位）。
- **Type consistency**：LLMProvider/TaskEngine 两处 union 在 Task 1 与 Task 9 分别定义；后端 `Record<LLMProvider, IProvider>`（Task 5/6）、前端 `Record<LLMProvider, string>` 默认模型（Task 9/10）键集一致为 4 个 provider。runner 函数签名与 `chat-websocket.service.ts` 的 `ProviderSpawnFn(command, options, writer)` 契约经 Task 0 说明对齐。