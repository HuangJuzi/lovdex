# Source Control 移植（Phase 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 claudecodeui 的 Source Control 面板（Git 四视图 + worktrees）移植进 lovdex，后端新增 `/api/git` 与 `/api/worktrees` 路由，前端恢复 git 标签页真面板。

**Architecture:** 后端整体拷贝 claudecodeui 的 `server/modules/git/` 与 `server/modules/worktrees/`，适配点只有：删除 AI 提交信息（`queryQoder` 依赖 + route + 两个 helper）、工作目录解析接入 lovdex `projectsDb.getProjectPathById`、worktrees gateway 接入 lovdex projects 服务。前端整体拷贝 `components/git-panel/`（剔除 `useSelectedProvider` + AI generate 调用），MainContent 里 Phase 1 的 git 占位替换为真 `<GitPanel>`。

**Tech Stack:** Express 4 routers / cross-spawn 跑 git / better-sqlite3 projects 表 / React 18 + Tailwind（面板零外部依赖，只用 lucide）+ Node `node:test` + tsx 测试。

**设计文档:** `docs/superpowers/specs/2026-08-13-files-source-control-port-design.md`（§4、§5）
**前置:** Phase 1 已交付（git 标签已在 MainContentTabs，占位空态在 MainContent）。

---
## 前置与约定

- 源根（只读参考）：`CCUI=/home/zhijuhuang/workdir/claudecodeui`
- 后端仓库：`BACK=/mnt/b/workdir/github/lovdex/lovdex-backend`；前端：`CLI=/mnt/b/workdir/github/lovdex/lovdex-cli`（各自独立 git repo，都在 main，提交直接落 main）
- **环境坑**：shell 全局 export 了 `TSX_TSCONFIG_PATH=server/tsconfig.json`。跑 cli 测试前 `unset TSX_TSCONFIG_PATH`；后端测试命令用 `npx tsx --tsconfig server/tsconfig.json --test <file>`（已实测）。
- **本阶段范围修正**（研究结论，优于原 spec §4.2）：git-panel 前端**不经过 `api.js`**——claudecodeui 的面板直接调 `authenticatedFetch` + 原始 URL。因此 **`api.js` 零改动**，与上游一致。
- **后端重启纪律**（memory `lovdex-backend-restart-requires-confirm`）：任何 `systemctl --user lovdex` 重启前**先征求用户同意**。后端验证优先用**测试**（临时 git 仓库，不起服务器）与**临时实例**（`SERVER_PORT` 替代端口，不碰生产 3001）。最终的浏览器验证才需要重启生产后端——该步骤单独成任务，明确要求先问用户。
- git 模块错误 envelope：保留 claudecodeui 原始字段名（`{error, details, notGitRepository}`），前端 `useGitPanelController` 直接读它们（特别是 `/status` 对"非 git 仓库"用 200 + `notGitRepository:true`，不能改成抛 AppError）。
- `git.routes.ts` 顶部有 `// @ts-nocheck`（claudecodeui 自带），拷贝后保留。

## File Structure Map

**后端新建（lovdex-backend `server/modules/`下）**
```
modules/git/index.ts                  # barrel（新建，2 行）
modules/git/git.module.ts             # 适配（去掉 queryQoder）
modules/git/git.routes.ts             # 拷贝 + 删 AI route/helpers
modules/git/git-parsing.service.ts    # 原样拷贝
modules/git/tests/git-parsing.test.ts # 新建（node:test）
modules/git/tests/git.routes.test.ts  # 新建（临时 git 仓库 + withServer）
modules/worktrees/**                  # 整目录拷贝（routes+services+tests），web 改 worktrees.module.ts 的 gateway
```
**后端修改**
```
server/index.js                       # import + 挂载 /api/git、/api/worktrees
```
**前端新建（lovdex-cli）**
```
src/components/git-panel/**           # 拷贝（22 个非测试文件 + commitGraph.test.ts），删 useSelectedProvider.ts，改 useGitPanelController.ts
src/components/git-panel/utils/gitPanelUtils.test.ts  # 新建简易测试
```
**前端修改**
```
src/components/main-content/types/types.ts        # MainContentProps 加 onProjectSelect/onProjectsRefresh
src/components/app/AppContent.tsx                  # 传 handleProjectSelect/refreshProjectsSilently
src/components/main-content/view/MainContent.tsx   # git 占位 → <GitPanel/>
```

---

### Task B1: 后端 git 模块移植（不含 AI 提交信息）

**Files:**
- Create: `$BACK/server/modules/git/git.routes.ts`、`git-parsing.service.ts`、`index.ts`、`git.module.ts`

- [ ] **Step 1: 拷贝两个原样文件**

Run:
```bash
mkdir -p $BACK/server/modules/git
cp $CCUI/server/modules/git/git.routes.ts $BACK/server/modules/git/git.routes.ts
cp $CCUI/server/modules/git/git-parsing.service.ts $BACK/server/modules/git/git-parsing.service.ts
```

- [ ] **Step 2: 从 git.routes.ts 删除 AI 提交信息**

用 grep 定位并删除三块 + DI 里的 `queryQoder`（`@ts-nocheck` 文件，删除时小心保持路由连续）：

1. `GitRouterDependencies` 类型里的 `queryQoder: ProviderRunFunction;` 行（应删，使 `ProviderRunFunction` 类型不再被引用；删后若无其他用处，删对应 import 引用）
2. `const spawnQoder = dependencies.queryQoder;` 行
3. 整个 `router.post('/generate-commit-message', ...)` 路由块（含其内部调用的 `generateCommitMessageWithAI` 与 `cleanCommitMessage` 两个函数——从 `router.post('/generate-commit-message'` 一直删到下一个顶级路线定义之前）

删除后验证：
```bash
cd $BACK && grep -cn "generate-commit-message\|spawnQoder\|queryQoder\|ProviderRunFunction" server/modules/git/git.routes.ts
```
Expected: `0`（全部删干净；若 ProviderRunFunction 类型定义留在别处没报错可保留，但引用必须清零）。

- [ ] **Step 3: 写 git.module.ts（适配 lovdex 装配）**

Create `$BACK/server/modules/git/git.module.ts`：

```ts
import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';

import { createGitRouter } from './git.routes.js';

/** Assembles the Git router with the lovdex DB-backed project path resolver. */
export function createGitModule() {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  });
}
```

- [ ] **Step 4: 写 barrel**

Create `$BACK/server/modules/git/index.ts`：

```ts
export { createGitModule } from './git.module.js';
```

- [ ] **Step 5: 后端 typecheck（暂不挂载也能过，只要无孤立错误）**

Run: `cd $BACK && npx tsc --noEmit -p server/tsconfig.json`
Expected: exit 0（git.routes.ts 有 @ts-nocheck 不受影响；git.module.ts/git-parsing.service.ts 应干净）。

- [ ] **Step 6: 提交**

```bash
cd $BACK && git add server/modules/git && git commit -m "feat: port git routes module from claudecodeui (no AI commit message)"
```

---

### Task B2: 后端 worktrees 模块移植

**Files:**
- Create: `$BACK/server/modules/worktrees/**`（整目录拷贝）

- [ ] **Step 1: 拷贝整目录**

Run:
```bash
cp -r $CCUI/server/modules/worktrees $BACK/server/modules/worktrees
```

- [ ] **Step 2: 核实 import 路径可用性**

Run: `cd $BACK && grep -rn "from '@/modules/projects\|from '@/modules/database" server/modules/worktrees/ | head`
Expected: 只有 `projectsDb`/projects 服务的 `@/` import（这些在 lovdex 都存在）。

- [ ] **Step 3: 改写 worktrees.module.ts 的 gateway（接入 lovdex projects 服务）**

lovdex 与 claudecodeui 的差异：
- `createProject` 在 lovdex 对 `active_conflict` **抛 409 AppError**（claudecodeui 是返回 outcome）；且 `mapProjectRowToApiView` 未导出。
- `restoreArchivedProject`、`deleteOrArchiveProject` 在 `@/modules/projects/services/project-delete.service.js`（`projects/index.ts` 只再导出了 deleteOrArchiveProject，restore 需直接按 service 路径 import）。
- `projectsDb.getProjectPath` 返回行含 `project_id/project_path/custom_project_name/isStarred/isArchived`。

把 `worktrees.module.ts` 里 `WorktreeProjectGateway` 的装配（参考原文件中 `worktreeProjects` 对象）替换为：

```ts
import * as path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { AppError } from '@/shared/utils.js';

// Matches the project view shape the ported worktree services consume
// (projectId/path/fullPath/displayName/isStarred, sessions + sessionMeta empty).
function mapWorktreeProjectRow(row: {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred?: number;
} & Record<string, unknown>): Record<string, unknown> {
  return {
    projectId: row.project_id,
    path: row.project_path,
    fullPath: row.project_path,
    displayName: row.custom_project_name ?? path.basename(row.project_path),
    isStarred: Boolean(row.isStarred),
    sessions: [],
    sessionMeta: { hasMore: false, total: 0 },
  };
}

const worktreeProjects = {
  getProjectPathById: (projectId: string) => projectsDb.getProjectPathById(projectId),
  getProjectByPath: (projectPath: string) => projectsDb.getProjectPath(projectPath),
  createProject: async (input: { projectPath: string; customName?: string }) => {
    try {
      const result = await createProject(input);
      return { outcome: result.outcome, project: result.project };
    } catch (error) {
      // lovdex throws AppError(409 PROJECT_ALREADY_EXISTS) where claudecodeui
      // returned an outcome; openWorktreeAsProject re-reads the row afterwards,
      // so mapping the surviving row here preserves the original flow.
      if (error instanceof AppError && error.code === 'PROJECT_ALREADY_EXISTS') {
        const row = projectsDb.getProjectPath(input.projectPath);
        if (row) {
          return { outcome: 'created', project: mapWorktreeProjectRow(row) };
        }
      }
      throw error;
    }
  },
  restoreProject: (projectId: string) => restoreArchivedProject(projectId),
  archiveProject: (projectId: string) => deleteOrArchiveProject(projectId, false),
};
```

> 若 `WorktreeProjectGateway` 接口（定义在 worktrees 模块的类型里）的 `createProject` 返回类型比上面窄（如 outcome 只允许 `'created' | 'reactivated_archived'`），把它加宽为 `'created' | 'reactivated_archived' | 'active_conflict'`，或在该适配层用 `as never`/结构化断言收窄——以 typecheck 干净为准。

- [ ] **Step 4: 后端 typecheck + 跑 worktrees 自带给的测试**

Run:
```bash
cd $BACK && npx tsc --noEmit -p server/tsconfig.json
npx tsx --tsconfig server/tsconfig.json --test server/modules/worktrees/tests/worktree-git.service.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/worktrees/tests/worktree-list.service.test.ts
```
Expected: typecheck exit 0；两个 service 测试 pass（这是纯解析/逻辑测试，不依赖真 worktree）。若个别自测试因 import 差别失效：修测试 import 的路径为 `@/...` 或相对路径（与 lovdex 测试惯例一致），**不改被测代码**。

- [ ] **Step 5: 提交**

```bash
cd $BACK && git add server/modules/worktrees && git commit -m "feat: port worktrees module from claudecodeui"
```

---

### Task B3: 后端挂载路由

**Files:**
- Modify: `$BACK/server/index.js`

- [ ] **Step 1: 加 import**

在 `server/index.js` 第 49 行 `import { buildTasksRouter, createTasksService } from './modules/tasks/index.js';` 之后加：

```js
import { createGitModule } from './modules/git/index.js';
import { createWorktreesModule } from './modules/worktrees/index.js';
```

> 若 worktrees barrel 导出的不是 `createWorktreesModule`，以 `$BACK/server/modules/worktrees/index.ts` 实际导出的工厂名为准。

- [ ] **Step 2: 挂载**

在 `app.use('/api/tasks', ...)` 那行（约 281 行）之后加：

```js
// Git (Source Control) API Routes (protected)
app.use('/api/git', authenticateToken, createGitModule());

// Git worktrees API Routes (protected)
app.use('/api/worktrees', authenticateToken, createWorktreesModule());
```

- [ ] **Step 3: 后端 typecheck**

Run: `cd $BACK && npx tsc --noEmit -p server/tsconfig.json`
Expected: exit 0。

- [ ] **Step 4: 提交**

```bash
cd $BACK && git add server/index.js && git commit -m "feat: mount /api/git and /api/worktrees routes"
```

---

### Task B4: 后端测试（parsers + 路由冒烟）

**Files:**
- Create: `$BACK/server/modules/git/tests/git-parsing.test.ts`、`$BACK/server/modules/git/tests/git.routes.test.ts`

- [ ] **Step 1: parser 单测（纯函数，node:test）**

Create `$BACK/server/modules/git/tests/git-parsing.test.ts` —— 先读 `git-parsing.service.ts` 的真实导出与返回形状，再写：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGitStatusOutput,
  parseGitLogWithStats,
} from '../git-parsing.service.js';

test('parseGitStatusOutput buckets porcelain -z entries', () => {
  const output = [
    ' M src/a.ts',  // modified (worktree)
    'A  src/new.ts', // staged added
    '?? untracked.txt', // untracked
    'D  gone.ts',    // staged deleted
  ].join('\0') + '\0';

  const result = parseGitStatusOutput(output);
  assert.ok(result.modified.some((f) => f.path === 'src/a.ts'));
  assert.ok(result.staged.some((f) => f.path === 'src/new.ts'));
  assert.ok(result.untracked.some((f) => f.path === 'untracked.txt'));
  assert.ok(result.deleted.some((f) => f.path === 'gone.ts'));
});

test('parseGitLogWithStats parses \\x1f-separated log lines with shortstat', () => {
  const line = 'abc123\tex\x1f\x1f\x1fAlice\x1fa@b.c\x1f2026-01-01T00:00:00Z\x1fAdd tests\n 1 file changed, 5 insertions(+), 2 deletions(-)';
  const commits = parseGitLogWithStats(line);
  assert.equal(commits[0].hash, 'abc123');
  assert.equal(commits[0].author, 'Alice');
  assert.equal(commits[0].message, 'Add tests');
});
```

> 字段名（`hash`/`author`/`modified`/`staged`…）以实际导出类型为准微调。若解析函数输出数组中条目结构不同，调整断言。

- [ ] **Step 2: 路由冒烟测试（临时 git 仓库 + withServer 模式）**

Create `$BACK/server/modules/git/tests/git.routes.test.ts` —— 复用 lovdex 测试惯例（`node:test` + express + ephemeral `fetch`，参考 `server/modules/auth/tests/auth.routes.test.ts` 的 `withServer` 助手）。测试要点：

1. `before`：`fs.mkdtemp` 建临时目录，里面 `git init -b main`、配 `user.name=Test`/`user.email=test@test`,创建一个文件、`git add . && git commit -m initial`。用 `projectsDb.getProjectPathById` 的反向依赖注一 —— 直接让 `withServer` 把 `createGitModule()` 用的 `resolveProjectPathById` 换成返回临时目录的恒定实现（不必真建 DB 行）：

```ts
import { createGitModule } from '../git.module.js';

// Instrument a router whose project resolver points at the temp repo.
function routerForRepo(repoPath: string) {
  // createGitModule hardcodes projectsDb; for unit tests spin the router
  // directly with an injected resolver instead:
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: () => repoPath,
  });
}
```
> 因此测试直接 import `createGitRouter`（`../git.routes.js`）+ `cross-spawn`，绕过 module：`const gitRoutes = createGitRouter({ fileSystem: fs, spawnProcess: spawn, resolveProjectPathById: () => repoDir })`。惰性实现时如 `createGitRouter` 未默认导出，用具名导出。

2. 用例：
   - `GET /api/git/status?project=repo` → 200，body 含 `{ branch: 'main', hasCommits: true }` 且无 `notGitRepository`
   - `POST /api/git/init` → `{ success: true }`（对已是 repo 返回成功或明确错误均可）
   - 在临时仓库加文件后 `POST /api/git/stage`（body `{project, files:['file.txt']}`）→ 再 `GET /api/git/status` 的 staged 含该文件
   - `POST /api/git/commit`（body `{project, message:'msg'}`）→ `GET /api/git/commits?project=repo&limit=5` 第一条 message 为该 msg
   - 末尾清理：删除临时目录

- [ ] **Step 3: 跑测试**

Run:
```bash
cd $BACK && npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git-parsing.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git.routes.test.ts
```
Expected: 全部 pass。

- [ ] **Step 4: 后端全量测试**

Run: `cd $BACK && find server -name "*.test.ts" -o -name "*.test.js" | while read f; do npx tsx --tsconfig server/tsconfig.json --test "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done | grep -c PASS`
Expected: 无 FAIL（既有 auth/tasks/worktrees 测试保持通过）。

- [ ] **Step 5: 提交**

```bash
cd $BACK && git add server/modules/git/tests && git commit -m "test: git parsers and route smoke tests"
```

---

### Task B5: 后端最终验证

- [ ] **Step 1: typecheck + lint**

Run: `cd $BACK && npx tsc --noEmit -p server/tsconfig.json && npm run lint --silent`
Expected: typecheck exit 0；lint 无 error。

- [ ] **Step 2: 提交（如有修正）**

```bash
cd $BACK && git add -A && git commit -m "fix: backend typecheck/lint for git+worktrees port"
```
（无改动则跳过。）

---

### Task F1: 前端 git-panel 移植（剔除 AI 提交信息）

**Files:**
- Create: `$CLI/src/components/git-panel/**`（拷贝，删 useSelectedProvider）
- Modify: `$CLI/src/components/git-panel/hooks/useGitPanelController.ts`、`types/types.ts`

- [ ] **Step 1: 拷贝（排除 useSelectedProvider.ts）**

Run:
```bash
cd $CLI && cp -r $CCUI/src/components/git-panel src/components/git-panel
rm src/components/git-panel/hooks/useSelectedProvider.ts
```

- [ ] **Step 2: 从 useGitPanelController.ts 删除 AI 提交信息**

grep 定位并删除（保留其余逻辑不动）：
1. `import { useSelectedProvider } from './useSelectedProvider';`（或对应 import 行）
2. `const provider = useSelectedProvider();`
3. `generateCommitMessage` 回调（`useCallback(...async (files) => { ... fetchWithAuth('/api/git/generate-commit-message' ... ) })` —— 整块,含 return 对象里给它的 `provider`/`generateCommitMessage` 键)

验证: `cd $CLI && grep -c "useSelectedProvider\|generate-commit-message\|generateCommitMessage" src/components/git-panel` → `0`。

- [ ] **Step 3: types/types.ts 清理**

删 `GitPanelController` 类型里的 `generateCommitMessage: (files: string[]) => Promise<string | null>;` 及 `GitGenerateMessageResponse` 类型（如有引用一并清理）。验证：`grep -c "generateCommit\|GitGenerateMessage" src/components/git-panel` → `0`。

- [ ] **Step 4: typecheck + 确认无孤立引用**

Run: `cd $CLI && unset TSX_TSCONFIG_PATH && npm run typecheck`
Expected: exit 0（git-panel 只依赖 `authenticatedFetch`(utils/api) 与 `Project`(types/app)，均已在 lovdex 存在；零 shared/ui import、零 i18n，已核实）。

- [ ] **Step 5: 提交**

```bash
cd $CLI && git add src/components/git-panel && git commit -m "feat: port git panel from claudecodeui (no AI commit message)"
```

---

### Task F2: 前端测试（commitGraph + gitPanelUtils）

- [ ] **Step 1: 确认 commitGraph.test.ts 可直接用**

commitGraph.test.ts 已随拷贝进来（纯算法测试，node:test?）。检查它的 import 与断言：
Run: `cd $CLI && head -20 src/components/git-panel/utils/commitGraph.test.ts`
若是 `node:test`/`node:assert` → 直接跑。若是 vitest/jest 风格 → 用 `assert/strict` 重写 `describe/it` 为 `test`，断言等价。

- [ ] **Step 2: 跑 commitGraph 测试**

Run: `cd $CLI && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/git-panel/utils/commitGraph.test.ts`
Expected: 全 pass（若 import 路径用 `@/` 需改成相对路径）。

- [ ] **Step 3: gitPanelUtils 简易测试（新建）**

Create `$CLI/src/components/git-panel/utils/gitPanelUtils.test.ts` —— 先读 `gitPanelUtils.ts` 实际导出，对纯函数（如 change-grouping / status label）写 2-3 个断言（node:test）。参考 Phase 1 的 `fileTreeUtils.test.ts` 风格。

- [ ] **Step 4: 跑新测试 + typecheck**

Run:
```bash
cd $CLI && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/git-panel/utils/gitPanelUtils.test.ts
npm run typecheck
```
Expected: pass + exit 0。

- [ ] **Step 5: 提交**

```bash
cd $CLI && git add src/components/git-panel/utils && git commit -m "test: cover commit graph and git panel utils"
```

---

### Task F3: MainContent 集成（GitPanel 替换占位）

**Files:**
- Modify: `$CLI/src/components/main-content/types/types.ts`
- Modify: `$CLI/src/components/app/AppContent.tsx`
- Modify: `$CLI/src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: MainContentProps 加两个可选回调**

`$CLI/src/components/main-content/types/types.ts` 的 `MainContentProps` 里 `activeTab`/`setActiveTab` 附近加：

```ts
  /** Switches the app to another project — used by the Worktrees view. */
  onProjectSelect?: (project: import('../../../types/app').Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh?: () => void;
```

- [ ] **Step 2: AppContent 传参**

`$CLI/src/components/app/AppContent.tsx` 的 `<MainContent ... />` 调用里加（`useProjectsState` 已返回 `handleProjectSelect` 与 `refreshProjectsSilently`）：

```tsx
          onProjectSelect={handleProjectSelect}
          onProjectsRefresh={refreshProjectsSilently}
```
（`handleProjectSelect`/`refreshProjectsSilently` 需要在 AppContent 的解构里已存在；若未解构先补上。）

- [ ] **Step 3: MainContent 替换 git 占位 + import**

`$CLI/src/components/main-content/view/MainContent.tsx`：
1. 加 import：`import GitPanel from '../../git-panel/view/GitPanel';`
2. 函数参数解构加 `onProjectSelect`、`onProjectsRefresh`（来自 MainContentProps）
3. `{activeTab === 'git' && (...)}` 占位块替换为：

```tsx
          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel
                selectedProject={selectedProject}
                isMobile={isMobile}
                onFileOpen={handleEditorOpen}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
              />
            </div>
          )}
```
> `handleEditorOpen` 已是 useEditorSidebar 的别名（Phase 1）；GitPanel 的 `FileOpenHandler` 签名 `(filePath, diffInfo?)` 与 code-editor 的 `CodeEditorFile` 兼容（研究已确认 types 形状一致）。

- [ ] **Step 4: typecheck + lint**

Run: `cd $CLI && unset TSX_TSCONFIG_PATH && npm run typecheck && npm run lint --silent`
Expected: typecheck exit 0；lint 0 errors。

- [ ] **Step 5: 前端全量测试**

Run: `cd $CLI && unset TSX_TSCONFIG_PATH && find src -name "*.test.*" -not -path "*/node_modules/*" -exec npx tsx --test {} +`
Expected: 全 pass（含新增 commitGraph/gitPanelUtils、既有 fileTree/chat 等）。

- [ ] **Step 6: 提交**

```bash
cd $CLI && git add src/components/main-content src/components/app/AppContent.tsx && git commit -m "feat: render Git panel in MainContent source-control tab"
```

---

### Task F4: 前端构建验证

- [ ] **Step 1: build**

Run: `cd $CLI && npm run build`
Expected: vite build 成功（若有 chunk 增大 warning 属正常，报告即可）。

- [ ] **Step 2: dev server 冒烟**

Run: `cd $CLI && unset TSX_TSCONFIG_PATH && (curl -s -o /dev/null -w "%{http_code}" "http://localhost:5187/src/components/git-panel/view/GitPanel.tsx")`
Expected: `200`（vite 已热加载新模块，无编译错误）。

- [ ] **Step 3: 提交（如有修正）**

```bash
cd $CLI && git add -A && git commit -m "fix: frontend build for git panel port"
```

---

### Task V1: 临时后端实例冒烟（不碰生产）

**Files:** 无（验证）

- [ ] **Step 1: 起一个替代端口后端**

Run（后台）：
```bash
cd $BACK && SERVER_PORT=3099 npx tsx --tsconfig server/tsconfig.json server/index.js > /tmp/lovdex-backend-alt.log 2>&1 &
```
Expected: 启动无异常（日志尾部 `server listening on http://...:3099`）。若 3001 已有 supervisor 实例（一定在跑），这 `3099` 是独立实例，互不影响。

- [ ] **Step 2: 对一个真实 git 目录请求 status（用 curl 不带 token——401 是期望验证）**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer bad" "http://localhost:3099/api/git/status?project=nonexistent"
```
Expected: `401`（证明路由已挂载且鉴权生效）。若后端 AUTH_ENABLED=false 部署则返回 404 —— 同样证明路由果实。

- [ ] **Step 3: 带登录态验证（如环境需要）**

若 AUTH_ENABLED 为 true：`POST /api/auth/login`（固定账号）拿 token，再带 token `GET /api/git/status?project=<某真实项目的 projectId>`。projectId 从 `GET /api/projects` 列表取。Expected: `200` + JSON 含 `modified/staged/...` 字段（非报错）。
> 如果该步骤发现 500 等异常，返回 B1-B3 修复再验。最后杀掉临时实例：`kill %1`。

- [ ] **Step 4: 别名：是否在 3099 验证成功无所谓——生产验证仍走 V2**

---

### Task V2: 重启生产后端（需用户确认）+ 手工验证

**Files:** 无（部署）

- [ ] **Step 1: 向用户确认重启**

在开始本任务前**必须停在 Step 1**，用自然语言向用户说明：lovdex 后端需要重启以加载新增 `/api/git` 与 `/api/worktrees` 路由，同一后端跑着其他项目，请确认。**用户同意后才继续**。

- [ ] **Step 2: 重启后端**

Run（经用户同意后）:
```bash
systemctl --user restart lovdex
```
（或按 supervisor 现行部署方式重启；以 memory `lovdex-supervisor` 记录为准。）

- [ ] **Step 3: 浏览器手工验证清单**

打开 dev server（`http://localhost:5187`，/api 会代理到 3001）：
1. 选择已登录且有 git 历史的项目 → 点击 `[Source Control]` 标签 → Git 面板四视图（Changes/History/Branches/Worktrees）
2. Changes：改动 → 暂存（勾选）→ 填写提交信息 → 提交 → 列表清空、History 出现新提交
3. 展开一个 changed file → diff 视图正确（+绿/-红）；点文件 → EditorSidebar 打开且显示 diff 叠加
4. History：提交列表 + 分支图渲染；展开某提交看 commit-diff
5. Branches：新建/切换/删除分支
6. Worktrees：新建 worktree → 自动切到该 worktree 项目（侧边栏出现该项目）；merge/remove 流程
7. 对非 git 项目 → 显示 `GitRepositoryErrorState` 的 `git init` 引导；点 init 后可用
8. chat 会话、files 面板、任务页不回归；`git` 标签在刷新后停留

- [ ] **Step 4: 记录结果并完成**

有 bug → 提交修复 → 重新做对应验证。全部通过 → 任务完成。

---

## 自审记录（写计划时对照）

- **Spec 覆盖**：§4.1 后端（git 全端点保留、去 AI、错误 envelope 保留、worktree linkedProjectId 对接）→ B1-B3；§4.2 前端（四视图+modals、API 同形状、手写提交信息）→ F1；§4.3 props 对接 → F3；§5 标签/占位替换 → F3；§7 测试 → B4/F2；§8 重启约束 → V2（明确 Step 1 卡用户确认）。
- **api.js 修正**：原 spec 写"api.js 追加 git 方法"，研究中确认上游 git-panel 直接用 `authenticatedFetch` 走原始 URL（不经过 api.js），故前端 **api.js 零改动**——已在文档与 F1 里落实，交付时向用户说明。
- **已知类型风险**：worktrees gateway `createProject` 的 outcome 联合可能与 claudecodeui 服务接口略宽/窄（B2 Step 3 已给加宽/收窄指引）；git routes 测试直接注入 resolver 绕过 DB（B4 Step 2）。