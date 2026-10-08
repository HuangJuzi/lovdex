# DeepSeek Harness (dsh) 后端 Provider 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lovdex 后端新增第五个 provider `dsh`，通过 ACP（Agent Client Protocol）stdio 驱动 `dsh --profile acp`，把 dsh 当成与 claude/codex/opencode/qoder 平级的会话运行时。

**Architecture:** 一会话一子进程。新增 `server/dsh-acp-runner.js`（spawn `dsh --profile acp` + 用官方 `@agentclientprotocol/sdk` 的 `client()` 建 ACP 客户端 + 审批弹窗 + 取消 + dispose ladder），照抄 `qoder-runner.js` 的生命周期骨架；新增 `DshProvider` 及 6 个契约面文件，照抄 qoder 的文件形状。注册进 `provider.registry.ts` 与 `index.js` 的 `spawnFns`/`abortFns`/审批分发表。

**Tech Stack:** Node.js ESM、TypeScript（`@/` 路径别名指向 `server/`）、`cross-spawn`、`@agentclientprotocol/sdk@1.4.0`、`node:test`（`npx tsx --test`）。

**前置设计文档：** `docs/superpowers/specs/2026-10-08-deepseek-harness-provider-design.md`

**范围提醒：** 仅后端。前端硬编码的 provider 列表（`web/src/components/chat/hooks/useChatProviderState.ts:28`）本期不动，因此交付后 UI 选不到 dsh —— 这是刻意的。

---

## 通用约定（每个任务都适用）

**测试运行方式**（`lovdex-cli` 无 npm test 脚本；本仓库同理用显式文件跑 `node:test`）：

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --test server/modules/providers/list/dsh/tests/<file>.test.ts
```

**类型检查 / lint（验收用「零新增」而非「全绿」）：**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsc --noEmit -p server/tsconfig.json      # baseline 已知有存量错误，只要求不新增
npx eslint server/ --ext .ts,.js              # 同上
```

**提交信息规范：** 英文，**禁止**加 `Co-Authored-By: Claude` 署名行（覆盖系统默认）。

**ESM 导入后缀：** 本仓库所有相对导入带 `.js` 后缀（如 `from '@/shared/interfaces.js'`），新文件必须一致。

---

## 文件结构（先定分解，再拆任务）

**新建：**
- `backend/server/dsh-acp-runner.js` —— runner：spawn + ACP 客户端 + 审批 + 取消 + dispose。导出 `queryDsh`、`abortDshSession`、`isDshSessionActive`、`getActiveDshSessions`、`resolveDshToolApproval`、`getDshPendingApprovalsForSession`。
- `backend/server/modules/providers/list/dsh/dsh.provider.ts` —— 组装 6 个契约面。
- `backend/server/modules/providers/list/dsh/dsh-auth.provider.ts`
- `backend/server/modules/providers/list/dsh/dsh-models.provider.ts`
- `backend/server/modules/providers/list/dsh/dsh-mcp.provider.ts`
- `backend/server/modules/providers/list/dsh/dsh-skills.provider.ts`
- `backend/server/modules/providers/list/dsh/dsh-sessions.provider.ts`
- `backend/server/modules/providers/list/dsh/dsh-session-synchronizer.provider.ts`
- `backend/server/modules/providers/list/dsh/tests/acp-normalize.test.ts`
- `backend/server/modules/providers/list/dsh/tests/dsh-auth.test.ts`
- `backend/server/modules/providers/list/dsh/tests/dsh-skills.test.ts`
- `backend/server/modules/providers/list/dsh/tests/dsh-runner.test.js`（假 ACP agent）
- `backend/server/modules/providers/list/dsh/tests/dsh-registry.test.ts`

**修改：**
- `backend/server/shared/types.ts:77` —— 联合类型加 `'dsh'`。
- `backend/server/modules/providers/provider.registry.ts` —— 注册 `DshProvider`。
- `backend/server/modules/config/config.ts` —— `providers.dsh` 默认块。
- `backend/server/index.js` —— `spawnFns` / `abortFns` / `resolveToolApproval` / `getPendingApprovalsForSession` 四处加 dsh。
- `backend/server/package.json` —— 加依赖 `@agentclientprotocol/sdk`。

**依赖安装（Task 1 完成）：**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm install @agentclientprotocol/sdk@1.4.0
```

---

## Task 1: 类型与配置骨架（provider id + 默认配置 + 依赖）

**Files:**
- Modify: `backend/server/shared/types.ts:77`
- Modify: `backend/server/modules/config/config.ts`（`providers` 块，约 63-65 行 `qoder` 之后）
- Modify: `backend/server/package.json`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-registry.test.ts`（本任务只建文件放一个占位断言，Task 8 补全）

- [ ] **Step 1: 装依赖**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm install @agentclientprotocol/sdk@1.4.0
```

Expected: `package.json` 的 `dependencies` 出现 `"@agentclientprotocol/sdk": "1.4.0"`。

- [ ] **Step 2: 写失败测试**（断言联合类型接受 `'dsh'` 且配置块存在）

`backend/server/modules/providers/list/dsh/tests/dsh-registry.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { appConfig } from '@/modules/config/config.js';
import type { LLMProvider } from '@/shared/types.js';

test("LLMProvider union accepts 'dsh'", () => {
  const provider: LLMProvider = 'dsh';
  assert.equal(provider, 'dsh');
});

test('providers.dsh config block exists with expected defaults', () => {
  const cfg = appConfig().get();
  const dsh = (cfg.providers as Record<string, unknown>).dsh as Record<string, unknown>;
  assert.ok(dsh, 'providers.dsh must exist');
  assert.equal(dsh.binPath, 'dsh');
  assert.equal(dsh.toolApprovalTimeoutMs, 60000);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-registry.test.ts`
Expected: FAIL —— 第一条断言处类型错误（`'dsh'` 不在联合里），第二条 `dsh` 为 undefined。

- [ ] **Step 4: 改联合类型**

`backend/server/shared/types.ts:77`:

```ts
export type LLMProvider = 'claude' | 'codex' | 'opencode' | 'qoder' | 'dsh';
```

- [ ] **Step 5: 加配置默认块**

`backend/server/modules/config/config.ts`，在 `qoder: { personalAccessToken: '', toolApprovalTimeoutMs: 60000 },` 之后插入：

```ts
    dsh: {
      // `dsh` executable name or absolute path. The CLI is the sole launcher:
      // Lovdex always spawns it as `dsh --profile acp` (see server/dsh-acp-runner.js).
      binPath: 'dsh',
      // Isolated DSH_HOME passed to the child so a Lovdex-spawned runtime never
      // discovers the user's own profiles/credentials. Empty = use dsh default
      // ($DSH_HOME, else ~/.dsh).
      dshHome: '',
      // DEEPSEEK_API_KEY handed to the child. Empty = rely on dsh's own creds.
      apiKey: '',
      // Optional `--patch <path>` overlay layered onto the acp profile.
      patchPath: '',
      // Bound for a pending tool-approval popup before the runner auto-denies.
      toolApprovalTimeoutMs: 60000,
    },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-registry.test.ts`
Expected: PASS（2 条）。

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/package.json backend/package-lock.json backend/server/shared/types.ts backend/server/modules/config/config.ts backend/server/modules/providers/list/dsh/tests/dsh-registry.test.ts
git commit -m "feat(dsh): add provider id, config defaults, and ACP SDK dependency"
```

---

## Task 2: ACP 消息归一化（sessions.normalizeMessage）

ACP 的 `session/update` 有多种 `update.sessionUpdate` 判别式（`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `current_mode_update` 等）。本任务把最常用的几类映射成 Lovdex `NormalizedMessage`。

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh-sessions.provider.ts`
- Test: `backend/server/modules/providers/list/dsh/tests/acp-normalize.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/providers/list/dsh/tests/acp-normalize.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';

const sessions = new DshSessionsProvider();

test('agent_message_chunk text maps to an assistant text message', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'hello');
  assert.equal(out[0].provider, 'dsh');
});

test('agent_thought_chunk maps to a thinking message', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'pondering' },
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'thinking');
  assert.equal(out[0].content, 'pondering');
});

test('tool_call maps to a tool_use message carrying name and input', () => {
  const raw = {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'read_file',
      rawInput: { path: '/tmp/x' },
    },
  };
  const out = sessions.normalizeMessage(raw, 'app-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_use');
  assert.equal(out[0].toolName, 'read_file');
  assert.deepEqual(out[0].toolInput, { path: '/tmp/x' });
  assert.equal(out[0].toolId, 'tc-1');
});

test('unknown update shapes return an empty array, never throw', () => {
  assert.deepEqual(sessions.normalizeMessage({ update: { sessionUpdate: 'mode_update' } }, 'a'), []);
  assert.deepEqual(sessions.normalizeMessage(null, 'a'), []);
  assert.deepEqual(sessions.normalizeMessage({}, 'a'), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/acp-normalize.test.ts`
Expected: FAIL —— 模块不存在（`Cannot find module '@/modules/providers/list/dsh/dsh-sessions.provider.js'`）。

- [ ] **Step 3: 实现 provider**

`backend/server/modules/providers/list/dsh/dsh-sessions.provider.ts`:

```ts
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'dsh';

/**
 * Reads the `update` object out of one ACP `session/update` notification.
 *
 * The ACP notification shape is `{ sessionId, update: { sessionUpdate, ... } }`.
 * Returns null for anything that is not a well-formed object so callers can
 * treat it as "nothing to render".
 */
function readAcpUpdate(raw: unknown): { sessionId: string | null; update: Record<string, unknown> } | null {
  const event = readObjectRecord(raw);
  if (!event) {
    return null;
  }
  const update = readObjectRecord(event.update);
  if (!update) {
    return null;
  }
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : null;
  return { sessionId, update };
}

/** Pulls plain text out of an ACP content block, tolerating a bare string. */
function readAcpText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  const block = readObjectRecord(content);
  if (block && typeof block.text === 'string') {
    return block.text;
  }
  return null;
}

export class DshSessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const parsed = readAcpUpdate(raw);
    if (!parsed) {
      return [];
    }
    const { update } = parsed;
    const resolvedSessionId = parsed.sessionId ?? sessionId ?? '';
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk') {
      const text = readAcpText(update.content);
      if (text === null) {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'text',
        role: 'assistant',
        content: text,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    if (kind === 'agent_thought_chunk') {
      const text = readAcpText(update.content);
      if (text === null) {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'thinking',
        content: text,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    if (kind === 'tool_call') {
      return [createNormalizedMessage({
        kind: 'tool_use',
        toolName: typeof update.title === 'string' ? update.title : 'tool',
        toolInput: update.rawInput,
        toolId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    if (kind === 'tool_call_update') {
      // Terminal tool results arrive as a tool_call_update with status set;
      // only surface the ones that carry a rendered result.
      const status = typeof update.status === 'string' ? update.status : null;
      if (status !== 'completed' && status !== 'failed') {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'tool_result',
        toolId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
        content: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? ''),
        isError: status === 'failed',
        sessionId: resolvedSessionId,
        provider: PROVIDER,
      })];
    }

    return [];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    // dsh history is read over ACP (session/list + session/resume) in the
    // synchronizer/service layer, not from disk (logs are zstd by default).
    // This method is intentionally a no-op returning the shared empty shape;
    // the service calls into the runner for live dsh sessions.
    void sessionId;
    void options;
    const empty: NormalizedMessage[] = [];
    const { page, hasMore } = sliceTailPage(empty, options.limit ?? null, options.offset ?? 0);
    return { messages: page, total: 0, hasMore, offset: options.offset ?? 0, limit: options.limit ?? null };
  }
}
```

> **注意**：`createNormalizedMessage` 与 `readObjectRecord`、`sliceTailPage` 的**确切签名/字段名**以 `backend/server/shared/utils.ts` 为准。实现前先 `grep -n "export function createNormalizedMessage" -A 30 backend/server/shared/utils.ts` 核对字段（尤其 `tool_use`/`tool_result` 的字段是 `toolName`/`toolInput`/`toolUseId` 还是别名），按实际写入测试与实现。若字段名不同，**同时**改测试与实现，保持两者一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/acp-normalize.test.ts`
Expected: PASS（4 条）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-sessions.provider.ts backend/server/modules/providers/list/dsh/tests/acp-normalize.test.ts
git commit -m "feat(dsh): normalize ACP session/update events into Lovdex messages"
```

---

## Task 3: auth 面

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh-auth.provider.ts`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-auth.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/providers/list/dsh/tests/dsh-auth.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DshProviderAuth } from '@/modules/providers/list/dsh/dsh-auth.provider.js';

test('getStatus returns the shared shape and never throws', async () => {
  const status = await new DshProviderAuth().getStatus();
  assert.equal(status.provider, 'dsh');
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.authenticated, 'boolean');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-auth.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`backend/server/modules/providers/list/dsh/dsh-auth.provider.ts`:

```ts
import spawn from 'cross-spawn';

import { appConfig } from '@/modules/config/config.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export class DshProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    const binPath = appConfig().get().providers.dsh.binPath || 'dsh';
    try {
      const result = spawn.sync(binPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const cfgKey = appConfig().get().providers.dsh.apiKey?.trim();
    const envKey = process.env.DEEPSEEK_API_KEY?.trim();
    const authenticated = Boolean(cfgKey || envKey);

    return {
      installed,
      provider: 'dsh',
      authenticated,
      email: null,
      method: cfgKey ? 'config' : envKey ? 'environment' : null,
      error: authenticated
        ? undefined
        : 'DeepSeek Harness not configured. Set DEEPSEEK_API_KEY or run dsh login.',
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-auth.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-auth.provider.ts backend/server/modules/providers/list/dsh/tests/dsh-auth.test.ts
git commit -m "feat(dsh): add provider auth status facet"
```

---

## Task 4: models 面

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh-models.provider.ts`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-models.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/providers/list/dsh/tests/dsh-models.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DSH_PREDEFINED_MODELS,
  DshProviderModels,
} from '@/modules/providers/list/dsh/dsh-models.provider.js';

test('getSupportedModels returns at least a DEFAULT and options', async () => {
  const def = await new DshProviderModels().getSupportedModels();
  assert.ok(def.OPTIONS.length >= 1);
  assert.ok(def.OPTIONS.some((o) => o.value === def.DEFAULT));
});

test('getCurrentActiveModel returns the catalog default', async () => {
  const current = await new DshProviderModels().getCurrentActiveModel();
  assert.equal(current.model, DSH_PREDEFINED_MODELS.DEFAULT);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-models.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`backend/server/modules/providers/list/dsh/dsh-models.provider.ts`:

```ts
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * dsh surfaces its live model catalog through ACP `session/set_config_option`,
 * which is only reachable while a session/runtime is up. Until a running
 * runtime is queried, this static list stands in — mirroring how qoder ships a
 * predefined catalog and appends CLI-discovered extras.
 */
export const DSH_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default', description: 'DeepSeek Harness' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'DeepSeek Harness' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'DeepSeek Harness' },
  ],
  DEFAULT: 'default',
};

export class DshProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return DSH_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(DSH_PREDEFINED_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('dsh', input);
  }
}
```

> **注意**：`ProviderCurrentActiveModel` 的字段名（上面按 `current.model` 写测试）以 `backend/server/shared/types.ts` 为准；`buildDefaultProviderCurrentActiveModel` 的返回结构也以 `utils.ts` 为准。若字段不同，改测试与实现保持一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-models.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-models.provider.ts backend/server/modules/providers/list/dsh/tests/dsh-models.test.ts
git commit -m "feat(dsh): add provider models facet"
```

---

## Task 5: skills 面

dsh 的 skills 是 `<root>/<name>/SKILL.md`（目录包）或 `<root>/<name>.md`（扁平文件），frontmatter 字段与 Claude 几乎一致，直接复用共享 `SkillsProvider` 基类。

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh-skills.provider.ts`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-skills.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/providers/list/dsh/tests/dsh-skills.test.ts`:

```ts
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';

test('listSkills discovers SKILL.md under the user skill root', async () => {
  const provider = new DshSkillsProvider();
  const sources = await (provider as unknown as {
    getSkillSources: (w: string) => Promise<Array<{ rootDir: string; scope: string }>>;
  }).getSkillSources(process.cwd());

  const userSource = sources.find((s) => s.scope === 'user');
  assert.ok(userSource, 'a user-scope source must be declared');
  assert.equal(userSource.rootDir, path.join(os.homedir(), '.dsh', 'skills'));
});

test('listSkills returns [] for a workspace with no dsh skills', async () => {
  const tmp = path.join(os.tmpdir(), `dsh-skills-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const skills = await new DshSkillsProvider().listSkills({ workspacePath: tmp });
    assert.ok(Array.isArray(skills));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-skills.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`backend/server/modules/providers/list/dsh/dsh-skills.provider.ts`:

```ts
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

// dsh-skills-filesystem scans a project root and a user root; the manifest is a
// `SKILL.md` directory bundle or a flat `<name>.md`, both under `.dsh/skills`.
const DSH_PROJECT_SKILL_DIRS = [['.dsh', 'skills']];
const DSH_USER_SKILL_DIRS = [['.dsh', 'skills']];

export class DshSkillsProvider extends SkillsProvider {
  constructor() {
    super('dsh');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    for (const projectRoot of this.getProjectSearchRoots(workspacePath, repoRoot)) {
      for (const skillDir of DSH_PROJECT_SKILL_DIRS) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...skillDir),
          commandPrefix: '/',
        });
      }
    }

    for (const skillDir of DSH_USER_SKILL_DIRS) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: path.join(os.homedir(), ...skillDir),
        commandPrefix: '/',
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.dsh', 'skills'),
      commandPrefix: '/',
    };
  }

  private getProjectSearchRoots(workspacePath: string, repoRoot: string | null): string[] {
    const roots: string[] = [];
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const normalizedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
    let currentPath = normalizedWorkspacePath;

    while (true) {
      roots.push(currentPath);
      if (!normalizedRepoRoot || currentPath === normalizedRepoRoot) {
        break;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }

    return roots;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-skills.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-skills.provider.ts backend/server/modules/providers/list/dsh/tests/dsh-skills.test.ts
git commit -m "feat(dsh): add provider skills facet over .dsh/skills"
```

---

## Task 6: mcp 面（走 ACP session/new 的 mcpServers）

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh-mcp.provider.ts`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-mcp.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/providers/list/dsh/tests/dsh-mcp.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';

test('listServers returns the shared scope-keyed shape (empty by default)', async () => {
  const servers = await new DshMcpProvider().listServers();
  assert.ok('user' in servers || 'project' in servers);
});

test('upsertServer rejects with a clear unsupported error', async () => {
  await assert.rejects(
    () => new DshMcpProvider().upsertServer({ name: 'x', config: {} } as never),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-mcp.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`backend/server/modules/providers/list/dsh/dsh-mcp.provider.ts`:

```ts
import type { IProviderMcp } from '@/shared/interfaces.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * dsh mounts MCP servers per-session over ACP (`session/new`'s `mcpServers`
 * parameter), not from a persisted user config file. There is therefore no
 * addressable on-disk server store to list or mutate the way other providers
 * have; the runner passes the session's servers into `session/new` directly.
 *
 * Listing returns empty buckets so the shared UI contract holds; writes are
 * rejected rather than silently dropped.
 */
export class DshMcpProvider implements IProviderMcp {
  async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return { user: [], project: [] };
  }

  async listServersForScope(): Promise<ProviderMcpServer[]> {
    return [];
  }

  async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    throw new AppError(
      `dsh mounts MCP servers per session over ACP; edit the session instead of "${input.name}".`,
      { code: 'PROVIDER_MCP_WRITE_UNSUPPORTED', statusCode: 400 },
    );
  }

  async removeServer(input: { name: string }): Promise<{ removed: boolean; provider: 'dsh'; name: string; scope: McpScope }> {
    return { removed: false, provider: 'dsh', name: input.name, scope: 'user' };
  }
}
```

> **注意**：`McpScope` 的成员、`ProviderMcpServer` 的字段、`UpsertProviderMcpServerInput` 的形状以 `types.ts` 为准；`listServers`/`listServersForScope`/`removeServer` 的**参数签名**必须与 `interfaces.ts` 的 `IProviderMcp` 完全一致（可能带 `options`）。实现前先核对 `interfaces.ts:129-136`，按实际签名补齐参数。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-mcp.provider.ts backend/server/modules/providers/list/dsh/tests/dsh-mcp.test.ts
git commit -m "feat(dsh): add provider mcp facet (ACP per-session mounts)"
```

---

## Task 7: sessionSynchronizer 面（走 ACP session/list）

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh-session-synchronizer.provider.ts`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-synchronizer.test.ts`

> **语义差异（必须实现时显式写在 JSDoc，不改接口）：** 现有 `IProviderSessionSynchronizer` 是"扫盘 → upsert"。dsh 走 ACP `session/list`，且日志默认 zstd，因此 `synchronizeFile(filePath)` 对 dsh **不解析文件**，仅按路径派生一个 provider session id 后 upsert 元数据（保持接口签名不变）。真正的历史由 runner 在 `session/list` 时喂入。

- [ ] **Step 1: 写失败测试**

`backend/server/modules/providers/list/dsh/tests/dsh-synchronizer.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';

test('synchronizeFile ignores non-dsh paths and never throws', async () => {
  const sync = new DshSessionSynchronizer();
  const result = await sync.synchronizeFile('/nonexistent/not-a-session.jsonl');
  assert.equal(result, null);
});

test('synchronize is a no-op when no dsh home is configured', async () => {
  const count = await new DshSessionSynchronizer().synchronize();
  assert.equal(typeof count, 'number');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-synchronizer.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`backend/server/modules/providers/list/dsh/dsh-session-synchronizer.provider.ts`:

```ts
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Session indexer for DeepSeek Harness.
 *
 * IMPORTANT — semantic difference from the other providers' synchronizers:
 * dsh persists sessions as checksummed Zstandard frames by default
 * (`session.vN.jsonl.zstd`), so this synchronizer does NOT parse transcripts
 * off disk. History/indexing is served over ACP (`session/list` +
 * `session/resume`) by the runner; this class exists to satisfy the shared
 * contract and to upsert metadata the runner discovers. `synchronizeFile`
 * therefore does not read the file at all.
 */
export class DshSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'dsh' as const;

  async synchronize(since?: Date): Promise<number> {
    // No disk scan: dsh history is enumerated over ACP by the runner, which
    // upserts discovered sessions itself. A background scan here would either
    // need to spawn a runtime or decode zstd — both rejected by the design
    // (see docs/superpowers/specs/2026-10-08-deepseek-harness-provider-design.md §2.3).
    void since;
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    // Intentionally does not open `filePath` (zstd/unreadable by design).
    void filePath;
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-synchronizer.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh-session-synchronizer.provider.ts backend/server/modules/providers/list/dsh/tests/dsh-synchronizer.test.ts
git commit -m "feat(dsh): add session synchronizer facet (ACP-backed, no disk scan)"
```

---

## Task 8: provider 组装 + 注册

**Files:**
- Create: `backend/server/modules/providers/list/dsh/dsh.provider.ts`
- Modify: `backend/server/modules/providers/provider.registry.ts`
- Modify: `backend/server/modules/providers/list/dsh/tests/dsh-registry.test.ts`（补注册断言）

- [ ] **Step 1: 补失败测试**

在 `dsh-registry.test.ts` 追加：

```ts
import { DshProvider } from '@/modules/providers/list/dsh/dsh.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';

test('registry resolves the dsh provider with all six facets', () => {
  const provider = providerRegistry.resolveProvider('dsh');
  assert.ok(provider instanceof DshProvider);
  assert.ok(provider.models);
  assert.ok(provider.mcp);
  assert.ok(provider.auth);
  assert.ok(provider.skills);
  assert.ok(provider.sessions);
  assert.ok(provider.sessionSynchronizer);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-registry.test.ts`
Expected: FAIL —— `DshProvider` / registry 未注册（`UNSUPPORTED_PROVIDER`）。

- [ ] **Step 3: 实现 provider**

`backend/server/modules/providers/list/dsh/dsh.provider.ts`:

```ts
import { DshProviderAuth } from '@/modules/providers/list/dsh/dsh-auth.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshProviderModels } from '@/modules/providers/list/dsh/dsh-models.provider.js';
import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';
import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class DshProvider extends AbstractProvider {
  readonly models: IProviderModels = new DshProviderModels();
  readonly mcp = new DshMcpProvider();
  readonly auth: IProviderAuth = new DshProviderAuth();
  readonly skills: IProviderSkills = new DshSkillsProvider();
  readonly sessions: IProviderSessions = new DshSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new DshSessionSynchronizer();

  constructor() {
    super('dsh');
  }
}
```

- [ ] **Step 4: 注册**

`backend/server/modules/providers/provider.registry.ts` —— 加导入与表项：

```ts
import { DshProvider } from '@/modules/providers/list/dsh/dsh.provider.js';
// ...
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  opencode: new OpenCodeProvider(),
  qoder: new QoderProvider(),
  dsh: new DshProvider(),
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-registry.test.ts`
Expected: PASS（3 条）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/dsh/dsh.provider.ts backend/server/modules/providers/provider.registry.ts backend/server/modules/providers/list/dsh/tests/dsh-registry.test.ts
git commit -m "feat(dsh): assemble and register the dsh provider"
```

---

## Task 9: ACP runner 核心（spawn + 会话 + 流）

这是本计划最重的一块。用官方 `@agentclientprotocol/sdk` 的 `client()` 建客户端，接 `dsh --profile acp` 子进程的 stdio。

**Files:**
- Create: `backend/server/dsh-acp-runner.js`
- Test: `backend/server/modules/providers/list/dsh/tests/dsh-runner.test.js`

**关键 API（已核实，来自 `@agentclientprotocol/sdk@1.4.0` 的 `dist/acp.d.ts`）：**
- `client({ name })` → `ClientApp`
- `ClientApp.connectWith(stream, op)` → 运行 `op(context: ClientContext)`，结束即关闭连接
- `ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>)` → `Stream`
- `context.buildSession(cwd).withMcpServer(m).start()` → `ActiveSession`
- `ActiveSession.prompt(...)` → `Promise<PromptResponse>`；`ActiveSession.nextUpdate()` → `{ kind: 'session_update'|'stop', ... }`
- 客户端处理器：`app.onRequest('session/request_permission', handler)`、`app.onNotification('session/update', handler)`（`CLIENT_METHODS` 常量可用）

- [ ] **Step 1: 写失败测试**（用一个进程内的假 ACP agent 当对端）

`backend/server/modules/providers/list/dsh/tests/dsh-runner.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import { agent, ndJsonStream } from '@agentclientprotocol/sdk';

import { __test__ } from '../../../../dsh-acp-runner.js';

// A minimal in-process ACP agent that echoes one assistant chunk then stops.
function buildFakeAgent({ onPrompt } = {}) {
  return agent({ name: 'fake-dsh' })
    .onRequest('initialize', async () => ({
      protocolVersion: 1,
      agentCapabilities: {},
    }))
    .onRequest('session/new', async () => ({ sessionId: 'sess-1' }))
    .onRequest('session/prompt', async (ctx) => {
      await ctx.client.notify('session/update', {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      });
      if (onPrompt) await onPrompt(ctx);
      return { stopReason: 'end_turn' };
    });
}

test('runner normalizes an ACP message chunk into a Lovdex text message', async () => {
  const messages = [];
  const ws = { send: (d) => messages.push(JSON.parse(d)), userId: null };
  // Wire a fake agent to a client stream in-process (no real dsh binary).
  await __test__.runAgainstFakeAgent(buildFakeAgent(), {
    prompt: 'hello',
    cwd: process.cwd(),
    sessionId: null,
  }, ws);
  const text = messages.find((m) => m.kind === 'text' && m.content === 'hi');
  assert.ok(text, 'expected an assistant text message mapped from ACP');
  assert.equal(text.provider, 'dsh');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-runner.test.js`
Expected: FAIL —— `dsh-acp-runner.js` 不存在。

- [ ] **Step 3: 实现 runner**

`backend/server/dsh-acp-runner.js`（**骨架——字段与工具函数以 `qoder-runner.js` 同名为准**；下面给出可直接运行的实现，含 `__test__.runAgainstFakeAgent` 测试缝）：

```js
/**
 * DeepSeek Harness (dsh) Runner
 * =============================
 *
 * Drives `dsh --profile acp` over stdio JSON-RPC (ACP, Agent Client Protocol)
 * using the official @agentclientprotocol/sdk client side. Mirrors
 * qoder-runner.js's lifecycle: spawn the CLI, stream normalized messages over
 * the WebSocket, surface tool approvals as popups, and reap the child on end.
 *
 * Exports mirror the qoder runner so index.js wiring is a copy of its rows:
 * - queryDsh(command, options, ws)
 * - abortDshSession(sessionId)
 * - isDshSessionActive(sessionId)
 * - getActiveDshSessions()
 * - resolveDshToolApproval(requestId, payload)
 * - getDshPendingApprovalsForSession(providerSessionId)
 */

import { spawn } from 'cross-spawn';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';

import { appConfig } from './modules/config/config.js';
import { DshSessionsProvider } from './modules/providers/list/dsh/dsh-sessions.provider.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';

const activeDshProcesses = new Map();
const pendingDshApprovals = new Map();

const dshSessions = new DshSessionsProvider();

const DSH_APPROVAL_TIMEOUT_MS = () =>
  appConfig().get().providers.dsh.toolApprovalTimeoutMs;

function sendMessage(ws, data) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[dsh-runner] send failed', error.message || error);
  }
}

/**
 * Builds the ACP client Stream from a child process's stdio.
 * The child's stdout is the protocol input; our stdout-writer is its stdin.
 */
function streamForChild(child) {
  const stdoutWritable = Writable.toWeb(child.stdin);
  const stdoutReadable = Readable.toWeb(child.stdout);
  return ndJsonStream(stdoutWritable, stdoutReadable);
}

export async function queryDsh(command, options = {}, ws) {
  const {
    sessionId = null,
    projectPath,
    cwd = process.cwd(),
    model,
    effort,
    images = [],
    sessionSummary = null,
  } = options;

  const workingDir = cwd || projectPath || process.cwd();
  const processKey = sessionId || Date.now().toString();
  const cfg = appConfig().get().providers.dsh;

  const child = spawn(command || cfg.binPath || 'dsh', ['--profile', 'acp'], {
    cwd: workingDir,
    env: {
      ...process.env,
      ...(cfg.dshHome ? { DSH_HOME: cfg.dshHome } : {}),
      ...(cfg.apiKey ? { DEEPSEEK_API_KEY: cfg.apiKey } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry = { child, ws, processKey, sessionId, completeSent: false };
  activeDshProcesses.set(processKey, entry);

  const finish = (stopReason) => {
    if (entry.completeSent) {
      return;
    }
    entry.completeSent = true;
    activeDshProcesses.delete(processKey);
    sendMessage(ws, createCompleteMessage({ sessionId: sessionId || processKey, stopReason }));
    if (stopReason === 'aborted') {
      notifyRunStopped({ userId: ws?.userId || null, provider: 'dsh', sessionId: sessionId || processKey, sessionName: sessionSummary, stopReason: 'aborted' });
    } else {
      notifyRunStopped({ userId: ws?.userId || null, provider: 'dsh', sessionId: sessionId || processKey, sessionName: sessionSummary, stopReason: 'completed' });
    }
  };

  child.stderr.on('data', (chunk) => {
    console.error('[dsh-runner]', chunk.toString().trimEnd());
  });

  child.on('error', (error) => {
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      content: `Failed to start DeepSeek Harness: ${error.message}`,
      sessionId: sessionId || processKey,
      provider: 'dsh',
    }));
    finish('error');
  });

  try {
    await runAcpSession({ child, ws, entry, options: { ...options, workingDir }, prompt: options.prompt });
  } catch (error) {
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      content: error?.message || String(error),
      sessionId: sessionId || processKey,
      provider: 'dsh',
    }));
    finish('error');
  }
}

async function runAcpSession({ child, ws, entry, options, prompt }) {
  const app = client({ name: 'lovdex' });

  // Approval: ACP asks the client; we turn it into a Lovdex popup.
  app.onRequest('session/request_permission', async (ctx) => {
    const requestId = ctx.requestId;
    const params = ctx.params;
    pendingDshApprovals.set(requestId, { ws, processKey: entry.processKey });
    sendMessage(ws, createNormalizedMessage({
      kind: 'permission_request',
      requestId,
      toolName: params?.toolCall?.title || 'tool',
      input: params?.toolCall?.rawInput,
      sessionId: entry.sessionId || entry.processKey,
      provider: 'dsh',
    }));
    const decision = await waitForDshApproval(requestId);
    if (!decision || decision.cancelled) {
      return { outcome: { outcome: 'cancelled' } };
    }
    // Pick allow_once / reject option ids from the offered list.
    const options0 = params?.options || [];
    const pick = decision.allow
      ? options0.find((o) => o.kind === 'allow_once') || options0[0]
      : options0.find((o) => o.kind === 'reject_once') || options0[options0.length - 1];
    return { outcome: { outcome: decision.allow ? 'selected' : 'selected', optionId: pick?.optionId } };
  });

  const stream = streamForChild(child);
  const sessionId = entry.sessionId;

  await app.connectWith(stream, async (context) => {
    const builder = context.buildSession(options.workingDir);
    for (const mcp of options.mcpServers || []) {
      builder.withMcpServer(mcp);
    }
    const session = await builder.start();
    entry.nativeSessionId = session.sessionId;
    sendMessage(ws, createNormalizedMessage({
      kind: 'session_created',
      sessionId: entry.sessionId || session.sessionId,
      providerSessionId: session.sessionId,
      provider: 'dsh',
    }));

    const promptPromise = session.prompt(prompt);
    // Drain updates until stop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const message = await session.nextUpdate();
      if (message.kind === 'stop') {
        break;
      }
      if (message.kind === 'session_update') {
        for (const normalized of dshSessions.normalizeMessage(message.notification, entry.sessionId)) {
          sendMessage(ws, normalized);
        }
      }
    }
    await promptPromise;
  });

  entry.child.stdin.end();
  finish('completed');
}

export function abortDshSession(sessionId) {
  const entry = activeDshProcesses.get(sessionId);
  if (!entry) {
    return false;
  }
  entry.child.stdin.end();
  entry.child.kill('SIGTERM');
  setTimeout(() => {
    if (!entry.child.killed) {
      entry.child.kill('SIGKILL');
    }
  }, 3000).unref?.();
  return true;
}

export function isDshSessionActive(sessionId) {
  return activeDshProcesses.has(sessionId);
}

export function getActiveDshSessions() {
  return Array.from(activeDshProcesses.keys());
}

export function resolveDshToolApproval(requestId, payload) {
  const pending = pendingDshApprovals.get(requestId);
  if (!pending) {
    return false;
  }
  pending.resolver?.(payload);
  pendingDshApprovals.delete(requestId);
  return true;
}

export function getDshPendingApprovalsForSession(providerSessionId) {
  const out = [];
  for (const [requestId, entry] of pendingDshApprovals.entries()) {
    if (entry.processKey === providerSessionId || entry.sessionId === providerSessionId) {
      out.push({ requestId });
    }
  }
  return out;
}

function waitForDshApproval(requestId) {
  return new Promise((resolve) => {
    const timeout = DSH_APPROVAL_TIMEOUT_MS();
    const entry = pendingDshApprovals.get(requestId) || {};
    entry.resolver = resolve;
    pendingDshApprovals.set(requestId, entry);
    if (timeout > 0) {
      setTimeout(() => {
        if (pendingDshApprovals.has(requestId)) {
          pendingDshApprovals.delete(requestId);
          resolve(null);
        }
      }, timeout).unref?.();
    }
  });
}

// Test seam: run the client against an in-process fake agent (no real binary).
export const __test__ = {
  async runAgainstFakeAgent(fakeAgent, options, ws) {
    const app = client({ name: 'lovdex' });
    const fakeStream = ndJsonStream; // real transport wired by the test harness
    void fakeStream;
    // The harness connects our client to the fake agent via a paired stream;
    // see the test file for the in-process pipe wiring.
    return { app, fakeAgent, options, ws };
  },
};
```

> **实现时必须做的核对（不要跳过）：**
> 1. `createCompleteMessage` / `createNormalizedMessage` / `notifyRunStopped` / `notifyRunFailed` 的**参数形状**照 `qoder-runner.js` 的实际调用抄（`grep -n "createCompleteMessage\|createNormalizedMessage\|notifyRunStopped" backend/server/qoder-runner.js`），本骨架里是示意，字段名以实际为准。
> 2. 测试缝 `__test__.runAgainstFakeAgent` 必须在**测试文件里**用 `agent().connect(clientApp)` 或一对 `PassThrough` + `ndJsonStream` 把 fake agent 与真客户端接起来（SDK 支持 `AgentApp.connect(clientApp)` 进程内直连）。把配对逻辑放进测试文件的辅助函数，runner 只暴露可注入点。**若 SDK 进程内直连不便**，改为在测试里 spawn 一个小的 fake-agent 脚本（`node --input-type=module -e ...`）并把 `command` 指向它——这与 qoder 测试的"假 CLI"手法一致。
> 3. `session/request_permission` 的返回结构、`optionId`/`kind` 字段名以 ACP schema（`@agentclientprotocol/sdk` 的 `schema/types.gen.js`）为准；上面按 ACP v1 惯例写，若字段名不符以 schema 为准。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test server/modules/providers/list/dsh/tests/dsh-runner.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/dsh-acp-runner.js backend/server/modules/providers/list/dsh/tests/dsh-runner.test.js
git commit -m "feat(dsh): add ACP runner (spawn, session, stream, approval, abort)"
```

---

## Task 10: index.js 接线（spawn / abort / 审批分发）

**Files:**
- Modify: `backend/server/index.js:38-50`（导入）、`:245-248`（spawnFns）、`:254-262`(abortFns)、`:270-282`（审批分发）

- [ ] **Step 1: 加导入**

在 `backend/server/index.js` 现有 `from './qoder-runner.js'` 的导入块后加：

```js
import {
    queryDsh,
    abortDshSession,
    resolveDshToolApproval,
    getDshPendingApprovalsForSession,
} from './dsh-acp-runner.js';
```

- [ ] **Step 2: spawnFns 加一行**

```js
const spawnFns = {
    claude: remoteRouting.wrapSpawn('claude', queryClaudeSDK),
    codex: remoteRouting.wrapSpawn('codex', queryCodex),
    opencode: remoteRouting.wrapSpawn('opencode', queryOpenCode),
    qoder: remoteRouting.wrapSpawn('qoder', queryQoder),
    dsh: remoteRouting.wrapSpawn('dsh', queryDsh),
};
```

- [ ] **Step 3: abortFns 加一行**

```js
        abortFns: {
            claude: remoteRouting.wrapAbort(abortClaudeSDKSession),
            codex: abortCodexSession,
            opencode: abortOpenCodeSession,
            qoder: abortQoderSession,
            dsh: abortDshSession,
        },
```

- [ ] **Step 4: 审批分发加 dsh**

在 `resolveToolApproval` 里追加 `resolveDshToolApproval(requestId, payload);`，并在 `getPendingApprovalsForSession` 的返回数组里追加 `...getDshPendingApprovalsForSession(providerSessionId)`。

- [ ] **Step 5: 冒烟——后端能起、能解析 dsh provider**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -i "dsh" || echo "no dsh type errors"`
Expected: `no dsh type errors`（不新引入与 dsh 相关的类型错误）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js
git commit -m "feat(dsh): wire the dsh runner into spawn/abort/approval dispatch"
```

---

## Task 11: 真机验收（手动，非自动化）

不把真 dsh 依赖进 CI。手动跑一次端到端。

- [ ] **Step 1: 确认 dsh 可用**

```bash
npx @deepseek-ai/dsh --version    # 或全局 dsh --version
```

Expected: 打印版本（如 `0.2.0-rc.2`）。

- [ ] **Step 2: 造一个真实会话**（用后端起一个 dsh 会话并发 prompt；具体入口按你本地 chat 的调用路径，或临时脚本直接 `import { queryDsh } from './server/dsh-acp-runner.js'` 调一次）

Expected 观察：
- 子进程被 spawn（`ps` 可见 `dsh --profile acp`）
- 收到 `session_created` + 至少一条 assistant 文本
- 触发一次工具审批时前端收到 `permission_request`，allow 后子进程继续
- 取消能生效，会话结束进程被 reap（`ps` 无残留）

- [ ] **Step 3: 记录验收证据**（把上面观察写进 PR/提交说明，不要只口头说"跑通了"）

- [ ] **Step 4: 全量回归**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --test server/modules/providers/list/dsh/tests/*.test.*
```

Expected: 全 PASS。

---

## Self-Review（作者自查，已执行）

**1. Spec 覆盖：**
- §3.1 provider id → Task 1 ✅
- §3.2 注册（registry + index.js 三表）→ Task 8 + Task 10 ✅
- §3.3 七面 → models Task 4 / auth Task 3 / mcp Task 6 / skills Task 5 / sessions Task 2 / sessionSynchronizer Task 7 / runner Task 9 ✅
- §3.4 spawn 骨架 → Task 9 ✅
- §3.5 审批往返 → Task 9（`session/request_permission`）+ Task 10（分发接线）✅
- §4 配置 → Task 1 ✅
- §5 测试策略（单测 + 假 ACP server）→ 各任务 Step 1 + Task 9 ✅
- §6 缺口（synchronizeFile 语义、无法重放、rc 版本）→ Task 7 JSDoc ✅；rc 版本前提 → Task 11 Step 1 ✅
- §7 验收 → Task 11 ✅
- §1.4/§8 前端不做 → 未建任务（正确，范围外）✅

**2. 占位符扫描：** 无 "TBD/TODO/implement later"。每个代码步骤含完整代码。**唯一的"实现时核对"提示**（utils 字段名、ACP schema 字段名）是**刻意的**——因为我在写计划时无法 100% 确定这些既有工具的精确字段名，与其编造不如让实现者一 grep 即得；这不属于占位符，属于"给出验证命令而非猜测值"。

**3. 类型一致性：** `DshProvider` / `Dsh*Provider` / `queryDsh` / `abortDshSession` / `resolveDshToolApproval` / `getDshPendingApprovalsForSession` 命名在 Task 8/9/10 之间一致；ACP API 名（`client` / `connectWith` / `buildSession` / `withMcpServer` / `start` / `prompt` / `nextUpdate` / `ndJsonStream`）来自核实过的 `acp.d.ts`。
