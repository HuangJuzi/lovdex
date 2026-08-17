# 项目列表只显示显式创建的项目 + 项目路径 canonical 化（realpath）设计

- 日期：2026-08-17
- 状态：设计待评审
- 相关：`docs/superpowers/specs/2026-08-11-lovdex-assistant-project-design.md`、`backend/server/modules/projects/`、`backend/server/modules/database/migrations.ts`

## 1. 背景与目标

侧边栏「Project 列表」的数据源是 `GET /api/projects` → `getProjectsWithSessions()` → `projects` 表。当前 `projects` 表由两类写入填充：

1. **显式创建**：用户在 lovdex「新建项目」向导里创建本地目录（`POST /api/projects/create-project`）或克隆仓库（`/clone-progress`），两者最终都走 `createProject()`。
2. **磁盘扫描自动发现**：四个 provider 的会话同步器（claude/codex 扫 `~/.claude`、`~/.codex`；opencode 读 `opencode.db`；qoder 扫 `~/.qoder/projects`）发现会话时，`sessionsDb.createSession()` 会顺带 `projectsDb.createProjectPath()` 注册项目。

这导致项目列表被大量「不是用户显式创建」的项目污染（`/tmp/*`、`multica_workspaces/*`、`.sophcode*`、operator 工作区、home 根目录等）。

同时，路径存储存在两套拼写，产生**重复项目**：

- claude/codex 同步器用 `normalizeToWorkspaceRoot()` 把真实路径**反向映射回软链路径**（`/mnt/b/workdir/foo` → `/home/zhijuhuang/workdir/foo`）。
- opencode/qoder 存的是原始 `cwd`（真实路径 `/mnt/b/workdir/foo`）。

同一个物理目录因此被存成两个 `project_path`，绕过 UNIQUE 约束，在列表里出现两条（如 `/home/zhijuhuang/workdir/github/lovdex` 与 `/mnt/b/workdir/github/lovdex`）。

目标（已与用户确认）：

1. **项目列表只显示显式创建（向导 create-project / clone）的项目和会话**，不显示磁盘扫描自动发现的项目。
2. **项目路径统一用真实绝对路径（`fs.realpath` 解析软链）**，并把已有数据库里的软链路径修复（合并重复）。

## 2. 关键设计决策

### 2.1 显式项目标记 `is_explicit`

- `projects` 表新增 `is_explicit INTEGER DEFAULT 0`（`1` = 用户显式创建）。
- `createProject()`（向导 create-project 与 clone 共同入口）传入 `isExplicit: true`；磁盘同步（`sessionsDb.createSession()`）与 app 会话（`createAppSession()`）保持默认 `false`。
- 冲突/恢复归档时若传入 explicit，则把既有行提升为 explicit（不覆盖回 0）。

**只收窄「Project list」展示入口，不改其它查询**：

- 在 `getProjectsWithSessions()` / `getArchivedProjectsWithSessions()` 里过滤 `is_explicit = 1`。
- 刻意**不改** `projectsDb.getProjectPaths()`（operator 工具 `listProjects` 仍能看到全部项目）、`getProjectPath()`（`/session/:id` 仍能解析隐藏项目的历史会话）、会话搜索（`session-conversations-search`）。
- watcher 的 `buildSessionUpsertedEvent()`：项目非 explicit 时返回 `null`，**不广播** `session_upserted`，否则前端会把它重新加回列表。

### 2.2 路径 canonical 化（realpath）

- `shared/utils.ts` 新增 `canonicalizeProjectPath(input)`：`fs.realpathSync(input)` 成功则 `normalizeProjectPath(realpath)`，失败回退 `normalizeProjectPath(input)`（词法）。
- 两个写库边界统一 canonicalize：
  - `projectsDb.createProjectPath()` 入库前 canonicalize。
  - `sessions.db.ts` 的 `normalizeProjectPathForProvider()` 改为 canonicalize（被 `createSession`/`createAppSession`/两个 `find*Pending*` 复用），保证 session 的 `project_path` 与 project 行一致。
- `createProject()`（向导）在 `validateWorkspacePath()` 之后、持久化之前，把 `resolvedPath` canonicalize 成真实路径。
- claude/codex 同步器**移除 `normalizeToWorkspaceRoot()` 调用**，直接传原始 `cwd`（写库边界会统一 realpath）。opencode/qoder 无需改动（写库边界兜底）。
- `getProjectPath()` 的入参也 canonicalize，使软链路径的查找能命中 canonical 存储的行。
- `validateWorkspacePath()` 的**词法包含检查保持不变**（向导输入仍需落在 `~` 下，如 `~/workdir/foo`），仅最终持久化的是真实路径 `/mnt/b/workdir/foo`。不改变 workspace-root 语义。

### 2.3 归档/删除与过滤的关系（正交）

侧边栏「删除项目」垃圾桶按钮打开**同一个确认弹窗**，里面两个按钮都走 `DELETE /api/projects/:id?force=`：

- **Archive project**（`force=false`）→ `deleteOrArchiveProject()` 设 `isArchived=1`：从主列表隐藏、数据保留、归档视图可恢复。
- **Delete all data**（`force=true`）→ 删 DB 行 + 删磁盘 `jsonl` 会话文件：永久删除。

两者都让项目从主列表消失，这是现有行为，与本次 `is_explicit` 过滤**正交、互不破坏**。归档视图同样按 `is_explicit` 过滤（与主列表一致）；因 ① 选择 A（现有项目全部不显式），归档视图里本就不会出现旧的自动发现项目。

### 2.4 现有数据处理（已确认：选项 A）

`projects` 表目前**无任何字段**能区分「向导创建」与「磁盘扫描自动发现」（两者 `custom_project_name` 都是 basename）。迁移后 `is_explicit` 全部默认 `0` → 现有自动发现项目**全部从列表消失、列表变空**，用户用「新建项目」重新加入自己真正在用的项目。

## 3. 后端改动（lovdex-backend）

### 3.1 schema

`backend/server/modules/database/schema.ts` → `PROJECTS_TABLE_SCHEMA_SQL` 增加：

```sql
is_explicit INTEGER DEFAULT 0
```

### 3.2 类型

`backend/server/shared/types.ts` → `ProjectRepositoryRow` 增加 `is_explicit: number;`。

### 3.3 路径工具

`backend/server/shared/utils.ts` 新增：

```ts
export function canonicalizeProjectPath(inputPath: string): string {
  // fs.realpathSync(inputPath) 成功 → normalizeProjectPath(real)
  // 失败 → normalizeProjectPath(inputPath)
}
```

### 3.4 projects 仓库

`backend/server/modules/database/repositories/projects.db.ts`：

- 所有 SELECT / RETURNING 增加 `is_explicit`。
- `createProjectPath(projectPath, customName = null, isExplicit = false)`：
  - 入参先 `canonicalizeProjectPath`。
  - INSERT 写入 `is_explicit = isExplicit ? 1 : 0`。
  - `ON CONFLICT(project_path) DO UPDATE`（仅恢复归档分支）追加 `is_explicit = CASE WHEN excluded.is_explicit = 1 THEN 1 ELSE projects.is_explicit END`。
- `getProjectPath()`：入参先 canonicalize 再查询（软链查找命中 canonical 行）。
- `getProjectPaths()` / `getArchivedProjectPaths()`：SELECT 增加 `is_explicit`，**不加 WHERE 过滤**（过滤放在 service 层）。

### 3.5 sessions 仓库

`backend/server/modules/database/repositories/sessions.db.ts`：

- `normalizeProjectPathForProvider()` 改用 `canonicalizeProjectPath`。

### 3.6 项目服务

`backend/server/modules/projects/services/project-management.service.ts`：

- 导入 `canonicalizeProjectPath`。
- `createProject()`：`resolvedProjectPath = canonicalizeProjectPath(pathValidation.resolvedPath)`，再走 `ensureWorkspaceDirectory` / `persistProjectPath`。
- 默认依赖 `persistProjectPath` 调 `projectsDb.createProjectPath(projectPath, customName, true)`（显式）。
- `CreateProjectDependencies.persistProjectPath` 签名扩展为接受 `isExplicit`（默认实现硬编码 `true`）。

### 3.7 列表服务

`backend/server/modules/projects/services/projects-with-sessions-fetch.service.ts`：

- `getProjectsWithSessions()`：`projectRows` 过滤 `Boolean(row.is_explicit)`。
- `getArchivedProjectsWithSessions()`：同样过滤。
- 行类型补 `is_explicit`。

### 3.8 watcher

`backend/server/modules/providers/services/sessions-watcher.service.ts`：

- `buildSessionUpsertedEvent()`：`project` 存在且 `!project.is_explicit` 时 `return null`。

### 3.9 同步器

- `claude-session-synchronizer.provider.ts`：移除 `normalizeToWorkspaceRoot` 导入与调用，`projectPath` 直接用 `data.cwd`。
- `codex-session-synchronizer.provider.ts`：同上，`projectPath` 直接用 `payload.cwd`。

### 3.10 迁移

`backend/server/modules/database/migrations.ts` 新增两个幂等步骤（在 `ensureProjectsForSessionPaths()` 之后调用）：

1. `migrateProjectsExplicitColumn(db)`：`addColumnToTableIfNotExists(db, 'projects', cols, 'is_explicit', 'INTEGER DEFAULT 0')`。
2. `canonicalizeProjectPathsMigration(db)`：遍历 `projects`，对每行：
   - `canonical = canonicalizeProjectPath(project_path)`；`canonical === project_path` 则跳过。
   - 若 `projects` 已存在 `project_path = canonical` 的行（重复）：
     - `UPDATE sessions SET project_path = canonical WHERE project_path = 旧路径`；
     - `UPDATE tasks SET project_path = canonical WHERE project_path = 旧路径`；
     - 合并标记到存活行：`is_explicit`/`isStarred`/`isArchived` 取 OR，`custom_project_name` 取非空；
     - `DELETE FROM projects WHERE project_id = 旧行 id`。
   - 否则 `UPDATE projects SET project_path = canonical WHERE project_id = 旧行 id`（FK `ON UPDATE CASCADE` 自动级联 sessions/tasks）。

> 说明：FK 关系为 sessions `ON DELETE SET NULL / ON UPDATE CASCADE`、tasks `ON DELETE CASCADE / ON UPDATE CASCADE`，因此合并前必须先手动把子表改指到存活行，再删 doomed 行。

## 4. 前端改动

无。`fullPath` 直接来自后端，过滤在前端不可见（watcher 已抑制非显式项目事件）。

## 5. 测试

沿用 `node:test` + 隔离 SQLite（`npx tsx --tsconfig server/tsconfig.json --test <file>`）。

1. `shared/tests/canonicalize-project-path.test.ts`：realpath 解析软链；路径不存在时回退词法。
2. `database/tests/projects-explicit-migration.test.ts`：`is_explicit` 列存在；软链重复路径迁移后合并为真实路径，sessions/tasks 正确改指，标记 OR 合并。
3. `projects/tests/projects-with-sessions-explicit.test.ts`：`getProjectsWithSessions()` / `getArchivedProjectsWithSessions()` 只返回 `is_explicit=1` 的项目。
4. `providers/tests/sessions-watcher-explicit.test.ts`（可选，需导出 `buildSessionUpsertedEvent`）：非显式项目的会话不产生 `session_upserted` 事件。

## 6. 影响与风险

- **行为变化**：迁移后现有自动发现项目从列表消失（已确认，选项 A）。列表为空的用户需「新建项目」重新加入。
- **operator 工具** `listProjects` 仍返回全部项目，不受影响。
- **`/session/:id` 解析**：`getProjectPath()` 不被过滤，隐藏项目的历史会话仍可打开。
- **归档视图**：同样只显示显式项目，与主列表一致。
