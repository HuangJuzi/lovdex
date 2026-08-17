# Lovdex 助手（特殊 Project）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧边栏「助手」改名为「Lovdex助手」、把它当作特殊 Project（工作区项目从项目列表隐藏、会话只在助手区展示、整行折叠），并清理 operator 工作区里的 `is_operator=0` 残留会话。

**Architecture:** 后端在 `/api/projects` 和 `session_upserted` 事件里给 operator 工作区项目打 `isOperatorWorkspace` 标记（复用现有 `isMainAgentWorkspace` 模式）；前端只在侧边栏渲染层过滤该标记，全局 `projects` state 保留其会话数据以支撑 `/session/:id` 路由解析。清理逻辑为服务启动时硬删工作区 `is_operator=0` 会话。

**Tech Stack:** Node.js + Express + better-sqlite3（backend），React + Tailwind（lovdex-cli）。测试用 `node:test` + `tsx --test`。

**两个仓库分开提交：**
- 后端 → `lovdex-backend`（Task 1–6）
- 前端 → `lovdex-cli`（Task 7–11）

**环境注意：** shell 全局导出了 `TSX_TSCONFIG_PATH=server/tsconfig.json`。跑 **lovdex-cli** 的测试前必须先 `unset TSX_TSCONFIG_PATH`；跑 **lovdex-backend** 的测试无需 unset。后端 `npm run typecheck` / `npm run lint` 基线有既有错误（`server/shared/utils.ts` 等），不作为通过门槛；前端 `npm run typecheck` 基线通过。

---

### Task 1: 后端 — operator 工作区路径判定 helper

**Files:**
- Create: `lovdex-backend/server/modules/operators/operator-workspace.service.ts`
- Test: `lovdex-backend/server/modules/operators/tests/operator-workspace.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lovdex-backend/server/modules/operators/tests/operator-workspace.service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { isOperatorWorkspacePath } from '@/modules/operators/operator-workspace.service.js';

async function withTempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const previousWorkspace = process.env.LOVDEX_OPERATOR_WORKSPACE;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'op-ws-'));
  const workspace = path.join(dir, 'operator-workspace');
  await mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.LOVDEX_OPERATOR_WORKSPACE = workspace;
  await initializeDatabase();

  try {
    await run(workspace);
  } finally {
    closeConnection();
    if (previousWorkspace === undefined) delete process.env.LOVDEX_OPERATOR_WORKSPACE;
    else process.env.LOVDEX_OPERATOR_WORKSPACE = previousWorkspace;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('isOperatorWorkspacePath matches the configured workspace and rejects a sibling path', async () => {
  await withTempWorkspace(async (workspace) => {
    assert.equal(await isOperatorWorkspacePath(workspace), true);
    assert.equal(await isOperatorWorkspacePath(path.join(path.dirname(workspace), 'other')), false);
  });
});

test('isOperatorWorkspacePath returns false for empty or unset paths', async () => {
  await withTempWorkspace(async () => {
    assert.equal(await isOperatorWorkspacePath(''), false);
    assert.equal(await isOperatorWorkspacePath('/definitely/not/exists'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/operators/tests/operator-workspace.service.test.ts`
Expected: FAIL — module not found (`Cannot find module '@/modules/operators/operator-workspace.service.js'`).

- [ ] **Step 3: Write minimal implementation**

Create `lovdex-backend/server/modules/operators/operator-workspace.service.ts`:

```ts
import { promises as fs } from 'node:fs';

import { getOperatorConfig } from '@/modules/operators/operator.config.js';

/**
 * 解析 operator 工作区（Lovdex助手 的工作目录）的 canonical real path，
 * 未配置或目录不存在时返回 null。复用 main-agent-workspace 的判定思路，
 * 但读 operator 配置，使「Lovdex助手」工作区在项目列表、websocket 事件里被一致识别。
 */
export async function resolveOperatorWorkspaceRoot(): Promise<string | null> {
  const workspace = getOperatorConfig().workspace;
  if (!workspace) {
    return null;
  }
  try {
    return await fs.realpath(workspace);
  } catch {
    return null;
  }
}

/** 当 `projectPath` 解析到 Lovdex助手（operator）工作区时返回 true。 */
export async function isOperatorWorkspacePath(projectPath: string): Promise<boolean> {
  if (!projectPath) {
    return false;
  }
  const root = await resolveOperatorWorkspaceRoot();
  if (!root) {
    return false;
  }
  try {
    return (await fs.realpath(projectPath)) === root;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/operators/tests/operator-workspace.service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/operators/operator-workspace.service.ts server/modules/operators/tests/operator-workspace.service.test.ts
git commit -m "feat(operators): add isOperatorWorkspacePath path helper"
```

---

### Task 2: 后端 — 项目列表打 `isOperatorWorkspace` 标记

**Files:**
- Modify: `lovdex-backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts`
- Test: `lovdex-backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lovdex-backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withTempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const previousWorkspace = process.env.LOVDEX_OPERATOR_WORKSPACE;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'op-mark-'));
  const workspace = path.join(dir, 'operator-workspace');
  const regular = path.join(dir, 'regular-project');
  await mkdir(workspace, { recursive: true });
  await mkdir(regular, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.LOVDEX_OPERATOR_WORKSPACE = workspace;
  await initializeDatabase();

  try {
    await run(workspace, regular);
  } finally {
    closeConnection();
    if (previousWorkspace === undefined) delete process.env.LOVDEX_OPERATOR_WORKSPACE;
    else process.env.LOVDEX_OPERATOR_WORKSPACE = previousWorkspace;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('getProjectsWithSessions marks the operator workspace project', async () => {
  await withTempWorkspace(async (workspace, regular) => {
    projectsDb.createProjectPath(workspace);
    projectsDb.createProjectPath(regular);

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const byPath = new Map(projects.map((p) => [p.fullPath, p]));

    assert.equal(byPath.get(workspace)?.isOperatorWorkspace, true);
    assert.equal(byPath.get(regular)?.isOperatorWorkspace, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/projects/services/tests/operator-workspace-mark.test.ts`
Expected: FAIL — `byPath.get(workspace)?.isOperatorWorkspace` is `undefined`, not `true`.

- [ ] **Step 3: Write minimal implementation**

In `projects-with-sessions-fetch.service.ts`:
1. Add import near the top (after the `getMainAgentWorkspace` import on line 9):

```ts
import { isOperatorWorkspacePath } from '@/modules/operators/operator-workspace.service.js';
```

2. Add the field to the `ProjectListItem` type (after `isMainAgentWorkspace: boolean;` on line 35):

```ts
  isOperatorWorkspace?: boolean;
```

3. In `getProjectsWithSessions` loop, after the `isMainAgentWorkspace` block (around line 245), compute and include the flag:

```ts
    const isOperatorWorkspace = await isOperatorWorkspacePath(projectPath);

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      isMainAgentWorkspace,
      isOperatorWorkspace,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
```

4. In `getArchivedProjectsWithSessions` loop, compute and include the flag (the object currently hardcodes `isMainAgentWorkspace: false`):

```ts
    const isOperatorWorkspace = await isOperatorWorkspacePath(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      isMainAgentWorkspace: false,
      isOperatorWorkspace,
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/projects/services/tests/operator-workspace-mark.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/projects/services/projects-with-sessions-fetch.service.ts server/modules/projects/services/tests/operator-workspace-mark.test.ts
git commit -m "feat(projects): mark operator workspace with isOperatorWorkspace"
```

---

### Task 3: 后端 — `session_upserted` 事件带 `isOperatorWorkspace`

**Files:**
- Modify: `lovdex-backend/server/modules/providers/services/sessions-watcher.service.ts`
- Modify: `lovdex-backend/server/modules/websocket/services/chat-run-registry.service.ts`

前端在 websocket `session_upserted` 时可能用事件里的 `project` 重建项目（丢了初始 `/api/projects` 打好的标），所以事件里也要带该标记。

- [ ] **Step 1: Modify `sessions-watcher.service.ts`**

1. Add import after line 11 (`import { generateDisplayName } ...`):

```ts
import { isOperatorWorkspacePath } from '@/modules/operators/operator-workspace.service.js';
```

2. In `buildSessionUpsertedEvent`, after `const displayName = ...` (line 131–133), compute the flag and add it to the project payload:

```ts
  const isOperatorWorkspace = project ? await isOperatorWorkspacePath(project.project_path) : false;

  return JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      custom_name: row.custom_name,
      summary: row.summary,
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
        isOperatorWorkspace,
      }
      : null,
    timestamp: new Date().toISOString(),
  });
```

- [ ] **Step 2: Modify `chat-run-registry.service.ts`**

1. Add import (near the `generateDisplayName` import):

```ts
import { isOperatorWorkspacePath } from '@/modules/operators/operator-workspace.service.js';
```

2. In `broadcastCanonicalSessionUpsert`, after the `displayName` computation (line 74–76), compute the flag and add it to the project payload:

```ts
  const isOperatorWorkspace = project ? await isOperatorWorkspacePath(project.project_path) : false;
```

and change the `project` object to include:

```ts
        isStarred: Boolean(project.isStarred),
        isOperatorWorkspace,
```

- [ ] **Step 3: Verify the two files still parse (type-aware smoke check)**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx -e "import('./server/modules/providers/services/sessions-watcher.service.js').then(()=>console.log('watcher ok'))"`
Expected: `watcher ok` (import resolves). Repeat with `./server/modules/websocket/services/chat-run-registry.service.js` → `registry ok`.

> 说明：这两个 emitter 未做单测（函数不导出、需真实 watcher 触发）。Task 1 已测 helper，这里靠 import 冒烟 + 后续前端联调覆盖。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/providers/services/sessions-watcher.service.ts server/modules/websocket/services/chat-run-registry.service.ts
git commit -m "feat(websocket): carry isOperatorWorkspace on session_upserted"
```

---

### Task 4: 后端 — sessions DB 查询非 operator 会话

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/sessions.db.ts`
- Test: `lovdex-backend/server/modules/database/tests/sessions-provider-mapping.test.ts`（追加一个用例）

- [ ] **Step 1: Write the failing test**

Append to `lovdex-backend/server/modules/database/tests/sessions-provider-mapping.test.ts` (end of file — reuses the existing `withIsolatedDatabase` helper defined at the top of that file):

```ts
test('getNonOperatorSessionsByProjectPath returns only is_operator=0 rows for the path', async () => {
  await withIsolatedDatabase(() => {
    const workspace = '/workspace/op';
    sessionsDb.createAppSession('op-1', 'claude', workspace, false);
    sessionsDb.createAppSession('op-2', 'claude', workspace, true);
    sessionsDb.createAppSession('other-1', 'claude', '/workspace/other', false);

    const rows = sessionsDb.getNonOperatorSessionsByProjectPath(workspace);
    const ids = rows.map((r) => r.session_id).sort();
    assert.deepEqual(ids, ['op-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/database/tests/sessions-provider-mapping.test.ts`
Expected: FAIL — `TypeError: sessionsDb.getNonOperatorSessionsByProjectPath is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `sessions.db.ts`, add after `getSessionsByProjectPathIncludingArchived` (line 399):

```ts
  /**
   * 指定路径下非 operator（is_operator = 0）的会话。用于清理 operator
   * 工作区里在 is_operator 列迁移前遗留的普通会话。
   */
  getNonOperatorSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND is_operator = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/database/tests/sessions-provider-mapping.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/database/repositories/sessions.db.ts server/modules/database/tests/sessions-provider-mapping.test.ts
git commit -m "feat(sessions): query non-operator sessions by project path"
```

---

### Task 5: 后端 — 清理 operator 工作区残留会话服务

**Files:**
- Create: `lovdex-backend/server/modules/operators/operator-cleanup.service.ts`
- Test: `lovdex-backend/server/modules/operators/tests/operator-cleanup.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lovdex-backend/server/modules/operators/tests/operator-cleanup.service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { cleanOperatorWorkspaceLegacySessions } from '@/modules/operators/operator-cleanup.service.js';

async function withTempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const previousWorkspace = process.env.LOVDEX_OPERATOR_WORKSPACE;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'op-clean-'));
  const workspace = path.join(dir, 'operator-workspace');
  await mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.LOVDEX_OPERATOR_WORKSPACE = workspace;
  await initializeDatabase();

  try {
    await run(workspace);
  } finally {
    closeConnection();
    if (previousWorkspace === undefined) delete process.env.LOVDEX_OPERATOR_WORKSPACE;
    else process.env.LOVDEX_OPERATOR_WORKSPACE = previousWorkspace;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('cleanOperatorWorkspaceLegacySessions deletes only non-operator sessions in the workspace', async () => {
  await withTempWorkspace(async (workspace) => {
    // 工作区内：一个非 operator 残留（带 transcript 文件）+ 一个 operator 会话（保留）
    const orphanFile = path.join(workspace, 'orphan.jsonl');
    await writeFile(orphanFile, '{}');
    sessionsDb.createSession('orphan-provider-1', 'claude', workspace, 'Orphan', undefined, undefined, orphanFile);
    sessionsDb.createAppSession('keeper-1', 'claude', workspace, true);
    // 工作区外：一个普通会话（不受影响）
    sessionsDb.createAppSession('outside-1', 'claude', path.join(path.dirname(workspace), 'regular'), false);

    const result = await cleanOperatorWorkspaceLegacySessions();

    assert.deepEqual(result.sessionIds, ['orphan-provider-1']);
    assert.equal(result.removed, 1);
    assert.equal(sessionsDb.getSessionById('orphan-provider-1'), undefined);
    assert.equal(sessionsDb.getSessionById('keeper-1')?.is_operator, 1);
    assert.ok(sessionsDb.getSessionById('outside-1'));
    // transcript 文件也被删除
    await assert.rejects(stat(orphanFile));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/operators/tests/operator-cleanup.service.test.ts`
Expected: FAIL — module not found `@/modules/operators/operator-cleanup.service.js`.

- [ ] **Step 3: Write minimal implementation**

Create `lovdex-backend/server/modules/operators/operator-cleanup.service.ts`:

```ts
import { getOperatorConfig } from '@/modules/operators/operator.config.js';
import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

export type OperatorCleanupResult = {
  removed: number;
  sessionIds: string[];
};

/**
 * 硬删 Lovdex助手 工作区内 is_operator = 0 的残留会话（DB 行 + transcript 文件）。
 * 这些行是 is_operator 列迁移前的历史遗留；工作区是助手专用，项目列表隐藏后
 * 它们不再有 UI 入口，属于孤儿数据。幂等：只作用于当前工作区路径。
 *
 * 破坏性操作——删除后不可恢复。
 */
export async function cleanOperatorWorkspaceLegacySessions(): Promise<OperatorCleanupResult> {
  const workspace = getOperatorConfig().workspace;
  if (!workspace) {
    return { removed: 0, sessionIds: [] };
  }

  const orphaned = sessionsDb.getNonOperatorSessionsByProjectPath(workspace);
  const sessionIds: string[] = [];

  for (const session of orphaned) {
    try {
      await sessionsService.deleteOrArchiveSessionById(session.session_id, {
        force: true,
        deletedFromDisk: true,
      });
      sessionIds.push(session.session_id);
    } catch (error) {
      console.error('[operator-cleanup] failed to delete session', {
        sessionId: session.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (sessionIds.length > 0) {
    console.log(
      `[operator-cleanup] removed ${sessionIds.length} orphaned non-operator session(s) from the Lovdex 助手 workspace`,
      sessionIds,
    );
  }

  return { removed: sessionIds.length, sessionIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/operators/tests/operator-cleanup.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/operators/operator-cleanup.service.ts server/modules/operators/tests/operator-cleanup.service.test.ts
git commit -m "feat(operators): clean orphaned non-operator sessions in assistant workspace"
```

---

### Task 6: 后端 — 启动时调用清理

**Files:**
- Modify: `lovdex-backend/server/index.js`

- [ ] **Step 1: Add the import**

In `server/index.js`, after the `buildOperatorRouter` import (line 42):

```js
import { cleanOperatorWorkspaceLegacySessions } from './modules/operators/operator-cleanup.service.js';
```

- [ ] **Step 2: Call after DB init**

In `startServer()`, right after `await initializeDatabase();` (line 1405), insert:

```js
        // 清理 Lovdex助手 工作区里 is_operator=0 的历史残留会话（破坏性，日志兜底）。
        try {
            const cleaned = await cleanOperatorWorkspaceLegacySessions();
            if (cleaned.removed > 0) {
                console.log(`[INFO] Cleaned ${cleaned.removed} orphaned non-operator session(s) from the Lovdex 助手 workspace`);
            }
        } catch (error) {
            console.warn('[WARN] Could not clean operator workspace legacy sessions:', error instanceof Error ? error.message : String(error));
        }
```

- [ ] **Step 3: Syntax-check the edited file**

> 不要直接起 server 冒烟：prod 已在跑、端口被占，且启动带 port-takeover 可能误杀现有服务。用语法校验即可。

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-backend && node --check server/index.js`
Expected: 退出码 0、无输出（`package.json` 的 `"type": "module"` 使 `node --check` 按 ESM 解析 `import` 语法）。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/index.js
git commit -m "feat(server): clean orphaned assistant-workspace sessions at startup"
```

---

### Task 7: 前端 — `Project` 类型 + websocket upsert 传播标记

**Files:**
- Modify: `lovdex-cli/src/types/app.ts`
- Modify: `lovdex-cli/src/hooks/useProjectsState.ts`

- [ ] **Step 1: Add the field to the Project type**

In `lovdex-cli/src/types/app.ts`, after `isMainAgentWorkspace?: boolean;` (line 73):

```ts
  isOperatorWorkspace?: boolean;
```

- [ ] **Step 2: Propagate in useProjectsState**

In `lovdex-cli/src/hooks/useProjectsState.ts`:

1. `SessionUpsertedEvent` type — the `project` field (lines 35–41) gains the flag:

```ts
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isOperatorWorkspace?: boolean;
  } | null;
```

2. `projectFromRegistration` (line 301–311) — add the field:

```ts
const projectFromRegistration = (project: Project): Project => ({
  projectId: project.projectId,
  path: project.path || project.fullPath,
  fullPath: project.fullPath || project.path || '',
  displayName: project.displayName,
  isStarred: project.isStarred,
  isOperatorWorkspace: project.isOperatorWorkspace,
  sessions: project.sessions ?? [],
  sessionMeta: project.sessionMeta ?? { hasMore: false, total: countLoadedProjectSessions(project) },
  taskmaster: project.taskmaster,
});
```

3. In `registerOptimisticSession`'s event payload (`project` object, lines 516–524) — add:

```ts
      project: {
        projectId: project.projectId,
        path: project.path || project.fullPath,
        fullPath: project.fullPath || project.path || '',
        displayName: project.displayName,
        isStarred: Boolean(project.isStarred),
        isOperatorWorkspace: Boolean(project.isOperatorWorkspace),
      },
```

4. In the websocket handler's `newProject` creation (lines 704–712) — add:

```ts
          const newProject: Project = {
            projectId: upsert.project.projectId,
            path: upsert.project.path,
            fullPath: upsert.project.fullPath,
            displayName: upsert.project.displayName,
            isStarred: upsert.project.isStarred,
            isOperatorWorkspace: upsert.project.isOperatorWorkspace,
            sessions: [],
            sessionMeta: { hasMore: false, total: 0 },
          } as Project;
```

- [ ] **Step 3: Typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: PASS（无输出）。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/types/app.ts src/hooks/useProjectsState.ts
git commit -m "feat(sidebar): propagate isOperatorWorkspace through project state"
```

---

### Task 8: 前端 — 侧边栏项目列表过滤工作区项目

**Files:**
- Modify: `lovdex-cli/src/components/sidebar/utils/utils.ts`
- Modify: `lovdex-cli/src/components/sidebar/utils/utils.test.ts`
- Modify: `lovdex-cli/src/components/sidebar/hooks/useSidebarController.ts`

- [ ] **Step 1: Write the failing test**

Append to `lovdex-cli/src/components/sidebar/utils/utils.test.ts`:

```ts
import { excludeHiddenProjects } from './utils';

test('excludeHiddenProjects drops operator workspace projects', () => {
  const assistantWs = mkProject('op-ws', 'operator-workspace', {});
  (assistantWs as Project).isOperatorWorkspace = true;
  const regular = mkProject('reg', 'Regular');
  const out = excludeHiddenProjects([assistantWs, regular]);
  assert.deepEqual(out.map((p) => p.projectId), ['reg']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/sidebar/utils/utils.test.ts`
Expected: FAIL — `excludeHiddenProjects is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lovdex-cli/src/components/sidebar/utils/utils.ts`, add after `filterProjects` (line 210–223):

```ts
/**
 * 侧边栏项目列表过滤：隐藏 operator 工作区（Lovdex助手）项目。会话数据保留在
 * 全局 projects state 里供 /session/:id 路由解析，这里只做渲染层过滤。
 */
export const excludeHiddenProjects = (projects: Project[]): Project[] =>
  projects.filter((project) => !project.isOperatorWorkspace);
```

In `lovdex-cli/src/components/sidebar/hooks/useSidebarController.ts`, import it (add to the existing import block from `'../utils/utils'`, lines 14–21):

```ts
  excludeHiddenProjects,
```

And change the `sortedProjects` memo (lines 519–522) to filter first:

```ts
  const sortedProjects = useMemo(() => {
    const visibleProjects = excludeHiddenProjects(projectsWithResolvedStarState);
    return sortProjects(visibleProjects, projectSortOrder, activeSessionIds, currentTime);
  }, [projectSortOrder, projectsWithResolvedStarState, activeSessionIds, currentTime]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/sidebar/utils/utils.test.ts`
Expected: PASS（全部用例，含原有）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/sidebar/utils/utils.ts src/components/sidebar/utils/utils.test.ts src/components/sidebar/hooks/useSidebarController.ts
git commit -m "feat(sidebar): hide operator workspace project from project list"
```

---

### Task 9: 前端 — 任务表单也过滤工作区项目

**Files:**
- Modify: `lovdex-cli/src/components/tasks/projectOptions.ts`
- Test: `lovdex-cli/src/components/tasks/projectOptions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lovdex-cli/src/components/tasks/projectOptions.test.ts`:

```ts
test('taskFormProjects excludes operator workspace projects too', () => {
  const ws = mkProject({ displayName: 'operator-workspace', fullPath: '/ws', isOperatorWorkspace: true });
  const plain = mkProject({ displayName: 'alpha', fullPath: '/a' });
  const out = taskFormProjects([plain, ws]);
  assert.deepEqual(out.map((p) => p.fullPath), ['/a']);
});
```

`mkProject` helper already sets `isMainAgentWorkspace: false` by default; `isOperatorWorkspace` comes from the spread `...over`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/projectOptions.test.ts`
Expected: FAIL — `deepEqual` 得到 `['/ws', '/a']` 而非 `['/a']`。

- [ ] **Step 3: Write minimal implementation**

In `lovdex-cli/src/components/tasks/projectOptions.ts`, change the filter (line 14):

```ts
    .filter((p) => !p.isMainAgentWorkspace && !p.isOperatorWorkspace)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/projectOptions.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/tasks/projectOptions.ts src/components/tasks/projectOptions.test.ts
git commit -m "feat(tasks): exclude operator workspace from task form projects"
```

---

### Task 10: 前端 — 重做 SidebarAssistant（改名 + 整行折叠）

**Files:**
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx`
- Test: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx`（新建）

- [ ] **Step 1: Write the failing test**

Create `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarAssistant from './SidebarAssistant';

test('SidebarAssistant renders the Lovdex助手 label', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarAssistant />
    </MemoryRouter>,
  );
  assert.ok(html.includes('Lovdex助手'));
  assert.ok(html.includes('新建 Lovdex助手 会话'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx`
Expected: FAIL — `html.includes('Lovdex助手')` 为 false（当前渲染的是「助手」）。

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx` with:

```tsx
import { ChevronDown, ChevronRight, Check, Edit2, MessageSquare, Plus, Settings, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { formatRelativeTime } from '../../../tasks/taskTimestamp';

type OperatorSession = {
  session_id: string;
  summary: string | null;
  updated_at: string;
  created_at: string;
};

const COLLAPSE_KEY = 'lovdex:assistant:sessions-collapsed';

/**
 * 把 Lovdex助手 会话打开到 /session/:id。用整页跳转（不是 SPA navigate）这样
 * AppContent 的 useProjectsState 会重新拉项目列表（含 operator 工作区），
 * session 才能正确解析为 selectedSession。
 */
function openSession(sessionId: string) {
  window.location.href = `${import.meta.env.BASE_URL}session/${sessionId}`
    .replace(/\/+/g, '/')
    .replace(/^\/\//, '/');
}

/**
 * 侧边栏顶部的「Lovdex助手」入口 + 其会话记录列表。
 *
 * Lovdex助手 是一个特殊的 Project（operator 工作区）：项目列表里它的工作区
 * 项目被过滤掉（isOperatorWorkspace），会话只在这里展示。折叠行为参考普通
 * Project 的整行折叠——点击 Lovdex助手 整行展开/收起会话列表，右侧 chevron
 * 指示状态。
 *
 * 会话列表（is_operator=1，按 updated_at 倒序）：
 *  - 每行 hover 出 [✎]（重命名）和 [🗑]（删除）；重命名走 api.renameSession，
 *    删除走 api.deleteSession(hard)。
 *  - 点击行打开 /session/:id（整页跳转）。
 *
 * 挂载时拉一次 + 窗口重新获焦时刷新。[+] → /assistant?new=1（强制新建）；
 * [⚙] → /settings/operator。
 */
export default function SidebarAssistant() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editContainerRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.operator.listSessions();
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { sessions?: OperatorSession[] } };
      setSessions(body?.data?.sessions ?? []);
      setNow(new Date());
    } catch {
      // swallow — the list just stays empty
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const safeLoad = async () => {
      await loadSessions();
      if (cancelled) return;
    };
    void safeLoad();
    const onFocus = () => void safeLoad();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [loadSessions]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  function startEdit(s: OperatorSession) {
    setEditingId(s.session_id);
    setEditingName(s.summary ?? '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function saveEdit() {
    const id = editingId;
    const name = editingName.trim();
    if (!id) return;
    // Empty rename clears the custom summary → falls back to "新会话".
    setSessions((prev) =>
      prev.map((s) => (s.session_id === id ? { ...s, summary: name || null } : s)),
    );
    setEditingId(null);
    setEditingName('');
    try {
      const res = await api.renameSession(id, name);
      if (!res.ok) {
        console.error('rename operator session failed', res.status);
        await loadSessions();
      }
    } catch (err) {
      console.error('rename operator session failed', err);
      await loadSessions();
    }
  }

  async function deleteSession(sessionId: string) {
    if (!window.confirm('删除该 Lovdex助手 会话？历史对话记录将一并删除，不可恢复。')) return;
    setDeleting((prev) => new Set(prev).add(sessionId));
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    try {
      const res = await api.deleteSession(sessionId, true);
      if (!res.ok) {
        console.error('delete operator session failed', res.status);
        await loadSessions();
      }
    } catch (err) {
      console.error('delete operator session failed', err);
      await loadSessions();
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  // Dismiss the inline rename when clicking outside its panel (matches Escape).
  useEffect(() => {
    if (!editingId) return;
    const onPointerDown = (event: MouseEvent) => {
      const container = editContainerRef.current;
      if (container && !container.contains(event.target as Node)) cancelEdit();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [editingId]);

  /** One session row: open-on-click + hover rename/delete, or inline rename form. */
  const renderRow = (s: OperatorSession) => {
    const isEditing = editingId === s.session_id;
    const label = s.summary ?? '新会话';
    return (
      <div key={s.session_id} className="group/row relative flex items-center">
        {isEditing ? (
          <div ref={editContainerRef} className="flex w-full items-center gap-1 px-1 py-1">
            <input
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void saveEdit();
                else if (e.key === 'Escape') cancelEdit();
              }}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <button
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20"
              onClick={(e) => {
                e.stopPropagation();
                void saveEdit();
              }}
              title="保存"
            >
              <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
            </button>
            <button
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20"
              onClick={(e) => {
                e.stopPropagation();
                cancelEdit();
              }}
              title="取消"
            >
              <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        ) : (
          <>
            <button
              className="block min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
              onClick={() => openSession(s.session_id)}
              title={label}
            >
              <span className="block truncate text-xs text-foreground">{label}</span>
              <span className="block text-[10px] text-muted-foreground/70">
                {formatRelativeTime(s.updated_at || s.created_at, now)}
              </span>
            </button>
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit(s);
                }}
                title="重命名"
                aria-label="重命名"
              >
                <Edit2 className="h-3 w-3" />
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/70 hover:bg-red-500/15 hover:text-red-500"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteSession(s.session_id);
                }}
                disabled={deleting.has(s.session_id)}
                title="删除会话"
                aria-label="删除会话"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const hasSessions = sessions.length > 0;
  const expanded = hasSessions && !collapsed;

  /** Collapsible list body shared by mobile + desktop (container classes differ). */
  const sessionList = (containerCls: string) =>
    expanded ? (
      <div className={cn('overflow-y-auto rounded-lg bg-muted/20 p-1', containerCls)}>
        {sessions.map(renderRow)}
      </div>
    ) : null;

  const chevron = hasSessions ? (
    collapsed ? (
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    ) : (
      <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    )
  ) : null;

  return (
    <div className="md:group group flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      {/* Mobile: 显式行，按钮常驻（触屏无 hover）。点击整行折叠。 */}
      <div className="md:hidden">
        <div
          className="mx-1 flex items-center justify-between rounded-lg bg-primary/5 p-2 active:scale-[0.98] transition-all duration-150"
          onClick={toggleCollapsed}
          title={hasSessions ? (collapsed ? '展开 Lovdex助手 会话' : '收起 Lovdex助手 会话') : 'Lovdex助手'}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <MessageSquare className="h-4 w-4 flex-shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">Lovdex助手</span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-primary active:scale-90"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/assistant?new=1');
              }}
              title="新建 Lovdex助手 会话"
              aria-label="新建 Lovdex助手 会话"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground active:scale-90"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/settings/operator');
              }}
              title="Lovdex助手 设置"
              aria-label="Lovdex助手 设置"
            >
              <Settings className="h-4 w-4" />
            </button>
            {chevron}
          </div>
        </div>
        {sessionList('mr-1 mb-1 mt-0.5 ml-3 max-h-[28vh] border-l border-border pl-3')}
      </div>

      {/* Desktop: 与 SidebarProjectItem 同款 ghost Button + hover-revealed actions。 */}
      <Button
        variant="ghost"
        className={cn(
          'hidden md:flex w-full justify-between p-2 h-auto font-normal hover:bg-primary/10',
          'bg-primary/5',
        )}
        onClick={toggleCollapsed}
        title={hasSessions ? (collapsed ? '展开 Lovdex助手 会话' : '收起 Lovdex助手 会话') : 'Lovdex助手'}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <MessageSquare className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">
            Lovdex助手
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <div
            role="button"
            tabIndex={0}
            className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-primary/20 hover:text-primary hover:ring-1 hover:ring-primary/40 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              navigate('/assistant?new=1');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                navigate('/assistant?new=1');
              }
            }}
            title="新建 Lovdex助手 会话"
            aria-label="新建 Lovdex助手 会话"
          >
            <Plus className="!h-5 !w-5" />
          </div>
          <div
            role="button"
            tabIndex={0}
            className="touch:opacity-100 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/15 hover:text-foreground hover:ring-1 hover:ring-foreground/30 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              navigate('/settings/operator');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                navigate('/settings/operator');
              }
            }}
            title="Lovdex助手 设置"
            aria-label="Lovdex助手 设置"
          >
            <Settings className="h-3.5 w-3.5" />
          </div>
          {chevron}
        </div>
      </Button>

      {/* Desktop: collapsible Lovdex助手 session history under the row. */}
      {sessionList('ml-3 mt-1 hidden max-h-[40vh] border-l border-border pl-3 md:block')}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: PASS。

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/sidebar/view/subcomponents/SidebarAssistant.tsx src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx
git commit -m "feat(sidebar): rename assistant to Lovdex助手 with project-style folding"
```

---

### Task 11: 前端 — 任务 UI / 设置页 / 助手面板文案统一

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`
- Modify: `lovdex-cli/src/components/tasks/TaskCard.tsx`
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`
- Modify: `lovdex-cli/src/components/operators/OperatorSettingsPage.tsx`
- Modify: `lovdex-cli/src/components/operators/AssistantPanel.tsx`

- [ ] **Step 1: Apply the string replacements**

Use `sed` for each exact replacement (or edit manually):

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli

sed -i 's/🤖 Lovdex 助手/🤖 Lovdex助手/g' src/components/tasks/TaskBoard.tsx src/components/tasks/TaskDetail.tsx
sed -i 's/🤖 助手/🤖 Lovdex助手/g' src/components/tasks/TaskCard.tsx
sed -i 's/关闭后侧边栏不显示「助手」入口。/关闭后侧边栏不显示「Lovdex助手」入口。/' src/components/operators/OperatorSettingsPage.tsx
sed -i 's/正在启动助手…/正在启动 Lovdex助手…/' src/components/operators/AssistantPanel.tsx
```

- [ ] **Step 2: Verify no remaining stale 助手 labels in these files**

Run: `grep -rn "助手" src/components/tasks/TaskBoard.tsx src/components/tasks/TaskCard.tsx src/components/tasks/TaskDetail.tsx src/components/operators/OperatorSettingsPage.tsx src/components/operators/AssistantPanel.tsx`
Expected: 仅剩「Lovdex助手」/「Lovdex 助手」相关注释或已替换后的文案；`TaskCard.tsx` 里的 `🤖 助手` 已不存在（注意 `TaskDetail.tsx` 里 `desc = '助手在等你回答一个问题...'` 属于叙述文案，可保留也可改为「Lovdex助手」，选保留）。

- [ ] **Step 3: Typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/tasks/TaskBoard.tsx src/components/tasks/TaskCard.tsx src/components/tasks/TaskDetail.tsx src/components/operators/OperatorSettingsPage.tsx src/components/operators/AssistantPanel.tsx
git commit -m "chore(tasks): unify Lovdex助手 naming"
```

---

### Task 12: 全量回归

**Files:**（无新增）

- [ ] **Step 1: 跑后端本次涉及的测试**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
npx tsx --test server/modules/operators/tests/operator-workspace.service.test.ts \
  server/modules/projects/services/tests/operator-workspace-mark.test.ts \
  server/modules/operators/tests/operator-cleanup.service.test.ts \
  server/modules/database/tests/sessions-provider-mapping.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 2: 跑前端本次涉及的测试**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
unset TSX_TSCONFIG_PATH
npx tsx --test src/components/sidebar/utils/utils.test.ts \
  src/components/tasks/projectOptions.test.ts \
  src/components/sidebar/view/subcomponents/SidebarAssistant.test.tsx
```
Expected: 全部 PASS。

- [ ] **Step 3: 前端整体 typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 人工验收（需要起服务 + 浏览器）**

1. 起后端（现有 supervisor 或 `cd lovdex-backend && npx tsx --tsconfig server/tsconfig.json server/index.js`），确认启动日志出现 cleanup 行（如有残留会话）。
2. 前端 `cd lovdex-cli && npm run dev`，打开侧边栏：
   - 顶部显示「Lovdex助手」，点击整行可展开/收起会话（chevron 跟随），会话缩进带左边线，与项目一致。
   - 下面 Project 列表不再出现 `operator-workspace` 项目。
   - 打开任意 Lovdex助手 会话（`/session/:id`），聊天正常、无解析回归。
   - 任务面板建任务：项目下拉里「🤖 Lovdex助手」在顶，`operator-workspace` 不再出现。

- [ ] **Step 5: 确认两个仓库已全部提交**

Run: `git -C /mnt/b/workdir/github/lovdex/lovdex-backend status --short && git -C /mnt/b/workdir/github/lovdex/lovdex-cli status --short`
Expected: 两仓库工作区干净（无未提交改动）。

---

## Self-Review 记录

- **Spec 覆盖**：命名（Task 10/11）、隐藏工作区项目（Task 2/3/7/8/9）、整行折叠（Task 10）、清理机制（Task 1/4/5/6）、测试（各 Task）、验收（Task 12）——全部有对应任务。
- **占位符扫描**：无 TBD/TODO；每个改代码的步骤都给出完整代码。
- **类型一致性**：`isOperatorWorkspace` 字段名在 backend `ProjectListItem`、事件 payload、前端 `Project`/`SessionUpsertedEvent` 统一；`cleanOperatorWorkspaceLegacySessions`、`isOperatorWorkspacePath`、`getNonOperatorSessionsByProjectPath`、`excludeHiddenProjects` 在引用处与定义处签名一致。
