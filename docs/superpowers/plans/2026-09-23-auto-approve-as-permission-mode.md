# 自动审批即权限模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「自动审批」从任务上的布尔开关改成权限模式体系里的一个模式值，让任务与会话共用同一套语义、同一套选项。

**Architecture:** 新增 Lovdex 层模式 `'autoApprove'`，在网关归一化为 `permissionMode: 'default'` + `autoApprove: true`（SDK 的 `PermissionMode` 是封闭联合，且自动审批策略挂在只在非 bypass 时才被调用的 `canUseTool` 里），所以**四个 provider 运行时零改动**。任务把布尔 `auto_approve` 换成模式字符串 `permission_mode`；模式解析统一为「会话键 → 任务 → provider 上次 → provider 默认」。

**Tech Stack:** TypeScript、React 18、better-sqlite3、node:test（前后端均 `npx tsx --test`；前端无 DOM，渲染测试用 `renderToStaticMarkup`）、Express + WebSocket。

**Spec:** `docs/superpowers/specs/2026-09-23-auto-approve-as-permission-mode-design.md`

---

## 环境前置（每个 shell 都要做）

`TSX_TSCONFIG_PATH=server/tsconfig.json` 在本机被**全局导出**，会让从 `web/` 跑的 `npx tsx` 去 `web/server/tsconfig.json` 找配置并崩溃。前端测试命令**必须**带 `env -u TSX_TSCONFIG_PATH`。

```bash
# 后端（在 backend/ 下）
npx tsx --tsconfig server/tsconfig.json --test <测试文件>

# 前端（在 web/ 下）
env -u TSX_TSCONFIG_PATH npx tsx --test <测试文件>
```

**基线**（改动前实测，验收标准是「零新增」而非全绿）：
- backend `npm run typecheck`：14 errors（全在无关测试文件）
- backend `npm run lint`：47 errors / 226 warnings
- web `npm run typecheck`：0 errors
- backend 全量测试 1376 pass；web 全量测试 747 pass

**并发会话警告**：工作区被另一个会话共用。`web/src/components/tasks/anchorPlacement.ts`、`anchorPlacement.test.ts`、`AnchorPopover.tsx` 是**别人的 WIP**。不要读改、不要 stage。每次提交**显式列出文件路径**，禁止 `git add -A` / `git add .`。

**分支**：用户已明确同意**直接在 `main` 上工作并提交**。不要创建或切换分支。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `backend/server/modules/permissions/auto-approve-policy.ts` | 自动审批策略（纯函数） | 加 `normalizePermissionMode` + `AUTO_APPROVE_MODE`；删 `resolveTaskAutoApprove` |
| `backend/server/modules/permissions/tests/auto-approve-policy.test.ts` | 上述测试 | 加/删 |
| `backend/server/modules/database/schema.ts` | 建表语句 | 两张表加 `permission_mode` |
| `backend/server/modules/database/migrations.ts` | 迁移 | helper 返回 boolean + 回填 |
| `backend/server/modules/database/repositories/tasks.db.ts` | 任务读写 | `auto_approve` → `permission_mode` |
| `backend/server/modules/database/repositories/scheduled-tasks.db.ts` | 定时任务读写 | 同上 |
| `backend/server/modules/tasks/services/tasks.service.ts` | 任务服务 | 同上 |
| `backend/server/modules/tasks/tasks.routes.ts` | REST 校验 | 同上 |
| `backend/server/modules/websocket/services/chat-websocket.service.ts` | `chat.send` 装配 | 归一化；删任务反查 |
| `backend/server/modules/websocket/services/headless-task-run.service.ts` | 无人值守运行 | 归一化 |
| `backend/server/index.js` | `startTaskRun` | 传模式 |
| `backend/server/modules/scheduler/services/scheduler.service.ts` | 派发镜像 | 传模式 |
| `web/src/components/chat/utils/resolvePermissionMode.ts` | 模式解析（纯函数） | **新建** |
| `web/src/components/chat/hooks/useChatProviderState.ts` | composer 模式 | 接入解析；`FALLBACK_PERMISSION_MODES` 加一档 |
| `web/src/components/chat/types/types.ts` | `PermissionMode` / `ChatInterfaceProps` | 加 `'autoApprove'` / `linkedTaskPermissionMode` |
| `web/src/components/chat/view/subcomponents/permissionModeLabels.ts` | 模式标签键 | 加一项 |
| `web/src/components/chat/view/subcomponents/ChatComposer.tsx` | 模式按钮配色 | 加一个分支 |
| `web/src/components/chat/view/ChatInterface.tsx` | 透传 | 加 `linkedTaskPermissionMode` |
| `web/src/components/main-content/view/MainContent.tsx` | 透传 | 同上 |
| `web/src/components/tasks/taskExecution.ts` | 任务运行发送 | 走统一解析 |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | 定时任务表单 | 布尔 → 模式选择器 |
| `web/src/components/tasks/CreateTaskDialog.tsx` | 任务新建 | 同上 |
| `web/src/components/tasks/TaskDetail.tsx` | 任务详情 | 同上 |
| `web/src/components/tasks/scheduledTaskPresentation.tsx` | 徽标 | 改读模式 |
| `web/src/types/app.ts` | `Task` / `ScheduledTask` | 字段改名 |
| `web/src/i18n/locales/en/chat.json` | 模式文案 | 加两条 |

---

## Task 1: 撤销上一版（会话级开关）的实现

上一版设计（`6c17ebe`…`18d6f3a`，6 个 commit）全部作废。**用 revert commit 撤销，不做 `git reset`**——另一个会话有未提交的工作，动分支历史会毁掉它。

**Files:** 由 `git revert` 决定（`backend/server/modules/permissions/auto-approve-policy.ts`、`.../tests/auto-approve-policy.test.ts`、`backend/server/modules/websocket/services/chat-websocket.service.ts`、`web/src/components/chat/hooks/useSessionAutoApprove.{ts,test.ts}`、`web/src/components/chat/view/subcomponents/AutoApproveToggle.{tsx,test.tsx}`、`web/src/components/chat/hooks/useChatComposerState.ts`、`web/src/components/chat/types/types.ts`、`web/src/components/chat/view/ChatInterface.tsx`、`web/src/components/main-content/view/MainContent.tsx`、`web/src/components/chat/view/subcomponents/ChatComposer.tsx`）

- [ ] **Step 1: 确认工作区状态**

```bash
cd /mnt/b/workdir/github/lovdex
git status --porcelain
```

Expected: 只有 `?? web/src/components/tasks/anchorPlacement.ts`、`?? web/src/components/tasks/anchorPlacement.test.ts`、` M web/src/components/tasks/AnchorPopover.tsx`（**别人的 WIP**）。若还有别的改动，先停下来报告。

- [ ] **Step 2: 逆序 revert 六个实现 commit**

```bash
cd /mnt/b/workdir/github/lovdex
git revert --no-edit 18d6f3a a3f3e42 eeab8fb 87d03bf 818b035 6c17ebe
```

Expected: 6 个 revert commit，无冲突。`git status --porcelain` 仍只显示那三个别人的文件。

- [ ] **Step 3: 验证撤销干净**

```bash
cd /mnt/b/workdir/github/lovdex
grep -rn "applyClientAutoApproveOverride\|useSessionAutoApprove\|AutoApproveToggle" backend/server web/src 2>/dev/null | grep -v node_modules
```

Expected: **无输出**（全部撤掉了）。

- [ ] **Step 4: 跑回归确认回到基线**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test $(find server -name "*.test.ts" | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | grep -v anchorPlacement | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: backend 1376 pass / 0 fail；web 747 pass / 0 fail。

---

## Task 2: 归一化纯函数 `normalizePermissionMode`

**Files:**
- Modify: `backend/server/modules/permissions/auto-approve-policy.ts`（末尾）
- Test: `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`（末尾）

- [ ] **Step 1: 写失败的测试**

在 `auto-approve-policy.test.ts` 的 import 里加 `AUTO_APPROVE_MODE, normalizePermissionMode`（保持字母序），并在文件末尾追加：

```ts
// --- 权限模式归一化 ---

test('the auto-approve mode becomes default + the flag', () => {
  assert.deepEqual(normalizePermissionMode(AUTO_APPROVE_MODE), {
    permissionMode: 'default',
    autoApprove: true,
  });
});

test('every known provider mode passes through with the flag off', () => {
  for (const mode of ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']) {
    assert.deepEqual(
      normalizePermissionMode(mode),
      { permissionMode: mode, autoApprove: false },
      `${mode} must pass through untouched`,
    );
  }
});

test('anything unknown degrades to default, never to auto-approval', () => {
  for (const value of ['dontAsk', 'garbage', '', null, undefined, 0, 1, true, {}, []]) {
    assert.deepEqual(
      normalizePermissionMode(value),
      { permissionMode: 'default', autoApprove: false },
      `${JSON.stringify(value)} must degrade to default`,
    );
  }
});

test('the mode constant is the exact wire value', () => {
  // 前后端与运行时共用同一个字面量；改动它会静默断掉整条链路。
  assert.equal(AUTO_APPROVE_MODE, 'autoApprove');
});
```

`'dontAsk'` 是 SDK 认识但 Lovdex 没验证过的模式，刻意不在白名单里——这条断言把它钉死。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: FAIL —— `normalizePermissionMode is not a function`。

- [ ] **Step 3: 写实现**

在 `auto-approve-policy.ts` 末尾追加：

```ts
/**
 * The Lovdex-level permission mode that means "answer the permission prompts
 * yourself". It is NOT a value the Claude SDK understands — `PermissionMode` is
 * a closed union ('default' | 'acceptEdits' | 'bypassPermissions' | 'plan' |
 * 'dontAsk' | 'auto') and `claude-sdk.js` forwards any non-'default' value
 * straight into it. `normalizePermissionMode` is what translates.
 *
 * Exported so the frontend, the runtimes and the tests all spell it the same
 * way; a typo in any one of them would silently disable the feature.
 */
export const AUTO_APPROVE_MODE = 'autoApprove';

/** Modes Lovdex has actually verified end to end. `dontAsk` is deliberately absent. */
const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'default',
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

/**
 * Translate a Lovdex permission mode into what the provider runtimes consume.
 *
 * `autoApprove` MUST resolve to `'default'`, not to `'bypassPermissions'`:
 * `canUseTool` is only consulted when the mode is not bypass, and the whole
 * auto-approval policy hangs off that callback. Resolving it to bypass would
 * skip the danger rules entirely — the feature would look like it worked while
 * silently approving `rm -rf /`.
 *
 * Unknown values degrade to `'default'`, matching the direction every other
 * fallback in this codebase takes (ask the human, never grant).
 */
export function normalizePermissionMode(mode: unknown): {
  permissionMode: string;
  autoApprove: boolean;
} {
  if (mode === AUTO_APPROVE_MODE) {
    return { permissionMode: 'default', autoApprove: true };
  }
  if (typeof mode === 'string' && KNOWN_PERMISSION_MODES.has(mode)) {
    return { permissionMode: mode, autoApprove: false };
  }
  return { permissionMode: 'default', autoApprove: false };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: PASS，`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/permissions/auto-approve-policy.ts backend/server/modules/permissions/tests/auto-approve-policy.test.ts
git commit -m "feat(auto-approve): normalize the auto-approve permission mode"
```

---

## Task 3: 前端模式值（联合类型 / 标签 / i18n / 配色 / 能力表）

**Files:**
- Modify: `web/src/components/chat/types/types.ts:10`
- Modify: `web/src/components/chat/view/subcomponents/permissionModeLabels.ts:14-23`
- Modify: `web/src/i18n/locales/en/chat.json`
- Modify: `web/src/components/chat/hooks/useChatProviderState.ts:52-56`
- Modify: `web/src/components/chat/view/subcomponents/ChatComposer.tsx:479-507`
- Modify: `backend/server/modules/providers/services/provider-capabilities.service.ts:37,47,57,67`

- [ ] **Step 1: 联合类型**

`web/src/components/chat/types/types.ts:10`：

```ts
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'autoApprove' | 'bypassPermissions' | 'plan';

/**
 * 与后端 `auto-approve-policy.ts` 的 `AUTO_APPROVE_MODE` **必须逐字一致**：
 * 它是前后端之间的线上值，任一侧拼错都会静默断掉整条链路（模式能选、但
 * 后端归一化不到，退化成 default = 不再自动批）。
 */
export const AUTO_APPROVE_MODE = 'autoApprove';
```

- [ ] **Step 2: 标签键**

`permissionModeLabels.ts` 的 `LABEL_KEYS`，在 `auto` 之后插入：

```ts
  autoApprove: { shortKey: 'codex.modesShort.autoApprove', fullKey: 'codex.modes.autoApprove' },
```

`Record<PermissionMode, …>` 会让 typecheck 在漏加时报错——这是设计好的守卫，不要用 `as` 绕过。

- [ ] **Step 3: i18n**

`web/src/i18n/locales/en/chat.json`，在 `codex.modes` 与 `codex.modesShort` 对象里各加一条（挨着 `auto`）：

```json
"autoApprove": "Auto Approve"
```

```json
"autoApprove": "AutoApprove"
```

文案要说明**开启后会发生什么**，不能只有名字——`Auto Approve` 配合 composer 的 tooltip 足够，但表单里会用更长的说明（Task 12）。

- [ ] **Step 4: 前端能力表兜底**

`useChatProviderState.ts:52-56` 的 `FALLBACK_PERMISSION_MODES`，四个 provider 各在 `'auto'` 之后加 `'autoApprove'`：

```ts
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  qoder: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
};
```

- [ ] **Step 5: 后端能力表（权威来源）**

`provider-capabilities.service.ts` 四处 `permissionModes`，同样在 `'auto'` 之后加 `'autoApprove'`。**这四个数组才是 composer 循环的实际来源**；上一步的 `FALLBACK_*` 只在能力表拉取失败时兜底。两处必须一致。

- [ ] **Step 6: 按钮配色**

`ChatComposer.tsx` 的 `:479-507` 有两个平行的三元链（外层按钮边框、内层圆点）。在各自 `permissionMode === 'auto'` 分支之后插入 `'autoApprove'` 分支，**两处都要加**：

外层（`:483-484` 之后）：

```tsx
                    : permissionMode === 'autoApprove'
                      ? 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
```

内层（`:502-503` 之后）：

```tsx
                        : permissionMode === 'autoApprove'
                          ? 'bg-warning'
```

用 warning 色系（与 `bypassPermissions` 同阶）是刻意的：这个模式同样是「不问你就动手」，不该看起来像普通模式。

- [ ] **Step 7: typecheck 与 lint**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -10 && npm run lint 2>&1 | tail -5
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -10
```

Expected: web 0 errors；backend 仍是那 14 个 pre-existing。

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/types/types.ts web/src/components/chat/view/subcomponents/permissionModeLabels.ts web/src/i18n/locales/en/chat.json web/src/components/chat/hooks/useChatProviderState.ts web/src/components/chat/view/subcomponents/ChatComposer.tsx backend/server/modules/providers/services/provider-capabilities.service.ts
git commit -m "feat(auto-approve): add the autoApprove permission mode to every provider"
```

---

## Task 4: 网关与 headless 接入归一化，删除旧函数

**Files:**
- Modify: `backend/server/modules/websocket/services/chat-websocket.service.ts`
- Modify: `backend/server/modules/websocket/services/headless-task-run.service.ts:113-121`
- Modify: `backend/server/modules/permissions/auto-approve-policy.ts`（删 `resolveTaskAutoApprove`）
- Modify: `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`（删对应测试）

**为什么没有单测：** `handleChatSend` 没有导出、也没有测试宿主（需要 DB 行、WebSocket、provider spawn）。本仓库对它的既有做法是把可判定部分抽成纯函数再测——Task 2 的 `normalizePermissionMode` 就是那一层。本任务的验收是 typecheck + lint 零新增 + Task 16 的 E2E。

- [ ] **Step 1: `chat-websocket.service.ts` 换掉任务反查**

import 改成只引 `normalizePermissionMode`（删 `resolveTaskAutoApprove`）。`runtimeOptions` 里把 `autoApprove` 那一项替换成：

```ts
    // 客户端传来的是 Lovdex 层模式（可能是 'autoApprove'）。归一化在这里发生，
    // 所以四家 provider 运行时拿到的永远只有它们已经认识的
    // permissionMode + autoApprove 组合，无需任何改动。
    ...normalizePermissionMode(clientOptions.permissionMode),
```

`...clientOptions` 的展开在前，这一句在后，所以 `permissionMode` 会被覆盖成归一化后的值。把原来那条「client-supplied autoApprove cannot upgrade」的注释一并删掉——它描述的是已作废的设计。

同时删掉 `ChatWebSocketDependencies` 里的 `getTaskAutoApprove?`，以及函数体里 `const getTaskAutoApprove = dependencies.getTaskAutoApprove ?? (() => null);` 那一行。

- [ ] **Step 2: `headless-task-run.service.ts` 用同一个函数**

把 `:113-121` 里的：

```ts
    // 'default' so canUseTool keeps being consulted — that callback is where
    // auto-approval short-circuits, and bypassPermissions would skip it
    // entirely. Without autoApprove these prompts surface as the board's
    // "等你批准" marker for the user to decide, identical to the manual button.
    permissionMode: 'default',
    ...(options.autoApprove === true ? { autoApprove: true } : {}),
```

换成：

```ts
    // Same normalisation as the interactive path — see normalizePermissionMode.
    // 'autoApprove' resolves to 'default' + the flag precisely so canUseTool
    // keeps being consulted (it is where the policy runs, and bypassPermissions
    // would skip it entirely).
    ...normalizePermissionMode(options.permissionMode),
```

顶部 import 加 `import { normalizePermissionMode } from '@/modules/permissions/auto-approve-policy.js';`。

依赖类型里的 `autoApprove?: boolean;` 换成 `permissionMode?: string;`，注释同步改成「来自任务行的 `permission_mode`」。

- [ ] **Step 3: 删掉 `resolveTaskAutoApprove`**

从 `auto-approve-policy.ts` 删除该函数及其 JSDoc（`chat.send` 不再查任务行，没有调用点了）。同步删掉 `auto-approve-policy.test.ts` 里以它开头的三个 test。

- [ ] **Step 4: 确认没有残留引用**

```bash
cd /mnt/b/workdir/github/lovdex
grep -rn "resolveTaskAutoApprove\|getTaskAutoApprove" backend/server --include=*.ts --include=*.js | grep -v node_modules
```

Expected: 无输出。

- [ ] **Step 5: typecheck + lint + 单测**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm run typecheck 2>&1 | grep -cE "error TS"
npm run lint 2>&1 | tail -3
npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/headless-task-run.test.ts
```

Expected: typecheck 14；`headless-task-run.test.ts` 可能需要同步改（它断言 `autoApprove: true` 进 runtimeOptions）——若失败，把断言改成 `permissionMode: 'autoApprove'` 进 options 后归一化出 `autoApprove: true`。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/websocket/services/chat-websocket.service.ts backend/server/modules/websocket/services/headless-task-run.service.ts backend/server/modules/permissions/auto-approve-policy.ts backend/server/modules/permissions/tests/auto-approve-policy.test.ts backend/server/modules/websocket/tests/headless-task-run.test.ts
git commit -m "feat(auto-approve): normalise the permission mode on both run paths"
```

---

## Task 5: 数据模型 —— 加列与幂等回填

**Files:**
- Modify: `backend/server/modules/database/schema.ts:163-228`
- Modify: `backend/server/modules/database/migrations.ts:32-43`
- Test: `backend/server/modules/database/tests/auto-approve-migration.test.ts`（已存在，扩写）

- [ ] **Step 1: 建表语句加列**

`schema.ts` 的 `TASKS_TABLE_SCHEMA_SQL`（`auto_approve` 在 `:198`）与 scheduled_tasks 建表语句（`:223`）各加一行：

```sql
    permission_mode   TEXT DEFAULT 'default',
```

`auto_approve` 那行**保留不动**——见 spec §4.3，删列要 `DROP COLUMN`，在活库上不值得冒险，且留着它才能让回填可重放。

- [ ] **Step 2: helper 返回是否真的加了列**

`migrations.ts:32-43` 的 `addColumnToTableIfNotExists` 改成返回 `boolean`：

```ts
const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
): boolean => {
  if (columnNames.includes(columnName)) return false;
  console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  return true;
};
```

- [ ] **Step 3: 写失败的测试**

在 `backend/server/modules/database/tests/auto-approve-migration.test.ts` 末尾追加（该文件已有建库/跑迁移的脚手架，复用它的 `mkDb` 之类辅助；若辅助名不同，照抄同文件里既有 test 的用法）：

```ts
test('the permission_mode column is added to both tables', () => {
  const db = mkDb();
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  const schedCols = (db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(taskCols.includes('permission_mode'), 'tasks.permission_mode');
  assert.ok(schedCols.includes('permission_mode'), 'scheduled_tasks.permission_mode');
});

test('an existing auto_approve = 1 row is backfilled to the auto-approve mode', () => {
  const db = mkDb();
  // 模拟老库：加列之后、回填之前，插一行带布尔开关的任务。
  db.prepare("INSERT INTO tasks (task_id, project_path, title, status, auto_approve) VALUES ('t1', '/p', 'x', 'todo', 1)").run();
  db.prepare("INSERT INTO tasks (task_id, project_path, title, status, auto_approve) VALUES ('t2', '/p', 'y', 'todo', 0)").run();
  runMigrations(db);
  const rows = db.prepare('SELECT task_id, permission_mode FROM tasks ORDER BY task_id').all() as { task_id: string; permission_mode: string }[];
  assert.deepEqual(rows, [
    { task_id: 't1', permission_mode: 'autoApprove' },
    { task_id: 't2', permission_mode: 'default' },
  ]);
});

test('re-running the migration does not undo a manual switch back to default', () => {
  const db = mkDb();
  runMigrations(db);
  db.prepare("INSERT INTO tasks (task_id, project_path, title, status, permission_mode) VALUES ('t1', '/p', 'x', 'todo', 'default')").run();
  // 第二次跑迁移：列已存在，回填必须整段跳过。
  runMigrations(db);
  const row = db.prepare("SELECT permission_mode FROM tasks WHERE task_id = 't1'").get() as { permission_mode: string };
  assert.equal(row.permission_mode, 'default', 'a manual switch must survive a restart');
});
```

第三条是本任务的核心断言：迁移每次启动都会跑，如果回填无条件执行，用户手动改回 `default` 的任务会在每次重启时被翻回自动审批。

- [ ] **Step 4: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/auto-approve-migration.test.ts
```

Expected: FAIL（列不存在 / 回填缺失）。

- [ ] **Step 5: 实现迁移**

在 `migrations.ts` 里 `tasks` 与 `scheduled_tasks` 的加列处，用返回值门控回填：

```ts
  // 只有「这一次真的加了列」才回填。迁移每次启动都会跑，无条件回填会把用户
  // 手动改回 'default' 的任务在每次重启时翻回自动审批——静默地。
  const addedTaskMode = addColumnToTableIfNotExists(
    db, 'tasks', taskColumns, 'permission_mode', "TEXT DEFAULT 'default'"
  );
  if (addedTaskMode) {
    db.exec("UPDATE tasks SET permission_mode = 'autoApprove' WHERE auto_approve = 1");
  }

  const addedScheduleMode = addColumnToTableIfNotExists(
    db, 'scheduled_tasks', scheduledTaskColumns, 'permission_mode', "TEXT DEFAULT 'default'"
  );
  if (addedScheduleMode) {
    db.exec("UPDATE scheduled_tasks SET permission_mode = 'autoApprove' WHERE auto_approve = 1");
  }
```

（`taskColumns` / `scheduledTaskColumns` 用文件里既有的 `getTableInfo(db, 'tasks').map(c => c.name)` 取法，照抄相邻代码。）

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/auto-approve-migration.test.ts
```

Expected: PASS，`# fail 0`。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts backend/server/modules/database/tests/auto-approve-migration.test.ts
git commit -m "feat(auto-approve): store the permission mode on tasks"
```

---

## Task 6: 仓储 / 服务 / 路由改读模式

**Files:**
- Modify: `backend/server/modules/database/repositories/tasks.db.ts:101,188`
- Modify: `backend/server/modules/database/repositories/scheduled-tasks.db.ts:54,103`
- Modify: `backend/server/modules/tasks/services/tasks.service.ts:103,539,547`
- Modify: `backend/server/modules/tasks/tasks.routes.ts:53,102,126,142`

- [ ] **Step 1: `tasks.db.ts`**

`:101` 的 INSERT 列清单里把 `auto_approve` 换成 `permission_mode`，值取 `row.permission_mode ?? 'default'`。
`:188` 的 update 白名单：

```ts
    if (updates.permissionMode !== undefined) { sets.push('permission_mode = ?'); params.push(updates.permissionMode); }
```

- [ ] **Step 2: `scheduled-tasks.db.ts`**

`:54` 的 INSERT 列清单与 `:103` 的字段映射（`auto_approve: (v) => (v ? 1 : 0)`）同步改成 `permission_mode`（字符串直接落库，不做 0/1 转换）。

- [ ] **Step 3: `tasks.service.ts`**

`:103` 的 `autoApprove?: boolean;` 改成：

```ts
  /** Lovdex 权限模式，见 auto-approve-policy.ts 的 normalizePermissionMode。 */
  permissionMode?: string;
```

`:539` / `:547` 的 create 入参同步改名，默认 `'default'`。

- [ ] **Step 4: `tasks.routes.ts` 校验**

`:142` 的 `if (typeof body.autoApprove === 'boolean') updates.autoApprove = body.autoApprove;` 改成**白名单校验**（不能只判类型——任意字符串都会流进 DB 再流进运行时）。归一化后的模式才是落库值，保证库里存的与运行时看到的是同一个：

```ts
      if (typeof body.permissionMode === 'string') {
        const { permissionMode: mode, autoApprove } = normalizePermissionMode(body.permissionMode);
        updates.permissionMode = autoApprove ? AUTO_APPROVE_MODE : mode;
      }
```

`:53` 的 create 分支同样处理（先算一次 `const normalized = normalizePermissionMode(body.permissionMode);` 再取 `normalized.autoApprove ? AUTO_APPROVE_MODE : normalized.permissionMode`）。`:102` 的 `hasFieldUpdates` 列表把 `'autoApprove'` 换成 `'permissionMode'`。

顶部 import `AUTO_APPROVE_MODE, normalizePermissionMode`。

- [ ] **Step 5: 跑相关测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/auto-approve-repository.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/tasks/tests/tasks.service.status.test.ts
```

Expected: 会失败——这些测试用的是 `autoApprove`。把它们改成 `permissionMode` 后重跑，Expected PASS。

- [ ] **Step 6: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | grep -E "error TS" | head -20
```

Expected: 14 个 pre-existing，无新增。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/database/repositories/tasks.db.ts backend/server/modules/database/repositories/scheduled-tasks.db.ts backend/server/modules/tasks/services/tasks.service.ts backend/server/modules/tasks/tasks.routes.ts backend/server/modules/database/tests/auto-approve-repository.test.ts
git commit -m "feat(auto-approve): read and write the task permission mode"
```

---

## Task 7: 两条启动路径改传模式

**Files:**
- Modify: `backend/server/index.js:617-630`
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`（dispatch 的 createTask 调用，约 `:243-260`）
- Modify: `backend/server/modules/scheduler/services/scheduled-task-db-like.ts`（若有 `auto_approve` 字段）

- [ ] **Step 1: `index.js` 的 `startTaskRun`**

把：

```js
        // 任务级开关，服务端直读 DB —— 两条启动路径（定时任务、助手
        // start_task_execution）都经这里，签名不变。
        autoApprove: task?.auto_approve === 1,
```

改成：

```js
        // 任务级权限模式，服务端直读 DB —— 两条启动路径（定时任务、助手
        // start_task_execution）都经这里，签名不变。归一化在
        // headless-task-run.service.ts 里做。
        permissionMode: task?.permission_mode ?? 'default',
```

- [ ] **Step 2: scheduler 派发镜像**

`dispatch()` 里 createTask 的入参，把 `autoApprove: schedule.auto_approve === 1` 换成 `permissionMode: schedule.permission_mode ?? 'default'`。同一文件里若有读 `auto_approve` 的地方一并改。

- [ ] **Step 3: 全仓确认后端再无 `auto_approve` 读取点**

```bash
cd /mnt/b/workdir/github/lovdex
grep -rn "auto_approve" backend/server --include=*.ts --include=*.js | grep -v node_modules | grep -v "migrations.ts\|schema.ts\|tests/"
```

Expected: 只剩 `migrations.ts` 的回填 SQL、`schema.ts` 的遗留列定义、以及测试里的老库模拟。**任何业务代码里还有 `auto_approve` 都是漏网。**

- [ ] **Step 4: 跑 scheduler 测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/scheduler/tests/scheduler.service.test.ts
```

Expected: 需把断言里的 `autoApprove` 改成 `permissionMode` 后 PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js backend/server/modules/scheduler/services/scheduler.service.ts backend/server/modules/scheduler/services/scheduled-task-db-like.ts backend/server/modules/scheduler/tests/scheduler.service.test.ts
git commit -m "feat(auto-approve): hand the task permission mode to both run paths"
```

---

## Task 8: 前端类型与测试夹具改名

**Files:**
- Modify: `web/src/types/app.ts:127,179`
- Modify: 约 18 个测试夹具文件

- [ ] **Step 1: 类型改名**

`web/src/types/app.ts` 里 `Task`（`:127`）与 `ScheduledTask`（`:179`）的：

```ts
  auto_approve: number; // 0 | 1
```

改成：

```ts
  /** Lovdex 权限模式（'default' | 'autoApprove' | …），见 auto-approve-policy.ts。 */
  permission_mode: string;
```

- [ ] **Step 2: 让编译器把所有夹具逼出来**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | grep -E "error TS" | sed 's/(.*//' | sort -u
```

Expected: 一批 `auto_approve` 缺失/多余的报错，横跨约 18 个文件。**逐个按报错修**，比手工搜可靠。

- [ ] **Step 3: 批量替换**

对每个报错文件，把夹具里的 `auto_approve: 0` 换成 `permission_mode: 'default'`，`auto_approve: 1` 换成 `permission_mode: 'autoApprove'`。涉及（以 typecheck 实际输出为准）：`lastRunTarget.test.ts`、`runHistoryDelete.test.ts`、`ScheduledRunHistoryView.test.tsx`、`taskTable.test.ts`、`taskStatus.test.ts`、`TaskTableView.test.tsx`、`taskTimestamp.test.ts`、`taskInbox.test.ts`、`taskFilter.test.ts`、`TaskInboxPanel.test.tsx`、`ScheduledTaskDetail.test.tsx`、`ScheduledTasksView.test.tsx`、`scheduleRunNow.test.ts`、`ScheduledTaskForm.test.tsx`、`taskActions.test.ts`、`TaskCard.test.tsx`、`useLinkedTask.test.ts`、`scheduleLabel.test.ts`。

- [ ] **Step 4: typecheck 归零**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -5
```

Expected: 0 errors。**这一步的完成标准是零报错，不是「大致改完」。**

- [ ] **Step 5: 跑全量前端测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | grep -v anchorPlacement | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: 0 fail（数量可能因夹具改名而略变）。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/types/app.ts
git add web/src/components/tasks/*.test.ts web/src/components/tasks/*.test.tsx web/src/hooks/useLinkedTask.test.ts web/src/utils/scheduleLabel.test.ts
git commit -m "refactor(auto-approve): rename the task flag to permission_mode across fixtures"
```

---

## Task 9: 模式解析纯函数 `resolvePermissionMode`

**Files:**
- Create: `web/src/components/chat/utils/resolvePermissionMode.ts`
- Test: `web/src/components/chat/utils/resolvePermissionMode.test.ts`

- [ ] **Step 1: 写失败的测试**

新建 `resolvePermissionMode.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePermissionMode } from './resolvePermissionMode';

const VALID = ['default', 'auto', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'] as const;

const base = {
  sessionMode: null,
  taskMode: null,
  providerLastMode: null,
  providerDefault: 'default',
  validModes: VALID,
} as const;

test('the session choice outranks everything', () => {
  assert.equal(
    resolvePermissionMode({ ...base, sessionMode: 'default', taskMode: 'autoApprove', providerLastMode: 'plan' }),
    'default',
  );
});

test('a task mode outranks the provider-level memory', () => {
  assert.equal(
    resolvePermissionMode({ ...base, taskMode: 'autoApprove', providerLastMode: 'plan' }),
    'autoApprove',
  );
});

test('without a session or task, the provider memory is used', () => {
  assert.equal(resolvePermissionMode({ ...base, providerLastMode: 'plan' }), 'plan');
});

test('with nothing set, the provider default wins', () => {
  assert.equal(resolvePermissionMode(base), 'default');
});

test('an invalid candidate is skipped, not returned', () => {
  // sessionMode 来自 localStorage，可能是别的 provider 留下的值。
  assert.equal(
    resolvePermissionMode({ ...base, sessionMode: 'garbage', taskMode: 'autoApprove' }),
    'autoApprove',
  );
  assert.equal(
    resolvePermissionMode({ ...base, sessionMode: '', taskMode: null, providerLastMode: 'dontAsk' }),
    'default',
  );
});

test('null and undefined candidates never win', () => {
  assert.equal(resolvePermissionMode({ ...base, sessionMode: undefined, taskMode: undefined }), 'default');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/resolvePermissionMode.test.ts
```

Expected: FAIL —— `Cannot find module './resolvePermissionMode'`。

- [ ] **Step 3: 写实现**

新建 `web/src/components/chat/utils/resolvePermissionMode.ts`：

```ts
/**
 * Which permission mode a send should actually use.
 *
 * Order: the session's own choice, then the linked task's, then the provider's
 * last-used memory, then the provider default.
 *
 * The task sitting above the provider memory is what makes "follow the task"
 * work: opening a task session starts in the task's mode. It is a *starting
 * point*, not a lock — the moment the user cycles the mode, the choice lands in
 * the session key and outranks the task for good.
 *
 * Pure: no localStorage, no React. Callers own the storage reads, so both the
 * composer and the task board's run button can share one definition of "this
 * session's mode".
 */
export function resolvePermissionMode(input: {
  sessionMode: string | null | undefined;
  taskMode: string | null | undefined;
  providerLastMode: string | null | undefined;
  providerDefault: string;
  validModes: readonly string[];
}): string {
  const { sessionMode, taskMode, providerLastMode, providerDefault, validModes } = input;
  const candidates = [sessionMode, taskMode, providerLastMode, providerDefault];
  const found = candidates.find(
    (mode): mode is string => typeof mode === 'string' && validModes.includes(mode),
  );
  // providerDefault 也可能不在 validModes 里（能力表拉到的列表变了），
  // 那种情况下退回字面量 'default'，与后端的归一化兜底同向。
  return found ?? 'default';
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/resolvePermissionMode.test.ts
```

Expected: PASS，`# pass 6`，`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/utils/resolvePermissionMode.ts web/src/components/chat/utils/resolvePermissionMode.test.ts
git commit -m "feat(auto-approve): one resolver for a session's permission mode"
```

---

## Task 10: composer 接入统一解析

**Files:**
- Modify: `web/src/components/chat/hooks/useChatProviderState.ts`（`:93` 附近的 args、`:602-616` 的回退链）
- Modify: `web/src/components/chat/types/types.ts:147` 一带（`ChatInterfaceProps`）
- Modify: `web/src/components/chat/view/ChatInterface.tsx:44` 一带
- Modify: `web/src/components/main-content/view/MainContent.tsx:188` 一带

- [ ] **Step 1: 透传任务的模式**

沿用既有 `linkedTaskModel` 的三段式管道：

`types.ts`（`ChatInterfaceProps`，`linkedTaskModel` 之后）：

```ts
  /** The linked task's `permission_mode`. `undefined` when there is no linked
   *  task — the composer then falls back to the provider's memory/default. */
  linkedTaskPermissionMode?: string | null;
```

`MainContent.tsx:188` 一带：

```tsx
                  linkedTaskPermissionMode={linkedTask ? linkedTask.permission_mode : undefined}
```

`ChatInterface.tsx` 解构处加 `linkedTaskPermissionMode,`，并把它传给 `useChatProviderState({...})`。

- [ ] **Step 2: hook 接收**

`useChatProviderState.ts:93` 一带的 `UseChatProviderStateArgs` 加 `linkedTaskPermissionMode?: string | null;`，hook 解构参数同步加。

- [ ] **Step 3: 回退链改用解析函数**

把 `:602-616` 的 `useEffect` 主体改成：

```ts
  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    // 会话键 → 任务 → provider 记忆 → provider 默认。任务那一档让「打开任务
    // 会话就跟随任务的模式」成立；用户一旦手动切过，会话键就永久压过它。
    setPermissionMode(
      resolvePermissionMode({
        sessionMode: selectedSession?.id
          ? localStorage.getItem(`permissionMode-${selectedSession.id}`)
          : null,
        taskMode: linkedTaskPermissionMode,
        providerLastMode: localStorage.getItem(`permissionMode-last-${provider}`),
        providerDefault: getDefaultPermissionModeForProvider(provider),
        validModes,
      }) as PermissionMode,
    );
  }, [selectedSession?.id, provider, linkedTaskPermissionMode, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);
```

保留原来那段解释 `permissionMode-last-${provider}` 存在理由的注释（「brand-new chat 还没有 session id」）。

- [ ] **Step 4: 跑测试 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/hooks/useChatProviderState.test.ts
npm run typecheck 2>&1 | tail -5
```

Expected: PASS；0 errors。`useChatProviderState.test.ts` 里已有 `linkedTaskModel` 的用例，照它的形状补 `linkedTaskPermissionMode` 的用例（任务模式生效 / 会话键压过任务）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/hooks/useChatProviderState.ts web/src/components/chat/hooks/useChatProviderState.test.ts web/src/components/chat/types/types.ts web/src/components/chat/view/ChatInterface.tsx web/src/components/main-content/view/MainContent.tsx
git commit -m "feat(auto-approve): the composer follows the linked task's mode"
```

---

## Task 11: 任务板「执行 / 重试」走同一条解析

**Files:**
- Modify: `web/src/components/tasks/taskExecution.ts:102-123`
- Test: `web/src/components/tasks/taskExecution.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `taskExecution.test.ts` 追加：

```ts
test('a task with the auto-approve mode runs in that mode', () => {
  const task = mkTask({ permission_mode: 'autoApprove' });
  assert.equal(buildTaskChatSend('s1', task).options.permissionMode, 'autoApprove');
});

test('a task with any other mode runs in that mode', () => {
  assert.equal(buildTaskChatSend('s1', mkTask({ permission_mode: 'acceptEdits' })).options.permissionMode, 'acceptEdits');
});

test('the session choice overrides the task', () => {
  // 用户在这个会话里手动切过模式 —— 点重试不该把自动审批偷偷开回来。
  safeLocalStorage.setItem('permissionMode-s1', 'default');
  assert.equal(buildTaskChatSend('s1', mkTask({ permission_mode: 'autoApprove' })).options.permissionMode, 'default');
  safeLocalStorage.removeItem('permissionMode-s1');
});

test('a missing task mode falls back to default', () => {
  const task = mkTask({});
  delete (task as Record<string, unknown>).permission_mode;
  assert.equal(buildTaskChatSend('s1', task).options.permissionMode, 'default');
});
```

（`mkTask` 用文件里既有的夹具构造器；`safeLocalStorage` 从 `../chat/utils/chatStorage` 引入。若该文件当前没有夹具构造器，直接内联一个最小的 `Task` 对象字面量。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskExecution.test.ts
```

Expected: FAIL —— 今天写死 `permissionMode: 'default'`。

- [ ] **Step 3: 改 `buildTaskChatSend`**

把 `options` 里的 `permissionMode: 'default',` 换成：

```ts
      // 走与 composer 相同的解析：会话键 → 任务 → default。任务运行不关心
      // provider 的交互偏好，所以后两档传 null / 'default'。
      permissionMode: resolvePermissionMode({
        sessionMode: safeLocalStorage.getItem(`permissionMode-${sessionId}`),
        taskMode: task.permission_mode,
        providerLastMode: null,
        providerDefault: 'default',
        validModes: TASK_RUN_PERMISSION_MODES,
      }),
```

文件顶部：

```ts
import { resolvePermissionMode } from '../chat/utils/resolvePermissionMode';

/**
 * 任务运行时允许的模式。**刻意不含 `plan`**：无人值守下 plan 只产出计划、
 * 不执行任何工具，任务会永远空跑，而你要到第二天看历史才发现。这不是
 * 「多一个选项」，是一个静默失败。
 */
export const TASK_RUN_PERMISSION_MODES = [
  'default',
  'autoApprove',
  'acceptEdits',
  'bypassPermissions',
] as const;
```

同时更新 `buildTaskChatSend` 的 JSDoc——现在写的是「Permission mode is the default (ask)」，已经不对了。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskExecution.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/taskExecution.ts web/src/components/tasks/taskExecution.test.ts
git commit -m "feat(auto-approve): the task run button shares the session's mode"
```

---

## Task 12: 定时任务表单 —— 布尔开关换模式选择器

**Files:**
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx:41,65,114-116,169,522-536`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx:303-321`

- [ ] **Step 1: 改测试**

把 `ScheduledTaskForm.test.tsx` 里三个 `autoApprove` 用例改成 `permissionMode`：

```tsx
test('EMPTY_DRAFT defaults the permission mode to default', () => {
  assert.equal(EMPTY_DRAFT.permissionMode, 'default');
});

test('toApiBody sends the permission mode', () => {
  assert.equal(toApiBody({ ...EMPTY_DRAFT, permissionMode: 'autoApprove' }).permissionMode, 'autoApprove');
});

test('toDraft reads the stored permission mode', () => {
  assert.equal(toDraft(mkScheduledTask({ permission_mode: 'autoApprove' }) as never).permissionMode, 'autoApprove');
});

test('toDraft treats a missing permission mode as default', () => {
  const withoutFlag = mkScheduledTask({ permission_mode: 'default' }) as Record<string, unknown>;
  delete withoutFlag.permission_mode;
  assert.equal(toDraft(withoutFlag as never).permissionMode, 'default');
});

test('plan is not offered for an unattended run', () => {
  // plan 只规划不执行 —— 定时任务选它等于永远空跑。
  assert.equal(TASK_RUN_PERMISSION_MODES.includes('plan' as never), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 改表单**

- `ScheduledTaskDraft.autoApprove: boolean`（`:41`）→ `permissionMode: string`
- `EMPTY_DRAFT`（`:65`）→ `permissionMode: 'default'`
- `toApiBody`（`:114-116`）→ `permissionMode: d.permissionMode`（删掉那段解释「后端用 body.autoApprove === true 判定」的注释——不再适用）
- `toDraft`（`:169`）→ `permissionMode: initial.permission_mode ?? 'default'`
- `:522-536` 的开关按钮 → 一个 `ChipSelect`（该文件 `:375-385` 的「引擎」就是现成样板），形状如下：

```tsx
          <ChipSelect
            ariaLabel="权限"
            label="权限"
            options={PERMISSION_MODE_OPTIONS}
            value={draft.permissionMode}
            isMobile={isMobile}
            onChange={(v) => set('permissionMode', v)}
          />
```

`PERMISSION_MODE_OPTIONS` 在文件顶部由 `TASK_RUN_PERMISSION_MODES` 派生：

```tsx
const PERMISSION_MODE_OPTIONS = TASK_RUN_PERMISSION_MODES.map((mode) => ({
  value: mode,
  // 说明后果，不只写名字：选它意味着无人值守时不再问你。
  label:
    mode === AUTO_APPROVE_MODE
      ? '自动审批（无人值守时自动放行工具调用，危险操作仍会拒绝）'
      : t(getPermissionModeLabelKeys(mode).fullKey),
}));
```

（若 `t` 不在模块作用域内，就把这段放进组件里用 `useMemo`。`TASK_RUN_PERMISSION_MODES` 从 `taskExecution.ts` 引入，`AUTO_APPROVE_MODE` 从 `../chat/types/types` 引入。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
npm run typecheck 2>&1 | tail -5
```

Expected: PASS；0 errors。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(auto-approve): pick the permission mode when scheduling a task"
```

---

## Task 13: 任务新建对话框

**Files:**
- Modify: `web/src/components/tasks/CreateTaskDialog.tsx:57,174,284-300`

- [ ] **Step 1: 改控件**

- `const [autoApprove, setAutoApprove] = useState(false);`（`:57`）→ `const [permissionMode, setPermissionMode] = useState('default');`
- payload（`:174`）→ `permissionMode,`
- `:284-300` 的开关按钮 → 与 Task 12 相同的模式选择控件，选项同样来自 `TASK_RUN_PERMISSION_MODES`。

- [ ] **Step 2: typecheck + 测试**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -5
env -u TSX_TSCONFIG_PATH npx tsx --test $(find src/components/tasks -name "*.test.tsx" -o -name "*.test.ts" | grep -v anchorPlacement | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: 0 errors；0 fail。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/CreateTaskDialog.tsx
git commit -m "feat(auto-approve): pick the permission mode when creating a task"
```

---

## Task 14: 任务详情内联编辑

**Files:**
- Modify: `web/src/components/tasks/TaskDetail.tsx:64,90,340-346,750-765`

- [ ] **Step 1: 改状态与保存**

- `:64` `const [autoApprove, setAutoApprove] = useState(false);` → `const [permissionMode, setPermissionMode] = useState('default');`
- `:90` `setAutoApprove(data.auto_approve === 1);` → `setPermissionMode(data.permission_mode ?? 'default');`
- `:340-346` 的 `saveAutoApprove` → `savePermissionMode(next: string)`，调 `api.tasks.update(task.task_id, { permissionMode: next })`，错误日志同步改名。

- [ ] **Step 2: 改控件**

`:750-765` 的开关 → 与 Task 12 相同的模式选择控件，挨着「执行引擎 / 模型」那几处既有套路。

- [ ] **Step 3: typecheck + 测试**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -5
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskDetail.test.tsx
```

Expected: 0 errors；PASS。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskDetail.tsx
git commit -m "feat(auto-approve): edit the task permission mode in place"
```

---

## Task 15: 徽标改读模式

**Files:**
- Modify: `web/src/components/tasks/scheduledTaskPresentation.tsx:27`
- Test: `web/src/components/tasks/ScheduledTasksView.test.tsx:129-136`

- [ ] **Step 1: 改测试**

```tsx
test('a scheduled task in the auto-approve mode shows an auto-approval badge', () => {
  const html = render([{ ...baseTask, schedule_id: 's1', permission_mode: 'autoApprove' }]);
  assert.match(html, /自动审批/);
});

test('a scheduled task in any other mode shows no auto-approval badge', () => {
  const html = render([{ ...baseTask, schedule_id: 's1', permission_mode: 'default' }]);
  assert.doesNotMatch(html, /自动审批/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 改徽标**

`scheduledTaskPresentation.tsx:27` 的 `if (task.auto_approve !== 1) return null;` 改成 `if (task.permission_mode !== AUTO_APPROVE_MODE) return null;`，import 常量（前端若要避免跨包引用后端模块，就在 `web/src/components/chat/types/types.ts` 旁导出同名常量并在注释里注明与后端 `auto-approve-policy.ts` 的 `AUTO_APPROVE_MODE` 必须一致）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/scheduledTaskPresentation.tsx web/src/components/tasks/ScheduledTasksView.test.tsx
git commit -m "feat(auto-approve): badge the task by its permission mode"
```

---

## Task 16: 全量回归

**Files:** 无改动。

- [ ] **Step 1: 后端**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm run typecheck 2>&1 | grep -cE "error TS"
npm run lint 2>&1 | tail -3
npx tsx --tsconfig server/tsconfig.json --test $(find server -name "*.test.ts" | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: typecheck 14（pre-existing）；lint 47 errors（pre-existing）；测试 0 fail。

- [ ] **Step 2: 前端**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -3
npm run lint 2>&1 | tail -3
env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name "*.test.ts" -o -name "*.test.tsx" | grep -v anchorPlacement | tr '\n' ' ') 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: typecheck 0 errors；测试 0 fail。

- [ ] **Step 3: 确认全仓再无 `auto_approve` 业务引用**

```bash
cd /mnt/b/workdir/github/lovdex
grep -rn "auto_approve" backend/server web/src --include=*.ts --include=*.tsx --include=*.js | grep -v node_modules | grep -v "migrations.ts\|schema.ts\|auto-approve-migration.test.ts"
```

Expected: 无输出。

---

## Task 17: 端到端手工验证

**Files:** 无改动。

> ⚠️ **需要用户明确许可**：后端改动要生效必须重启后端进程。本项目规定**每一次**重启都要单独取得用户许可。不要自行重启。用户说「已重启」就直接往下走。

- [ ] **Step 1: 确认服务在跑**

```bash
ss -ltnp 2>/dev/null | grep -E ':(3188|5188)'
```

Expected: 两个端口都在监听。缺哪个就告诉用户，不要自行拉起。

- [ ] **Step 2: 迁移回填**

重启后检查一个原本开着自动审批的任务：

```bash
cd /mnt/b/workdir/github/lovdex/backend
node -e "const D=require('better-sqlite3');const p=require('os').homedir()+'/.lovdex/data/new-auth.db';const db=new D(p,{readonly:true});console.log(db.prepare('SELECT task_id,auto_approve,permission_mode FROM tasks ORDER BY created_at DESC LIMIT 5').all())"
```

Expected: 原本 `auto_approve=1` 的行现在是 `permission_mode='autoApprove'`；其余是 `'default'`。

- [ ] **Step 3: 关掉自动审批（本次改动的起点）**

打开一个原本开着自动审批的任务会话：

1. composer 的模式按钮应显示 **「Auto Approve」**（warning 色）。
2. 点一下切到下一个模式（`Accept Edits`）→ 再发一条会触发工具调用的消息。
3. Expected: 出现权限确认弹窗，**而不是** `AutoApproveNotice` 的「已自动放行 …」。
4. 刷新页面 → 模式**仍是** `Accept Edits`（会话键持久化）。
5. 点「重试」→ Expected: **不**自动批（会话键压过任务）。

- [ ] **Step 4: 任务侧跟随**

回到任务详情，确认任务的模式**仍是 Auto Approve**（会话里的切换没有写回任务）。新建一个会话跑一次任务（或等定时派发）→ Expected: 新会话跟随任务，模式是 Auto Approve，全程无弹窗。

- [ ] **Step 5: 记录结果**

把观察到的现象记进本文件末尾（或直接向用户汇报）。若第 3 步的弹窗没出现，**不要**标记完成——先按 systematic-debugging 定位。

---

## 完成标准

- [ ] 全仓业务代码里搜不到 `auto_approve`（只剩 schema 遗留列、迁移回填 SQL、老库模拟测试）。
- [ ] `normalizePermissionMode('autoApprove')` 产出 `{permissionMode:'default', autoApprove:true}`，且**未知值一律落 default**。
- [ ] 四个 provider 运行时**一行未改**（`claude-sdk.js` / `qoder-runner.js` / `openai-codex.js` / `opencode-runner.js` 的 diff 为空）。
- [ ] 迁移回填**幂等**：连跑两次不改变用户手动设成 `default` 的行。
- [ ] 模式解析四档优先级有测试；`plan` 不在任务可选集合里。
- [ ] composer 里能关掉自动审批，刷新后仍关着；任务行的模式不被写回。
- [ ] 定时 / 助手 headless 行为与回填前等价。
- [ ] backend / web 的 typecheck 与 lint **零新增**。
