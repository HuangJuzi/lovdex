# 自动审批模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给任务加一个 `auto_approve` 开关，打开后无人值守执行时工具调用自动放行、危险操作自动拒绝，不再需要人工确认。

**Architecture:** 开关是**任务属性**（`tasks.auto_approve` 为唯一权威来源，定时任务派发时从 `scheduled_tasks.auto_approve` 镜像过来）。运行时把 `autoApprove` 放进 `runtimeOptions`，各 provider runner 在自己的权限决策点、**「询问人类」那一步之前**短路，调用一个纯函数策略模块 `decideAutoApproval` 得到 allow/deny。**不使用 `bypassPermissions`**——那个模式下 SDK 根本不调用 `canUseTool`，拦不住危险操作，还会让 classifier 替交互型工具编答案。

**Tech Stack:** Node.js + TypeScript（backend 用 `node:test` + `tsx`）、better-sqlite3、React（web 用 `node:test` + `renderToStaticMarkup`，无 DOM）。

**Spec:** `docs/superpowers/specs/2026-09-21-auto-approve-design.md`

---

## 通用约定（每个 Task 都适用）

**后端测试命令**（`backend/package.json` 没有 `test` 脚本，必须直接调 tsx）：

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/<module>/tests/<file>.test.ts
```

**前端测试命令**：

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/<file>.test.tsx
```

**提交信息**：英文，**禁止加 `Co-Authored-By` 署名行**。

**基线不干净**：backend 有 pre-existing 的 typecheck 错误和 lint 警告。验收标准是「零新增」，不是「全绿」。跑 lint/typecheck 前先确认改动前后数量一致。

**测试用 fixture 与生产隔离**：任何碰 DB 的测试必须显式设 `DATABASE_PATH` 指向临时目录。`connection.ts` 的隔离条件是 `NODE_TEST_CONTEXT && DATABASE_PATH` **两个都要**——`node --test` 只设前者，不设后者会打到**正在运行的生产库**。本计划的迁移测试已内联这段隔离逻辑，照抄即可。

---

## 文件结构

**新增：**

| 文件 | 职责 |
|---|---|
| `backend/server/modules/permissions/auto-approve-policy.ts` | 纯函数策略：`decideAutoApproval(toolName, input)` + `TOOLS_REQUIRING_INTERACTION` |
| `backend/server/modules/permissions/tests/auto-approve-policy.test.ts` | 策略表驱动单测 |
| `backend/server/modules/database/tests/auto-approve-migration.test.ts` | 两张表加列的迁移测试 |
| `backend/server/modules/database/tests/auto-approve-repository.test.ts` | `tasksDb` 读写 `auto_approve` 的仓储测试 |
| `web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx` | 会话里那行「已自动放行 / 已自动拒绝」提示 |

**修改（后端）：**

| 文件 | 改动 |
|---|---|
| `backend/server/modules/database/schema.ts` | 两张表加 `auto_approve` 列 |
| `backend/server/modules/database/migrations.ts` | 两处 `addColumnToTableIfNotExists` |
| `backend/server/modules/database/repositories/tasks.db.ts` | `createTask` / `updateTask` 支持 `autoApprove` |
| `backend/server/modules/database/repositories/scheduled-tasks.db.ts` | `createScheduledTask` / `updateScheduledTask` 支持 `autoApprove` |
| `backend/server/shared/types.ts` | `TaskRow` / `ScheduledTaskRow` 加字段；`MessageKind` 加 `permission_auto` |
| `backend/server/modules/tasks/services/tasks.service.ts` | `CreateTaskInput` + `createTask` + `updateTask` |
| `backend/server/modules/tasks/tasks.routes.ts` | create / update 两条路由的字段映射 |
| `backend/server/modules/scheduler/services/scheduler.service.ts` | create 校验 + update keyMap + dispatch 镜像 |
| `backend/server/modules/websocket/services/headless-task-run.service.ts` | `HeadlessTaskRunOptions.autoApprove` → `runtimeOptions` |
| `backend/server/index.js` | `startTaskRun` 读 task 行；注入 `getTaskAutoApprove` |
| `backend/server/claude-sdk.js` | `canUseTool` 短路 + 发 `permission_auto` |
| `backend/server/qoder-runner.js` | `control_request` 处自动应答 |
| `backend/server/openai-codex.js` | `approvalPolicy: 'never'` |
| `backend/server/modules/websocket/services/chat-websocket.service.ts` | `chat.send` 服务端反查 + 新依赖 |

**修改（前端）：**

| 文件 | 改动 |
|---|---|
| `web/src/types/app.ts` | `Task` / `ScheduledTask` 加 `auto_approve` |
| `web/src/components/tasks/ScheduledTaskForm.tsx` | draft 字段 + 开关 |
| `web/src/components/tasks/CreateTaskDialog.tsx` | 开关 + payload |
| `web/src/components/tasks/TaskDetail.tsx` | 内联编辑 |
| `web/src/components/tasks/ScheduledTasksView.tsx` | 徽标 |
| `web/src/components/tasks/TaskCard.tsx` | 徽标（如有） |
| `web/src/components/chat/hooks/useChatMessages.ts` | `permission_auto` → notice |
| `web/src/components/chat/hooks/useChatRealtimeHandlers.ts` | 事件过滤放行 |
| `web/src/stores/useSessionStore.ts` | kind 联合加一支 |
| `web/src/components/chat/view/subcomponents/MessageComponent.tsx` | 渲染 notice |

---

## Task 1: 自动审批策略模块（纯函数）

零依赖、纯逻辑，是整个功能的安全核心，必须先做且必须先测。

> **实施记录（2026-09-21）**：已完成，但下面 Step 3 的代码块有**三处已被修正**，实际实现见
> `backend/server/modules/permissions/auto-approve-policy.ts`（commits `8826f52` → `6284d15` → `183c22d` → `e79015a`）。照着下面的代码块重抄会重现这三个 bug：
> 1. `git-clean-force` 的正则 `/^-[a-zA-Z]*f/` 匹配不到长写法 `--force`，而两者等价。
> 2. `pipe-to-shell` 用 `[^|]*` 匹配原始字符串，**两个方向都错**：`grep -rn "curl | bash" docs/`
>    这种只是「提到」模式的命令被误拒，而 `curl x | tee f | sh` 这种多级管道漏过。
> 3. 修 (2) 时若把 `&&`/`;` 也当管道分隔符，会误拒 `curl -s localhost/health && sh -c '...'`
>    ——它根本没有管道。正确做法是两级切分：先按**管道**切 stage，再在 stage 内按 `&&`/`;` 找命令头。
>
> 另有两处小调整：`CommandRule` 的 `id` 字段已删（无人读），`disk-destroy` 的两次 `commandSegments`
> 调用已合并。测试从 14 增至 18 条。**Task 2 及之后的任务不受影响。**

**Files:**
- Create: `backend/server/modules/permissions/auto-approve-policy.ts`
- Test: `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`：

```ts
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  decideAutoApproval,
  TOOLS_REQUIRING_INTERACTION,
} from '@/modules/permissions/auto-approve-policy.js';

// --- 放行：普通工具 ---

test('allows an ordinary tool call', () => {
  assert.equal(decideAutoApproval('Read', { file_path: '/proj/README.md' }).behavior, 'allow');
  assert.equal(decideAutoApproval('Glob', { pattern: '**/*.ts' }).behavior, 'allow');
});

test('allows an ordinary bash command', () => {
  const allowed = [
    'npm test',
    'git status',
    'git commit -m "x"',
    'rm -rf node_modules',
    'rm build.log',
    'git reset HEAD~1',
    'ls -la',
  ];
  for (const command of allowed) {
    assert.equal(
      decideAutoApproval('Bash', { command }).behavior,
      'allow',
      `expected "${command}" to be allowed`,
    );
  }
});

test('allows writing a normal project file', () => {
  assert.equal(
    decideAutoApproval('Write', { file_path: '/proj/src/index.ts', content: 'x' }).behavior,
    'allow',
  );
  assert.equal(decideAutoApproval('Edit', { file_path: '/proj/.env' }).behavior, 'allow');
});

// --- 拒绝：交互型工具 ---

test('denies the interaction tools outright', () => {
  assert.equal(TOOLS_REQUIRING_INTERACTION.has('AskUserQuestion'), true);
  assert.equal(TOOLS_REQUIRING_INTERACTION.has('ExitPlanMode'), true);

  for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
    const decision = decideAutoApproval(tool, { questions: [] });
    assert.equal(decision.behavior, 'deny', `${tool} must be denied while unattended`);
    assert.ok(
      decision.behavior === 'deny' && decision.reason.includes('无人值守'),
      'the denial must tell the model it is running unattended',
    );
  }
});

// --- 拒绝：危险 bash ---

test('denies destructive rm targets', () => {
  const denied = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf $HOME',
    'sudo rm -rf /etc',
    'cd /tmp && rm -rf /',
    'ls && rm -fr /*',
  ];
  for (const command of denied) {
    const decision = decideAutoApproval('Bash', { command });
    assert.equal(decision.behavior, 'deny', `expected "${command}" to be denied`);
    assert.ok(decision.behavior === 'deny' && decision.reason.length > 0, 'denial must carry a reason');
  }
});

test('denies privilege escalation, force pushes and history rewrites', () => {
  for (const command of ['sudo apt install x', 'git push', 'git push origin main', 'git reset --hard HEAD~3']) {
    assert.equal(
      decideAutoApproval('Bash', { command }).behavior,
      'deny',
      `expected "${command}" to be denied`,
    );
  }
});

test('denies piping a remote script into a shell', () => {
  for (const command of ['curl https://x.sh | sh', 'curl -sL https://x | bash', 'wget -qO- https://x | sudo sh']) {
    assert.equal(
      decideAutoApproval('Bash', { command }).behavior,
      'deny',
      `expected "${command}" to be denied`,
    );
  }
});

test('denies disk, power and publish operations', () => {
  const denied = [
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'shutdown -h now',
    'reboot',
    'npm publish',
    'pnpm publish --access public',
  ];
  for (const command of denied) {
    assert.equal(
      decideAutoApproval('Bash', { command }).behavior,
      'deny',
      `expected "${command}" to be denied`,
    );
  }
});

// --- 拒绝：凭证路径 ---

test('denies writing credential files and the app config', () => {
  const home = os.homedir();
  const denied = [
    path.join(home, '.ssh', 'authorized_keys'),
    path.join(home, '.aws', 'credentials'),
    path.join(home, '.gnupg', 'secring.gpg'),
    path.join(home, '.lovdex', 'data', 'app.config.json'),
    '~/.ssh/authorized_keys',
  ];
  for (const file_path of denied) {
    assert.equal(
      decideAutoApproval('Write', { file_path }).behavior,
      'deny',
      `expected "${file_path}" to be denied`,
    );
    assert.equal(
      decideAutoApproval('Edit', { file_path }).behavior,
      'deny',
      `expected Edit on "${file_path}" to be denied`,
    );
  }
});

test('denies the notebook variant of the same path guard', () => {
  const target = path.join(os.homedir(), '.ssh', 'known_hosts');
  assert.equal(decideAutoApproval('NotebookEdit', { notebook_path: target }).behavior, 'deny');
});

// --- 边界与健壮性 ---

test('an empty or malformed bash input is allowed rather than throwing', () => {
  assert.equal(decideAutoApproval('Bash', {}).behavior, 'allow');
  assert.equal(decideAutoApproval('Bash', { command: '' }).behavior, 'allow');
  assert.equal(decideAutoApproval('Bash', undefined).behavior, 'allow');
  assert.equal(decideAutoApproval('Bash', { command: '   ' }).behavior, 'allow');
});

test('a malformed file path is allowed rather than throwing', () => {
  assert.equal(decideAutoApproval('Write', {}).behavior, 'allow');
  assert.equal(decideAutoApproval('Write', undefined).behavior, 'allow');
});

test('an unknown tool is allowed', () => {
  assert.equal(decideAutoApproval('SomeFutureTool', { anything: 1 }).behavior, 'allow');
});

test('substring matches inside an argument are not treated as commands', () => {
  // `grep sudo notes.txt` 不是提权；误伤会让正常任务无谓失败。
  assert.equal(decideAutoApproval('Bash', { command: 'grep sudo notes.txt' }).behavior, 'allow');
  assert.equal(decideAutoApproval('Bash', { command: 'echo "git push"' }).behavior, 'allow');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: FAIL — `Cannot find module '@/modules/permissions/auto-approve-policy.js'`

- [ ] **Step 3: 写实现**

创建 `backend/server/modules/permissions/auto-approve-policy.ts`：

```ts
import os from 'node:os';
import path from 'node:path';

/**
 * Auto-approval policy for unattended task runs.
 *
 * When a task has `auto_approve = 1`, the provider runtimes answer their own
 * permission requests instead of asking the human: they call
 * `decideAutoApproval` right in front of the "ask" step. See
 * docs/superpowers/specs/2026-09-21-auto-approve-design.md.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It stops an agent from casually doing
 * something destructive while nobody is watching. A determined agent walks
 * around every rule below (re-encoding a command, variable expansion, running
 * the same thing through an interpreter). Do not treat it as a sandbox, and do
 * not rely on it to make an untrusted prompt safe to run unattended.
 */

export type AutoApproveDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string };

/**
 * Tools that need a human on the other end. `claude-sdk.js` registers these with
 * `timeoutMs: 0` (wait forever), so under auto-approval they must be denied
 * rather than waited on — an invented answer on the model's behalf would be
 * worse than telling it to use its own judgement.
 *
 * Defined here rather than in `claude-sdk.js` so the policy module and the
 * runtimes cannot drift apart; `claude-sdk.js` imports it back.
 */
export const TOOLS_REQUIRING_INTERACTION: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

export const UNATTENDED_INTERACTION_DENY_REASON =
  '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。';

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

/**
 * Split a shell command into argument vectors on separators, so a dangerous
 * command hiding behind `cd /tmp && rm -rf /` is still seen. Pipelines are NOT
 * split here — the pipe-to-shell rule matches against the raw string instead.
 */
function commandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** The shell command inside a Bash tool input, tolerating the raw-string shape. */
function bashCommandOf(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input === 'object') {
    const command = (input as { command?: unknown }).command;
    if (typeof command === 'string') return command.trim();
  }
  return '';
}

const ROOT_OR_HOME_TARGETS: ReadonlySet<string> = new Set([
  '/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*',
  '/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/home',
]);

/** `rm` with a recursive/force flag pointed at a root-ish target. */
function hasDestructiveRm(command: string): boolean {
  return commandSegments(command).some((tokens) => {
    if (tokens[0] !== 'rm') return false;
    const args = tokens.slice(1);
    const recursiveOrForce = args
      .filter((arg) => arg.startsWith('-'))
      .some((flag) => /[rRf]/.test(flag.replace(/^--?/, '')));
    if (!recursiveOrForce) return false;
    return args.filter((arg) => !arg.startsWith('-')).some((target) => ROOT_OR_HOME_TARGETS.has(target));
  });
}

type CommandRule = { id: string; reason: string; matches: (command: string) => boolean };

const COMMAND_RULES: readonly CommandRule[] = [
  {
    id: 'rm-destructive-target',
    reason: '拒绝：不允许删除根目录或家目录',
    matches: hasDestructiveRm,
  },
  {
    id: 'sudo',
    reason: '拒绝：不允许在无人值守时提权执行',
    matches: (command) => commandSegments(command).some((tokens) => tokens[0] === 'sudo'),
  },
  {
    id: 'git-push',
    reason: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
    matches: (command) => commandSegments(command).some((tokens) => tokens[0] === 'git' && tokens[1] === 'push'),
  },
  {
    id: 'git-reset-hard',
    reason: '拒绝：git reset --hard 会丢弃未提交的改动',
    matches: (command) =>
      commandSegments(command).some((tokens) => tokens[0] === 'git' && tokens[1] === 'reset' && tokens.includes('--hard')),
  },
  {
    id: 'git-clean-force',
    reason: '拒绝：git clean 带 -f 会丢弃未跟踪文件',
    matches: (command) =>
      commandSegments(command).some(
        (tokens) =>
          tokens[0] === 'git' &&
          tokens[1] === 'clean' &&
          tokens.slice(2).some((arg) => /^-[a-zA-Z]*f/.test(arg)),
      ),
  },
  {
    id: 'pipe-to-shell',
    reason: '拒绝：不允许把远端脚本直接管道进 shell 执行',
    matches: (command) => /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|dash)\b/.test(command),
  },
  {
    id: 'disk-destroy',
    reason: '拒绝：不允许写裸设备或格式化文件系统',
    matches: (command) =>
      commandSegments(command).some((tokens) => tokens[0] === 'mkfs' || tokens[0].startsWith('mkfs.')) ||
      commandSegments(command).some((tokens) => tokens[0] === 'dd' && tokens.some((arg) => arg.startsWith('of=/dev/'))),
  },
  {
    id: 'power',
    reason: '拒绝：不允许关机或重启',
    matches: (command) =>
      commandSegments(command).some((tokens) =>
        ['shutdown', 'reboot', 'halt', 'poweroff'].includes(tokens[0]),
      ),
  },
  {
    id: 'publish',
    reason: '拒绝：不允许发布包到远端仓库（不可逆的外发操作）',
    matches: (command) =>
      commandSegments(command).some(
        (tokens) => ['npm', 'yarn', 'pnpm'].includes(tokens[0]) && tokens[1] === 'publish',
      ),
  },
];

// ---------------------------------------------------------------------------
// File writes
// ---------------------------------------------------------------------------

const FILE_PATH_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/** The target path of a file-writing tool input. */
function filePathOf(input: unknown): string {
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/**
 * Credential directories and Lovdex's own config. The app config is on the list
 * because it holds `AUTH_ENABLED` and the JWT secret — an agent rewriting it can
 * turn the login gate off.
 */
function isSensitivePath(rawPath: string): boolean {
  if (!rawPath) return false;
  const home = os.homedir();
  const expanded =
    rawPath === '~' ? home : rawPath.startsWith('~/') ? path.join(home, rawPath.slice(2)) : rawPath;
  const resolved = path.resolve(expanded);

  const credentialDirs = ['.ssh', '.aws', '.gnupg'].map((dir) => path.join(home, dir));
  if (credentialDirs.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))) {
    return true;
  }
  return resolved === path.join(home, '.lovdex', 'data', 'app.config.json');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide a permission request on the user's behalf during an unattended run.
 *
 * Deliberately NOT on the list: `.env`, `git commit`, ordinary file deletes and
 * `rm -rf node_modules`. Scheduled tasks do those legitimately, and a false
 * denial costs more (a task that fails for no reason the user can see) than the
 * marginal safety it buys. The list errs loose on purpose.
 */
export function decideAutoApproval(toolName: string, input: unknown): AutoApproveDecision {
  if (TOOLS_REQUIRING_INTERACTION.has(toolName)) {
    return { behavior: 'deny', reason: UNATTENDED_INTERACTION_DENY_REASON };
  }

  if (toolName === 'Bash') {
    const command = bashCommandOf(input);
    const hit = COMMAND_RULES.find((rule) => rule.matches(command));
    if (hit) return { behavior: 'deny', reason: hit.reason };
    return { behavior: 'allow' };
  }

  if (FILE_PATH_TOOLS.has(toolName)) {
    const target = filePathOf(input);
    if (isSensitivePath(target)) {
      return { behavior: 'deny', reason: `拒绝：${target} 属于凭证或关键配置路径` };
    }
    return { behavior: 'allow' };
  }

  return { behavior: 'allow' };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: PASS，全部用例通过。若 `grep sudo notes.txt` 那条失败，说明 `sudo` 规则用了子串匹配而不是 segment 头匹配——改回 `tokens[0] === 'sudo'`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/permissions/
git commit -m "feat(permissions): add unattended auto-approval policy module

Pure decision function used by the provider runtimes to answer their own
permission requests during unattended task runs. Denies interaction tools
outright (they would otherwise hang the run forever) and denies a built-in
list of destructive operations; everything else is allowed.

Documented in the module as accident-prevention, not a sandbox."
```

---

## Task 2: 两张表加 `auto_approve` 列

**Files:**
- Modify: `backend/server/modules/database/schema.ts`
- Modify: `backend/server/modules/database/migrations.ts`
- Modify: `backend/server/shared/types.ts`
- Test: `backend/server/modules/database/tests/auto-approve-migration.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/database/tests/auto-approve-migration.test.ts`：

```ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

// Shape of `tasks` BEFORE this change: exactly TASKS_TABLE_SCHEMA_SQL minus the
// auto_approve column. Every rebuild gate inside migrateTasksTable stays silent
// on this shape, so the in-place addColumnToTableIfNotExists ALTER is the only
// mechanism that can add the column — which is the real rollout path for an
// already-upgraded production DB.
const TASKS_WITHOUT_AUTO_APPROVE_DDL = `
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    project_path      TEXT NOT NULL REFERENCES projects(project_path) ON DELETE CASCADE ON UPDATE CASCADE,
    title             TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','in_review','done','archived')),
    executor_provider TEXT NOT NULL DEFAULT 'claude'
                      CHECK (executor_provider IN ('claude','codex','opencode','qoder')),
    executor_model    TEXT,
    position          REAL NOT NULL DEFAULT 0,
    session_id        TEXT,
    started_at        DATETIME,
    completed_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_summary        TEXT,
    sub_status        TEXT CHECK (sub_status IS NULL OR sub_status IN ('failed','done','only_plan','needs_review','blocked','waiting_answer','waiting_plan')),
    verdict_reason    TEXT,
    verdict_at        DATETIME,
    priority          TEXT NOT NULL DEFAULT 'P2'
                      CHECK (priority IN ('P0','P1','P2','P3')),
    deadline          TEXT,
    is_operator       INTEGER DEFAULT 0,
    label             TEXT NOT NULL DEFAULT 'other'
                      CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
    remark            TEXT,
    context_summary   TEXT,
    context_source_session_id TEXT,
    context_mode      TEXT NOT NULL DEFAULT 'none'
                      CHECK (context_mode IN ('none','summary','raw')),
    context_status    TEXT
                      CHECK (context_status IS NULL OR context_status IN ('pending','ready','failed')),
    context_raw       TEXT,
    source_schedule_id TEXT
);
`;

const PROJECTS_DDL = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  custom_project_name TEXT DEFAULT NULL,
  isStarred BOOLEAN DEFAULT 0,
  isArchived BOOLEAN DEFAULT 0
);
`;

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test('a fresh database gets auto_approve on both tasks and scheduled_tasks, defaulting to 0', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-fresh-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  await initializeDatabase();

  try {
    const db = getConnection();
    assert.ok(columnNames(db, 'tasks').includes('auto_approve'), 'tasks.auto_approve must exist');
    assert.ok(
      columnNames(db, 'scheduled_tasks').includes('auto_approve'),
      'scheduled_tasks.auto_approve must exist',
    );

    db.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
    db.prepare('INSERT INTO tasks (task_id, project_path, title, source_schedule_id) VALUES (?, ?, ?, ?)')
      .run('t1', '/tmp/repo', 'task', 's1');
    const row = db.prepare('SELECT auto_approve FROM tasks WHERE task_id = ?').get('t1') as {
      auto_approve: number;
    };
    assert.equal(row.auto_approve, 0, 'a task created without the flag must default to 0 (never auto-approve)');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('auto_approve is added in place to an existing tasks table without dropping its rows', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-tasks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(PROJECTS_DDL);
  legacy.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
  legacy.exec(TASKS_WITHOUT_AUTO_APPROVE_DDL);
  legacy.prepare('INSERT INTO tasks (task_id, project_path, title, remark) VALUES (?, ?, ?, ?)')
    .run('t1', '/tmp/repo', 'legacy task', 'keep me');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    const cols = columnNames(db, 'tasks');
    assert.ok(cols.includes('auto_approve'), 'expected auto_approve to be added in place');
    // ALTER TABLE ADD COLUMN appends at the END. A rename→recreate rebuild would
    // place it per TASKS_TABLE_SCHEMA_SQL instead, so the ordering proves which
    // mechanism ran.
    assert.ok(
      cols.indexOf('source_schedule_id') < cols.indexOf('auto_approve'),
      'expected auto_approve to be appended at the end (in-place ALTER, not a rebuild)',
    );
    const row = db.prepare('SELECT title, remark, auto_approve FROM tasks WHERE task_id = ?').get('t1') as {
      title: string;
      remark: string | null;
      auto_approve: number;
    };
    assert.equal(row.title, 'legacy task', 'the existing row must survive the migration');
    assert.equal(row.remark, 'keep me');
    assert.equal(row.auto_approve, 0, 'pre-existing tasks must default to 0 — the change must not widen them');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('auto_approve is added in place to an existing scheduled_tasks table', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-sched-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE scheduled_tasks (
      schedule_id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      project_path TEXT,
      executor_provider TEXT NOT NULL DEFAULT 'claude',
      executor_model TEXT,
      priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
      label TEXT NOT NULL DEFAULT 'other' CHECK (label IN ('bug','feature','optimization','refactor','docs','other','reminder')),
      is_operator INTEGER DEFAULT 0,
      auto_run INTEGER DEFAULT 1,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once','interval','cron')),
      cron_expr TEXT,
      interval_seconds INTEGER,
      run_at DATETIME,
      timezone TEXT DEFAULT 'local',
      next_run_at DATETIME NOT NULL,
      last_run_at DATETIME,
      last_task_id TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy.prepare(
    'INSERT INTO scheduled_tasks (schedule_id, title, schedule_type, next_run_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'nightly', 'cron', '2026-09-22T01:00:00.000Z');
  legacy.close();

  await initializeDatabase();

  try {
    const db = getConnection();
    assert.ok(columnNames(db, 'scheduled_tasks').includes('auto_approve'));
    const row = db.prepare('SELECT title, auto_approve FROM scheduled_tasks WHERE schedule_id = ?').get('s1') as {
      title: string;
      auto_approve: number;
    };
    assert.equal(row.title, 'nightly');
    assert.equal(row.auto_approve, 0, 'existing schedules must keep asking for approval');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/auto-approve-migration.test.ts
```

Expected: FAIL — 三个用例都在 `auto_approve` 断言处失败。

- [ ] **Step 3: 给两张表加列**

在 `backend/server/modules/database/schema.ts` 的 `tasks` 表定义里，`source_schedule_id TEXT` 之后加一行：

```
    source_schedule_id TEXT,
    auto_approve      INTEGER DEFAULT 0
```

在 `scheduled_tasks` 表定义里，`last_task_id TEXT,` 之前加一行：

```
    auto_run          INTEGER DEFAULT 1,
    auto_approve      INTEGER DEFAULT 0,
```

- [ ] **Step 4: 加迁移**

在 `backend/server/modules/database/migrations.ts` 里找到 `addColumnToTableIfNotExists` 被调用的地方（`tasks` 与 `scheduled_tasks` 各自所在的迁移函数）。在这两个函数里各加一处：

```ts
addColumnToTableIfNotExists(db, 'tasks', getTableInfo(db, 'tasks').map((c) => c.name), 'auto_approve', 'INTEGER DEFAULT 0');
```

```ts
addColumnToTableIfNotExists(db, 'scheduled_tasks', getTableInfo(db, 'scheduled_tasks').map((c) => c.name), 'auto_approve', 'INTEGER DEFAULT 0');
```

注意 `addColumnToTableIfNotExists` 的第 3 个参数是列名数组，必须传**当前实际列名**（用 `getTableInfo(...).map(...)` 求值），不能传 schema 里的期望列——传错了会让它以为列已存在而静默跳过。

- [ ] **Step 5: 给类型加字段**

在 `backend/server/shared/types.ts` 的 `TaskRow` 里，`source_schedule_id` 之后加：

```ts
  /** 无人值守执行时是否自动审批工具权限（0 = 保持询问，1 = 自动决定）。 */
  auto_approve: number; // 0 | 1
```

在 `ScheduledTaskRow` 里，`auto_run` 之后加：

```ts
  auto_approve: number; // 0 | 1 — 派发时镜像到任务的同名字段
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/auto-approve-migration.test.ts
```

Expected: PASS，三个用例全过。

- [ ] **Step 7: 跑既有迁移测试确认零回归**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/*.test.ts
```

Expected: 全部 PASS。若有既有用例失败，说明 schema.ts 的改动破坏了某个重建路径，**不要**放宽断言，去修 schema。

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts backend/server/shared/types.ts backend/server/modules/database/tests/auto-approve-migration.test.ts
git commit -m "feat(database): add auto_approve column to tasks and scheduled_tasks

Both default to 0 so existing tasks, assistant-created tasks and
session-converted tasks keep asking for approval exactly as they do today."
```

---

## Task 3: `tasks` 仓储 / service / 路由支持 `auto_approve`

**Files:**
- Modify: `backend/server/modules/database/repositories/tasks.db.ts`
- Modify: `backend/server/modules/tasks/services/tasks.service.ts`
- Modify: `backend/server/modules/tasks/tasks.routes.ts`
- Test: `backend/server/modules/database/tests/auto-approve-repository.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/database/tests/auto-approve-repository.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-approve-repo-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    getConnection().prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('p1', '/tmp/repo');
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('createTask defaults auto_approve to 0 and honours an explicit true', async () => {
  await withIsolatedDatabase(() => {
    const plain = tasksDb.createTask({ projectPath: '/tmp/repo', title: 'plain', executorProvider: 'claude' });
    assert.equal(plain.auto_approve, 0, 'omitting the flag must keep the existing behaviour');

    const flagged = tasksDb.createTask({
      projectPath: '/tmp/repo',
      title: 'flagged',
      executorProvider: 'claude',
      autoApprove: true,
    });
    assert.equal(flagged.auto_approve, 1);
  });
});

test('updateTask toggles auto_approve and leaves other fields alone', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.createTask({ projectPath: '/tmp/repo', title: 'toggle', executorProvider: 'claude' });
    assert.equal(task.auto_approve, 0);

    const on = tasksDb.updateTask(task.task_id, { autoApprove: true });
    assert.equal(on?.auto_approve, 1);
    assert.equal(on?.title, 'toggle', 'unrelated fields must be untouched');

    const off = tasksDb.updateTask(task.task_id, { autoApprove: false });
    assert.equal(off?.auto_approve, 0);
  });
});

test('updateTask with no autoApprove key does not clear an existing flag', async () => {
  await withIsolatedDatabase(() => {
    const task = tasksDb.createTask({
      projectPath: '/tmp/repo',
      title: 'keep',
      executorProvider: 'claude',
      autoApprove: true,
    });
    // 这是「部分更新」的回归点：undefined 必须被忽略，不能被当成 false 写回。
    const updated = tasksDb.updateTask(task.task_id, { title: 'renamed' });
    assert.equal(updated?.title, 'renamed');
    assert.equal(updated?.auto_approve, 1, 'an unrelated update must not silently turn auto-approval off');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/auto-approve-repository.test.ts
```

Expected: FAIL — `plain.auto_approve` 是 `undefined`。

- [ ] **Step 3: 改仓储**

在 `backend/server/modules/database/repositories/tasks.db.ts` 的 `createTask` 里：

1. 入参类型加一行（`sourceScheduleId` 旁边）：

```ts
    autoApprove?: boolean;
```

2. INSERT 的列清单加 `auto_approve`，VALUES 占位符加一个 `?`：

```sql
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model, position, session_id, started_at, completed_at, priority, deadline, is_operator, label, remark, context_source_session_id, context_mode, context_status, source_schedule_id, auto_approve)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${startedAtSet}, ${completedAtSet}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

3. 参数列表末尾追加：

```ts
      input.sourceScheduleId ?? null,
      input.autoApprove ? 1 : 0,
```

在 `updateTask` 里：

1. 入参类型加 `autoApprove?: boolean;`（`remark` 之后）
2. 在 `remark` 那一行之后加：

```ts
    if (updates.autoApprove !== undefined) { sets.push('auto_approve = ?'); params.push(updates.autoApprove ? 1 : 0); }
```

`undefined` 被跳过这一点是本任务第三个测试的回归点，别改成 `!== null` 之类。

- [ ] **Step 4: 跑仓储测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/auto-approve-repository.test.ts
```

Expected: PASS，三个用例全过。

- [ ] **Step 5: 打通 service 与路由**

`backend/server/modules/tasks/services/tasks.service.ts`：

1. `CreateTaskInput` 加字段（`sourceScheduleId` 附近）：

```ts
  /** 无人值守执行时是否自动审批工具权限；缺省 false（保持询问）。 */
  autoApprove?: boolean;
```

2. `createTask` 里把 `input.autoApprove` 透传进 `resolveDb.createTask({...})`（在 `sourceScheduleId` 那一行旁边加 `autoApprove: input.autoApprove,`）。

3. `updateTask` 的校验块（`:513-528`）不需要加新校验——布尔值只有真/假两种，非法输入由路由层过滤。但要在类型上确认 `Parameters<TaskDbLike['updateTask']>[1]` 已经包含 `autoApprove`（上一步改了 `tasksDb.updateTask` 的签名，`TaskDbLike` 是 `Pick<typeof tasksDb, ...>`，会自动带上）。

`backend/server/modules/tasks/tasks.routes.ts`：

1. create 分支（`:40-54` 的映射对象）加：

```ts
        autoApprove: body.autoApprove === true,
```

2. update 分支的 `hasFieldUpdates` 数组（`:101`）加上 `'autoApprove'`：

```ts
      const hasFieldUpdates = ['title', 'description', 'executorProvider', 'executorModel', 'sessionId', 'projectPath', 'priority', 'deadline', 'label', 'remark', 'autoApprove'].some((k) => body[k] !== undefined);
```

3. update 分支的 `updates` 装配处（`:126-140` 一带）加：

```ts
      if (typeof body.autoApprove === 'boolean') updates.autoApprove = body.autoApprove;
```

- [ ] **Step 6: 跑 task service 与路由的既有测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/tasks/tests/*.test.ts
```

Expected: 全部 PASS（零回归）。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/database/repositories/tasks.db.ts backend/server/modules/tasks/
git commit -m "feat(tasks): persist and expose a per-task auto_approve flag

Partial updates leave the flag alone: an omitted key is not treated as false."
```

---

## Task 4: `scheduled_tasks` 支持 `auto_approve` 并在派发时镜像

**Files:**
- Modify: `backend/server/modules/database/repositories/scheduled-tasks.db.ts`
- Modify: `backend/server/modules/scheduler/services/scheduler.service.ts`
- Test: `backend/server/modules/scheduler/tests/scheduler.service.test.ts`（追加用例）

- [ ] **Step 1: 写失败的测试**

在 `backend/server/modules/scheduler/tests/scheduler.service.test.ts` 末尾追加。注意文件顶部的 `mkRow` fixture 需要先补上默认值（否则类型不过）：

先改 `mkRow`，在 `auto_run: 1,` 之后加一行：

```ts
    auto_approve: 0,
```

再追加用例：

```ts
test('dispatch mirrors auto_approve from the schedule onto the task', async () => {
  const { svc, rows, createdTasks } = makeService('2026-08-13T12:00:00.000Z');
  rows.set('flagged', mkRow({
    schedule_id: 'flagged',
    auto_approve: 1,
    run_at: '2026-08-13T00:00:00.000Z',
    next_run_at: '2026-08-13T00:00:00.000Z',
  }));
  rows.set('plain', mkRow({
    schedule_id: 'plain',
    auto_approve: 0,
    run_at: '2026-08-13T00:00:00.000Z',
    next_run_at: '2026-08-13T00:00:00.000Z',
  }));

  await svc.tickNow();

  assert.equal(createdTasks.length, 2);
  const flagged = createdTasks.find((t) => (t as { sourceScheduleId?: string }).sourceScheduleId === 'flagged');
  const plain = createdTasks.find((t) => (t as { sourceScheduleId?: string }).sourceScheduleId === 'plain');
  assert.equal((flagged as { autoApprove?: boolean }).autoApprove, true, 'the flag must reach the task row');
  assert.equal((plain as { autoApprove?: boolean }).autoApprove, false, 'an unflagged schedule must not auto-approve');
});

test('create defaults auto_approve to false and honours an explicit true', async () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');

  const plain = await svc.create({ title: 'a', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;
  assert.equal(plain.auto_approve, 0);

  const flagged = await svc.create({
    title: 'b',
    scheduleType: 'cron',
    cronExpr: '0 9 * * *',
    autoApprove: true,
  }) as ScheduledTaskRow;
  assert.equal(flagged.auto_approve, 1);
});

test('update accepts autoApprove and maps it to the auto_approve column', async () => {
  const { svc, rows } = makeService('2026-08-13T12:00:00.000Z');
  const row = await svc.create({ title: 'a', scheduleType: 'cron', cronExpr: '0 9 * * *' }) as ScheduledTaskRow;

  const updated = await svc.update(row.schedule_id, { autoApprove: true }) as ScheduledTaskRow;
  assert.equal(updated.auto_approve, 1);
});
```

注意 `makeService` 的 `db.createScheduledTask` stub 需要透传这个字段，否则前两个用例拿不到值。在 stub 里 `run_at: i.runAt ?? null,` 之后加：

```ts
        auto_approve: i.autoApprove ? 1 : 0,
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.service.test.ts
```

Expected: FAIL — `autoApprove` 为 `undefined`。

- [ ] **Step 3: 改仓储**

`backend/server/modules/database/repositories/scheduled-tasks.db.ts` 的 `createScheduledTask`：

1. 入参类型加 `autoApprove?: boolean | 0 | 1;`（`autoRun` 之后）
2. INSERT 列清单加 `auto_approve`，占位符加一个 `?`：

```sql
      INSERT INTO scheduled_tasks (schedule_id, title, description, project_path, executor_provider, executor_model, priority, label, is_operator, auto_run, auto_approve, schedule_type, cron_expr, interval_seconds, run_at, timezone, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

3. 参数列表在 `input.autoRun ...` 之后加：

```ts
      input.autoApprove === true || input.autoApprove === 1 ? 1 : 0,
```

`updateScheduledTask` 的 `allowed` 白名单（`:97-104`）加一行：

```ts
      auto_approve: (v) => (v ? 1 : 0),
```

- [ ] **Step 4: 改 scheduler service**

`backend/server/modules/scheduler/services/scheduler.service.ts`：

1. `create()` 的 `deps.scheduledTasksDb.createScheduledTask({...})` 调用里加（`autoRun` 那一行之后）：

```ts
        autoApprove: input.autoApprove === true,
```

2. `update()` 的 `keyMap` 里加一行（`autoRun: 'auto_run',` 之后）：

```ts
        autoApprove: 'auto_approve',
```

3. `dispatch()` 的 `deps.tasksService.createTask({...})` 调用里加（`sourceScheduleId` 那一行附近）：

```ts
        autoApprove: schedule.auto_approve === 1,
```

这一行是「镜像」的全部实现——任务一旦派发就自包含，之后改定时任务不影响已在跑的那一次。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/scheduler/tests/scheduler.service.test.ts
```

Expected: 全部 PASS（含新增三个用例与既有全部用例）。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/database/repositories/scheduled-tasks.db.ts backend/server/modules/scheduler/
git commit -m "feat(scheduler): mirror the schedule's auto_approve onto each dispatched task

Mirrored at dispatch rather than looked up at run time so a running task is
self-contained: editing or deleting the schedule no longer affects it."
```

---

## Task 5: headless 启动路径注入 `autoApprove`

**Files:**
- Modify: `backend/server/modules/websocket/services/headless-task-run.service.ts`
- Modify: `backend/server/index.js`
- Test: `backend/server/modules/websocket/tests/headless-task-run.test.ts`（追加用例）

- [ ] **Step 1: 写失败的测试**

在 `backend/server/modules/websocket/tests/headless-task-run.test.ts` 末尾追加：

```ts
test('carries autoApprove into runtimeOptions when the task opted in', async () => {
  const captured: { options?: Record<string, unknown> } = {};
  startHeadlessTaskRun(
    'sess-auto',
    {
      content: 'unattended work',
      autoApprove: true,
      spawnFns: { claude: makeSpawnFn(captured as never) } as never,
    },
    {
      getSessionById: () => ({ provider: 'claude', provider_session_id: null, project_path: '/p', is_operator: 0 }),
      startRun: () => ({ writer: {} }),
      completeRunIfCurrent: () => {},
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.options?.autoApprove, true);
  // 开关只替换「问人」这一步，权限模式本身必须保持 default —— 正是 default
  // 才会调用 canUseTool，改成 bypassPermissions 会让 SDK 整个跳过审批回调。
  assert.equal(captured.options?.permissionMode, 'default');
});

test('omits autoApprove entirely when the task did not opt in', async () => {
  const captured: { options?: Record<string, unknown> } = {};
  startHeadlessTaskRun(
    'sess-plain',
    { content: 'normal work', spawnFns: { claude: makeSpawnFn(captured as never) } as never },
    {
      getSessionById: () => ({ provider: 'claude', provider_session_id: null, project_path: '/p', is_operator: 0 }),
      startRun: () => ({ writer: {} }),
      completeRunIfCurrent: () => {},
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal('autoApprove' in (captured.options ?? {}), false, 'the key must be absent, not merely falsy');
  assert.equal(captured.options?.permissionMode, 'default');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/headless-task-run.test.ts
```

Expected: FAIL — 第一个用例 `captured.options?.autoApprove` 是 `undefined`。

- [ ] **Step 3: 改 headless launcher**

`backend/server/modules/websocket/services/headless-task-run.service.ts`：

1. `HeadlessTaskRunOptions` 加字段：

```ts
  /**
   * Answer this run's own permission requests instead of asking the human.
   * Comes from the task row's `auto_approve`; the caller (startTaskRun) is
   * responsible for reading it server-side — never from a client payload.
   */
  autoApprove?: boolean;
```

2. `runtimeOptions` 里加（`permissionMode` 之前，并更新那段注释）：

```ts
    // 'default' so canUseTool keeps being consulted — that callback is where
    // auto-approval short-circuits, and bypassPermissions would skip it
    // entirely. Without autoApprove these prompts surface as the board's
    // "等你批准" marker for the user to decide, identical to the manual button.
    permissionMode: 'default',
    ...(options.autoApprove === true ? { autoApprove: true } : {}),
```

用展开而不是 `autoApprove: options.autoApprove` 是为了在未开启时**整个键不存在**——测试里那条 `'autoApprove' in options === false` 就是锁这个行为的。

- [ ] **Step 4: 让 `startTaskRun` 读任务行**

`backend/server/index.js` 的 `startTaskRun`（`:614-626`）里，把 `startHeadlessTaskRun` 的调用改成：

```js
    return startHeadlessTaskRun(sessionId, {
        content,
        model: task?.executor_model ?? null,
        // 任务级开关，服务端直读 DB —— 两条启动路径（定时任务、助手
        // start_task_execution）都经这里，签名不变。
        autoApprove: task?.auto_approve === 1,
        spawnFns,
    });
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/headless-task-run.test.ts
```

Expected: 全部 PASS（含既有的 6 个用例）。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/websocket/services/headless-task-run.service.ts backend/server/modules/websocket/tests/headless-task-run.test.ts backend/server/index.js
git commit -m "feat(tasks): thread auto_approve from the task row into headless runs

permissionMode stays 'default' on purpose: that is what keeps canUseTool in
the loop, and auto-approval lives inside that callback."
```

---

## Task 6: 任务板「执行」路径服务端反查

任务板按钮走的是浏览器 `chat.send`，**不经过 `startTaskRun`**。这里必须服务端查库，不能信任前端传来的值。

**Files:**
- Modify: `backend/server/modules/permissions/auto-approve-policy.ts`
- Modify: `backend/server/modules/websocket/services/chat-websocket.service.ts`
- Modify: `backend/server/index.js`
- Test: `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`（追加用例）

解析函数放在 permissions 模块而不是 WS 服务里：它是纯逻辑，且 `chat-websocket.service.ts` 依赖很重，测试 import 它会拖进整个 WS 栈。

- [ ] **Step 1: 写失败的测试**

在 `backend/server/modules/permissions/tests/auto-approve-policy.test.ts` 末尾追加（并把它加进文件顶部的 import 列表）：

```ts
test('resolveTaskAutoApprove: true only for an explicit auto_approve = 1', () => {
  const lookup = (sessionId: string) =>
    sessionId === 'flagged' ? { auto_approve: 1 } : sessionId === 'plain' ? { auto_approve: 0 } : null;

  assert.equal(resolveTaskAutoApprove('flagged', lookup), true);
  assert.equal(resolveTaskAutoApprove('plain', lookup), false);
  assert.equal(resolveTaskAutoApprove('no-task', lookup), false, 'a session with no task must not auto-approve');
});

test('resolveTaskAutoApprove: ignores a truthy-but-not-1 value a stale row might carry', () => {
  assert.equal(resolveTaskAutoApprove('weird', () => ({ auto_approve: 2 })), false);
});

test('resolveTaskAutoApprove: a throwing lookup degrades to false rather than failing the send', () => {
  const lookup = () => {
    throw new Error('db is down');
  };
  assert.equal(resolveTaskAutoApprove('boom', lookup), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: FAIL — `resolveTaskAutoApprove` 未导出。

- [ ] **Step 3: 加解析函数**

在 `backend/server/modules/permissions/auto-approve-policy.ts` 末尾追加：

```ts
/**
 * Resolve the auto-approval flag for a session's linked task.
 *
 * `chat.send` options come from the browser, so this must be resolved
 * server-side: trusting a client-supplied flag would let any client grant
 * itself unattended permissions. Returns true only for an explicit
 * `auto_approve === 1`; anything else (no task, flag 0, an unexpected value, a
 * DB error) resolves to false so the run keeps asking the human — exactly what
 * happens today.
 */
export function resolveTaskAutoApprove(
  sessionId: string,
  lookup: (sessionId: string) => { auto_approve: number } | null,
): boolean {
  try {
    return lookup(sessionId)?.auto_approve === 1;
  } catch (error) {
    console.error('[auto-approve] task lookup failed; falling back to asking the human', error);
    return false;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 接进 chat.send**

`backend/server/modules/websocket/services/chat-websocket.service.ts`：

1. 顶部 import 加：

```ts
import { resolveTaskAutoApprove } from '@/modules/permissions/auto-approve-policy.js';
```

2. 在 `ChatWebSocketDependencies`（`:109-129`）里加一个可选依赖：

```ts
  /**
   * The task linked to this app session, for auto-approval resolution. Optional
   * and defaulting to "no task" — a missing wiring degrades to today's
   * ask-the-human behaviour, which is the safe direction.
   */
  getTaskAutoApprove?: (sessionId: string) => { auto_approve: number } | null;
```

3. 在 `handleChatSend` 的 `runtimeOptions`（`:254-272`）里，**跟在 `...clientOptions` 之后**加一行覆盖：

```ts
    // Placed after the ...clientOptions spread so a client-supplied
    // `autoApprove` is discarded — this value is server-authoritative.
    autoApprove: resolveTaskAutoApprove(sessionId, getTaskAutoApprove),
```

4. 在该函数体内、`runtimeOptions` 之前解析依赖：

```ts
  const getTaskAutoApprove = dependencies.getTaskAutoApprove ?? (() => null);
```

- [ ] **Step 6: 在 index.js 接线**

在 `backend/server/index.js` 里找到构造 `ChatWebSocketDependencies`（传给 chat websocket 服务）的地方，加入：

```js
    // 任务板「执行」按钮走的是浏览器的 chat.send，不经过 startTaskRun ——
    // 这里按 sessionId 反查关联任务，开关才对该路径生效。
    getTaskAutoApprove: (sessionId) => tasksDb.getTaskBySessionId(sessionId),
```

用现有的 `tasksDb` import；若该作用域里没有，用 `tasksService.getTaskBySessionId(sessionId)`（`tasks.service.ts:499`）替代。

- [ ] **Step 7: 跑 websocket 模块全部测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/*.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/modules/websocket/ backend/server/modules/permissions/ backend/server/index.js
git commit -m "feat(tasks): auto-approve the task board's run button too

Resolved server-side by session id: chat.send options come from the browser,
so trusting a client-supplied flag would let any client grant itself
unattended permissions."
```

---

## Task 7: Claude runtime 接入 + `permission_auto` 事件

**Files:**
- Modify: `backend/server/claude-sdk.js`
- Modify: `backend/server/shared/types.ts`

- [ ] **Step 1: 给消息类型加一支**

`backend/server/shared/types.ts` 的 `MessageKind` 联合里，`'permission_cancelled'` 之后加：

```ts
  | 'permission_auto'
```

`createNormalizedMessage`（`shared/utils.ts:408-416`）是 `{ ...fields, ... }` 展开，所以额外字段能原样透传；但 `NormalizedMessage` 类型得先有这两个键，否则 `shared/utils.ts` 是 .ts 文件、调用方将来被类型检查时会报错。在 `NormalizedMessage` 类型里（`toolName?: string;` 附近）加：

```ts
  /** 仅 permission_auto：自动审批给出的决定。 */
  autoApproveBehavior?: 'allow' | 'deny';
  /** 仅 permission_auto：拒绝时的理由，直接展示给用户。 */
  autoApproveReason?: string;
```

- [ ] **Step 2: 让 claude-sdk 复用策略模块**

`backend/server/claude-sdk.js`：

1. 顶部 import 区加：

```js
import { decideAutoApproval, TOOLS_REQUIRING_INTERACTION } from './modules/permissions/auto-approve-policy.js';
```

2. 删掉本地的 `const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);`（`:54`）——改由策略模块提供，避免两处漂移。

- [ ] **Step 3: 在 canUseTool 里短路**

在 `sdkOptions.canUseTool = async (toolName, input, context) => {` 那一行的**紧前面**声明开关：

```js
    // 无人值守自动审批。来源于 runtimeOptions，headless 与 chat.send 两条路
    // 都已在服务端反查过任务行，客户端无法自授。刻意不放到 sdkOptions 上：
    // sdkOptions 会交给 SDK 做 schema 校验，多一个未知键有被拒的风险。
    const autoApprove = options.autoApprove === true;
```

然后在 canUseTool 内部，**原有 `if (!requiresInteraction) { ... }` 整块之后、`const requestId = createRequestId();` 之前**插入：

```js
      // 放在这里而不是函数最开头：上面的 disallowedTools 检查必须先跑完。
      // 自动审批只替换「问人」这一步，不推翻用户在设置里显式的拉黑决定。
      if (autoApprove) {
        const decision = decideAutoApproval(toolName, input);
        const behavior = decision.behavior;
        // 留痕但不打扰：不建 requestId、不进 pendingToolApprovals、不发
        // permission_request，所以既不会闪「等你批准」，也没有超时这回事。
        ws.send(createNormalizedMessage({
          kind: 'permission_auto',
          toolName,
          autoApproveBehavior: behavior,
          autoApproveReason: behavior === 'deny' ? decision.reason : undefined,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'claude',
        }));
        if (behavior === 'deny') {
          console.warn(`[claude-sdk] auto-denied ${toolName} during an unattended run: ${decision.reason}`);
          return { behavior: 'deny', message: decision.reason };
        }
        return { behavior: 'allow', updatedInput: input };
      }
```

`createNormalizedMessage` 是 `{ ...fields, ... }` 展开（`shared/utils.ts:408-416`），这两个自定义字段会原样透传——前提是 Task 7 Step 1 已经把它们加进了 `NormalizedMessage` 类型。

- [ ] **Step 4: 确认新字段能过服务端事件登记**

读 `backend/server/modules/websocket/services/chat-run-registry.service.ts:243-258` 的 `decorateAndRecordEvent`，确认它对未知 `kind` 不做白名单拦截（它对所有帧统一记序、入缓冲）。若它按 kind 分支，给 `permission_auto` 加一个与 `permission_request`/`permission_cancelled` 并列的透传分支——**注意不要**让它调用 `taskLinkage.onSessionApproval`，否则任务板仍会闪「等你批准」。

- [ ] **Step 5: 手工验证一条自动放行与一条自动拒绝**

启动后端（**需要用户明确许可才能重启，见仓库约定**），或在已运行的后端上：

1. 建一个临时项目 + 一个 `auto_approve=1` 的任务，描述写「运行 `git status` 并汇报」；
2. 点「执行」；
3. 预期：会话里出现 `permission_auto` 帧，任务跑完，任务板全程无「等你批准」。

再建一个描述写「运行 `git push`」的任务，预期：`permission_auto` 带 `autoApproveBehavior: 'deny'`，会话里能看到拒绝理由，任务继续/结束而不是挂起。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/claude-sdk.js backend/server/shared/types.ts
git commit -m "feat(claude): short-circuit canUseTool when a task opted into auto-approval

Inserted after the disallowedTools check and before the ask-the-human step, so
auto-approval replaces only the prompt and never overrides an explicit denial
the user configured. Emits permission_auto for the transcript instead of a
permission_request, which would put a pending-approval marker on the board."
```

---

## Task 8: qoder / codex provider 接入

**Files:**
- Modify: `backend/server/qoder-runner.js`
- Modify: `backend/server/openai-codex.js`

- [ ] **Step 1: codex —— 一行**

`backend/server/openai-codex.js:288-306`。该 provider 没有 `canUseTool` 回调，只有 `approvalPolicy`。在解析 `approvalPolicy` 的地方加：

```js
// 任务开了自动审批就直接 never；codex 没有逐工具的审批回调，
// approvalPolicy 是它唯一的粒度。
const approvalPolicy = options.autoApprove === true
  ? 'never'
  : (options.approvalPolicy === 'never' ? 'never' : 'untrusted');
```

保留用户显式设的 `'never'` 不被降级。

- [ ] **Step 2: qoder —— 在 control_request 处自动应答**

`backend/server/qoder-runner.js:474-513` 的 `if (response.type === 'control_request')` 分支里，在 `sendMessage(ws, createNormalizedMessage({ kind: 'permission_request', ... }))` **之前**插入。照抄同分支 `onExpire`（`:495-509`）的既有写法：

```js
        if (response.type === 'control_request') {
          const parsed = parseQoderControlRequest(response);
          if (parsed) {
            const sid = capturedSessionId || sessionId || null;

            // 无人值守自动审批：直接回一条 control_response，不经过人类。
            // 走的是与人工审批同一个 buildQoderControlResponse，协议形状一致；
            // 刻意不调 registerQoderApproval —— 那会留下一个永远等不到人的
            // pending 条目，和它 60s 后必然触发的 onExpire deny。
            if (options.autoApprove === true) {
              const decision = decideAutoApproval(parsed.toolName, parsed.input);
              const denied = decision.behavior === 'deny';
              sendMessage(ws, createNormalizedMessage({
                kind: 'permission_auto',
                toolName: parsed.toolName,
                autoApproveBehavior: decision.behavior,
                autoApproveReason: denied ? decision.reason : undefined,
                sessionId: sid,
                provider: 'qoder',
              }));
              if (denied) {
                console.warn(`[qoder-runner] auto-denied ${parsed.toolName} during an unattended run: ${decision.reason}`);
              }
              writeNdjson(buildQoderControlResponse(parsed.requestId, {
                allow: !denied,
                message: denied ? decision.reason : undefined,
                updatedInput: parsed.input,
              }));
              return; // control frames are protocol, not chat messages
            }

            sendMessage(ws, createNormalizedMessage({
              kind: 'permission_request',
              /* ...原有内容保持不变... */
```

注意这个 `return` 之后原本还有一句 `return; // control frames are protocol, not chat messages`（`:512`）——现在有两条提前返回路径，保留原来那句在 `registerQoderApproval` 块之后即可。

- [ ] **Step 3: 确认 import**

`backend/server/qoder-runner.js` 顶部加：

```js
import { decideAutoApproval } from './modules/permissions/auto-approve-policy.js';
```

- [ ] **Step 4: 跑 provider runner 既有测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/*.test.ts
```

Expected: 全部 PASS。`resolveQoderPermissionOptions` 与 `isQoderInteractivePermissionMode` 的既有用例不受影响——自动审批不改变 `--permission-mode` 取值，qoder 仍走交互控制协议，只是由我们自动应答。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/qoder-runner.js backend/server/openai-codex.js
git commit -m "feat(providers): auto-approve for qoder and codex in unattended runs

qoder answers the control_request itself through the same
buildQoderControlResponse the human path uses, minus the pending registration;
codex sets approvalPolicy to never."
```

---

## Task 9: 前端类型 + 定时任务表单开关

**Files:**
- Modify: `web/src/types/app.ts`
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Test: `web/src/components/tasks/ScheduledTaskForm.test.tsx`（追加用例）

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/tasks/ScheduledTaskForm.test.tsx` 末尾追加：

```tsx
test('EMPTY_DRAFT defaults autoApprove to false', () => {
  // 默认必须是关：新建定时任务不应该悄悄拿到无人监督权限。
  assert.equal(EMPTY_DRAFT.autoApprove, false);
});

test('toApiBody sends autoApprove as a boolean', () => {
  assert.equal(toApiBody({ ...EMPTY_DRAFT, autoApprove: true }).autoApprove, true);
  assert.equal(toApiBody({ ...EMPTY_DRAFT, autoApprove: false }).autoApprove, false);
});

test('toDraft reads the stored auto_approve flag', () => {
  assert.equal(toDraft(mkScheduledTask({ auto_approve: 1 }) as never).autoApprove, true);
  assert.equal(toDraft(mkScheduledTask({ auto_approve: 0 }) as never).autoApprove, false);
});

test('toDraft treats a missing auto_approve as off', () => {
  const withoutFlag = mkScheduledTask({});
  delete (withoutFlag as Record<string, unknown>).auto_approve;
  assert.equal(toDraft(withoutFlag as never).autoApprove, false);
});

test('renders an auto-approval toggle that explains the consequence', () => {
  const html = renderWithOptions([]);
  const toggle = /<button[^>]*aria-label="自动审批"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(toggle.length > 0, 'the auto-approval toggle must render');
  assert.ok(/ aria-pressed="false"/.test(toggle), 'a new task must default to off');
  // 只写开关名的文案会让人不知道开了会发生什么。
  assert.ok(html.includes('危险操作仍会拒绝'), 'the hint must state what turning it on does');
});
```

同时给 fixture `mkScheduledTask` 补默认值，在 `auto_run: 1,` 之后加：

```tsx
    auto_approve: 0,
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: FAIL — `EMPTY_DRAFT.autoApprove` 是 `undefined`。

- [ ] **Step 3: 前端类型**

`web/src/types/app.ts`：

`Task` 接口里 `remark` 之后加：

```ts
  /** 无人值守执行时是否自动审批工具权限（0 = 保持询问，1 = 自动决定）。 */
  auto_approve: number; // 0 | 1
```

`ScheduledTask` 接口里 `auto_run` 之后加：

```ts
  auto_approve: number; // 0 | 1
```

- [ ] **Step 4: 表单**

`web/src/components/tasks/ScheduledTaskForm.tsx`：

1. `ScheduledTaskDraft` 里 `autoRun: boolean;` 之后加：

```ts
  /** 无人值守执行时自动放行工具调用（危险操作仍会拒绝）。 */
  autoApprove: boolean;
```

2. `EMPTY_DRAFT` 里 `autoRun: true,` 之后加：

```ts
  autoApprove: false,
```

3. `toApiBody` 的返回对象里 `autoRun: d.autoRun ? 1 : 0,` 之后加：

```ts
    autoApprove: d.autoApprove,
```

后端用 `body.autoApprove === true` 判定，所以这里发**布尔值**（不是 0/1）——与 `autoRun` 的 `0|1` 不同，别顺手统一。

4. `toDraft` 的返回对象里 `autoRun: initial.auto_run === 1,` 之后加：

```ts
    autoApprove: initial.auto_approve === 1,
```

用 `=== 1` 而不是真值判断：老行或后端漏传时得到 `false`（保持询问），是安全方向。

5. 在「自动执行」那个 `<button>`（`:520-532`）与它后面的 `<span>`（`:533`）**之后**加一组同样的控件：

```tsx
              <button
                type="button"
                aria-label="自动审批"
                aria-pressed={draft.autoApprove}
                onClick={() => set('autoApprove', !draft.autoApprove)}
                className={cn(
                  'flex h-9 items-center rounded-full border px-3 text-sm transition-colors',
                  draft.autoApprove
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border/80 bg-card text-muted-foreground',
                )}
              >
                自动审批
              </button>
              <span className="text-xs text-muted-foreground">
                无人值守时自动放行工具调用（危险操作仍会拒绝）
              </span>
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/types/app.ts web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(web): add the auto-approval toggle to the scheduled task form

The form backs both create and edit, so the scheduled tasks page gets editing
for free. Defaults to off."
```

---

## Task 10: 新建任务弹窗 + 任务详情内联编辑

**Files:**
- Modify: `web/src/components/tasks/CreateTaskDialog.tsx`
- Modify: `web/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 新建任务弹窗**

`web/src/components/tasks/CreateTaskDialog.tsx`：

1. 加 state（`const [model, setModel] = useState('');` 附近）：

```tsx
  const [autoApprove, setAutoApprove] = useState(false);
```

2. 在 `reset()` 里加 `setAutoApprove(false);`（确认该函数存在并把所有 state 归位；若没有统一 reset，就在每次打开时重置的那个 effect 里加）。

3. `api.tasks.create({...})` 的 payload（`:161-175`）里加：

```tsx
        autoApprove,
```

助手任务（`isAssistant`）也照常发送该字段——助手建的任务默认走 false，用户手动打开也合理，因为那是人在 UI 上做的决定。

4. 在引擎/模型 chip 那一行之后加同样的 toggle（复用 Step 3 的 JSX 形状，`aria-label="自动审批"`，文案 `无人值守时自动放行工具调用（危险操作仍会拒绝）`），`onClick={() => setAutoApprove((v) => !v)}`。

- [ ] **Step 2: 任务详情**

`web/src/components/tasks/TaskDetail.tsx`：

1. 加 state（`const [model, setModel] = useState('');` 附近）：

```tsx
  const [autoApprove, setAutoApprove] = useState(false);
```

2. 在从 `task` 回填 state 的地方加 `setAutoApprove(task.auto_approve === 1);`

3. 在 `saveModel`（`:327-335`）之后加一个同形状的保存函数：

```tsx
  async function saveAutoApprove(next: boolean) {
    if (!task || next === (task.auto_approve === 1)) return;
    setAutoApprove(next);
    try {
      const res = await api.tasks.update(task.task_id, { autoApprove: next });
      if (!res.ok) { const err = await res.json().catch(() => null); console.error('save autoApprove failed', err?.error?.message ?? res.status); return; }
      setTask(await res.json());
    } catch (err) { console.error('save autoApprove failed', err); }
  }
```

失败时只打日志、不回滚 UI，与 `saveModel` / `saveEngine` 的既有做法一致。

4. 在「模型」那一行（`:718-725`）之后加一行同样的 `.flex items-center gap-3` 结构：

```tsx
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">自动审批</span>
                  <button
                    type="button"
                    aria-label="自动审批"
                    aria-pressed={autoApprove}
                    onClick={() => void saveAutoApprove(!autoApprove)}
                    className={cn(
                      'flex h-8 items-center rounded-full border px-3 text-xs transition-colors',
                      autoApprove
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'border-border/80 bg-card text-muted-foreground',
                    )}
                  >
                    {autoApprove ? '已开启' : '已关闭'}
                  </button>
                  <span className="text-2xs text-muted-foreground">无人值守时自动放行（危险操作仍会拒绝）</span>
                </div>
```

若该文件没有 `cn` import，按已有 chip 的写法调整（用模板字符串拼接 className）。

- [ ] **Step 3: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsc --noEmit
```

Expected: 错误数量与改动前一致（web 基线可能是干净的——先跑一次记录基线再对比）。

- [ ] **Step 4: 跑前端测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/CreateTaskDialog.test.tsx src/components/tasks/ScheduledTaskForm.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/tasks/CreateTaskDialog.tsx web/src/components/tasks/TaskDetail.tsx
git commit -m "feat(web): expose the auto-approval flag on task creation and detail

Task detail follows the existing inline-edit pattern used by engine and model."
```

---

## Task 11: 列表徽标

**Files:**
- Modify: `web/src/components/tasks/ScheduledTasksView.tsx`
- Modify: `web/src/components/tasks/TaskCard.tsx`（若任务卡片也有徽标行）
- Test: `web/src/components/tasks/ScheduledTasksView.test.tsx`（追加用例）

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/tasks/ScheduledTasksView.test.tsx` 末尾追加（若该文件的 fixture 叫别的名字，沿用它的）：

```tsx
test('a scheduled task with auto_approve on shows an auto-approval badge', () => {
  const html = renderView([mkScheduledTask({ schedule_id: 's1', auto_approve: 1 })]);
  assert.ok(html.includes('自动审批'), 'the badge must render for flagged schedules');
});

test('a scheduled task without the flag shows no auto-approval badge', () => {
  const html = renderView([mkScheduledTask({ schedule_id: 's1', auto_approve: 0 })]);
  assert.equal(html.includes('自动审批'), false, 'the badge must not render when the flag is off');
});
```

`renderView` 用该文件已有的渲染 helper；没有就照抄 `ScheduledTaskForm.test.tsx` 顶部那段 `createPortal` patch + `renderToStaticMarkup` 写法，再包一层传 `tasks` / `projectOptions` / 四个空回调。

同样给该文件的 fixture 补 `auto_approve: 0,`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: FAIL — 第一个用例找不到「自动审批」。

- [ ] **Step 3: 实现**

`web/src/components/tasks/ScheduledTasksView.tsx`：

1. `statusBadge`（`:27-36`）之后加一个并列的纯函数：

```tsx
/**
 * 只在开启时渲染。默认关是绝大多数情况，给它一个「已关闭」徽标只会让列表更吵，
 * 而这个徽标的唯一作用是让人扫一眼看出哪些任务在无人值守时会自己批。
 */
function autoApproveBadge(task: ScheduledTask) {
  if (task.auto_approve !== 1) return null;
  return (
    <span className="rounded-full bg-info/10 px-2 py-0.5 font-semibold text-info">⚡ 自动审批</span>
  );
}
```

2. 卡片里（`:60` 的 `<div className="self-start">{statusBadge(task)}</div>`）改成同时渲染两个：

```tsx
      <div className="flex flex-wrap items-center gap-1">
        {statusBadge(task)}
        {autoApproveBadge(task)}
      </div>
```

3. 桌面表格（`:96-140`）里找到渲染状态徽标的那一列，把 `autoApproveBadge(task)` 一并渲染在同一格内，用 `<div className="flex flex-wrap items-center gap-1">` 包住两个徽标。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/tasks/ScheduledTasksView.tsx web/src/components/tasks/ScheduledTasksView.test.tsx
git commit -m "feat(web): badge the scheduled tasks that will approve their own permissions"
```

---

## Task 12: 会话里的 `permission_auto` 提示

**Files:**
- Create: `web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx`
- Modify: `web/src/components/chat/hooks/useChatMessages.ts`
- Modify: `web/src/components/chat/hooks/useChatRealtimeHandlers.ts`
- Modify: `web/src/stores/useSessionStore.ts`
- Modify: `web/src/components/chat/view/subcomponents/MessageComponent.tsx`

- [ ] **Step 1: 放行事件**

1. `web/src/stores/useSessionStore.ts:30-31` 的 kind 联合会加一行：

```ts
  | 'permission_auto'
```

2. `web/src/components/chat/hooks/useChatRealtimeHandlers.ts:267-268` 的排除条件里加一行：

```ts
        && msg.kind !== 'permission_auto'
```

这两处是让帧不被当成「未知事件」丢弃。用 grep 确认没有其它 `permission_cancelled` 的并列分支需要同步（`hooks/useProjectsState.ts:702` 也有一处，同样加上）。

- [ ] **Step 2: 转成消息**

`web/src/components/chat/hooks/useChatMessages.ts` 的 switch 里，在 `case 'permission_cancelled':` 所在的「控制事件，不渲染」分组**之前**加：

```ts
      case 'permission_auto': {
        const denied = msg.autoApproveBehavior === 'deny';
        msgOut.push({
          type: 'notice',
          content: denied
            ? `已自动拒绝 ${msg.toolName ?? '工具'}：${msg.autoApproveReason ?? '无人值守执行中'}`
            : `已自动放行 ${msg.toolName ?? '工具'}`,
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;
      }
```

`ChatMessage.type` 是裸 `string`（`web/src/components/chat/types/types.ts:39`），不需要改联合类型。`autoApproveBehavior` / `autoApproveReason` 由后端 `permission_auto` 帧原样带来（见 Task 7 Step 1 的字段定义）。

- [ ] **Step 3: 渲染组件**

创建 `web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx`：

```tsx
import type { ChatMessage } from '../../types/types';

/**
 * One compact line per automatic permission decision, so a transcript from an
 * unattended run is not a blank where the approvals should be. Deliberately
 * quiet — these are not errors and they are not the user's problem.
 */
export function AutoApproveNotice({ message }: { message: ChatMessage }) {
  const denied = (message.content ?? '').startsWith('已自动拒绝');
  return (
    <div
      className={`my-1 flex items-start gap-2 px-3 text-xs ${
        denied ? 'text-warning' : 'text-muted-foreground'
      }`}
    >
      <span aria-hidden="true">{denied ? '⚡' : '⚡'}</span>
      <span>{message.content}</span>
    </div>
  );
}
```

- [ ] **Step 4: 接进 MessageComponent**

`web/src/components/chat/view/subcomponents/MessageComponent.tsx`：在 `:139` 那个 `message.type === 'error' ? ... : message.type === 'tool' ? ...` 的分支链最前面加一个：

```tsx
              {message.type === 'notice' ? (
                <AutoApproveNotice message={message} />
              ) : message.type === 'error' ? (
```

并在文件顶部加 import：

```tsx
import { AutoApproveNotice } from './AutoApproveNotice';
```

**注意**：先读 `:130-160` 的实际结构再插——如果外层还有别的条件包裹（比如 `isGrouped` 或 `message.type === 'user' ? ... :`），把 notice 分支放在最内层真正决定内容的那条链上。

- [ ] **Step 5: 跑前端测试 + 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsc --noEmit && env -u TSX_TSCONFIG_PATH npx tsx --test 'src/**/*.test.ts' 'src/**/*.test.tsx'
```

Expected: typecheck 零新增错误；测试全过。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/chat/ web/src/stores/useSessionStore.ts web/src/hooks/useProjectsState.ts
git commit -m "feat(web): render automatic permission decisions in the transcript

One quiet line per decision so an unattended run's transcript is not blank
where the approvals happened. No toast, no board marker."
```

---

## Task 13: 端到端验证

**Files:** 无源码改动（除非发现问题）

- [ ] **Step 1: 起后端并要求重启许可**

重启后端**必须逐次获得用户明确许可**——这是仓库约定，不要自行重启。如果后端已在运行且用户说「已重启」，直接继续。

- [ ] **Step 2: 准备一个临时项目**

```bash
mkdir -p /tmp/auto-approve-e2e && cd /tmp/auto-approve-e2e && git init -q 2>/dev/null; echo hi > README.md
```

在 UI 里把它注册为项目（或复用一个已有的一次性项目）。

- [ ] **Step 3: 正向用例 —— 自动放行**

建一个定时任务：
- 项目：上一步那个临时项目
- 描述：`运行 git status 和 ls，把结果汇报出来`
- **自动审批：开启**
- 调度：单次，时间设为 1 分钟后（或直接用「立即触发」）

触发后断言：

1. 任务状态跑到 `done` / `in_review`，**不是**卡在 `in_progress`；
2. 任务板**全程没有**「等你批准」标记；
3. 会话转录里能看到 `已自动放行 Bash` 那行提示。

- [ ] **Step 4: 反向用例 —— 危险操作被拒**

再建一个任务，描述：`依次运行 git push 和 git status`，自动审批开启，立即触发。

断言：

1. `git push` 被拒（转录里有 `已自动拒绝` 与理由）；
2. `git status` 仍然放行；
3. 任务**没有挂起**，最终结束（不是无限期 `in_progress`）。

- [ ] **Step 5: 回归用例 —— 不开开关行为不变**

再建一个任务，描述同上，**自动审批关闭**，立即触发。

断言：出现「等你批准」标记，60 秒后该次调用被 deny——与改动前完全一致。

- [ ] **Step 6: 交互型工具用例**

建一个描述写 `先用 AskUserQuestion 问我要在哪个目录操作，再继续` 的任务，自动审批开启，立即触发。

断言：任务**不挂起**，会话里出现自动拒绝 + 「请基于现有信息自行判断并继续」，任务最终结束。

这一条是本功能最有价值的回归——改动前它会永远卡在 `in_progress`。

- [ ] **Step 7: 确认助手无法自我授权**

spec §4.4 的约束：助手工具**不得**暴露 `auto_approve`，否则助手可以给自己（或它建的任务）授予无人监督权限。跑：

```bash
cd /mnt/b/workdir/github/lovdex/backend && grep -n "autoApprove\|auto_approve" server/modules/operators/operator.tools.ts
```

Expected: **无任何输出**。

有输出就说明有人把参数加进了 `create_task` / `create_scheduled_tasks` / `update_scheduled_task` 的 schema，删掉它——这是本设计里唯一一条「靠不做来实现」的安全属性，`update_scheduled_task` 的工具 schema 一旦能传这个键，助手就能把任意已存在的定时任务改成自动审批。

再确认路由层的通路是安全的：`tasks.routes.ts` 与 `scheduler.routes.ts` 接受 `autoApprove`，但那是 **HTTP + 登录态**的路，助手工具走的是 `tasksService.createTask` / `schedulerService.create` 直调，不经过路由。上面这条 grep 为空即证明两条路没有交叉。

- [ ] **Step 8: 记录结果**

把这四条的实际输出（任务状态、转录里的提示行）贴给用户。**不要**只贴「全部通过」——上面几条都要有你亲眼看到的具体证据。

- [ ] **Step 9: 提交（如有修复）**

```bash
cd /mnt/b/workdir/github/lovdex && git add -A && git commit -m "fix(auto-approve): <具体问题>"
```

若四步全过且无改动，跳过本步。

---

## 验收清单

- [ ] `auto_approve=0`（默认）的任务，行为与改动前**逐字节一致**：定时任务 60s 后 deny、交互型工具仍无限期等待。
- [ ] `auto_approve=1` 的任务在无人值守时不再卡死，普通工具自动放行。
- [ ] 危险操作被拒绝且任务**不挂起**。
- [ ] `AskUserQuestion` / `ExitPlanMode` 不再让任务永远卡在 `in_progress`。
- [ ] 客户端在 `chat.send` 里伪造 `autoApprove: true` **无效**（服务端反查）。
- [ ] 用户在聊天设置里显式拉黑的 `disallowedTools`，在自动审批开启时**仍然生效**。
- [ ] 助手工具（`create_task` / `create_scheduled_tasks` / `update_scheduled_task`）**没有**暴露 `auto_approve`。
- [ ] 三个 UI 入口都可设置：定时任务表单（新建 + 编辑）、新建任务弹窗、任务详情。
- [ ] 定时任务列表对开启的任务显示徽标。
- [ ] backend typecheck / lint 与 web typecheck 均为**零新增**错误。
