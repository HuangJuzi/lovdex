# 项目列表显式过滤 + 路径 realpath 规范化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让侧边栏 Project 列表只显示用户在 lovdex 里显式创建（向导 create-project / clone）的项目和会话，并把项目路径统一规范化成真实绝对路径（解析软链），迁移合并已有重复数据。

**Architecture:** 给 `projects` 表加 `is_explicit` 标记区分「显式创建」与「磁盘扫描自动发现」，只在 `getProjectsWithSessions`/`getArchivedProjectsWithSessions` 与 watcher 事件层过滤，不改 `getProjectPaths()`（operator 工具）与 `getProjectPath()`（`/session/:id` 解析）。路径规范化统一收敛到 `canonicalizeProjectPath()`，在写库边界（`projectsDb.createProjectPath` + `sessionsDb.normalizeProjectPathForProvider`）解析 `fs.realpath`；启动迁移把历史软链路径合并去重。

**Tech Stack:** Express + better-sqlite3（后端）、`node:test` + 隔离 SQLite 测试（`npx tsx --tsconfig server/tsconfig.json --test <file>`）、`fs.realpathSync` 软链解析。前端零改动。

**Spec:** `docs/superpowers/specs/2026-08-17-project-list-explicit-and-realpath-design.md`

---

### 文件结构

- `backend/server/shared/utils.ts` — 新增 `canonicalizeProjectPath()` 路径工具。
- `backend/server/modules/database/schema.ts` — `projects` 表加 `is_explicit` 列。
- `backend/server/shared/types.ts` — `ProjectRepositoryRow` 加 `is_explicit`。
- `backend/server/modules/database/repositories/projects.db.ts` — `createProjectPath` 支持显式标记 + 路径 canonicalize + 提升非显式行；`getProjectPath` 入参 canonicalize；SELECT/RETURNING 加 `is_explicit`。
- `backend/server/modules/database/repositories/sessions.db.ts` — `normalizeProjectPathForProvider` 改为 canonicalize。
- `backend/server/modules/projects/services/project-management.service.ts` — `createProject` canonicalize 路径 + 默认显式写入。
- `backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts` — 列表按 `is_explicit` 过滤。
- `backend/server/modules/providers/services/sessions-watcher.service.ts` — 非显式项目不广播 `session_upserted`。
- `backend/server/modules/providers/list/claude/claude-session-synchronizer.provider.ts` — 移除 `normalizeToWorkspaceRoot`。
- `backend/server/modules/providers/list/codex/codex-session-synchronizer.provider.ts` — 同上。
- `backend/server/modules/database/migrations.ts` — 新增 `is_explicit` 列迁移 + `canonicalizeProjectPathsMigration` 路径合并迁移。

---

## Task 1: `canonicalizeProjectPath` 路径工具

**Files:**
- Create: `backend/server/shared/tests/canonicalize-project-path.test.ts`
- Modify: `backend/server/shared/utils.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/canonicalize-project-path.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeProjectPath } from '@/shared/utils.js';

test('canonicalizeProjectPath resolves symlinks to the real absolute path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'canon-'));
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  await mkdir(real, { recursive: true });
  await symlink(real, link);

  try {
    assert.equal(canonicalizeProjectPath(link), real);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('canonicalizeProjectPath falls back to lexical normalization when path does not exist', () => {
  assert.equal(canonicalizeProjectPath('/no/such/path/../dir'), '/no/such/dir');
});

test('canonicalizeProjectPath returns empty string for empty input', () => {
  assert.equal(canonicalizeProjectPath(''), '');
  assert.equal(canonicalizeProjectPath('   '), '');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/canonicalize-project-path.test.ts`
Expected: FAIL（`canonicalizeProjectPath` 未导出 / not a function）

- [ ] **Step 3: 实现 `canonicalizeProjectPath`**

在 `backend/server/shared/utils.ts` 的 `normalizeProjectPath`（约 line 287）之后新增：

```ts
/**
 * Canonicalizes a project path to its real (symlink-resolved) absolute spelling.
 *
 * Unlike `normalizeProjectPath` (purely lexical), this resolves symlinks via
 * `fs.realpathSync` so the same physical directory always collapses to one
 * spelling. When the path does not exist on disk (deleted directory, or a
 * provider-reported cwd that never materialized), it falls back to lexical
 * normalization instead of throwing.
 */
export function canonicalizeProjectPath(inputPath: string): string {
  const normalized = normalizeProjectPath(inputPath);
  if (!normalized) {
    return '';
  }

  try {
    return normalizeProjectPath(fs.realpathSync(normalized));
  } catch {
    return normalized;
  }
}
```

（`fs` 已在文件顶部 `import fs from 'node:fs';`，无需新增导入。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/canonicalize-project-path.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add backend/server/shared/utils.ts backend/server/shared/tests/canonicalize-project-path.test.ts
git commit -m "feat(shared): add canonicalizeProjectPath (realpath with lexical fallback)"
```

---

## Task 2: `projects` 表加 `is_explicit` 列（schema + 类型 + 迁移）

**Files:**
- Modify: `backend/server/modules/database/schema.ts`
- Modify: `backend/server/shared/types.ts`
- Modify: `backend/server/modules/database/migrations.ts`
- Create: `backend/server/modules/database/tests/projects-explicit-column.test.ts`

- [ ] **Step 1: 改 schema**

`backend/server/modules/database/schema.ts` 的 `PROJECTS_TABLE_SCHEMA_SQL`（`projects` 表）在 `isArchived BOOLEAN DEFAULT 0` 之后加一行：

```sql
    is_explicit INTEGER DEFAULT 0
```

完整表结构变为：

```sql
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    is_explicit INTEGER DEFAULT 0
);
```

- [ ] **Step 2: 改类型**

`backend/server/shared/types.ts` 的 `ProjectRepositoryRow` 加字段：

```ts
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
  is_explicit: number;
};
```

- [ ] **Step 3: 迁移函数加列**

在文件底部（`runMigrations` 定义之前）新增导出函数：

```ts
/**
 * Adds the `is_explicit` flag that distinguishes user-created projects
 * (wizard create-project / clone) from disk-scan auto-discovered ones.
 */
export function migrateProjectsExplicitColumn(db: Database): void {
  const columns = getTableInfo(db, 'projects').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columns, 'is_explicit', 'INTEGER DEFAULT 0');
}
```

在 `runMigrations` 里、`ensureProjectsForSessionPaths(db);` 之后加：

```ts
    ensureProjectsForSessionPaths(db);

    migrateProjectsExplicitColumn(db);
```

- [ ] **Step 4: 写失败测试**

创建 `backend/server/modules/database/tests/projects-explicit-column.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-explicit-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('projects table has is_explicit column', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const columns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    assert.ok(columns.map((c) => c.name).includes('is_explicit'));
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/projects-explicit-column.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/database/schema.ts backend/server/shared/types.ts backend/server/modules/database/migrations.ts backend/server/modules/database/tests/projects-explicit-column.test.ts
git commit -m "feat(db): add is_explicit column to projects table"
```

---

## Task 3: `projects.db.ts` 显式标记 + 路径 canonicalize

**Files:**
- Modify: `backend/server/modules/database/repositories/projects.db.ts`
- Modify: `backend/server/modules/database/tests/projects.db.integration.test.ts`

- [ ] **Step 1: 改导入**

`backend/server/modules/database/repositories/projects.db.ts` 顶部：

```ts
import { canonicalizeProjectPath, normalizeProjectPath } from '@/shared/utils.js';
```

（原为 `import { normalizeProjectPath } from '@/shared/utils.js';`）

- [ ] **Step 2: 改 `createProjectPath`**

把 `createProjectPath`（当前约 line 19-45）整体替换为：

```ts
    createProjectPath(projectPath: string, customProjectName: string | null = null, isExplicit: boolean = false): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = canonicalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        const conflictsWithActiveProject =
            existingProject !== null
            && existingProject.isArchived === 0
            && (existingProject.is_explicit === 1 || !isExplicit);
        if (conflictsWithActiveProject) {
            return {
                outcome: 'active_conflict',
                project: existingProject,
            };
        }

        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, is_explicit)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0,
            is_explicit = CASE WHEN excluded.is_explicit = 1 THEN 1 ELSE projects.is_explicit END
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName, isExplicit ? 1 : 0) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: existingProject && existingProject.isArchived === 1 ? 'reactivated_archived' : 'created',
                project: row,
            };
        }

        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },
```

- [ ] **Step 3: 改 `getProjectPath` 入参 canonicalize**

把 `getProjectPath`（当前约 line 47-57）里的 `normalizeProjectPath` 换成 `canonicalizeProjectPath`，并给 SELECT 加 `is_explicit`：

```ts
    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = canonicalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },
```

- [ ] **Step 4: 其余 SELECT 加 `is_explicit`**

给以下三个方法的 SELECT 列都加上 `is_explicit`（保持返回 `ProjectRepositoryRow` 完整）：

- `getProjectById`（当前约 line 59-68）SELECT 加 `is_explicit`。
- `getProjectPaths`（当前约 line 89-96）SELECT 加 `is_explicit`。
- `getArchivedProjectPaths`（当前约 line 102-109）SELECT 加 `is_explicit`。

例如 `getProjectPaths`：

```ts
    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },
```

- [ ] **Step 5: 补充显式标记测试**

在 `backend/server/modules/database/tests/projects.db.integration.test.ts` 末尾追加：

```ts
test('createProjectPath promotes a non-explicit active project to explicit', async () => {
  await withIsolatedDatabase(() => {
    const discovered = projectsDb.createProjectPath('/workspace/promoted');
    assert.equal(discovered.outcome, 'created');
    assert.equal(discovered.project?.is_explicit, 0);

    const promoted = projectsDb.createProjectPath('/workspace/promoted', null, true);
    assert.equal(promoted.outcome, 'created');
    assert.equal(promoted.project?.project_id, discovered.project?.project_id);
    assert.equal(promoted.project?.is_explicit, 1);
  });
});

test('createProjectPath keeps active_conflict for an already-explicit active project', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/workspace/explicit', null, true);
    const conflict = projectsDb.createProjectPath('/workspace/explicit', null, true);
    assert.equal(conflict.outcome, 'active_conflict');
    assert.equal(conflict.project?.is_explicit, 1);
  });
});
```

- [ ] **Step 6: 运行测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/projects.db.integration.test.ts`
Expected: PASS（原 3 个测试 + 新 2 个全过）

- [ ] **Step 7: Commit**

```bash
git add backend/server/modules/database/repositories/projects.db.ts backend/server/modules/database/tests/projects.db.integration.test.ts
git commit -m "feat(db): explicit project flag + realpath canonicalization in projects repo"
```

---

## Task 4: `sessions.db.ts` 写库路径 canonicalize

**Files:**
- Modify: `backend/server/modules/database/repositories/sessions.db.ts`

- [ ] **Step 1: 改导入**

`backend/server/modules/database/repositories/sessions.db.ts` 顶部：

```ts
import { canonicalizeProjectPath, normalizeProjectPath } from '@/shared/utils.js';
```

（原为 `import { normalizeProjectPath } from '@/shared/utils.js';`）

- [ ] **Step 2: 改 `normalizeProjectPathForProvider`**

把（当前约 line 58-61）：

```ts
function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}
```

改为：

```ts
function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return canonicalizeProjectPath(projectPath);
}
```

- [ ] **Step 3: 运行既有 session 测试确认无回归**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/sessions-summary.integration.test.ts server/modules/database/tests/sessions.db.integration.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/server/modules/database/repositories/sessions.db.ts
git commit -m "feat(db): canonicalize session project_path via realpath"
```

---

## Task 5: `createProject` 服务 canonicalize + 显式写入

**Files:**
- Modify: `backend/server/modules/projects/services/project-management.service.ts`

- [ ] **Step 1: 改导入**

`backend/server/modules/projects/services/project-management.service.ts` 顶部导入改为：

```ts
import { AppError, canonicalizeProjectPath, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';
```

（原为 `import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';`）

- [ ] **Step 2: 默认 `persistProjectPath` 传显式标记**

`defaultDependencies`（约 line 56-57）改为：

```ts
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName, true),
```

- [ ] **Step 3: `createProject` canonicalize 路径**

`createProject` 里（约 line 109）：

```ts
  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
```

改为：

```ts
  const resolvedProjectPath = canonicalizeProjectPath(pathValidation.resolvedPath);
```

- [ ] **Step 4: 运行既有服务测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/tests/project-management.service.test.ts`
Expected: PASS（注入的 `persistProjectPath` 忽略第 3 参数，仍兼容）

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/projects/services/project-management.service.ts
git commit -m "feat(projects): createProject marks projects explicit + canonicalizes path"
```

---

## Task 6: 列表按 `is_explicit` 过滤

**Files:**
- Modify: `backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts`
- Modify: `backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts`
- Create: `backend/server/modules/projects/services/tests/projects-with-sessions-explicit.test.ts`

- [ ] **Step 1: 改 `getProjectsWithSessions` 过滤**

`backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts` 里 `getProjectsWithSessions`（约 line 206-212）的行类型与获取改为：

```ts
  const projectRows = (projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    is_explicit?: number;
  }>).filter((row) => Boolean(row.is_explicit));
```

- [ ] **Step 2: 改 `getArchivedProjectsWithSessions` 过滤**

`getArchivedProjectsWithSessions`（约 line 302-308）同样处理：

```ts
  const projectRows = (projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    is_explicit?: number;
  }>).filter((row) => Boolean(row.is_explicit));
```

- [ ] **Step 3: 更新既有测试 `operator-workspace-mark.test.ts`**

把（约 line 40-41）：

```ts
    projectsDb.createProjectPath(workspace);
    projectsDb.createProjectPath(regular);
```

改为显式创建：

```ts
    projectsDb.createProjectPath(workspace, null, true);
    projectsDb.createProjectPath(regular, null, true);
```

- [ ] **Step 4: 写失败测试**

创建 `backend/server/modules/projects/services/tests/projects-with-sessions-explicit.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import {
  getArchivedProjectsWithSessions,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: (dir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'projects-explicit-'));
  const explicitDir = path.join(dir, 'explicit');
  const discoveredDir = path.join(dir, 'discovered');
  await mkdir(explicitDir, { recursive: true });
  await mkdir(discoveredDir, { recursive: true });
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('getProjectsWithSessions only returns explicit projects', async () => {
  await withIsolatedDatabase(async (dir) => {
    projectsDb.createProjectPath(path.join(dir, 'explicit'), null, true);
    projectsDb.createProjectPath(path.join(dir, 'discovered'));

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const paths = projects.map((p) => p.fullPath);
    assert.ok(paths.includes(path.join(dir, 'explicit')));
    assert.ok(!paths.includes(path.join(dir, 'discovered')));
  });
});

test('getArchivedProjectsWithSessions only returns explicit projects', async () => {
  await withIsolatedDatabase(async (dir) => {
    projectsDb.createProjectPath(path.join(dir, 'explicit-archived'), null, true);
    projectsDb.createProjectPath(path.join(dir, 'discovered-archived'));
    projectsDb.updateProjectIsArchivedById(
      projectsDb.getProjectPath(path.join(dir, 'explicit-archived'))!.project_id,
      true,
    );
    projectsDb.updateProjectIsArchivedById(
      projectsDb.getProjectPath(path.join(dir, 'discovered-archived'))!.project_id,
      true,
    );

    const archived = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    const paths = archived.map((p) => p.fullPath);
    assert.ok(paths.includes(path.join(dir, 'explicit-archived')));
    assert.ok(!paths.includes(path.join(dir, 'discovered-archived')));
  });
});
```

- [ ] **Step 5: 运行测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/projects/services/tests/projects-with-sessions-explicit.test.ts server/modules/projects/services/tests/operator-workspace-mark.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts backend/server/modules/projects/services/tests/operator-workspace-mark.test.ts backend/server/modules/projects/services/tests/projects-with-sessions-explicit.test.ts
git commit -m "feat(projects): project list only returns explicitly created projects"
```

---

## Task 7: watcher 抑制非显式项目的 `session_upserted`

**Files:**
- Modify: `backend/server/modules/providers/services/sessions-watcher.service.ts`
- Create: `backend/server/modules/providers/services/tests/sessions-watcher-explicit.test.ts`

- [ ] **Step 1: 导出并改 `buildSessionUpsertedEvent`**

`backend/server/modules/providers/services/sessions-watcher.service.ts` 里：

- 把 `async function buildSessionUpsertedEvent(...)` 改为 `export async function buildSessionUpsertedEvent(...)`（约 line 123）。
- 在 `const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;`（约 line 131）之后加：

```ts
  if (project && !project.is_explicit) {
    return null;
  }
```

- [ ] **Step 2: 写失败测试**

创建 `backend/server/modules/providers/services/tests/sessions-watcher-explicit.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { buildSessionUpsertedEvent } from '@/modules/providers/services/sessions-watcher.service.js';

async function withIsolatedDatabase(runTest: (dir: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'watcher-explicit-'));
  await mkdir(path.join(dir, 'explicit'), { recursive: true });
  await mkdir(path.join(dir, 'discovered'), { recursive: true });
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('buildSessionUpsertedEvent skips sessions whose project is not explicit', async () => {
  await withIsolatedDatabase(async (dir) => {
    const explicitPath = path.join(dir, 'explicit');
    const discoveredPath = path.join(dir, 'discovered');

    projectsDb.createProjectPath(explicitPath, null, true);
    sessionsDb.createSession('sess-explicit', 'claude', explicitPath);

    sessionsDb.createSession('sess-discovered', 'claude', discoveredPath);

    assert.ok((await buildSessionUpsertedEvent('sess-explicit')) !== null);
    assert.equal(await buildSessionUpsertedEvent('sess-discovered'), null);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/services/tests/sessions-watcher-explicit.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/server/modules/providers/services/sessions-watcher.service.ts backend/server/modules/providers/services/tests/sessions-watcher-explicit.test.ts
git commit -m "feat(watcher): suppress session_upserted for non-explicit projects"
```

---

## Task 8: 同步器移除 `normalizeToWorkspaceRoot`

**Files:**
- Modify: `backend/server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`
- Modify: `backend/server/modules/providers/list/codex/codex-session-synchronizer.provider.ts`

- [ ] **Step 1: claude 同步器**

`claude-session-synchronizer.provider.ts`：

- 移除导入列表里的 `normalizeToWorkspaceRoot`（约 line 11）。
- 把（约 line 128-130）：

```ts
      const projectPath =
        typeof data.cwd === 'string' ? normalizeToWorkspaceRoot(data.cwd) : undefined;
```

改为：

```ts
      const projectPath =
        typeof data.cwd === 'string' ? data.cwd : undefined;
```

（写库边界 `sessionsDb.createSession` → `normalizeProjectPathForProvider` 会统一 realpath。）

- [ ] **Step 2: codex 同步器**

`codex-session-synchronizer.provider.ts`：

- 移除导入列表里的 `normalizeToWorkspaceRoot`（约 line 11）。
- 把（约 line 116-117）：

```ts
      const projectPath =
        typeof payload?.cwd === 'string' ? normalizeToWorkspaceRoot(payload.cwd) : undefined;
```

改为：

```ts
      const projectPath =
        typeof payload?.cwd === 'string' ? payload.cwd : undefined;
```

- [ ] **Step 3: 运行同步器既有测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-synchronizer-summary.test.ts server/modules/providers/tests/codex-synchronizer-summary.test.ts server/modules/providers/tests/codex-sessions.test.ts server/modules/providers/tests/opencode-synchronizer.test.ts server/modules/providers/tests/qoder-synchronizer.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/server/modules/providers/list/claude/claude-session-synchronizer.provider.ts backend/server/modules/providers/list/codex/codex-session-synchronizer.provider.ts
git commit -m "refactor(providers): store raw cwd, canonicalize at write boundary"
```

---

## Task 9: 历史路径 canonical 合并迁移

**Files:**
- Modify: `backend/server/modules/database/migrations.ts`
- Create: `backend/server/modules/database/tests/canonicalize-project-paths-migration.test.ts`

- [ ] **Step 1: 实现 `canonicalizeProjectPathsMigration`**

在 `backend/server/modules/database/migrations.ts` 顶部导入 `canonicalizeProjectPath`：

```ts
import { canonicalizeProjectPath } from '@/shared/utils.js';
```

在文件里、`migrateProjectsExplicitColumn` 之后新增：

```ts
/**
 * One-time canonicalization of stored project paths.
 *
 * Walks every `projects` row and re-keys it to its real (symlink-resolved)
 * path. When two rows resolve to the same physical directory (a symlink-path
 * row and a real-path row), the duplicate is merged into the survivor: child
 * `sessions` / `tasks` rows are repointed first (their FKs reference
 * `projects(project_path)`), the surviving project row absorbs the doomed
 * row's flags/name, then the doomed row is deleted.
 */
export function canonicalizeProjectPathsMigration(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');

  const rows = db
    .prepare('SELECT project_id, project_path FROM projects')
    .all() as Array<{ project_id: string; project_path: string }>;

  for (const row of rows) {
    const canonical = canonicalizeProjectPath(row.project_path);
    if (!canonical || canonical === row.project_path) {
      continue;
    }

    const survivor = db
      .prepare('SELECT project_id FROM projects WHERE project_path = ?')
      .get(canonical) as { project_id: string } | undefined;

    if (survivor) {
      const doomed = db
        .prepare(
          'SELECT project_id, custom_project_name, isStarred, isArchived, is_explicit FROM projects WHERE project_id = ?'
        )
        .get(row.project_id) as {
        project_id: string;
        custom_project_name: string | null;
        isStarred: number;
        isArchived: number;
        is_explicit: number;
      };
      const keep = db
        .prepare(
          'SELECT project_id, custom_project_name, isStarred, isArchived, is_explicit FROM projects WHERE project_id = ?'
        )
        .get(survivor.project_id) as typeof doomed;

      db.prepare('UPDATE sessions SET project_path = ? WHERE project_path = ?').run(canonical, row.project_path);
      db.prepare('UPDATE tasks SET project_path = ? WHERE project_path = ?').run(canonical, row.project_path);
      db.prepare(
        'UPDATE projects SET custom_project_name = ?, isStarred = ?, isArchived = ?, is_explicit = ? WHERE project_id = ?'
      ).run(
        keep.custom_project_name ?? doomed.custom_project_name,
        keep.isStarred || doomed.isStarred,
        keep.isArchived || doomed.isArchived,
        keep.is_explicit || doomed.is_explicit,
        keep.project_id,
      );
      db.prepare('DELETE FROM projects WHERE project_id = ?').run(doomed.project_id);
      continue;
    }

    // No existing canonical row: rename in place. The FK ON UPDATE CASCADE on
    // sessions/tasks repoints child rows automatically.
    db.prepare('UPDATE projects SET project_path = ? WHERE project_id = ?').run(canonical, row.project_id);
  }
}
```

在 `runMigrations` 里、`migrateProjectsExplicitColumn(db);` 之后加：

```ts
    migrateProjectsExplicitColumn(db);
    canonicalizeProjectPathsMigration(db);
```

- [ ] **Step 2: 写失败测试**

创建 `backend/server/modules/database/tests/canonicalize-project-paths-migration.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { canonicalizeProjectPathsMigration } from '@/modules/database/migrations.js';

async function withIsolatedDatabase(runTest: (dir: string, real: string, link: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'canon-migrate-'));
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  await mkdir(real, { recursive: true });
  await symlink(real, link);
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(dir, real, link);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('merges symlink-path project into its real-path duplicate', async () => {
  await withIsolatedDatabase(async (_dir, real, link) => {
    const db = getConnection();

    // Raw inserts bypass the repo's canonicalization to simulate legacy data.
    db.prepare(
      "INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit) VALUES ('symlink-id', ?, 'symlink-name', 1, 0, 1)"
    ).run(link);
    db.prepare(
      "INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit) VALUES ('real-id', ?, NULL, 0, 0, 0)"
    ).run(real);
    db.prepare(
      "INSERT INTO sessions (session_id, provider, project_path) VALUES ('sess-1', 'claude', ?)"
    ).run(link);

    canonicalizeProjectPathsMigration(db);

    const projects = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown>>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project_id, 'real-id');
    assert.equal(projects[0].project_path, real);
    assert.equal(projects[0].custom_project_name, 'symlink-name');
    assert.equal(projects[0].isStarred, 1);
    assert.equal(projects[0].is_explicit, 1);

    const session = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get('sess-1') as { project_path: string };
    assert.equal(session.project_path, real);
  });
});

test('renames in place when no real-path duplicate exists', async () => {
  await withIsolatedDatabase(async (_dir, real, link) => {
    const db = getConnection();
    db.prepare(
      "INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived, is_explicit) VALUES ('only-id', ?, NULL, 0, 0, 1)"
    ).run(link);
    db.prepare(
      "INSERT INTO sessions (session_id, provider, project_path) VALUES ('sess-2', 'claude', ?)"
    ).run(link);

    canonicalizeProjectPathsMigration(db);

    const projects = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown>>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project_path, real);

    const session = db.prepare('SELECT project_path FROM sessions WHERE session_id = ?').get('sess-2') as { project_path: string };
    assert.equal(session.project_path, real);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/canonicalize-project-paths-migration.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/server/modules/database/migrations.ts backend/server/modules/database/tests/canonicalize-project-paths-migration.test.ts
git commit -m "feat(db): migrate legacy symlink project paths to realpath"
```

---

## Task 10: 全量验证

- [ ] **Step 1: 后端类型检查**

Run: `cd backend && npm run typecheck`
Expected: 无类型错误

- [ ] **Step 2: 跑全部后端测试**

Run: `cd backend && find server -name '*.test.ts' -o -name '*.test.js' | xargs npx tsx --tsconfig server/tsconfig.json --test`
Expected: 全部 PASS（关键回归点是 projects / database / providers / tasks / routes / shared 模块测试）

- [ ] **Step 3: 前端类型检查（应无改动、无回归）**

Run: `cd web && npm run typecheck`
Expected: 无类型错误

- [ ] **Step 4: 最终提交（如有遗漏文件）**

```bash
git status
# 如有未提交的本任务相关文件，补 git add + commit
```
