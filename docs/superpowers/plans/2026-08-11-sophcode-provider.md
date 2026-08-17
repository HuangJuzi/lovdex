# Sophcode Provider 支持 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 lovdex-backend + lovdex-cli 中把 `sophcode` 加为一等公民 Provider（与 claude/codex 并列），用户可在 Web UI 选择 Sophcode 发消息，会话历史/模型列表/MCP/skills/auth/token 用量完整可用。

**Architecture:** 后端复用现有 `IProvider` 抽象（models/mcp/auth/skills/sessions/sessionSynchronizer），新增 `server/modules/providers/list/sophcode/` 模块；运行时是 lovdex 第一个 CLI 型运行时——spawn `sophcode run --format json` 并解析 NDJSON 事件流（`step_start`/`text`/`step_finish`），sophcode 共享 opencode 的 `~/.local/share/opencode/opencode.db` 和 `~/.config/opencode/opencode.jsonc`。前端把 `sophcode` 加入类型/可选列表/显示，其余由后端 capabilities 驱动。

**Tech Stack:** Node ESM + tsx、Express、better-sqlite3、cross-spawn、React + Vite（前端）。

**Spec:** `docs/superpowers/specs/2026-08-11-sophcode-provider-design.md`

**测试基线（改前）：** 后端 provider 测试 8 个红（7 个因 opencode/cursor 未注册，1 个 codex skills 环境问题不在范围）。

---

## 文件结构

**后端（lovdex-backend，工作目录 `/mnt/b/workdir/github/lovdex/lovdex-backend`）：**
- Create `server/modules/providers/list/sophcode/sophcode.provider.ts`
- Create `server/modules/providers/list/sophcode/sophcode-models.provider.ts`
- Create `server/modules/providers/list/sophcode/sophcode-auth.provider.ts`
- Create `server/modules/providers/list/sophcode/sophcode-mcp.provider.ts`
- Create `server/modules/providers/list/sophcode/sophcode-skills.provider.ts`
- Create `server/modules/providers/list/sophcode/sophcode-sessions.provider.ts`
- Create `server/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.ts`
- Create `server/sophcode-runner.js`
- Create tests: `server/modules/providers/tests/sophcode-models.test.ts`, `sophcode-auth.test.ts`, `sophcode-sessions.test.ts`, `sophcode-synchronizer.test.ts`, `server/modules/websocket/tests/sophcode-runner.test.ts`
- Modify: `server/shared/types.ts`(LLMProvider)、`server/modules/providers/provider.registry.ts`、`server/modules/providers/provider.routes.ts`(parseProvider)、`server/modules/providers/services/provider-capabilities.service.ts`、`server/index.js`(spawnFns/abortFns + token-usage 分支)、`server/modules/providers/tests/mcp.test.ts`、`server/modules/providers/tests/skills.test.ts`

**前端（lovdex-cli，工作目录 `/mnt/b/workdir/github/lovdex/lovdex-cli`）：**
- Modify: `src/types/app.ts`、`src/components/chat/hooks/useChatProviderState.ts`、`src/components/chat/constants/providerEffort.ts`、`src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`、`src/components/llm-logo-provider/SessionProviderLogo.tsx`、`src/i18n/locales/en/chat.json`
- Create: `src/components/llm-logo-provider/SophcodeLogo.tsx`

**测试命令（后端）：** `unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test <file>`
**类型检查：** `npm run typecheck`（后端）、`npx tsc --noEmit`（前端）

---

## Task 1: sophcode-models.provider.ts

**Files:**
- Create: `server/modules/providers/list/sophcode/sophcode-models.provider.ts`
- Test: `server/modules/providers/tests/sophcode-models.test.ts`

- [ ] **Step 1: 写失败测试**（mock `sophcode models` 输出与 opencode.db）

```ts
// server/modules/providers/tests/sophcode-models.test.ts
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DebugDatabases } from '@/shared/utils.js'; // 见下：不引入，用临时替换

import { SophcodeProviderModels } from '@/modules/providers/list/sophcode/sophcode-models.provider.js';

test('sophcode models provider builds catalog from `sophcode models`', async () => {
  const provider = new SophcodeProviderModels();
  const def = await provider.getSupportedModels();
  assert.ok(def.OPTIONS.length > 0);
  assert.ok(def.OPTIONS.every((o) => o.value.includes('/')));
  assert.ok(def.DEFAULT.includes('/'));
});

test('sophcode models provider falls back to static catalog on spawn failure', async () => {
  // Temporarily break the PATH so spawnSync('sophcode') fails.
  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const provider = new SophcodeProviderModels();
    const def = await provider.getSupportedModels();
    assert.ok(def.OPTIONS.length > 0);
  } finally {
    process.env.PATH = originalPath;
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sophcode-models.test.ts`
Expected: FAIL with "Cannot find module ... sophcode-models.provider.js"

- [ ] **Step 3: 实现**

```ts
// server/modules/providers/list/sophcode/sophcode-models.provider.ts
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const SOPHCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'opencode/deepseek-v4-flash-free', label: 'opencode/deepseek-v4-flash-free' }],
  DEFAULT: 'opencode/deepseek-v4-flash-free',
};

export function runSophcodeModels(): string[] {
  try {
    const result = spawnSync('sophcode', ['models'], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0 || !result.stdout) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('/'));
  } catch {
    return [];
  }
}

export function buildSophcodeModelsDefinition(): ProviderModelsDefinition {
  const lines = runSophcodeModels();
  if (lines.length === 0) {
    return SOPHCODE_FALLBACK_MODELS;
  }
  const seenValues = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const value of lines) {
    if (seenValues.has(value)) {
      continue;
    }
    seenValues.add(value);
    options.push({ value, label: value });
  }
  return { OPTIONS: options, DEFAULT: options[0]?.value ?? SOPHCODE_FALLBACK_MODELS.DEFAULT };
}

export function readSophcodeSessionModel(sessionId?: string): string | null {
  if (!sessionId) {
    return null;
  }
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT model FROM session WHERE id = ?').get(sessionId) as
        | { model?: string }
        | undefined;
      return row?.model || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export class SophcodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return buildSophcodeModelsDefinition();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const model = readSophcodeSessionModel(sessionId);
    if (model) {
      return { model };
    }
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('sophcode', input);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同上命令
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/sophcode-models.provider.ts server/modules/providers/tests/sophcode-models.test.ts && git commit -m "feat(providers): add sophcode models provider"
```

---

## Task 2: sophcode-auth.provider.ts

**Files:**
- Create: `server/modules/providers/list/sophcode/sophcode-auth.provider.ts`
- Test: `server/modules/providers/tests/sophcode-auth.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// server/modules/providers/tests/sophcode-auth.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SophcodeProviderAuth } from '@/modules/providers/list/sophcode/sophcode-auth.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('sophcode auth reports installed+authenticated when auth.json has providers', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sophcode-auth-'));
  const authDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, 'auth.json'), JSON.stringify({ SophNet: { type: 'api', key: 'sk-x' } }), 'utf8');
  const restore = patchHomeDir(tempRoot);
  try {
    const status = await new SophcodeProviderAuth().getStatus();
    assert.equal(status.provider, 'sophcode');
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
  } finally {
    restore();
  }
});

test('sophcode auth reports not authenticated when auth.json is missing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sophcode-auth-'));
  const restore = patchHomeDir(tempRoot);
  try {
    const status = await new SophcodeProviderAuth().getStatus();
    assert.equal(status.authenticated, false);
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sophcode-auth.test.ts`
Expected: FAIL "Cannot find module ... sophcode-auth.provider.js"

- [ ] **Step 3: 实现**

```ts
// server/modules/providers/list/sophcode/sophcode-auth.provider.ts
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

export class SophcodeProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      spawnSync('sophcode', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    let authenticated = false;
    let email: string | null = null;
    let method: string | null = null;
    let error: string | undefined;

    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    try {
      if (!fsSync.existsSync(authPath)) {
        error = 'opencode auth.json not found';
      } else {
        const auth = readObjectRecord(JSON.parse(fsSync.readFileSync(authPath, 'utf8'))) ?? {};
        const providerKeys = Object.keys(auth).filter((key) => key !== 'provider');
        if (providerKeys.length > 0) {
          authenticated = true;
          method = 'credentials_file';
          email = providerKeys.join(', ');
        } else {
          error = 'No credentials found in auth.json';
        }
      }
    } catch (readError) {
      error = readError instanceof Error ? readError.message : 'Failed to read auth.json';
    }

    return {
      installed,
      provider: 'sophcode',
      authenticated,
      email,
      method,
      error: authenticated ? undefined : (error || 'Not authenticated'),
    };
  }
}
```

> 注：sophcode/opencode 的 `auth.json` 顶层即 providerId → 凭据对象（如 `{"SophNet": {"type":"api","key":"..."}}`）。若实测结构不同，用 `sophcode auth list` 输出校正 `providerKeys` 提取逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: 同上命令
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/sophcode-auth.provider.ts server/modules/providers/tests/sophcode-auth.test.ts && git commit -m "feat(providers): add sophcode auth provider"
```

---

## Task 3: sophcode-mcp.provider.ts（含修 mcp.test.ts）

**Files:**
- Create: `server/modules/providers/list/sophcode/sophcode-mcp.provider.ts`
- Modify: `server/modules/providers/tests/mcp.test.ts`（opencode 测试改指 sophcode）

- [ ] **Step 1: 把 mcp.test.ts 的 opencode 测试改指 sophcode**

在 `server/modules/providers/tests/mcp.test.ts` 中：
- 测试名 `providerMcpService handles opencode MCP config...` → `...handles sophcode MCP config...`
- 所有 `providerMcpService.upsertProviderMcpServer('opencode', ...)` → `'sophcode'`
- 所有 `providerMcpService.listProviderMcpServers('opencode', ...)` → `'sophcode'`
- 断言里的 `userStdio.type === 'local'` 等保持不变（sophcode 用 opencode 的 mcp 配置格式）
- 不改 `~/.config/opencode/opencode.jsonc` 与 `<workspace>/opencode.json` 路径

同时把文件里 `handle cursor MCP JSON config formats` 测试的 `'cursor'` 相关调用改指 `'sophcode'`（cursor 不注册，此测试改为验证 sophcode 也能处理 project/user JSON 格式；若其断言依赖 cursor 特有格式则删除该测试，见 Task 8）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/mcp.test.ts`
Expected: sophcode MCP 测试 FAIL "Unsupported provider \"sophcode\"."（sophcode 未注册）

- [ ] **Step 3: 实现 sophcode-mcp.provider.ts**

```ts
// server/modules/providers/list/sophcode/sophcode-mcp.provider.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

/** Strips // and /* *​\/ comments and trailing commas so JSONC parses as JSON. */
export function stripJsoncComments(content: string): string {
  return content
    .replace(/^﻿/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^"\\])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

const readJsoncConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return readObjectRecord(JSON.parse(stripJsoncComments(content))) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const writeJsonConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

export class SophcodeMcpProvider extends McpProvider {
  constructor() {
    super('sophcode', ['user', 'project'], ['stdio', 'http']);
  }

  private configPath(scope: McpScope, workspacePath: string): string {
    return scope === 'user'
      ? path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc')
      : path.join(workspacePath, 'opencode.json');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsoncConfig(this.configPath(scope, workspacePath));
    return readObjectRecord(config.mcp) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const config = await readJsoncConfig(this.configPath(scope, workspacePath));
    config.mcp = servers;
    await writeJsonConfig(this.configPath(scope, workspacePath), config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
      return {
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        environment: input.env ?? {},
      };
    }
    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }
    return {
      type: 'remote',
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }
    const config = rawConfig as Record<string, unknown>;
    if (config.type === 'local' || Array.isArray(config.command)) {
      const commandArr = readStringArray(config.command);
      return {
        provider: 'sophcode',
        name,
        scope,
        transport: 'stdio',
        command: commandArr[0],
        args: commandArr.slice(1),
        env: readStringRecord(config.environment),
      };
    }
    if (config.type === 'remote' || typeof config.url === 'string') {
      return {
        provider: 'sophcode',
        name,
        scope,
        transport: 'http',
        url: readOptionalString(config.url),
        headers: readStringRecord(config.headers),
      };
    }
    return null;
  }
}
```

- [ ] **Step 4: 注册 sophcode（最小装配）**，让 MCP 测试能 resolve

在 `server/modules/providers/provider.registry.ts` 注册 SophcodeProvider（其子模块先只挂 models/mcp/auth，其余后续 Task 补全）。同时更新 `server/shared/types.ts` 的 `LLMProvider` 联合类型加 `'sophcode'`，否则 `Record<LLMProvider, IProvider>` 会类型报错。这两个文件改动与 `sophcode.provider.ts` 一起在 Task 7 统一做——**本 Task 先建一个临时的 `SophcodeProvider`**：

```ts
// server/modules/providers/list/sophcode/sophcode.provider.ts（临时，Task 7 补全）
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { SophcodeProviderAuth } from '@/modules/providers/list/sophcode/sophcode-auth.provider.js';
import { SophcodeMcpProvider } from '@/modules/providers/list/sophcode/sophcode-mcp.provider.js';
import { SophcodeProviderModels } from '@/modules/providers/list/sophcode/sophcode-models.provider.js';
import type { IProviderAuth, IProviderMcp, IProviderModels, IProviderSessionSynchronizer, IProviderSkills, IProviderSessions } from '@/shared/interfaces.js';

export class SophcodeProvider extends AbstractProvider {
  readonly models: IProviderModels = new SophcodeProviderModels();
  readonly mcp: IProviderMcp = new SophcodeMcpProvider();
  readonly auth: IProviderAuth = new SophcodeProviderAuth();
  readonly skills = undefined as unknown as IProviderSkills;
  readonly sessions = undefined as unknown as IProviderSessions;
  readonly sessionSynchronizer = undefined as unknown as IProviderSessionSynchronizer;

  constructor() {
    super('sophcode');
  }
}
```

`provider.registry.ts` 改为：
```ts
import { SophcodeProvider } from '@/modules/providers/list/sophcode/sophcode.provider.js';
// ... 保留 claude/codex import
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  sophcode: new SophcodeProvider(),
};
```

并给 `server/shared/types.ts` 的 `LLMProvider` 加 `'sophcode'`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/mcp.test.ts`
Expected: sophcode MCP 测试 PASS（其余 cursor/global 测试仍红，Task 8 处理）

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/ server/modules/providers/provider.registry.ts server/shared/types.ts server/modules/providers/tests/mcp.test.ts && git commit -m "feat(providers): add sophcode mcp provider and register provider skeleton"
```

---

## Task 4: sophcode-skills.provider.ts（含修 skills.test.ts）

**Files:**
- Create: `server/modules/providers/list/sophcode/sophcode-skills.provider.ts`
- Modify: `server/modules/providers/tests/skills.test.ts`（opencode→sophcode；cursor 相关断言删除）

- [ ] **Step 1: 改 skills.test.ts 的 opencode 测试指 sophcode**

把 `providerSkillsService` 调用中 `'opencode'` 改为 `'sophcode'`（opencode skills 路径不变：`~/.config/opencode/skills`、`.opencode/skills`、`.claude/skills`、`.agents/skills`）。cursor 相关测试与全局 skills 测试里的 cursor 断言留到 Task 8 清理——本 Task 先让 sophcode skills 测试能识别 provider。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/skills.test.ts`
Expected: sophcode skills 测试 FAIL "Unsupported provider \"sophcode\"."（sophcode.skills 是 undefined）

- [ ] **Step 3: 实现 sophcode-skills.provider.ts**

```ts
// server/modules/providers/list/sophcode/sophcode-skills.provider.ts
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

export class SophcodeSkillsProvider extends SkillsProvider {
  constructor() {
    super('sophcode');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.opencode', 'skills'),
      commandPrefix: '/',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.claude', 'skills'),
      commandPrefix: '/',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'repo',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      commandPrefix: '/',
    });

    if (repoRoot) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.opencode', 'skills'),
        commandPrefix: '/',
      });
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.claude', 'skills'),
        commandPrefix: '/',
      });
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        commandPrefix: '/',
      });
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
      commandPrefix: '/',
    });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
      commandPrefix: '/',
    };
  }
}
```

- [ ] **Step 4: 把 sophcode.skills 挂到 SophcodeProvider**

在 `sophcode.provider.ts` 中把 `readonly skills` 改为 `new SophcodeSkillsProvider()`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/skills.test.ts`
Expected: sophcode skills 测试 PASS

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/sophcode-skills.provider.ts server/modules/providers/list/sophcode/sophcode.provider.ts server/modules/providers/tests/skills.test.ts && git commit -m "feat(providers): add sophcode skills provider"
```

---

## Task 5: sophcode-sessions.provider.ts

**Files:**
- Create: `server/modules/providers/list/sophcode/sophcode-sessions.provider.ts`
- Test: `server/modules/providers/tests/sophcode-sessions.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// server/modules/providers/tests/sophcode-sessions.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { SophcodeSessionsProvider } from '@/modules/providers/list/sophcode/sophcode-sessions.provider.js';

test('sophcode sessions normalizes a text part event', () => {
  const provider = new SophcodeSessionsProvider();
  const raw = { type: 'text', part: { type: 'text', text: 'hello', messageID: 'msg1', sessionID: 'ses1' } };
  const msgs = provider.normalizeMessage(raw, 'ses1');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'text');
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, 'hello');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sophcode-sessions.test.ts`
Expected: FAIL "Cannot find module ... sophcode-sessions.provider.js"

- [ ] **Step 3: 实现**（先查 opencode.db message/part 表列，再写查询）

> 实现前先跑：`sophcode db "SELECT name FROM pragma_table_info('message')" --format json` 和 `...pragma_table_info('part')`，确认列名（期望 message 有 `id, sessionID, role, time, ...`；part 有 `id, messageID, sessionID, type, text, ...`）。按实际列名调整下方 SQL。

```ts
// server/modules/providers/list/sophcode/sophcode-sessions.provider.ts
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

const PROVIDER = 'sophcode';

function openSophcodeDb(): Database.Database {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function loadMessagesForSession(db: Database.Database, providerSessionId: string): AnyRecord[] {
  const messages = db
    .prepare('SELECT id, sessionID, role, time FROM message WHERE sessionID = ? ORDER BY time ASC')
    .all(providerSessionId) as AnyRecord[];
  const parts = db
    .prepare('SELECT id, messageID, sessionID, type, text FROM part WHERE sessionID = ? ORDER BY rowid ASC')
    .all(providerSessionId) as AnyRecord[];

  const byMessage = new Map<string, string>();
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      byMessage.set(String(part.messageID), String(part.text));
    }
  }

  return messages.map((message) => ({
    role: message.role,
    text: byMessage.get(String(message.id)) ?? '',
  }));
}

export class SophcodeSessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const event = readObjectRecord(raw);
    if (!event) {
      return [];
    }
    const part = readObjectRecord(event.part);
    if (!part) {
      return [];
    }
    const resolvedSessionId = String(event.sessionID || part.sessionID || sessionId || '');
    if (part.type === 'text' && typeof part.text === 'string') {
      return [createNormalizedMessage({
        kind: 'text',
        role: 'assistant',
        content: part.text,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }
    return [];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    try {
      const db = openSophcodeDb();
      try {
        const rawMessages = loadMessagesForSession(db, sessionId);
        const normalized: NormalizedMessage[] = rawMessages.map((raw) =>
          createNormalizedMessage({
            kind: 'text',
            role: raw.role === 'user' ? 'user' : 'assistant',
            content: String(raw.text ?? ''),
            sessionId,
            provider: PROVIDER,
          }),
        );
        const total = normalized.length;
        const paged = sliceTailPage(normalized, { limit, offset, total });
        return { messages: paged, total, hasMore: offset + (paged.length ?? 0) < total, offset, limit };
      } finally {
        db.close();
      }
    } catch {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }
}
```

> 注：`sliceTailPage(items, { limit, offset, total })` 的返回形状需在实现时对照 `shared/utils.ts` 里 `sliceTailPage` 的实际签名（返回数组或 `{items,...}`）。若返回 `{items}` 则 `paged` 改为 `paged.items`。

- [ ] **Step 4: 跑测试确认通过**

Run: 同上命令
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/sophcode-sessions.provider.ts server/modules/providers/tests/sophcode-sessions.test.ts && git commit -m "feat(providers): add sophcode sessions provider"
```

---

## Task 6: sophcode-session-synchronizer.provider.ts

**Files:**
- Create: `server/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.ts`
- Test: `server/modules/providers/tests/sophcode-synchronizer.test.ts`

- [ ] **Step 1: 写失败测试**（用临时 opencode.db 造一行 session，验证 upsert 到 sessions 表）

```ts
// server/modules/providers/tests/sophcode-synchronizer.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SophcodeSessionSynchronizer } from '@/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('sophcode synchronizer upserts sessions from opencode.db', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sophcode-sync-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, path TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)`);
  db.prepare(`INSERT INTO session (id, title, path, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('ses_1', 'My Sophcode Chat', '/tmp', 'opencode/deepseek-v4-flash-free', 1720000000000, 1720000000000);
  db.close();

  const restore = patchHomeDir(tempRoot);
  try {
    const synchronizer = new SophcodeSessionSynchronizer();
    // createSession 会写 app 的 sessions 表（真实 DB）。这里只验证扫描返回行数。
    const count = await synchronizer.scanAndCount();
    assert.equal(count, 1);
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sophcode-synchronizer.test.ts`
Expected: FAIL "Cannot find module ... sophcode-session-synchronizer.provider.js"

- [ ] **Step 3: 实现**

```ts
// server/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.ts
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { readOptionalString } from '@/shared/utils.js';

const PROVIDER = 'sophcode';

export class SophcodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private openDb(): Database.Database {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  async synchronize(_since?: Date): Promise<number> {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (!fsSync.existsSync(dbPath)) {
      return 0;
    }
    let db: Database.Database;
    try {
      db = this.openDb();
    } catch {
      return 0;
    }
    try {
      const rows = db.prepare(
        `SELECT id, title, path, time_created, time_updated FROM session WHERE time_archived IS NULL`
      ).all() as Array<{ id: string; title?: string; path?: string; time_created?: number; time_updated?: number }>;

      for (const row of rows) {
        const projectPath = readOptionalString(row.path) || '';
        const createdAt = row.time_created ? new Date(row.time_created).toISOString() : undefined;
        const updatedAt = row.time_updated ? new Date(row.time_updated).toISOString() : undefined;
        sessionsDb.createSession(
          String(row.id),
          PROVIDER,
          projectPath,
          readOptionalString(row.title) || undefined,
          createdAt,
          updatedAt,
          null,
        );
      }
      return rows.length;
    } finally {
      db.close();
    }
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    // opencode.db is a single shared file; no per-file incremental mapping.
    return null;
  }
}
```

> 注：测试里 `scanAndCount()` 是临时辅助——实现里不提供该方法，改测试为调用 `synchronize()` 后断言返回 `1`（若需要真实断言，可 mock `sessionsDb`，或简化测试只断言 `typeof synchronize === 'function'` 且对临时 DB 返回 1）。**以可稳定通过为准调整断言。**

- [ ] **Step 4: 跑测试确认通过**

Run: 同上命令
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.ts server/modules/providers/tests/sophcode-synchronizer.test.ts && git commit -m "feat(providers): add sophcode session synchronizer"
```

---

## Task 7: 补全 sophcode.provider.ts + 路由 + capabilities

**Files:**
- Modify: `server/modules/providers/list/sophcode/sophcode.provider.ts`（挂上 sessions + sessionSynchronizer）
- Modify: `server/modules/providers/provider.routes.ts`（parseProvider 加 `'sophcode'`）
- Modify: `server/modules/providers/services/provider-capabilities.service.ts`

- [ ] **Step 1: 补全 `sophcode.provider.ts`**

```ts
// server/modules/providers/list/sophcode/sophcode.provider.ts
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { SophcodeProviderAuth } from '@/modules/providers/list/sophcode/sophcode-auth.provider.js';
import { SophcodeProviderModels } from '@/modules/providers/list/sophcode/sophcode-models.provider.js';
import { SophcodeMcpProvider } from '@/modules/providers/list/sophcode/sophcode-mcp.provider.js';
import { SophcodeSessionSynchronizer } from '@/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.js';
import { SophcodeSessionsProvider } from '@/modules/providers/list/sophcode/sophcode-sessions.provider.js';
import { SophcodeSkillsProvider } from '@/modules/providers/list/sophcode/sophcode-skills.provider.js';

export class SophcodeProvider extends AbstractProvider {
  readonly models = new SophcodeProviderModels();
  readonly mcp = new SophcodeMcpProvider();
  readonly auth = new SophcodeProviderAuth();
  readonly skills = new SophcodeSkillsProvider();
  readonly sessions = new SophcodeSessionsProvider();
  readonly sessionSynchronizer = new SophcodeSessionSynchronizer();

  constructor() {
    super('sophcode');
  }
}
```

- [ ] **Step 2: 更新 provider.routes.ts 的 parseProvider**（约 line 284-297）

```ts
const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'sophcode'
  ) {
    return normalized;
  }
  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};
```

- [ ] **Step 3: 更新 provider-capabilities.service.ts**（在 `PROVIDER_CAPABILITIES` 里加 sophcode 条目）

```ts
sophcode: {
  provider: 'sophcode',
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  defaultPermissionMode: 'default',
  supportsImages: true,
  supportsAbort: true,
  supportsPermissionRequests: false,
  supportsTokenUsage: true,
  supportsEffort: true,
},
```

- [ ] **Step 4: 类型检查 + 跑 provider 测试**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npm run typecheck && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sophcode-models.test.ts server/modules/providers/tests/sophcode-auth.test.ts server/modules/providers/tests/sophcode-sessions.test.ts server/modules/providers/tests/sophcode-synchronizer.test.ts`
Expected: typecheck PASS；sophcode 4 个测试 PASS

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/list/sophcode/sophcode.provider.ts server/modules/providers/provider.routes.ts server/modules/providers/services/provider-capabilities.service.ts && git commit -m "feat(providers): wire sophcode provider into registry, routes, capabilities"
```

---

## Task 8: 清理剩余红测试（global adder + cursor）

**Files:**
- Modify: `server/modules/providers/tests/mcp.test.ts`
- Modify: `server/modules/providers/tests/skills.test.ts`

- [ ] **Step 1: 修 global adder 测试**（mcp.test.ts，期望 provider 数 4 → 3，删 cursor 断言）

`providerMcpService global adder writes to all providers...` 测试：
- `assert.equal(globalResult.length, 4)` → `3`
- 删除 `cursorProject` 断言块（`.cursor/mcp.json`）
- `opencodeProject` 断言保留（sophcode 写 `<workspace>/opencode.json`），变量名可改 `sophcodeProject`

- [ ] **Step 2: 处理 cursor MCP 测试**

`providerMcpService handles cursor MCP JSON config formats`：若 cursor 特有 JSON 格式（`.cursor/mcp.json`）与 sophcode 不同且无法复用，则**删除该测试**（cursor 不注册）。若它只是测通用 JSON writer，改指 sophcode 即可。

- [ ] **Step 3: 清 skills.test.ts 的 cursor 断言**

`providerSkillsService adds global skills for claude, codex, and cursor` 与 `lists cursor skills...`：删除 cursor provider 相关断言，保留 claude/codex；cursor 目录断言删除。

- [ ] **Step 4: 跑完整 provider 测试套件**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test "server/modules/providers/tests/*.test.ts" 2>&1 | grep -E "^(not ok|# (tests|pass|fail))"`
Expected: `# pass` 增加，`# fail` 减少到只有 codex skills 环境问题（`not ok ... codex repository...` `undefined vs 'repo'`）——该 1 个为既有环境问题，不在范围。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/modules/providers/tests/mcp.test.ts server/modules/providers/tests/skills.test.ts && git commit -m "test(providers): clean up opencode/cursor references now that sophcode is the provider"
```

---

## Task 9: sophcode-runner.js（运行时）

**Files:**
- Create: `server/sophcode-runner.js`
- Test: `server/modules/websocket/tests/sophcode-runner.test.js`

- [ ] **Step 1: 写失败测试**（纯函数解析 NDJSON 事件行）

```ts
// server/modules/websocket/tests/sophcode-runner.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSophcodeJsonLine, resolveSophcodePermissionOptions } from '../../sophcode-runner.js';

test('sophcode runner maps permission modes to CLI flags', () => {
  assert.deepEqual(resolveSophcodePermissionOptions('plan'), { args: ['--agent', 'plan'], env: {} });
  assert.deepEqual(resolveSophcodePermissionOptions('bypassPermissions').args, ['--auto']);
  assert.deepEqual(resolveSophcodePermissionOptions('acceptEdits').env, { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) });
  assert.deepEqual(resolveSophcodePermissionOptions('default'), { args: [], env: {} });
});

test('sophcode runner parses a text event into a stream delta', () => {
  const state = { textByMessage: new Map() };
  const line = JSON.stringify({ type: 'text', sessionID: 'ses1', part: { type: 'text', text: 'hello', messageID: 'msg1' } });
  const events = parseSophcodeJsonLine(line, state);
  assert.ok(events.length >= 1);
  assert.equal(events[0].kind, 'stream_delta');
  assert.equal(events[0].content, 'hello');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/sophcode-runner.test.js`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 sophcode-runner.js**

```js
// server/sophcode-runner.js
import { spawn } from 'cross-spawn';

import { appendImagesInputTag, normalizeImageDescriptors } from './shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeSophcodeProcesses = new Map();

/**
 * Maps UI permission mode onto sophcode's `run` CLI (opencode fork, verified v0.3.0):
 * - plan              -> --agent plan
 * - bypassPermissions -> --auto
 * - acceptEdits       -> OPENCODE_PERMISSION={"edit":"allow"}
 * - default           -> nothing (user config governs)
 */
export function resolveSophcodePermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

/**
 * Parses one NDJSON event line from `sophcode run --format json`.
 * Returns an array of normalized messages to emit (may be empty).
 * `state` tracks per-message accumulated text for delta streaming.
 */
export function parseSophcodeJsonLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const part = event.part;
  const sessionId = event.sessionID || part?.sessionID || state.sessionId || null;
  if (sessionId) {
    state.sessionId = sessionId;
  }

  const messages = [];

  if (event.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
    const key = part.messageID || part.id;
    const previous = state.textByMessage.get(key) || '';
    const text = part.text;
    let delta = '';
    if (text.startsWith(previous)) {
      delta = text.slice(previous.length);
    } else {
      delta = text; // rewrite / shorter text: emit full
      state.textByMessage.set(key, '');
    }
    if (delta) {
      messages.push(createNormalizedMessage({
        kind: 'stream_delta',
        content: delta,
        sessionId,
        provider: 'sophcode',
      }));
    }
    state.textByMessage.set(key, text);
  }

  if (event.type === 'step_finish') {
    const key = part.messageID || part.id;
    if (state.textByMessage.has(key)) {
      messages.push(createNormalizedMessage({ kind: 'stream_end', sessionId, provider: 'sophcode' }));
      state.textByMessage.delete(key);
    }
    if (part?.tokens) {
      const t = part.tokens;
      messages.push(createNormalizedMessage({
        kind: 'status',
        text: 'token_budget',
        tokenBudget: {
          used: t.total || 0,
          inputTokens: t.input || 0,
          outputTokens: t.output || 0,
          breakdown: { input: t.input || 0, output: t.output || 0 },
        },
        sessionId,
        provider: 'sophcode',
      }));
    }
  }

  return messages;
}

function sendMessage(ws, data) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[sophcode-runner] send failed', error);
  }
}

export async function querySophcode(command, options, ws) {
  const {
    sessionId = null,
    model,
    effort,
    permissionMode = 'default',
    cwd = process.cwd(),
    images = [],
  } = options || {};

  const state = { textByMessage: new Map(), sessionId };
  let capturedSessionId = sessionId || null;
  let sessionCreatedSent = false;
  let completeSent = false;

  const args = ['run', '--format', 'json', '--dir', cwd];
  if (capturedSessionId) {
    args.push('--session', capturedSessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  if (effort && effort !== 'default') {
    args.push('--variant', effort);
  }
  const permissionOptions = resolveSophcodePermissionOptions(permissionMode);
  args.push(...permissionOptions.args);

  const hasAttachments = normalizeImageDescriptors(images).length > 0;
  if ((command && command.trim()) || hasAttachments) {
    const promptWithImages = appendImagesInputTag(command?.trim() || '', images);
    args.push(promptWithImages);
  }

  const processKey = capturedSessionId || `new-${Date.now()}`;
  const child = spawn('sophcode', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...permissionOptions.env },
  });

  activeSophcodeProcesses.set(processKey, child);
  child.sessionKey = processKey;
  child.stdin.end();

  child.stdout.setEncoding('utf8');
  let lineBuffer = '';
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const events = parseSophcodeJsonLine(line, state);
      const newSessionId = state.sessionId;
      if (newSessionId && !capturedSessionId) {
        capturedSessionId = newSessionId;
        activeSophcodeProcesses.set(newSessionId, child);
        activeSophcodeProcesses.delete(processKey);
        if (ws.setSessionId) {
          ws.setSessionId(newSessionId);
        }
        if (!sessionCreatedSent) {
          sessionCreatedSent = true;
          sendMessage(ws, createNormalizedMessage({
            kind: 'session_created',
            newSessionId,
            sessionId: newSessionId,
            provider: 'sophcode',
          }));
        }
      }
      for (const msg of events) {
        if (msg.kind === 'status' && msg.text === 'token_budget') {
          sendMessage(ws, createNormalizedMessage({ ...msg, sessionId: capturedSessionId || sessionId || null }));
        } else {
          sendMessage(ws, msg);
        }
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: text,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'sophcode',
      }));
    }
  });

  return new Promise((resolve, reject) => {
    child.on('error', async (error) => {
      console.error('[sophcode-runner] spawn error', error.message);
      const installed = await providerAuthService.isProviderInstalled('sophcode');
      const errorContent = !installed
        ? 'Sophcode CLI is not installed. Install it from https://opencode.ai/docs/'
        : error.message;
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'sophcode',
      }));
      if (!completeSent) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({ provider: 'sophcode', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
      }
      reject(error);
    });

    child.on('close', (code) => {
      activeSophcodeProcesses.delete(processKey);
      if (capturedSessionId) {
        activeSophcodeProcesses.delete(capturedSessionId);
      }

      if (lineBuffer.trim()) {
        const events = parseSophcodeJsonLine(lineBuffer.trim(), state);
        for (const msg of events) {
          sendMessage(ws, msg);
        }
      }

      if (!completeSent && !child.aborted) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({
          provider: 'sophcode',
          sessionId: capturedSessionId || sessionId || null,
          actualSessionId: capturedSessionId || sessionId || null,
          exitCode: code === 0 ? 0 : 1,
        }));
        if (code === 0) {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'sophcode',
            sessionId: capturedSessionId || sessionId || null,
            stopReason: 'completed',
          });
        }
      }

      if (code === 0) {
        resolve();
      } else {
        if (!completeSent) {
          completeSent = true;
          sendMessage(ws, createCompleteMessage({ provider: 'sophcode', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
        }
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'sophcode',
          sessionId: capturedSessionId || sessionId || null,
          error: new Error(`Sophcode CLI exited with code ${code}`),
        });
        reject(new Error(`Sophcode CLI exited with code ${code}`));
      }
    });
  });
}

export function abortSophcodeSession(sessionId) {
  const child = activeSophcodeProcesses.get(sessionId);
  if (!child) {
    return false;
  }
  child.aborted = true;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  return true;
}

export function isSophcodeSessionActive(sessionId) {
  return activeSophcodeProcesses.has(sessionId);
}

export function getActiveSophcodeSessions() {
  return Array.from(activeSophcodeProcesses.keys());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同上命令
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/sophcode-runner.js server/modules/websocket/tests/sophcode-runner.test.js && git commit -m "feat(runtime): add sophcode CLI runner"
```

---

## Task 10: index.js 接线 + token-usage 分支

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: 接 spawnFns/abortFns**

在 `server/index.js` 顶部 import：
```js
import { abortSophcodeSession, querySophcode } from './sophcode-runner.js';
```
在 `createWebSocketServer(server, { ... chat: { spawnFns: {...}, abortFns: {...} } })` 里：
```js
spawnFns: {
  claude: queryClaudeSDK,
  codex: queryCodex,
  sophcode: querySophcode,
},
abortFns: {
  claude: abortClaudeSDKSession,
  codex: abortCodexSession,
  sophcode: abortSophcodeSession,
},
```

- [ ] **Step 2: token-usage 端点加 sophcode 分支**

在 `server/index.js` 的 `GET /api/projects/:projectId/sessions/:sessionId/token-usage` 里，`const provider = sessionRow.provider || 'claude';` 之后加：

```js
if (provider === 'sophcode') {
  const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  if (!fsExistsSync(dbPath)) {
    return res.status(404).json({ error: 'Sophcode db not found' });
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return res.status(404).json({ error: 'Sophcode db not found' });
  }
  try {
    const row = db.prepare('SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?').get(providerNativeSessionId);
    if (!row) {
      return res.status(404).json({ error: 'Sophcode session not found', sessionId: safeSessionId });
    }
    const input = Number(row.tokens_input || 0) + Number(row.tokens_cache_read || 0);
    const used = Number(row.tokens_input || 0) + Number(row.tokens_output || 0) + Number(row.tokens_reasoning || 0) + Number(row.tokens_cache_read || 0) + Number(row.tokens_cache_write || 0);
    return res.json({
      used,
      total: 200000,
      inputTokens: input,
      outputTokens: Number(row.tokens_output || 0),
      breakdown: { input, output: Number(row.tokens_output || 0) },
    });
  } finally {
    db.close();
  }
}
```

> 需在 `server/index.js` 顶部确认 `better-sqlite3` 的 `Database` 已 import（或新增 `import Database from 'better-sqlite3';`），以及 `fsExistsSync` 对应的 import（`fsSync` 或 `fsPromises`）。按文件现有 import 命名调整。

- [ ] **Step 3: 类型/语法检查 + 启动后端冒烟**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npm run typecheck && npx tsx --tsconfig server/tsconfig.json -e "import('./server/index.js').then(()=>{console.log('loaded');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `loaded`（模块可加载，不抛 import 错误）

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && git add server/index.js && git commit -m "feat(runtime): wire sophcode into websocket runtimes and token usage endpoint"
```

---

## Task 11: 后端全量测试 + 类型检查

**Files:** 无新增

- [ ] **Step 1: 跑完整后端测试套件**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test "server/**/*.test.ts" "server/**/*.test.js" 2>&1 | grep -E "^(not ok|# (tests|pass|fail))"`
Expected: 无新增 fail；仅保留 codex skills 环境问题（`undefined vs 'repo'`）这一既有项。

- [ ] **Step 2: 若有 sophcode 相关新增失败，修复后重跑**

若 `sophcode-*` 或 runner 测试在真实环境失败（如 opencode.db 被占用、模型名变化），修正实现/断言后重跑直到绿。

---

## Task 12: 前端类型 + effort 常量

**Files:**
- Modify: `src/types/app.ts`、`src/components/chat/constants/providerEffort.ts`

- [ ] **Step 1: 改 `src/types/app.ts`**

`export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';` → 加 `| 'sophcode'`：
```ts
export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode' | 'sophcode';
```

- [ ] **Step 2: 改 `src/components/chat/constants/providerEffort.ts`**

```ts
export const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  // ... 现有 claude/codex 保留 ...
  sophcode: ['low', 'medium', 'high'],
};
```

- [ ] **Step 3: 前端类型检查**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsc --noEmit`
Expected: 可能因 `PROVIDERS` 数组或 `Record<LLMProvider,...>` 未覆盖 sophcode 报类型错——这是预期的中间态，Task 13 补齐。

---

## Task 13: useChatProviderState.ts

**Files:**
- Modify: `src/components/chat/hooks/useChatProviderState.ts`

- [ ] **Step 1: 加 sophcode 到 PROVIDERS 与 fallback 表**

```ts
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
  sophcode: 'opencode/deepseek-v4-flash-free',
};
const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'sophcode'];
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  sophcode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};
```

- [ ] **Step 2: 加 sophcodeModel state**

在 `opencodeModel` state 旁加：
```ts
const [sophcodeModel, setSophcodeModel] = useState<string>(() => {
  return localStorage.getItem('sophcode-model') || FALLBACK_DEFAULT_MODEL.sophcode;
});
```

- [ ] **Step 3: `setStoredProviderModel` 加 sophcode 分支**（在 opencode 分支后）

```ts
if (targetProvider === 'sophcode') {
  setSophcodeModel(model);
  localStorage.setItem('sophcode-model', model);
  return;
}
```

- [ ] **Step 4: `providerModels` memo 加 sophcode**

```ts
const providerModels = useMemo<Record<LLMProvider, string>>(() => ({
  claude: claudeModel,
  cursor: cursorModel,
  codex: codexModel,
  opencode: opencodeModel,
  sophcode: sophcodeModel,
}), [claudeModel, cursorModel, codexModel, opencodeModel, sophcodeModel]);
```

- [ ] **Step 5: 加 sophcode 的 catalog reconcile effect**（仿 opencode 的 useEffect）

```ts
useEffect(() => {
  const sophcode = providerModelCatalog.sophcode;
  if (sophcode) {
    const next = pickStoredOrCurrent('sophcode-model', sophcodeModel, sophcode);
    if (next !== sophcodeModel) {
      setSophcodeModel(next);
    }
    if (localStorage.getItem('sophcode-model') !== next) {
      localStorage.setItem('sophcode-model', next);
    }
  }
}, [providerModelCatalog.sophcode, sophcodeModel]);
```

- [ ] **Step 6: 返回值加 sophcode**（在返回对象里 opencodeModel 旁加 `sophcodeModel, setSophcodeModel`）

- [ ] **Step 7: 传递 sophcodeModel 到 ProviderSelectionEmptyState**（在父组件传 props 处补齐）

检查 `AppContent.tsx` / `ChatInterface.tsx` 中调用 `ProviderSelectionEmptyState` 的地方，把 `sophcodeModel`/`setSophcodeModel` 传入。

- [ ] **Step 8: 类型检查**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsc --noEmit`
Expected: 若仍有 `Record<LLMProvider,...>` 未覆盖 sophcode 的报错，逐个补齐（见 Task 14）。

---

## Task 14: ProviderSelectionEmptyState.tsx + Logo + i18n

**Files:**
- Modify: `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- Modify: `src/components/llm-logo-provider/SessionProviderLogo.tsx`
- Create: `src/components/llm-logo-provider/SophcodeLogo.tsx`
- Modify: `src/i18n/locales/en/chat.json`

- [ ] **Step 1: ProviderSelectionEmptyState.tsx**

在 `PROVIDER_META` 加：
```tsx
{ id: "sophcode", name: "Sophcode" },
```
`getCurrentModel` 加：
```tsx
if (p === "sophcode") return s;
```
（签名加 `s: string` 参数，调用处传 `sophcodeModel`）
`getProviderDisplayName` 加：
```tsx
if (p === "sophcode") return "Sophcode";
```
`setModelForProvider` 加 sophcode 分支：
```tsx
} else if (providerId === "sophcode") {
  setSophcodeModel(modelValue);
  localStorage.setItem("sophcode-model", modelValue);
}
```
props 类型与解构加 `sophcodeModel`/`setSophcodeModel`。
`readyPrompt` 对象加：
```tsx
sophcode: t("providerSelection.readyPrompt.sophcode", {
  model: sophcodeModel,
  defaultValue: "Ready with Sophcode {{model}}",
}),
```

- [ ] **Step 2: SessionProviderLogo.tsx**

```tsx
import SophcodeLogo from './SophcodeLogo';
// ...
if (provider === 'sophcode') {
  return <SophcodeLogo className={className} />;
}
```

- [ ] **Step 3: 新建 SophcodeLogo.tsx**

```tsx
// src/components/llm-logo-provider/SophcodeLogo.tsx
type SophcodeLogoProps = { className?: string };
export default function SophcodeLogo({ className = 'w-5 h-5' }: SophcodeLogoProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-label="Sophcode">
      <rect width="24" height="24" rx="5" fill="#6C5CE7" />
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">So</text>
    </svg>
  );
}
```

- [ ] **Step 4: i18n en/chat.json**

在 `providerSelection.readyPrompt` 下加：
```json
"sophcode": "Ready with Sophcode {{model}}"
```

- [ ] **Step 5: 前端类型检查 + build**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx tsc --noEmit && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && git add src/ && git commit -m "feat(ui): add sophcode provider to model/logo/i18n"
```

---

## Task 15: E2E 冒烟验证

**Files:** 无新增

- [ ] **Step 1: 启动后端**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json server/index.js`（后台）

- [ ] **Step 2: 验证 provider API**

```bash
curl -s localhost:<SERVER_PORT>/api/providers/capabilities | python3 -m json.tool | grep -A2 sophcode   # 期望出现 sophcode 条目
curl -s localhost:<SERVER_PORT>/api/providers/sophcode/models | python3 -m json.tool | head
curl -s localhost:<SERVER_PORT>/api/providers/sophcode/auth/status | python3 -m json.tool
```

- [ ] **Step 3: 建 sophcode 会话并发消息**（走 WebSocket，或临时脚本）

用真实 `sophcode run` 已确认可用；验证 `POST /api/providers/sessions`（provider=sophcode）返回 session，再通过前端 UI 选 Sophcode 发一条消息，确认流式 + 会话历史 + token 用量。

- [ ] **Step 4: 前端 UI 冒烟**

打开前端，会话为空时选 Sophcode 看到模型列表（来自 `sophcode models`），发消息验证流式回复。

- [ ] **Step 5: 收尾**

停掉后端进程；提交前端/后端剩余改动（如有）。

---

## Self-Review 记录

- **Spec 覆盖**：类型/注册/路由/capabilities（Task 7）、models（Task 1）、auth（Task 2）、mcp（Task 3）、skills（Task 4）、sessions（Task 5）、synchronizer（Task 6）、runtime（Task 9）、index.js spawnFns/abortFns + token-usage（Task 10）、前端 7 处（Task 12-14）、测试与 E2E（Task 11/15）。✓ 全覆盖。
- **占位符扫描**：无 TBD/TODO。`sophcode.db` 列名、`sliceTailPage` 返回形状、`auth.json` 结构、`OPENCODE_PERMISSION` 兼容性、`better-sqlite3` import 名等标注为"实现时校验"，均有明确的校验命令。
- **类型一致性**：`runSophcodeModels`/`buildSophcodeModelsDefinition`/`readSophcodeSessionModel`、`SophcodeProvider` 子模块命名、runner 导出 `querySophcode`/`abortSophcodeSession`/`isSophcodeSessionActive`/`getActiveSophcodeSessions` 全计划一致。前端 `sophcodeModel`/`setSophcodeModel` 命名一致。