# 文件管理增强（多选、拖拽移动、文件夹上传）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理 tab 支持多选（Ctrl/Cmd/Shift）、批量删除/下载 ZIP、拖拽移动（本地 + 远程 lite）、上传整个文件夹、上传/移动到子文件夹。

**Architecture:** 后端新增批量 move 路由（先检后动、整批 409）：移动的纯逻辑（去重/子孙检测/no-op）抽到 `backend/server/shared/file-move-planner.ts` 供主侧路由与 lite 端 `fs.move` 共用；lite RPC 协议新增 `fs/move` 方法并上报 capability，主侧按 capability 降级 501。前端在现有 FileTree 上增量扩展：新 `useFileTreeSelection` hook 管选中集合，树节点 `draggable` 用自定义 dataTransfer 类型区分「内部拖动 = 移动」与「外部文件 = 上传」，`webkitdirectory` input 选文件夹走现有 `relativePaths` 链路（超 20 文件前端分批）。

**Tech Stack:** 后端 Node + Express（`backend/server/index.js` 单文件路由）、lite agent（TypeScript, ws RPC）、前端 React 18 + TS（vite），测试 `node:test` + `node:assert/strict`。

**测试命令（注意 cwd 与 env，`TSX_TSCONFIG_PATH` 全局导出会劫持 `npx tsx`）：**

```bash
# 后端 server 侧（从仓库根）
cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/file-move-planner.test.ts
# lite 侧
cd backend/remote-agent && env -u TSX_TSCONFIG_PATH npm test
# 前端（web 无 DOM 测试环境，只测纯函数）
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/utils/fileTreeSelection.test.ts
# 类型检查
cd backend && npm run typecheck   # 基线有 pre-existing 错误，验收=零新增
cd web && npm run typecheck       # 基线 exit=0
```

**Spec:** `docs/superpowers/specs/2026-10-13-file-manager-enhancements-design.md`
**验收基线:** tsc/lint「零新增」错误（backend baseline 不干净）；web typecheck 必须 exit=0。
**提交信息约定:** commit message 用英文、**不加** Co-Authored-By 署名行。
**注意:** 工作区可能有并发会话的 WIP（`web/src/components/chat/utils/fileMention*`），commit 时只 `git add` 本计划涉及的文件。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `backend/server/shared/file-move-planner.ts` | 新增：批量移动纯逻辑（去重、子孙检测、no-op、冲突收集） |
| `backend/server/shared/tests/file-move-planner.test.ts` | 新增：planner 单测 |
| `backend/server/shared/agent-runtime/protocol.ts` | 改：`makeFsMoveParamsSchema` |
| `backend/remote-agent/src/fs.ts` | 改：`AllowlistedFs.move` 实现 |
| `backend/remote-agent/src/rpc-dispatch.ts` | 改：接线 `fs/move` |
| `backend/remote-agent/src/index.ts` | 改：capabilities 加 `fs/move` |
| `backend/remote-agent/src/tests/fs-move.test.ts` | 新增：lite move 单测 |
| `backend/server/modules/remote-agents/remote-fs.service.ts` | 改：客户端加 `move()` |
| `backend/server/index.js` | 改：`POST /files/move` 路由（本地 + 远程 + 501 降级） |
| `web/src/utils/api.js` | 改：`moveFiles` API |
| `web/src/components/file-tree/utils/fileTreeSelection.ts` | 新增：选择纯函数（祖先包含去重、Shift 范围、Ctrl 切换） |
| `web/src/components/file-tree/utils/fileTreeSelection.test.ts` | 新增：选择纯函数单测 |
| `web/src/components/file-tree/hooks/useFileTreeSelection.ts` | 新增：选中集合 hook |
| `web/src/components/file-tree/hooks/useFileTreeUpload.ts` | 改：分批上传、`handleFileSelect` 带 targetPath、`handleFolderSelect` |
| `web/src/components/file-tree/hooks/useFileTreeOperations.ts` | 改：批量删除、`downloadItemsAsZip` 泛化 |
| `web/src/components/file-tree/hooks/useFileTreeMove.ts` | 新增：拖拽移动（dragStart/目录 drop/根 drop） |
| `web/src/components/file-tree/view/FileTreeHeader.tsx` | 改：上传文件夹按钮 |
| `web/src/components/file-tree/view/FileContextMenu.tsx` | 改：目录菜单加「上传到此文件夹」 |
| `web/src/components/file-tree/view/FileTreeNode.tsx` | 改：选中态、draggable、per-item drop、修饰键点击 |
| `web/src/components/file-tree/view/FileTreeSelectionBar.tsx` | 新增：批量操作条 |
| `web/src/components/file-tree/view/FileTree.tsx` | 改：接线全部 |
| `web/src/i18n/locales/en/common.json` | 改：fileTree 新键 |
| `web/src/components/file-tree/constants/constants.ts` | 改：无（常量不变，仅引用） |

**Props 穿透说明：** `FileTreeNode` 已有 5 层手动 props 穿透（FileTree → Body → List → Node 递归）。本计划继续沿用手动穿透（与现状一致，不引入 context——那是无谓重构）：新增 `selection`、`selectionHandlers`、`moveHandlers` 三组 props，全部 optional。

---

## Task 1: 移动纯逻辑 `file-move-planner`（shared，TDD）

**Files:**
- Create: `backend/server/shared/file-move-planner.ts`
- Test: `backend/server/shared/tests/file-move-planner.test.ts`

说明：planner 接收**已解析的 POSIX 风格路径**（主侧由 `validatePathInProject` 产出、lite 侧由 `resolveWithinRoots` 产出），只做纯逻辑不做 IO。分隔符统一用 `/`（两个调用方都是 Linux/Unix 进程内的绝对路径）。

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/file-move-planner.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMoves, collectMoveConflicts } from '@/shared/file-move-planner.js';

test('planMoves: plain moves join targetDir + basename', () => {
  const plan = planMoves(
    [
      { path: '/proj/src/a.ts', type: 'file' },
      { path: '/proj/docs', type: 'directory' },
    ],
    '/proj/lib',
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.moves.map((m) => ({ from: m.from, to: m.to })),
    [
      { from: '/proj/src/a.ts', to: '/proj/lib/a.ts' },
      { from: '/proj/docs', to: '/proj/lib/docs' },
    ],
  );
  assert.deepEqual(plan.skippedNoOp, []);
});

test('planMoves: no-op when destination equals source', () => {
  const plan = planMoves([{ path: '/proj/lib/a.ts', type: 'file' }], '/proj/lib');
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.skippedNoOp, ['/proj/lib/a.ts']);
});

test('planMoves: rejects target inside a moved directory (or the item itself)', () => {
  // 目标就是被移动项
  const selfMove = planMoves([{ path: '/proj/docs', type: 'directory' }], '/proj/docs');
  assert.equal(selfMove.ok, false);
  if (selfMove.ok) return;
  assert.equal(selfMove.code, 'INTO_ITSELF');
  assert.equal(selfMove.path, '/proj/docs');

  // 目标是被移动项的子孙
  const intoChild = planMoves([{ path: '/proj/docs', type: 'directory' }], '/proj/docs/sub');
  assert.equal(intoChild.ok, false);
  if (intoChild.ok) return;
  assert.equal(intoChild.code, 'INTO_ITSELF');
});

test('planMoves: prefix compare is segment-aware (not raw string)', () => {
  // '/proj/docs-old' 不包含 '/proj/docs' —— 不应误判
  const plan = planMoves([{ path: '/proj/docs', type: 'directory' }], '/proj/docs-old');
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].to, '/proj/docs-old/docs');
});

test('planMoves: drops descendants of other selected items and exact duplicates', () => {
  const plan = planMoves(
    [
      { path: '/proj/docs', type: 'directory' },
      { path: '/proj/docs/sub/b.ts', type: 'file' }, // 被选中目录包含 -> 跳过
      { path: '/proj/docs', type: 'directory' },     // 重复路径 -> 跳过
      { path: '/proj/c.ts', type: 'file' },
    ],
    '/proj/lib',
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.moves.map((m) => m.from).sort(),
    ['/proj/c.ts', '/proj/docs'],
  );
});

test('collectMoveConflicts: lists names of existing destinations', async () => {
  const moves = [
    { from: '/proj/a.ts', to: '/proj/lib/a.ts', name: 'a.ts' },
    { from: '/proj/b.ts', to: '/proj/lib/b.ts', name: 'b.ts' },
  ];
  const existing = new Set(['/proj/lib/b.ts']);
  const conflicts = await collectMoveConflicts(moves, (p) => Promise.resolve(existing.has(p)));
  assert.deepEqual(conflicts, ['b.ts']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/file-move-planner.test.ts
```

Expected: FAIL（`Cannot find module '@/shared/file-move-planner.js'`）

- [ ] **Step 3: 实现 planner**

创建 `backend/server/shared/file-move-planner.ts`：

```ts
/**
 * Pure planning logic for batch file-tree moves. Shared by the main server's
 * /files/move route and the remote lite's fs.move RPC — both resolve paths
 * against their own roots first, then hand the resolved POSIX-style absolute
 * paths to the planner. No IO here: conflict detection is injected so callers
 * keep their own fs access semantics.
 */

export type MoveItem = { path: string; type: 'file' | 'directory' };

export type PlannedMove = { from: string; to: string; name: string };

export type MovePlan =
  | { ok: true; moves: PlannedMove[]; skippedNoOp: string[] }
  | { ok: false; code: 'INTO_ITSELF'; path: string };

const isUnder = (child: string, ancestor: string) =>
  child.startsWith(ancestor + '/');

export function planMoves(items: MoveItem[], targetDir: string): MovePlan {
  // Deduplicate exact paths (later duplicates dropped).
  const seen = new Set<string>();
  const unique: MoveItem[] = [];
  for (const it of items) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    unique.push(it);
  }

  // Drop items already covered by a selected ancestor directory.
  const deduped = unique.filter(
    (it) => !unique.some((other) => other.path !== it.path && isUnder(it.path, other.path)),
  );

  const moves: PlannedMove[] = [];
  const skippedNoOp: string[] = [];
  for (const it of deduped) {
    // Moving an item onto itself or into its own subtree is invalid.
    if (targetDir === it.path || isUnder(targetDir, it.path)) {
      return { ok: false, code: 'INTO_ITSELF', path: it.path };
    }
    const name = it.path.split('/').pop() ?? it.path;
    const to = `${targetDir}/${name}`;
    if (to === it.path) {
      skippedNoOp.push(it.path);
      continue;
    }
    moves.push({ from: it.path, to, name });
  }
  return { ok: true, moves, skippedNoOp };
}

/** Collect the display names of destinations that already exist. */
export async function collectMoveConflicts(
  moves: PlannedMove[],
  exists: (p: string) => Promise<boolean>,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const m of moves) {
    if (await exists(m.to)) conflicts.push(m.name);
  }
  return conflicts;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/file-move-planner.test.ts
```

Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add backend/server/shared/file-move-planner.ts backend/server/shared/tests/file-move-planner.test.ts
git commit -m "feat(files): add shared move planner (dedup, into-itself guard, conflicts)"
```

---

## Task 2: lite 端 `fs.move` + RPC 接线 + capability（TDD）

**Files:**
- Modify: `backend/server/shared/agent-runtime/protocol.ts`（在 `makeFsDeleteParamsSchema` 之后加 schema）
- Modify: `backend/remote-agent/src/fs.ts`（`AllowlistedFs` 类型 + 实现）
- Modify: `backend/remote-agent/src/rpc-dispatch.ts`（`fs/rename` 分支后接线）
- Modify: `backend/remote-agent/src/index.ts:125-137`（capabilities 数组加 `'fs/move'`）
- Test: `backend/remote-agent/src/tests/fs-move.test.ts`（create）

- [ ] **Step 1: 写失败测试**

创建 `backend/remote-agent/src/tests/fs-move.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAllowlistedFs } from '../fs.js';
import { handleRpc } from '../rpc-dispatch.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkroot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-move-'));
  return fsp.realpath(dir);
}

test('move: relocates files and directories into target', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'dst'));
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');
  await fsp.mkdir(path.join(root, 'src'));
  await fsp.writeFile(path.join(root, 'src', 'b.ts'), 'y');

  const r = await api.move(path.join(root, 'dst'), [
    { path: path.join(root, 'a.ts'), type: 'file' },
    { path: path.join(root, 'src'), type: 'directory' },
  ]);
  assert.equal(r.success, true);
  assert.equal(r.movedCount, 2);
  await fsp.access(path.join(root, 'dst', 'a.ts'));
  await fsp.access(path.join(root, 'dst', 'src', 'b.ts'));
});

test('move: conflict aborts the whole batch before any rename', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'dst'));
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');
  await fsp.writeFile(path.join(root, 'dst', 'a.ts'), 'EXISTS');

  await assert.rejects(
    api.move(path.join(root, 'dst'), [{ path: path.join(root, 'a.ts'), type: 'file' }]),
    /already exists/,
  );
  // 原文件未被移动（整批不落盘）
  await fsp.access(path.join(root, 'a.ts'));
});

test('move: rejects target inside a moved directory', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'docs'));
  await fsp.mkdir(path.join(root, 'docs', 'sub'));

  await assert.rejects(
    api.move(path.join(root, 'docs', 'sub'), [{ path: path.join(root, 'docs'), type: 'directory' }]),
    /into itself/,
  );
});

test('move: no-op when destination equals source; path outside roots rejected', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');

  const r = await api.move(root, [{ path: path.join(root, 'a.ts'), type: 'file' }]);
  assert.equal(r.success, true);
  assert.equal(r.movedCount, 0);
  assert.equal(r.skippedCount, 1);
  await fsp.access(path.join(root, 'a.ts'));

  await assert.rejects(
    api.move('/etc', [{ path: '/etc/passwd', type: 'file' }]),
    /outside|escape|allowed root/i,
  );
});

test('rpc dispatch: fs/move routes to allowlisted fs with zod-validated params', async () => {
  const root = await mkroot();
  const cfg = { roots: [root] } as unknown as RemoteAgentConfig;
  await fsp.mkdir(path.join(root, 'dst'));
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');

  const r = (await handleRpc(
    'fs/move',
    { targetDir: path.join(root, 'dst'), items: [{ path: path.join(root, 'a.ts'), type: 'file' }] },
    cfg,
  )) as { success: boolean; movedCount: number };
  assert.equal(r.success, true);
  assert.equal(r.movedCount, 1);
});
```

（cfg 构造抄 `fs.test.ts:178` 的现成方式；`handleRpc` 第 4 参 controller 是 optional，不传。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend/remote-agent && env -u TSX_TSCONFIG_PATH npm test
```

Expected: FAIL（`api.move is not a function` / 类型错误）

- [ ] **Step 3: protocol.ts 加 schema**

在 `makeFsDeleteParamsSchema`（约 protocol.ts:322）之后加：

```ts
/** Zod schema for the `fs/move` `rpc_req` params: batch move into `targetDir`. */
export function makeFsMoveParamsSchema() {
  return z.object({
    targetDir: z.string().min(1),
    items: z
      .array(
        z.object({
          path: z.string().min(1),
          type: z.enum(['file', 'directory']),
        }),
      )
      .min(1),
  });
}
```

- [ ] **Step 4: fs.ts 实现 `move`**

`AllowlistedFs` 类型（fs.ts:51 `rename` 行后）加：

```ts
  move(
    targetDir: string,
    items: Array<{ path: string; type: 'file' | 'directory' }>,
  ): Promise<{ success: boolean; movedCount: number; skippedCount: number }>;
```

实现（`async rename(...)` 之后、`async delete(...)` 之前）加：

```ts
    async move(targetDir, items) {
      const resolvedTarget = resolveWithinRoots(targetDir, roots);
      const targetStat = await fsp.stat(resolvedTarget);
      if (!targetStat.isDirectory()) {
        throw new Error('move target is not a directory');
      }

      const resolvedItems = items.map((it) => ({
        path: resolveWithinRoots(it.path, roots),
        type: it.type,
      }));

      const { planMoves, collectMoveConflicts } =
        await import('../../server/shared/file-move-planner.js');
      const plan = planMoves(resolvedItems, resolvedTarget);
      if (!plan.ok) {
        throw new Error(`cannot move a folder into itself: ${plan.path}`);
      }

      const exists = async (p: string) => {
        try {
          await fsp.access(p);
          return true;
        } catch {
          return false;
        }
      };
      const conflicts = await collectMoveConflicts(plan.moves, exists);
      if (conflicts.length > 0) {
        throw new Error(`Target already exists: ${conflicts.join(', ')}`);
      }

      for (const m of plan.moves) {
        await fsp.rename(m.from, m.to);
      }
      return {
        success: true,
        movedCount: plan.moves.length,
        skippedCount: plan.skippedNoOp.length,
      };
    },
```

（动态 import 是沿 fs.ts 现状风格？——不是：fs.ts 顶部静态 import。**用静态 import**：文件顶部加 `import { planMoves, collectMoveConflicts } from '../../server/shared/file-move-planner.js';`，实现里直接调用。）

- [ ] **Step 5: rpc-dispatch.ts 接线**

把 `fs/rename` 分支的条件行（rpc-dispatch.ts:251）改为包含 `fs/move`：

```ts
  if (method === 'fs/write' || method === 'fs/create' || method === 'fs/rename' || method === 'fs/move' || method === 'fs/delete' || method === 'fs/tree') {
```

在 `if (method === 'fs/rename') {...}` 块（rpc-dispatch.ts:265-268）后加：

```ts
    if (method === 'fs/move') {
      const p = makeFsMoveParamsSchema().parse(params);
      return fsApi.move(p.targetDir, p.items);
    }
```

顶部 import 列表（rpc-dispatch.ts:10-19）加 `makeFsMoveParamsSchema`。

- [ ] **Step 6: index.ts capabilities 上报**

`backend/remote-agent/src/index.ts` 的 capabilities 数组（约 132 行 `'fs/rename'` 之后）加一行：

```ts
      'fs/move',
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd backend/remote-agent && env -u TSX_TSCONFIG_PATH npm test
```

Expected: PASS（含既有全部测试 + 新 5 个）

- [ ] **Step 8: Commit**

```bash
git add backend/server/shared/agent-runtime/protocol.ts backend/remote-agent/src/fs.ts backend/remote-agent/src/rpc-dispatch.ts backend/remote-agent/src/index.ts backend/remote-agent/src/tests/fs-move.test.ts
git commit -m "feat(remote-agent): add fs/move rpc with batch pre-flight conflict check"
```

---

## Task 3: 主侧 remote-fs 客户端 `move()` + move 路由

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-fs.service.ts`（`RemoteFsClient` 类型 + 实现）
- Modify: `backend/server/index.js`（`files/rename` 路由（约 index.js:1352-1440）之后加 move 路由）

- [ ] **Step 1: remote-fs.service.ts 加客户端方法**

类型（remote-fs.service.ts:75 `rename` 行后）：

```ts
  move(
    hostId: string,
    targetDir: string,
    items: Array<{ path: string; type: 'file' | 'directory' }>,
  ): Promise<{ success: boolean; movedCount: number; skippedCount: number }>;
```

实现（remote-fs.service.ts:108-110 `rename(h, oldPath, newName)` 后）：

```ts
    move(h, targetDir, items) {
      return reg().rpc(h, 'fs/move', { targetDir, items });
    },
```

- [ ] **Step 2: 写 move 路由**

在 `backend/server/index.js` 的 rename 路由结束后（`app.put('/api/projects/:projectId/files/rename', ...)` 的 `});` 之后）插入：

```js
// POST /api/projects/:projectId/files/move - Move files/directories into a
// target directory. Batch is pre-flight checked: ANY destination conflict
// aborts the whole batch with 409 (nothing is moved).
app.post('/api/projects/:projectId/files/move', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { items, targetDir } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be a non-empty array' });
        }
        if (items.length > 100) {
            return res.status(400).json({ error: 'Too many items. Maximum is 100.' });
        }
        for (const item of items) {
            if (!item || typeof item.path !== 'string' || !item.path) {
                return res.status(400).json({ error: 'Each item needs a non-empty path' });
            }
            if (item.type !== 'file' && item.type !== 'directory') {
                return res.status(400).json({ error: 'Each item type must be "file" or "directory"' });
            }
        }

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve and validate every source path + the target dir.
        const resolvedItems = [];
        for (const item of items) {
            const v = validatePathInProject(projectRoot, item.path);
            if (!v.valid) {
                return res.status(403).json({ error: v.error });
            }
            resolvedItems.push({ path: v.resolved, type: item.type });
        }
        const targetValidation = validatePathInProject(projectRoot, targetDir || '');
        if (!targetValidation.valid) {
            return res.status(403).json({ error: targetValidation.error });
        }
        const resolvedTargetDir = targetValidation.resolved;

        const plan = planMoves(resolvedItems, resolvedTargetDir);
        if (!plan.ok) {
            return res.status(403).json({ error: 'Cannot move a folder into itself' });
        }

        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            // Old lite builds predate fs/move; fail loudly instead of moving half a batch.
            const capabilities = getRemoteAgentsRuntime().registry.getCapabilities(hostId);
            if (!capabilities || !capabilities.includes('fs/move')) {
                return res.status(501).json({
                    error: 'Remote host agent is outdated and does not support moving files. Upgrade the agent on that host.',
                });
            }
            const { fsClient } = getRemoteAgentsRuntime();
            const r = await fsClient.move(hostId, resolvedTargetDir, resolvedItems);
            return res.json({
                success: true,
                movedCount: r.movedCount,
                skippedCount: r.skippedCount,
                targetDir: resolvedTargetDir,
            });
        }

        // Local project: target must exist.
        try {
            await fsPromises.access(resolvedTargetDir);
        } catch {
            return res.status(404).json({ error: 'Target directory not found' });
        }

        // Pre-flight: collect ALL conflicts before touching anything.
        const conflicts = [];
        for (const m of plan.moves) {
            try {
                await fsPromises.access(m.to);
                conflicts.push(m.name);
            } catch {
                // free to move
            }
        }
        if (conflicts.length > 0) {
            return res.status(409).json({
                error: `Target already contains: ${conflicts.join(', ')}`,
                conflicts,
            });
        }

        // Execute. Sequential renames on the same filesystem; a mid-batch
        // failure stops immediately (no rollback) — the error names the item.
        for (const m of plan.moves) {
            try {
                await fsPromises.rename(m.from, m.to);
            } catch (error) {
                console.error('Error moving file:', m.from, '->', m.to, error);
                return res.status(500).json({
                    error: `Failed to move ${m.name}: ${error.message}`,
                    failedName: m.name,
                });
            }
        }

        res.json({
            success: true,
            movedCount: plan.moves.length,
            skippedCount: plan.skippedNoOp.length,
            targetDir: resolvedTargetDir,
        });
    } catch (error) {
        console.error('Error moving files:', error);
        if (resolveErrorCode(error) === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});
```

并在 index.js 顶部 import 区（`MAX_FILE_UPLOAD_COUNT` 那组 import，index.js:64 附近）加：

```js
import { planMoves } from './shared/file-move-planner.js';
```

（index.js 是 ESM，`import` 放其他 `import` 旁。）

- [ ] **Step 3: typecheck**

```bash
cd backend && npm run typecheck
```

Expected: 与基线相同的错误数（零新增）。remote-fs.service.ts 是 TS；index.js 是 JS（allowJs），tsc 只检查 TS。

- [ ] **Step 4: 手动冒烟（可选但推荐，需要后端跑起来）**

先问用户是否可以重启后端（记忆：重启后端=杀所有活跃会话，须逐次确认）。若后端已在跑且允许：

```bash
# 建临时项目目录模拟
curl -s -X POST http://127.0.0.1:3188/api/projects/<projectId>/files/move \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"items":[{"path":"a.txt","type":"file"}],"targetDir":"sub"}'
```

Expected: `{"success":true,...}`；再发一次同名 → 409 `conflicts:["a.txt"]`。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/remote-fs.service.ts backend/server/index.js
git commit -m "feat(files): add POST /files/move route (batch, pre-flight conflicts, remote 501 fallback)"
```

---

## Task 4: 前端选择纯函数（TDD）

**Files:**
- Create: `web/src/components/file-tree/utils/fileTreeSelection.ts`
- Test: `web/src/components/file-tree/utils/fileTreeSelection.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `web/src/components/file-tree/utils/fileTreeSelection.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDescendantOfAny,
  topMostSelectedPaths,
  rangeBetween,
} from './fileTreeSelection';

test('isDescendantOfAny: segment-aware prefix match', () => {
  assert.equal(isDescendantOfAny('docs/sub/a.ts', ['docs']), true);
  assert.equal(isDescendantOfAny('docs-old/a.ts', ['docs']), false);
  assert.equal(isDescendantOfAny('docs', ['docs']), false); // self is not a descendant
  assert.equal(isDescendantOfAny('a.ts', []), false);
});

test('topMostSelectedPaths: drops paths covered by selected ancestors', () => {
  assert.deepEqual(
    topMostSelectedPaths(['docs', 'docs/sub/a.ts', 'other.txt']),
    ['docs', 'other.txt'],
  );
  assert.deepEqual(topMostSelectedPaths(['b.ts', 'a.ts']), ['b.ts', 'a.ts']);
});

test('rangeBetween: inclusive slice by visible order', () => {
  const order = ['a.ts', 'docs', 'docs/x.ts', 'b.ts', 'c.ts'];
  assert.deepEqual(rangeBetween(order, 'a.ts', 'b.ts'), ['a.ts', 'docs', 'docs/x.ts', 'b.ts']);
  assert.deepEqual(rangeBetween(order, 'c.ts', 'docs'), ['docs', 'docs/x.ts', 'b.ts', 'c.ts']); // reversed works
  assert.deepEqual(rangeBetween(order, 'a.ts', 'missing.ts'), []); // unknown endpoint -> empty
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/utils/fileTreeSelection.test.ts
```

Expected: FAIL（module not found）

- [ ] **Step 3: 实现**

创建 `web/src/components/file-tree/utils/fileTreeSelection.ts`：

```ts
/**
 * Pure helpers for the file-tree multi-select model. Paths are the
 * project-relative POSIX paths used by FileTreeNode.path ('docs/sub/a.ts').
 */

/** Whether `path` is strictly inside any of `ancestors` (segment-aware). */
export function isDescendantOfAny(path: string, ancestors: string[]): boolean {
  return ancestors.some((a) => a !== path && path.startsWith(a + '/'));
}

/** Drop selected paths already covered by a selected ancestor directory. */
export function topMostSelectedPaths(selected: string[]): string[] {
  return selected.filter((p) => !isDescendantOfAny(p, selected));
}

/** The inclusive range between two paths in visible order (either direction). */
export function rangeBetween(visibleOrder: string[], from: string, to: string): string[] {
  const i = visibleOrder.indexOf(from);
  const j = visibleOrder.indexOf(to);
  if (i === -1 || j === -1) return [];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return visibleOrder.slice(lo, hi + 1);
}

/** Flatten the currently visible tree (respects expansion + search filter). */
export function flattenVisiblePaths(items: { path: string; type: string; children?: unknown[] }[]): string[] {
  const out: string[] = [];
  const walk = (nodes: typeof items) => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.type === 'directory' && Array.isArray(n.children)) {
        walk(n.children as typeof items);
      }
    }
  };
  walk(items);
  return out;
}
```

（`flattenVisiblePaths` 不单独测——它由后续 hook 的集成行为覆盖；它是 `rangeBetween` 的输入生产者，逻辑一行递归。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/utils/fileTreeSelection.test.ts
```

Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/file-tree/utils/fileTreeSelection.ts web/src/components/file-tree/utils/fileTreeSelection.test.ts
git commit -m "feat(file-tree): add multi-select pure helpers (dedup, shift range)"
```

---

## Task 5: `useFileTreeSelection` hook + api `moveFiles`

**Files:**
- Create: `web/src/components/file-tree/hooks/useFileTreeSelection.ts`
- Modify: `web/src/utils/api.js`（`deleteFile`（api.js:263-267）后加 `moveFiles`）

- [ ] **Step 1: api.js 加 moveFiles**

在 `deleteFile` 定义后加：

```js
  moveFiles: (projectId, { items, targetDir }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/move`, {
      method: 'POST',
      body: JSON.stringify({ items, targetDir: targetDir || '' }),
    }),
```

- [ ] **Step 2: 实现 hook**

创建 `web/src/components/file-tree/hooks/useFileTreeSelection.ts`：

```ts
import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';

import type { FileTreeNode } from '../types/types';
import { flattenVisiblePaths, rangeBetween, topMostSelectedPaths } from '../utils/fileTreeSelection';

type UseFileTreeSelectionArgs = {
  visibleItems: FileTreeNode[];
};

export type SelectionClickResult =
  | { kind: 'default' }
  | { kind: 'toggle'; path: string }
  | { kind: 'range'; paths: string[] }
  | { kind: 'clear' };

export function useFileTreeSelection({ visibleItems }: UseFileTreeSelectionArgs) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const visibleOrder = useMemo(() => flattenVisiblePaths(visibleItems), [visibleItems]);

  /** Decide what a row click means. The caller (FileTreeNode) runs the default
   *  open/expand behavior only for `default`/`clear` results. */
  const classifyClick = useCallback(
    (item: FileTreeNode, e: MouseEvent): SelectionClickResult => {
      if (e.shiftKey) {
        const from = anchorPath ?? item.path;
        return { kind: 'range', paths: rangeBetween(visibleOrder, from, item.path) };
      }
      if (e.ctrlKey || e.metaKey) {
        return { kind: 'toggle', path: item.path };
      }
      if (selectedPaths.size > 0) {
        return { kind: 'clear' };
      }
      return { kind: 'default' };
    },
    [anchorPath, selectedPaths, visibleOrder],
  );

  const applyClick = useCallback((result: SelectionClickResult) => {
    if (result.kind === 'toggle') {
      setAnchorPath(result.path);
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(result.path)) next.delete(result.path);
        else next.add(result.path);
        return next;
      });
    } else if (result.kind === 'range') {
      setAnchorPath((prev) => prev);
      setSelectedPaths(new Set(result.paths));
    } else {
      setAnchorPath(null);
      setSelectedPaths(new Set());
    }
  }, []);

  const isSelected = useCallback((path: string) => selectedPaths.has(path), [selectedPaths]);

  /** Selection with descendants-of-selected stripped (for batch ops). */
  const topMostSelected = useMemo(() => topMostSelectedPaths([...selectedPaths]), [selectedPaths]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setAnchorPath(null);
  }, []);

  return {
    selectedPaths,
    selectedCount: selectedPaths.size,
    topMostSelected,
    isSelected,
    classifyClick,
    applyClick,
    clearSelection,
  };
}
```

- [ ] **Step 3: typecheck**

```bash
cd web && npm run typecheck
```

Expected: exit=0

- [ ] **Step 4: Commit**

```bash
git add web/src/utils/api.js web/src/components/file-tree/hooks/useFileTreeSelection.ts
git commit -m "feat(file-tree): add selection hook and moveFiles api client"
```

---

## Task 6: 上传改造——分批 + targetPath + 文件夹选择（TDD 分批逻辑）

**Files:**
- Modify: `web/src/components/file-tree/hooks/useFileTreeUpload.ts`
- Test: `web/src/components/file-tree/hooks/useFileTreeUpload.test.ts`（create；现有 `uploadUrl.test.ts` 只测 URL builder）

- [ ] **Step 1: 写失败测试（分批纯函数）**

创建 `web/src/components/file-tree/hooks/useFileTreeUpload.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkFilesForUpload } from './useFileTreeUpload';

const file = (name: string, kb = 1) =>
  new File([new ArrayBuffer(kb * 1024)], name, { type: 'text/plain' });

test('chunkFilesForUpload: <= limit returns a single batch', () => {
  const batches = chunkFilesForUpload([file('a'), file('b')], 20);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test('chunkFilesForUpload: exactly limit is one batch, limit+1 splits', () => {
  const files = Array.from({ length: 20 }, (_, i) => file(`f${i}`));
  assert.equal(chunkFilesForUpload(files, 20).length, 1);
  const batches = chunkFilesForUpload([...files, file('f20')], 20);
  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches.map((b) => b.length),
    [20, 1],
  );
});

test('chunkFilesForUpload: 1000 files at limit 20 -> 50 batches', () => {
  const files = Array.from({ length: 1000 }, (_, i) => file(`f${i}`));
  const batches = chunkFilesForUpload(files, 20);
  assert.equal(batches.length, 50);
  assert.ok(batches.every((b) => b.length === 20));
});

test('chunkFilesForUpload: empty input -> no batches', () => {
  assert.deepEqual(chunkFilesForUpload([], 20), []);
});
```

注意：node:test 环境有全局 `File`（Node 20+），tsx 跑没问题（uploadUrl.test.ts 同目录同跑法已验证）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/hooks/useFileTreeUpload.test.ts
```

Expected: FAIL（`chunkFilesForUpload` 未导出）

- [ ] **Step 3: 实现**

在 `useFileTreeUpload.ts` 的 `buildUploadUrl`（约 114-117 行）后加：

```ts
/** Slice files into multer-legal batches (folder picks can exceed
 *  MAX_FILE_UPLOAD_COUNT; batches upload strictly in sequence). */
export const chunkFilesForUpload = (files: File[], limit: number): File[][] => {
  if (files.length === 0) return [];
  const batches: File[][] = [];
  for (let i = 0; i < files.length; i += limit) {
    batches.push(files.slice(i, i + limit));
  }
  return batches;
};
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/hooks/useFileTreeUpload.test.ts
```

Expected: PASS（4 tests）

- [ ] **Step 5: 改造 uploadFiles 支持分批 + targetPath 透传**

把 `uploadFiles`（约 307-392 行）整体替换为：

```ts
  const uploadFiles = useCallback(
    async (files: File[], targetPath = '') => {
      if (files.length === 0) {
        setDropTarget(null);
        return;
      }

      const fileName = files.length === 1 ? getFileDisplayName(files[0]) : undefined;

      if (!selectedProject) {
        const message = 'Select a project before uploading files.';
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName);
        return;
      }

      // Size check stays per-file across all batches.
      const oversizedFile = files.find((file) => file.size > MAX_FILE_UPLOAD_SIZE_BYTES);
      if (oversizedFile) {
        const message = `${getFileDisplayName(oversizedFile)} is larger than ${MAX_FILE_UPLOAD_SIZE_LABEL}.`;
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName);
        return;
      }

      const batches = chunkFilesForUpload(files, MAX_FILE_UPLOAD_COUNT);
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      const bytesBeforeBatch = (batch: File[]) =>
        batch.reduce((sum, f) => sum + f.size, 0);

      clearProgressTimer();
      setOperationLoading(true);
      setUploadProgress({
        status: 'uploading',
        progress: 0,
        fileCount: files.length,
        fileName,
        targetPath,
      });

      let uploadedTotal = 0;
      let sentBytes = 0;

      try {
        for (const batch of batches) {
          const batchBase = sentBytes;
          await uploadFormDataWithProgress(
            selectedProject.projectId,
            targetPath,
            buildUploadFormData(batch, targetPath),
            (progress) => {
              // Aggregate: batch progress is scaled into the whole-upload byte share.
              const batchBytes = bytesBeforeBatch(batch);
              const overall =
                totalBytes > 0
                  ? Math.min(99, Math.round(((batchBase + (progress / 100) * batchBytes) / totalBytes) * 100))
                  : progress;
              setUploadProgress((current) =>
                current && current.status === 'uploading'
                  ? { ...current, progress: overall }
                  : current,
              );
            },
          );
          sentBytes += bytesBeforeBatch(batch);
          uploadedTotal += batch.length;
        }

        setUploadProgress({
          status: 'complete',
          progress: 100,
          fileCount: files.length,
          uploadedCount: uploadedTotal,
          fileName,
          targetPath,
        });

        showToast(formatUploadSuccessMessage(uploadedTotal, files.length), 'success');
        scheduleProgressClear(COMPLETE_PROGRESS_CLEAR_DELAY_MS);
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        console.error('Upload error:', err);
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName, 0);
      } finally {
        setOperationLoading(false);
        setDropTarget(null);
      }
    },
    [
      clearProgressTimer,
      onRefresh,
      scheduleProgressClear,
      selectedProject,
      setUploadError,
      showToast,
    ],
  );
```

同时删除现在无人引用的 `validateFilesForUpload`（约 56-67 行）——它的两个检查已内联（数量→分批、大小→保留）。**注意**：先 grep `validateFilesForUpload` 确认没有其他引用再删。

- [ ] **Step 6: handleFileSelect 带 targetPath + handleFolderSelect**

替换 `handleFileSelect`（约 394-399 行）并新增 `handleFolderSelect`：

```ts
  // `pendingUploadTargetRef` remembers where an "upload here" context-menu
  // action wants the next picker selection to land.
  const pendingUploadTargetRef = useRef<string>('');

  const openFilePicker = useCallback((targetPath = '') => {
    pendingUploadTargetRef.current = targetPath;
    fileInputRef.current?.click();
  }, []);

  const openFolderPicker = useCallback((targetPath = '') => {
    pendingUploadTargetRef.current = targetPath;
    folderInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(
    async (fileList: FileList | File[]) => {
      const target = pendingUploadTargetRef.current;
      pendingUploadTargetRef.current = '';
      await uploadFiles(Array.from(fileList), target);
    },
    [uploadFiles],
  );

  // webkitdirectory inputs give one root folder; files carry webkitRelativePath
  // ('<root>/…'), which buildUploadFormData already forwards as relativePaths.
  const handleFolderSelect = useCallback(
    async (fileList: FileList | File[]) => {
      const target = pendingUploadTargetRef.current;
      pendingUploadTargetRef.current = '';
      const files = Array.from(fileList).filter((f) => {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
        const base = rel.split('/')[0] || '';
        return !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(base);
      });
      await uploadFiles(files, target);
    },
    [uploadFiles],
  );
```

hook 里加两个 input ref（`treeRef` 声明旁）：

```ts
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
```

return 对象加 `openFilePicker`、`openFolderPicker`、`handleFolderSelect`、`fileInputRef`、`folderInputRef`（保留 `handleFileSelect` 导出兼容 FileTreeHeader 现有 prop——Task 8 会切换到 openFilePicker）。

**两个隐藏 input 由 FileTree.tsx 渲染**（Task 8），不放在 hook 里（hook 无 DOM）。

- [ ] **Step 7: typecheck + 全测试**

```bash
cd web && npm run typecheck
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/hooks/useFileTreeUpload.test.ts src/components/file-tree/hooks/uploadUrl.test.ts
```

Expected: typecheck exit=0；测试 PASS。

- [ ] **Step 8: Commit**

```bash
git add web/src/components/file-tree/hooks/useFileTreeUpload.ts web/src/components/file-tree/hooks/useFileTreeUpload.test.ts
git commit -m "feat(file-tree): batch uploads past file limit, folder picker, upload target dir"
```

---

## Task 7: 批量删除 + 批量 ZIP 下载（useFileTreeOperations）

**Files:**
- Modify: `web/src/components/file-tree/hooks/useFileTreeOperations.ts`

- [ ] **Step 1: 批量删除状态与处理器**

`DeleteConfirmation` 类型（约 18-21 行）改为：

```ts
export type DeleteConfirmation = {
  isOpen: boolean;
  item: FileTreeNode | null;
  // 多选批量删除：非空时 item 为 null
  items: FileTreeNode[] | null;
};
```

state 初始化相应改为 `{ isOpen: false, item: null, items: null }`。

`handleStartDelete` 后新增：

```ts
  const handleStartDeleteMany = useCallback((items: FileTreeNode[]) => {
    if (items.length === 0) return;
    setDeleteConfirmation({ isOpen: true, item: null, items });
  }, []);
```

`handleConfirmDelete`（约 159-188 行）替换为（单条走原路径，多条循环）：

```ts
  const handleConfirmDelete = useCallback(async () => {
    const { item, items } = deleteConfirmation;
    if (!selectedProject) return;
    if (!item && (!items || items.length === 0)) return;

    setOperationLoading(true);
    try {
      const targets = item ? [item] : items ?? [];
      const failed: string[] = [];
      for (const target of targets) {
        try {
          const response = await api.deleteFile(selectedProject.projectId, {
            path: target.path,
            type: target.type,
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to delete');
          }
        } catch (err) {
          console.error('Delete failed for', target.path, err);
          failed.push(target.name);
        }
      }

      if (failed.length === 0) {
        showToast(
          targets.length === 1
            ? t('fileTree.toast.deleted', 'Deleted successfully')
            : t('fileTree.toast.deletedMany', 'Deleted {{count}} items', { count: targets.length }),
          'success',
        );
      } else if (failed.length === targets.length) {
        showToast(t('fileTree.toast.deleteFailed', 'Failed to delete'), 'error');
      } else {
        showToast(
          t('fileTree.toast.deletePartial', 'Deleted {{ok}} of {{count}}; failed: {{failed}}', {
            ok: targets.length - failed.length,
            count: targets.length,
            failed: failed.join(', '),
          }),
          'error',
        );
      }

      onRefresh();
      handleCancelDelete();
    } finally {
      setOperationLoading(false);
    }
  }, [deleteConfirmation, selectedProject, showToast, t, onRefresh, handleCancelDelete]);
```

`UseFileTreeOperationsResult` 类型加 `handleStartDeleteMany: (items: FileTreeNode[]) => void;` 并在 return 里导出 `handleStartDeleteMany`。

- [ ] **Step 2: 泛化 ZIP 下载**

`downloadFolderAsZip`（约 298-345 行）重构为共享收集器 + 多入口。在它上方加：

```ts
  const collectNodeIntoZip = useCallback(
    async (zip: JSZip, node: FileTreeNode, zipPath: string, skipped: string[]) => {
      if (node.type === 'file') {
        const response = await api.readFileBlob(selectedProject!.projectId, node.path);
        if (!response.ok) {
          // Remote 413 (>32MB) and missing files skip with a report.
          skipped.push(node.path);
          return;
        }
        const fileBytes = await response.arrayBuffer();
        zip.file(zipPath || node.name, fileBytes);
        return;
      }
      for (const child of node.children ?? []) {
        await collectNodeIntoZip(zip, child, zipPath ? `${zipPath}/${child.name}` : child.name, skipped);
      }
    },
    [selectedProject],
  );

  const downloadItemsAsZip = useCallback(
    async (items: FileTreeNode[], zipName: string) => {
      if (!selectedProject || items.length === 0) return;
      const zip = new JSZip();
      const skipped: string[] = [];
      for (const item of items) {
        await collectNodeIntoZip(zip, item, item.name, skipped);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      triggerBrowserDownload(zipBlob, zipName);
      if (skipped.length > 0) {
        showToast(
          t('fileTree.toast.zipSkipped', 'Skipped (too large or unreadable): {{names}}', {
            names: skipped.join(', '),
          }),
          'error',
        );
      } else {
        showToast(t('fileTree.toast.folderDownloaded', 'Downloaded as ZIP'), 'success');
      }
    },
    [selectedProject, showToast, t, triggerBrowserDownload, collectNodeIntoZip],
  );
```

`downloadFolderAsZip` 改为薄封装（保留原 toast 行为）：

```ts
  const downloadFolderAsZip = useCallback(
    async (folder: FileTreeNode) => {
      await downloadItemsAsZip([folder], `${folder.name}.zip`);
    },
    [downloadItemsAsZip],
  );
```

`UseFileTreeOperationsResult` 加 `downloadItemsAsZip: (items: FileTreeNode[], zipName: string) => Promise<void>;` 并导出。

- [ ] **Step 3: typecheck**

```bash
cd web && npm run typecheck
```

Expected: exit=0（`deleteConfirmation.item` 的使用方 FileTree.tsx 弹窗在 Task 9 一并适配——若此时 typecheck 报 FileTree.tsx 对 `items` 无感知属正常，**不会**：FileTree.tsx 只读 `item`，`items` 是新增字段，兼容。弹窗文案适配留 Task 9。）

- [ ] **Step 4: Commit**

```bash
git add web/src/components/file-tree/hooks/useFileTreeOperations.ts
git commit -m "feat(file-tree): batch delete and multi-item zip download"
```

---

## Task 8: 拖拽移动 hook + 上传文件夹按钮 + 右键上传到子文件夹

**Files:**
- Create: `web/src/components/file-tree/hooks/useFileTreeMove.ts`
- Modify: `web/src/components/file-tree/view/FileTreeHeader.tsx`
- Modify: `web/src/components/file-tree/view/FileContextMenu.tsx`

- [ ] **Step 1: useFileTreeMove hook**

创建 `web/src/components/file-tree/hooks/useFileTreeMove.ts`：

```ts
import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';

import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import { isDescendantOfAny } from '../utils/fileTreeSelection';

/** Custom dataTransfer type: presence means "dragging items inside the tree"
 *  (a move). OS file drags only ever carry "Files". */
export const TREE_DRAG_MIME = 'application/x-lovdex-tree-items';

type UseFileTreeMoveArgs = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
};

export function useFileTreeMove({ selectedProject, onRefresh, showToast }: UseFileTreeMoveArgs) {
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);

  const beginItemDrag = useCallback(
    (e: DragEvent, itemPath: string, selectedPaths: Set<string>) => {
      const paths = selectedPaths.has(itemPath)
        ? [...selectedPaths]
        : [itemPath];
      e.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify({ paths }));
      e.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  /** Directory-row dragOver: only reacts to internal drags (moves). External
   *  file drags keep the upload flow (root overlay / per-item upload drop). */
  const handleItemDragOver = useCallback((e: DragEvent, itemPath: string, selectedPaths: Set<string>) => {
    if (!e.dataTransfer.types.includes(TREE_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    // Drop onto a selected item's own subtree is a no-op — no highlight.
    if (isDescendantOfAny(itemPath, [...selectedPaths]) || selectedPaths.has(itemPath)) {
      e.dataTransfer.dropEffect = 'none';
      setMoveTarget(null);
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    setMoveTarget(itemPath);
  }, []);

  const handleItemDragLeave = useCallback(() => {
    setMoveTarget(null);
  }, []);

  const handleItemDrop = useCallback(
    (e: DragEvent, itemPath: string, selectedPaths: Set<string>) => {
      if (!e.dataTransfer.types.includes(TREE_DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setMoveTarget(null);
      if (isDescendantOfAny(itemPath, [...selectedPaths]) || selectedPaths.has(itemPath)) {
        showToast('Cannot move a folder into itself', 'error');
        return;
      }
      void runMove(e, itemPath);
    },
    // runMove defined below via hoisted function expression; see Step 2 note
    [selectedPaths, showToast],
  );

  const runMove = useCallback(
    async (e: DragEvent, targetDir: string) => {
      if (!selectedProject) return;
      const raw = e.dataTransfer.getData(TREE_DRAG_MIME);
      if (!raw) return;
      const { paths } = JSON.parse(raw) as { paths: string[] };
      if (!Array.isArray(paths) || paths.length === 0) return;

      setOperationLoading(true);
      try {
        const response = await api.moveFiles(selectedProject.projectId, {
          items: paths.map((p) => ({ path: p, type: 'file' })),
          targetDir,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Move failed');
        }
        showToast(
          `Moved ${data.movedCount ?? paths.length} item${(data.movedCount ?? paths.length) === 1 ? '' : 's'}`,
          'success',
        );
        onRefresh();
      } catch (err) {
        showToast((err as Error).message, 'error');
      } finally {
        setOperationLoading(false);
      }
    },
    [selectedProject, showToast, onRefresh],
  );

  return {
    moveTarget,
    operationLoading,
    beginItemDrag,
    handleItemDragOver,
    handleItemDragLeave,
    handleItemDrop,
  };
}
```

**注意 items 的 type 问题**：move API body 需要每项 `type`。拖拽开始时我们只有 path。两个选择：(a) `beginItemDrag` 时把 type 一起序列化（需要 FileTreeNode）；(b) 后端只按 path 处理（本地 rename 不需要 type；**lite fs.move 也不用 type**——planner 不读 type！）。检查：`planMoves` 不用 type、本地路由不用、lite 不用。所以**前端可以发 `type: 'file'` 占位**……不行——语义错误。更好：`beginItemDrag` 接收 `items: FileTreeNode[]`，序列化 `{ items: [{path, type}] }`，drop 时原样发。**采用这个**，上面 `runMove` 的 `paths.map(...)` 相应改为直接用序列化的 items：

```ts
      const { items } = JSON.parse(raw) as { items: Array<{ path: string; type: 'file' | 'directory' }> };
      if (!Array.isArray(items) || items.length === 0) return;
      ...
        const response = await api.moveFiles(selectedProject.projectId, { items, targetDir });
```

同时 `handleItemDragOver`/`handleItemDrop` 的 `selectedPaths` 参数改为 `selectedPaths: Set<string>`（用于子树拦截判断，保留）。`beginItemDrag` 签名：

```ts
  const beginItemDrag = useCallback(
    (e: DragEvent, draggedItem: { path: string; type: 'file' | 'directory' }, selectedPaths: Set<string>) => {
      const items = selectedPaths.has(draggedItem.path)
        ? [...selectedPaths].map((p) => ({ path: p, type: 'directory' as const }))
        : [draggedItem];
      ...
```

——不行，selectedPaths 没有类型信息。**决定：选中集合存 `Map<string, 'file' | 'directory'>`**。这影响 Task 5 的 hook（`selectedPaths` 从 `Set<string>` 改 `Map`）。Task 5 已写 `Set`——**在 Task 5 实现时直接用 `Map<string, FileTreeItemType>`**，API：`selectedPaths.has(path)` 改为统一暴露 `isSelected(path)`、`selectedEntries()` 返回数组。为避免计划内自相矛盾，Task 5 Step 2 的 hook 代码里 `selectedPaths` 状态类型用：

```ts
const [selected, setSelected] = useState<Map<string, 'file' | 'directory'>>(new Map());
```

对外暴露：`isSelected(path)`、`selectedCount`、`selectedPaths: string[]`（派生数组，供拦截判断）、`selectedEntries`（供 move/drag 序列化）。`applyClick`/`classifyClick` 相应操作 Map（toggle 需要该行的 type——`classifyClick(item, e)` 里 item 是 FileTreeNode，有 type，直接带上）。**执行者按此修正 Task 5 的代码再写 Task 8**（语义不变，只换容器）。

`handleItemDrop` 里引用 `runMove` 的循环依赖：把 `runMove` 定义在 `handleItemDrop` **之前**即可（useCallback 顺序调整），deps 加 `runMove`。

- [ ] **Step 2: FileTreeHeader 加上传文件夹按钮**

`FileTreeHeaderProps` 加：

```ts
  onUploadFolder?: (files: FileList) => void;
  onOpenFilePicker?: (targetPath?: string) => void;
```

（`onUploadFiles` prop 改由 `onOpenFilePicker` 替代：FileTree.tsx 传 `upload.openFilePicker`，header 的 upload 按钮调 `onOpenFilePicker?.()`，input 的 onChange 仍调 `onUploadFiles`——**保留 `onUploadFiles` prop 名给 onChange**，按钮 onClick 换 `onOpenFilePicker`。）

Upload 按钮块（FileTreeHeader.tsx:67-110）改造：在现有 Upload Button 后加 FolderUp 按钮（lucide 图标 `FolderUp`，import 行加）：

```tsx
          {onUploadFolder && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => folderUploadInputRef.current?.click()}
              title={t('fileTree.uploadFolder', 'Upload folder (max {{size}} each)', {
                size: MAX_FILE_UPLOAD_SIZE_LABEL,
              })}
              aria-label={t('fileTree.uploadFolder', 'Upload folder (max {{size}} each)', {
                size: MAX_FILE_UPLOAD_SIZE_LABEL,
              })}
              disabled={operationLoading}
            >
              <FolderUp className="h-3.5 w-3.5" />
            </Button>
          )}
```

组件内加（`uploadInputRef` 旁）：

```tsx
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const handleFolderInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    if (files && files.length > 0) {
      onUploadFolder?.(files);
    }
    event.target.value = '';
  };
```

并渲染隐藏 input（现有 input 后）：

```tsx
              <input
                ref={folderUploadInputRef}
                type="file"
                multiple
                // @ts-expect-error non-standard but universally supported dir picker
                webkitdirectory=""
                directory=""
                className="hidden"
                onChange={handleFolderInputChange}
                tabIndex={-1}
                aria-hidden="true"
              />
```

（`webkitdirectory`/`directory` 无 React 类型；React 对小写 custom attribute 会原样透传，`webkitdirectory=""` 直接可用，`@ts-expect-error` 兜住 `directory`。若 typecheck 报错行号对不上，改为对象展开 `{...{ webkitdirectory: '', directory: '' }}`。）

Upload 按钮的 onClick 改 `onOpenFilePicker?.()`（无则回退 `uploadInputRef.current?.click()`）。

- [ ] **Step 3: FileContextMenu 目录菜单加「上传到此文件夹」**

`FileContextMenu` props 加：

```ts
  onUploadHere?: (path: string) => void;
```

directory 分支的 menuActions（FileContextMenu.tsx:125-167）在 `newFolder` 之后加：

```ts
        {
          key: 'uploadHere',
          icon: Upload,
          label: t('fileTree.context.uploadHere', 'Upload to this folder'),
          onSelect: () => onUploadHere?.(item.path),
        },
```

import 行（lucide）加 `Upload`，deps 数组（约 190 行）加 `onUploadHere`。

- [ ] **Step 4: typecheck**

```bash
cd web && npm run typecheck
```

Expected: exit=0

- [ ] **Step 5: Commit**

```bash
git add web/src/components/file-tree/hooks/useFileTreeMove.ts web/src/components/file-tree/view/FileTreeHeader.tsx web/src/components/file-tree/view/FileContextMenu.tsx
git commit -m "feat(file-tree): drag-move hook, folder upload button, upload-here menu"
```

---

## Task 9: FileTree 集成（选中态、拖拽、per-item drop、批量条、弹窗适配）

**Files:**
- Create: `web/src/components/file-tree/view/FileTreeSelectionBar.tsx`
- Modify: `web/src/components/file-tree/view/FileTreeNode.tsx`
- Modify: `web/src/components/file-tree/view/FileTreeList.tsx`
- Modify: `web/src/components/file-tree/view/FileTreeBody.tsx`
- Modify: `web/src/components/file-tree/view/FileTree.tsx`

这是最大的一个任务，但每步都是机械接线。按以下顺序改。

- [ ] **Step 1: FileTreeSelectionBar 组件**

创建 `web/src/components/file-tree/view/FileTreeSelectionBar.tsx`：

```tsx
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Trash2, X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';

type FileTreeSelectionBarProps = {
  count: number;
  operationLoading?: boolean;
  onDelete: () => void;
  onDownloadZip: () => void;
  onClear: () => void;
};

export default function FileTreeSelectionBar({
  count,
  operationLoading,
  onDelete,
  onDownloadZip,
  onClear,
}: FileTreeSelectionBarProps) {
  const { t } = useTranslation();
  if (count <= 0) return null;

  return (
    <div className="flex items-center justify-between border-b border-border bg-accent/40 px-3 py-1.5">
      <span className="text-xs font-medium text-foreground">
        {t('fileTree.selection.selected', '{{count}} selected', { count })}
      </span>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onDownloadZip}
          disabled={operationLoading}
          title={t('fileTree.selection.downloadZip', 'Download as ZIP')}
        >
          <Download className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10"
          onClick={onDelete}
          disabled={operationLoading}
          title={t('fileTree.selection.delete', 'Delete selected')}
        >
          {operationLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onClear}
          title={t('fileTree.selection.clear', 'Clear selection')}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
```

（先确认 `web/src/components/shared/view/ui` 确有 `Button` 导出——FileTreeHeader.tsx:6 已这么 import，成立。）

- [ ] **Step 2: FileTreeNode 接线（选中态 + 修饰键点击 + draggable + drop）**

`FileTreeNodeProps` 加一组 optional props：

```ts
  // Multi-select
  isSelected?: boolean;
  onRowClick?: (item: FileTreeNodeType, e: ReactMouseEvent) => void; // takes modifiers
  // Internal drag-move (rows draggable; directories are drop targets)
  onItemDragStart?: (e: DragEvent, item: FileTreeNodeType) => void;
  onItemDragOver?: (e: DragEvent, item: FileTreeNodeType) => void;
  onItemDragLeave?: (e: DragEvent, item: FileTreeNodeType) => void;
  onItemDrop?: (e: DragEvent, item: FileTreeNodeType) => void;
  isMoveTarget?: boolean;
  // External upload drop onto this directory
  onUploadDrop?: (e: DragEvent, item: FileTreeNodeType) => void;
```

import 行加 `type DragEvent, type MouseEvent as ReactMouseEvent`（react）。

行 div（rowContent 内，约 139-143 行）改为：

```tsx
    <div
      className={cn(rowClassName, isSelected && 'bg-primary/15 hover:bg-primary/20', isMoveTarget && 'ring-1 ring-primary/60 bg-primary/10')}
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      onClick={(e) => onRowClick?.(item, e)}
      draggable={Boolean(onItemDragStart)}
      onDragStart={(e) => onItemDragStart?.(e, item)}
      onDragOver={(e) => {
        onItemDragOver?.(e, item);
        onUploadDrop && e.dataTransfer.types.includes('Files') && onUploadDropOver?.(e, item);
      }}
      onDragLeave={(e) => {
        onItemDragLeave?.(e, item);
        onUploadDropLeave?.(e, item);
      }}
      onDrop={(e) => {
        onItemDrop?.(e, item);
        onUploadDrop?.(e, item);
      }}
    >
```

——upload drop 与 move drop 的路由逻辑：两个 handler 都收到事件，各自按 `dataTransfer.types` 判断是否归自己管（move hook 判 TREE_DRAG_MIME，upload 判 Files），互不干扰。**因此 onUploadDropOver/onUploadDropLeave 不需要**：upload per-item drop 复用 `useFileTreeUpload.handleItemDragOver/handleItemDrop`（已存在，Task 前分析过它们只 setDropTarget）。简化后：

```tsx
      onDragOver={(e) => {
        onItemDragOver?.(e, item);      // move hook: internal drags
        uploadHandlersRef?.onUploadDragOver?.(e, item);  // upload: Files drags
      }}
```

——props 膨胀。**最终决定**：FileTreeNode 收一个聚合 optional 对象 prop：

```ts
  treeInteractions?: {
    isSelected: boolean;
    isMoveTarget: boolean;
    onRowClick: (item: FileTreeNodeType, e: ReactMouseEvent) => void;
    onDragStart: (e: DragEvent, item: FileTreeNodeType) => void;
    onDragOver: (e: DragEvent, item: FileTreeNodeType) => void;
    onDragLeave: (e: DragEvent, item: FileTreeNodeType) => void;
    onDrop: (e: DragEvent, item: FileTreeNodeType) => void;
  };
```

单个 prop，穿透 4 层各加一行。行 div：

```tsx
    <div
      className={cn(
        rowClassName,
        treeInteractions?.isSelected && 'bg-primary/15 hover:bg-primary/20',
        treeInteractions?.isMoveTarget && 'ring-1 ring-inset ring-primary/60 bg-primary/10',
      )}
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      onClick={(e) => (treeInteractions ? treeInteractions.onRowClick(item, e) : onItemClick(item))}
      draggable={Boolean(treeInteractions)}
      onDragStart={(e) => treeInteractions?.onDragStart(e, item)}
      onDragOver={(e) => treeInteractions?.onDragOver(e, item)}
      onDragLeave={(e) => treeInteractions?.onDragLeave(e, item)}
      onDrop={(e) => treeInteractions?.onDrop(e, item)}
    >
```

递归子节点（约 209-235 行）把 `treeInteractions={treeInteractions}` 传下去。

- [ ] **Step 3: FileTreeList / FileTreeBody 穿透**

两个文件的 props 类型各加：

```ts
  treeInteractions?: FileTreeNodeProps['treeInteractions'];
```

（FileTreeList import type from './FileTreeNode'；FileTreeBody 同理透传。）渲染处各加 `treeInteractions={treeInteractions}`。

- [ ] **Step 4: FileTree.tsx 总装**

在 `FileTree.tsx`：

```tsx
import { useFileTreeSelection } from '../hooks/useFileTreeSelection';
import { useFileTreeMove, TREE_DRAG_MIME } from '../hooks/useFileTreeMove';
import FileTreeSelectionBar from './FileTreeSelectionBar';
import type { FileTreeNode as FileTreeNodeType } from '../types/types';
```

组件体内（`upload` hook 之后）：

```tsx
  // Multi-select over the visible (search-filtered) tree
  const selection = useFileTreeSelection({ visibleItems: filteredFiles });
  const move = useFileTreeMove({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });

  // Esc clears selection
  useEffect(() => {
    if (selection.selectedCount === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selection.clearSelection();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selection]);

  // Selected rows as nodes (for delete/zip)
  const selectedNodes = useMemo(() => {
    const found: FileTreeNodeType[] = [];
    const walk = (nodes: FileTreeNodeType[]) => {
      for (const n of nodes) {
        if (selection.isSelected(n.path)) found.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(filteredFiles);
    return found;
  }, [filteredFiles, selection]);

  const topMostNodes = useMemo(() => {
    const top = new Set(selection.topMostSelected);
    return selectedNodes.filter((n) => top.has(n.path));
  }, [selectedNodes, selection.topMostSelected]);
```

`handleItemClick` 保持原样（default 行为），新增分类入口：

```tsx
  const handleRowClick = useCallback(
    (item: FileTreeNodeType, e: ReactMouseEvent) => {
      const result = selection.classifyClick(item, e);
      if (result.kind === 'default' || result.kind === 'clear') {
        handleItemClick(item);
      }
      selection.applyClick(result);
    },
    [selection, handleItemClick],
  );
```

（import `type MouseEvent as ReactMouseEvent` from react。）

per-item interactions 对象：

```tsx
  const treeInteractions = useMemo(
    () => ({
      isSelected: (path: string) => selection.isSelected(path),
      isMoveTarget: (path: string) => move.moveTarget === path,
      onRowClick: handleRowClick,
      onDragStart: (e: DragEvent, item: FileTreeNodeType) => {
        move.beginItemDrag(e, { path: item.path, type: item.type }, selection.selected);
      },
      onDragOver: (e: DragEvent, item: FileTreeNodeType) => {
        if (item.type !== 'directory') return;
        move.handleItemDragOver(e, item.path, selection.selectedPaths);
        upload.handleItemDragOver(e, item.path); // external Files drags (upload)
      },
      onDragLeave: () => {
        move.handleItemDragLeave();
      },
      onDrop: (e: DragEvent, item: FileTreeNodeType) => {
        if (item.type !== 'directory') return;
        move.handleItemDrop(e, item.path, selection.selectedPaths);
        upload.handleItemDrop(e, item.path);
      },
    }),
    [selection, move, upload, handleRowClick],
  );
```

**注意**：Step 2 里 `treeInteractions.isSelected/isMoveTarget` 定义成了 boolean——这里是函数。**统一为函数**：FileTreeNode 里 `treeInteractions?.isSelected(item.path)`、`treeInteractions?.isMoveTarget(item.path)`。Step 2 的 JSX 相应用：

```tsx
      className={cn(
        rowClassName,
        treeInteractions?.isSelected(item.path) && 'bg-primary/15 hover:bg-primary/20',
        treeInteractions?.isMoveTarget(item.path) && 'ring-1 ring-inset ring-primary/60 bg-primary/10',
      )}
```

类型：

```ts
  treeInteractions?: {
    isSelected: (path: string) => boolean;
    isMoveTarget: (path: string) => boolean;
    onRowClick: (item: FileTreeNodeType, e: ReactMouseEvent) => void;
    onDragStart: (e: DragEvent, item: FileTreeNodeType) => void;
    onDragOver: (e: DragEvent, item: FileTreeNodeType) => void;
    onDragLeave: (e: DragEvent, item: FileTreeNodeType) => void;
    onDrop: (e: DragEvent, item: FileTreeNodeType) => void;
  };
```

根容器 drop（移动到根）：现有 `upload.handleDrop`（FileTree.tsx:143）扩展——内部拖拽落到根空白 = 移到项目根：

```tsx
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(TREE_DRAG_MIME)) {
          move.handleItemDrop(e, '', selection.selectedPaths);
          return;
        }
        upload.handleDrop(e);
      }}
```

`upload.handleDrop` 现签名 `(e: DragEvent)`，直接传 e。move 的 `handleItemDrop(e, '', ...)` 里 targetDir 为 `''` → API `targetDir: ''` → 后端 `validatePathInProject(projectRoot, '')` 解析为项目根。✓

**根容器 dragOver 需放行 move 拖拽**：`upload.handleDragOver`（FileTree.tsx:142）已经无条件 `e.preventDefault()`——满足 drop 触发条件，无需改。

- [ ] **Step 5: 批量条 + 隐藏 input + Header/菜单接线 + 弹窗适配**

FileTree JSX（`FileTreeUploadProgress` 之后、`FileTreeDetailedColumns` 之前）：

```tsx
      <FileTreeSelectionBar
        count={selection.selectedCount}
        operationLoading={operationLoading || move.operationLoading}
        onDelete={() => operations.handleStartDeleteMany(topMostNodes)}
        onDownloadZip={() =>
          operations.downloadItemsAsZip(
            topMostNodes,
            `selection-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`,
          )
        }
        onClear={selection.clearSelection}
      />
```

隐藏 input（根容器 div 内任意处）：

```tsx
      <input
        ref={upload.fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => upload.handleFileSelect(e.target.files ?? [])}
        tabIndex={-1}
        aria-hidden="true"
      />
```

（文件夹 input 已由 FileTreeHeader 渲染。）

FileTreeHeader props：

```tsx
        onUploadFiles={upload.handleFileSelect}
        onUploadFolder={upload.handleFolderSelect}
        onOpenFilePicker={(targetPath) => upload.openFilePicker(targetPath ?? '')}
```

FileTreeNode（经 Body/List）传 `treeInteractions`；FileContextMenu 经 FileTreeNode 已有 `onNewFile` 等回调链——**「上传到此文件夹」需要传到 FileContextMenu**：FileTreeNode 已把 context props 一路透传，给它加 `onUploadHere={(path) => upload.openFilePicker(path)}` 并透传到 FileContextMenu。

删除确认弹窗（FileTree.tsx:258-301）适配多项：`operations.deleteConfirmation.item` 为 null 且 items 非空时显示批量文案：

```tsx
      {operations.deleteConfirmation.isOpen &&
        (operations.deleteConfirmation.item || (operations.deleteConfirmation.items?.length ?? 0) > 0) && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-destructive/10 p-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {operations.deleteConfirmation.item
                    ? t('fileTree.delete.title', 'Delete {{type}}', {
                        type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File',
                      })
                    : t('fileTree.delete.titleMany', 'Delete {{count}} items', {
                        count: operations.deleteConfirmation.items?.length ?? 0,
                      })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item
                    ? operations.deleteConfirmation.item.name
                    : (operations.deleteConfirmation.items ?? [])
                        .slice(0, 5)
                        .map((n) => n.name)
                        .join(', ') +
                      ((operations.deleteConfirmation.items?.length ?? 0) > 5
                        ? ` … +${(operations.deleteConfirmation.items?.length ?? 0) - 5}`
                        : '')}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item
                ? operations.deleteConfirmation.item.type === 'directory'
                  ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                  : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')
                : t('fileTree.delete.manyWarning', 'These items (and folder contents) will be permanently deleted.')}
            </p>
            {/* 按钮区保持原样 */}
```

（按钮区不动，`operations.handleCancelDelete`/`handleConfirmDelete` 已兼容两条路径。）

- [ ] **Step 6: i18n 键**

`web/src/i18n/locales/en/common.json` 的 `fileTree` 对象内加（保持字母序无所谓，跟现有风格就近放）：

```json
      "uploadFolder": "Upload folder (max {{size}} each)",
      "selection": {
        "selected": "{{count}} selected",
        "downloadZip": "Download as ZIP",
        "delete": "Delete selected",
        "clear": "Clear selection"
      },
      "toast": {
        "deleted": "Deleted successfully",
        "deletedMany": "Deleted {{count}} items",
        "deleteFailed": "Failed to delete",
        "deletePartial": "Deleted {{ok}} of {{count}}; failed: {{failed}}",
        "zipSkipped": "Skipped (too large or unreadable): {{names}}"
      },
```

`fileTree.context` 内加 `"uploadHere": "Upload to this folder"`，`fileTree.delete` 段若无则加（现在 delete 文案是 t() 内联默认，key 可能缺——检查 `common.json` 现有 `fileTree` 是否已有 `delete` 子对象，没有就把 `title/titleMany/fileWarning/folderWarning/manyWarning/confirm` 一并加上，值照 t() 内联默认抄）。

- [ ] **Step 7: typecheck + 全前端测试**

```bash
cd web && npm run typecheck
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/utils/fileTreeSelection.test.ts src/components/file-tree/hooks/useFileTreeUpload.test.ts src/components/file-tree/hooks/uploadUrl.test.ts
```

Expected: typecheck exit=0；测试全 PASS。

- [ ] **Step 8: Commit**

```bash
git add web/src/components/file-tree web/src/i18n/locales/en/common.json
git commit -m "feat(file-tree): wire multi-select, drag-move, folder upload into FileTree UI"
```

---

## Task 10: 端到端验收

- [ ] **Step 1: 后端全量测试**

```bash
cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/file-move-planner.test.ts
cd backend/remote-agent && env -u TSX_TSCONFIG_PATH npm test
cd backend && npm run typecheck
```

Expected: 全 PASS；typecheck 零新增错误（对照执行前 baseline）。

- [ ] **Step 2: 浏览器手动验收（需用户配合或用 puppeteer recipe）**

**重启后端前必须逐次征得用户同意**（重启=杀所有活跃会话）。验收清单：

1. 多选：Ctrl+点击 3 个文件 → 批量条出现「3 selected」；Shift 范围选；点空白清除；Esc 清除
2. 批量删除：选中 2 文件 1 文件夹 → 删除 → 确认弹窗列名 → 树刷新
3. 批量 ZIP：选中混合 → 下载 → zip 内容路径结构正确
4. 拖拽移动：拖文件到文件夹上（高亮）→ 松手 → 移动成功；拖文件夹到自己的子文件夹 → 拒绝 toast
5. 冲突：把 `a.txt` 拖到已有 `a.txt` 的文件夹 → 409 提示、原文件不动
6. 上传文件夹：FolderUp 按钮 → 选含 25 个文件的文件夹 → 分批上传进度聚合 → 结构完整落盘
7. 拖外部文件到子文件夹 → 落在该文件夹内
8. 右键目录 →「Upload to this folder」→ 选的文件落在该目录

- [ ] **Step 3: 更新 spec 状态 + 收尾**

确认 spec（`docs/superpowers/specs/2026-10-13-file-manager-enhancements-design.md`）无需勘误后：

```bash
git log --oneline -8
git status
```

Expected: 干净工作区（除并发会话的 chat WIP 文件），全部提交就位。

---

## Self-Review 记录

- **Spec 覆盖**：多选（Task 4/5/9）、批量删除（Task 7/9）、批量 ZIP（Task 7/9）、上传文件夹（Task 6/8）、分批（Task 6）、上传到子文件夹（Task 6/8/9 per-item drop + 右键）、拖拽移动（Task 1/2/3/8/9）、远程 lite（Task 2/3）、501 降级（Task 3）。全覆盖。
- **类型一致性**：`treeInteractions` 在 Task 9 Step 2/Step 4 有两种形状（boolean vs 函数）——已统一为函数形状并在 Task 9 Step 4 注明；`selectedPaths` 容器在 Task 5（Set）与 Task 8（需要 type 信息）有冲突——已在 Task 8 Step 1 注明执行时用 `Map<string, type>` 落实到 Task 5。执行者务必先读该注记。
- **已知妥协**：move 路由无法单测（index.js 模块顶层起服务），由 shared planner 单测 + lite fs.move 单测 + 手动冒烟覆盖；批量删除循环单条 DELETE 是有意为之（spec §2）。
