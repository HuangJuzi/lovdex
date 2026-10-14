# 分支删除失败时提供「强制删除」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 `git branch -d` 因分支未合并而失败时，Git 面板弹二次确认，用户同意后改用 `git branch -D` 强制删除。

**Architecture:** 后端 `POST /api/git/delete-branch` 接受可选 `force` 参数，未合并失败时返回结构化 `409 { code: 'BRANCH_NOT_MERGED' }`；前端控制器 `deleteBranch` 返回结构化结果（success/notMerged/error），`BranchesView` 在 `notMerged` 时复用现有 `ConfirmActionModal` 再弹一次并带 `force:true` 重试。

**Tech Stack:** Node/Express + TypeScript 后端（`backend/server/modules/git/`，`node:test` + 真实临时 git 仓库）；React + TypeScript 前端（`web/src/components/git-panel/`，无 DOM 测试环境，靠 `tsc`/`eslint` 与手动验证）。

**Spec:** `docs/superpowers/specs/2026-10-14-branch-force-delete-design.md`

---

## 背景与约定（动手前必读）

- 工作目录：`/mnt/b/workdir/github/lovdex`（monorepo）。执行前先 `git status`，`web/src/components/file-tree/hooks/useFileTreeOperations.ts` 已存在一处**与本任务无关的未提交改动**，不要把它裹进本次提交。建议从 `main` 切一个 `feat/git-panel-force-delete-branch` 分支开发。
- 后端 `backend/server/modules/git/git.routes.ts` 顶部有 `// @ts-nocheck`，该文件内无类型约束；不要为其引入类型注解引发全文件报错。
- 后端测试运行方式（已验证可用）：
  ```bash
  cd /mnt/b/workdir/github/lovdex/backend
  npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git.routes.test.ts
  ```
  > 若 shell 里有全局 `TSX_TSCONFIG_PATH` 干扰，先 `unset TSX_TSCONFIG_PATH`。上面显式传 `--tsconfig` 通常已足够。
- 前端无测试运行器；前端改动的验收 = `cd web && npm run typecheck` 通过 + `npx eslint src/components/git-panel` 无新增错误 + 最后的手动验证。
- `git branch -d` 在分支未合并时把 `error: The branch '<name>' is not fully merged.` 输出到 **stderr** 并以退出码 1 结束；`spawnAsync`（`git.routes.ts:25`）已把 `stderr` 挂到抛出的 error 上。
- 提交信息用英文，**不要**加 `Co-Authored-By` 署名行。

---

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `backend/server/modules/git/git.routes.ts` | `/delete-branch` 路由 + 未合并判定 helper | 改：接受 `force`，结构化 409 |
| `backend/server/modules/git/tests/git.routes.test.ts` | 真实仓库集成测试 | 新增一个 test |
| `web/src/components/git-panel/types/types.ts` | 类型：`DeleteBranchResult`、`code` 字段、`ConfirmActionType`、控制器签名 | 改 |
| `web/src/components/git-panel/hooks/useGitPanelController.ts` | `deleteBranch` 返回结构化结果 | 改 |
| `web/src/components/git-panel/constants/constants.ts` | 5 个 `Record<ConfirmActionType,...>` 补 `forceDeleteBranch` | 改 |
| `web/src/components/git-panel/view/modals/ConfirmActionModal.tsx` | 图标映射补 `deleteBranch`/`forceDeleteBranch` | 改 |
| `web/src/components/git-panel/view/branches/BranchesView.tsx` | 删除失败 → 二次确认 → 强制删除 | 改 |

---

## Task 1: 后端 `/delete-branch` 支持 `force` 并返回结构化「未合并」

**Files:**
- Modify: `backend/server/modules/git/git.routes.ts:836-859`
- Test: `backend/server/modules/git/tests/git.routes.test.ts`（文件末尾追加新 `test(...)`）

- [ ] **Step 1: 写失败的测试**

在 `backend/server/modules/git/tests/git.routes.test.ts` 文件末尾（最后一个 `});` 之后）追加：

```ts
test('delete-branch reports BRANCH_NOT_MERGED for an unmerged branch and force-deletes it', async (t) => {
  const repoDir = await makeTempRepo(t);
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });

  // A branch whose commit is NOT reachable from main → `git branch -d` refuses.
  run(['checkout', '-b', 'feat/unmerged']);
  await fs.writeFile(path.join(repoDir, 'feature.txt'), 'work\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'unmerged work']);
  run(['checkout', 'main']);

  await withServer(repoDir, async (base) => {
    // Plain delete (-d) must refuse with the structured code.
    const plainRes = await fetch(`${base}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'repo', branch: 'feat/unmerged' }),
    });
    assert.equal(plainRes.status, 409);
    const plainBody = (await plainRes.json()) as { code?: string; error?: string };
    assert.equal(plainBody.code, 'BRANCH_NOT_MERGED');

    // The branch must survive the refused delete.
    const afterPlain = execFileSync('git', ['branch', '--list', 'feat/unmerged'], {
      cwd: repoDir,
      stdio: 'pipe',
    }).toString();
    assert.ok(afterPlain.includes('feat/unmerged'));

    // Force delete (-D) succeeds and removes the branch.
    const forceRes = await fetch(`${base}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'repo', branch: 'feat/unmerged', force: true }),
    });
    assert.equal(forceRes.status, 200);
    const forceBody = (await forceRes.json()) as { success?: boolean };
    assert.equal(forceBody.success, true);

    const afterForce = execFileSync('git', ['branch', '--list', 'feat/unmerged'], {
      cwd: repoDir,
      stdio: 'pipe',
    }).toString();
    assert.equal(afterForce.trim(), '');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git.routes.test.ts
```
预期：新 test **失败**，`plainRes.status` 实际是 `500`（当前路由对所有失败都返回 500），断言 `assert.equal(plainRes.status, 409)` 抛错。

- [ ] **Step 3: 新增「未合并」判定 helper**

在 `backend/server/modules/git/git.routes.ts` 中，紧跟在 `validateBranchName` 函数之后（约第 76 行 `}` 之后）插入：

```ts
/**
 * True when `git branch -d` refused because the branch has commits that are
 * not merged into HEAD. git writes this to stderr as:
 *   error: The branch '<name>' is not fully merged.
 * and exits non-zero. spawnAsync attaches stdout/stderr to the thrown error.
 */
function isNotFullyMergedError(error) {
  const text = `${error?.stderr ?? ''}${error?.stdout ?? ''}${error?.message ?? ''}`;
  return text.includes(' is not fully merged');
}
```

- [ ] **Step 4: 改写 `/delete-branch` 路由**

把 `backend/server/modules/git/git.routes.ts` 中现有的 `/delete-branch` 处理函数（从 `router.post('/delete-branch', ...)` 到它的闭合 `});`）整体替换为：

```ts
// Delete a local branch. `-d` (safe) by default; `force:true` uses `-D`,
// which discards unmerged commits — the caller must confirm with the user first.
router.post('/delete-branch', async (req, res) => {
  const { project, branch, force } = req.body;
  const shouldForce = force === true;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Safety: cannot delete the currently checked-out branch (applies to -D too).
    const { stdout: currentBranch } = await spawnAsync('git', ['branch', '--show-current'], { cwd: projectPath });
    if (currentBranch.trim() === branch) {
      return res.status(400).json({ error: 'Cannot delete the currently checked-out branch' });
    }

    const { stdout } = await spawnAsync('git', ['branch', shouldForce ? '-D' : '-d', branch], { cwd: projectPath });
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git delete branch error:', error);
    // Only the safe (`-d`) path can fail because the branch is unmerged, and
    // only that failure is recoverable by retrying with `-D`. Everything else
    // stays a generic 500 so the UI does not offer a force-delete that cannot help.
    if (!shouldForce && isNotFullyMergedError(error)) {
      return res.status(409).json({
        error: `The branch '${branch}' is not fully merged`,
        code: 'BRANCH_NOT_MERGED',
      });
    }
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git.routes.test.ts
```
预期：`# pass 2`、`# fail 0`（原有 smoke test 仍需通过）。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/git/git.routes.ts backend/server/modules/git/tests/git.routes.test.ts
git commit -m "feat(git-panel): return BRANCH_NOT_MERGED and support force branch delete"
```

---

## Task 2: 前端类型与控制器返回结构化结果

**Files:**
- Modify: `web/src/components/git-panel/types/types.ts:6`（`ConfirmActionType`）、`:109`（控制器签名）、`:144-147`（`GitOperationResponse`）
- Modify: `web/src/components/git-panel/hooks/useGitPanelController.ts:298-323`（`deleteBranch`）

- [ ] **Step 1: 加 `DeleteBranchResult` 类型**

在 `web/src/components/git-panel/types/types.ts` 中，`GitOperationResponse` 定义（约 144 行）**之前**插入：

```ts
/** Outcome of a branch-delete attempt, richer than a boolean so the UI can
 * distinguish "needs force" from a real error. */
export type DeleteBranchResult =
  | { status: 'success' }
  | { status: 'notMerged' }
  | { status: 'error'; message: string };
```

- [ ] **Step 2: 给 `GitOperationResponse` 加 `code` 字段**

把 `types.ts:144-147` 的：

```ts
export type GitOperationResponse = GitApiErrorResponse & {
  success?: boolean;
  output?: string;
};
```

改为：

```ts
export type GitOperationResponse = GitApiErrorResponse & {
  success?: boolean;
  output?: string;
  /** Machine-readable failure code, e.g. 'BRANCH_NOT_MERGED'. */
  code?: string;
};
```

- [ ] **Step 3: 扩展 `ConfirmActionType`**

把 `types.ts:6` 的：

```ts
export type ConfirmActionType = 'discard' | 'delete' | 'commit' | 'pull' | 'push' | 'publish' | 'revertLocalCommit' | 'deleteBranch';
```

改为：

```ts
export type ConfirmActionType = 'discard' | 'delete' | 'commit' | 'pull' | 'push' | 'publish' | 'revertLocalCommit' | 'deleteBranch' | 'forceDeleteBranch';
```

- [ ] **Step 4: 更新控制器接口签名**

把 `types.ts:109` 的：

```ts
  deleteBranch: (branchName: string) => Promise<boolean>;
```

改为：

```ts
  deleteBranch: (branchName: string, options?: { force?: boolean }) => Promise<DeleteBranchResult>;
```

- [ ] **Step 5: 重写控制器 `deleteBranch`**

把 `useGitPanelController.ts:298-323` 的整个 `deleteBranch` useCallback：

```ts
  const deleteBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) return false;

      try {
        const response = await fetchWithAuth('/api/git/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: selectedProject.projectId, branch: branchName }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, selectedProject],
  );
```

替换为：

```ts
  const deleteBranch = useCallback(
    async (branchName: string, options?: { force?: boolean }): Promise<DeleteBranchResult> => {
      if (!selectedProject) {
        return { status: 'error', message: 'No project selected' };
      }

      try {
        const response = await fetchWithAuth('/api/git/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            branch: branchName,
            force: options?.force === true,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        // "Not merged" is not an error — it is a recoverable state the caller
        // turns into a force-delete confirmation, so it must NOT hit the error bar.
        if (data.code === 'BRANCH_NOT_MERGED') {
          return { status: 'notMerged' };
        }
        if (!data.success) {
          const message = data.error ?? 'Delete branch failed';
          setOperationError(message);
          return { status: 'error', message };
        }

        void fetchBranches();
        return { status: 'success' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Delete branch failed';
        setOperationError(message);
        return { status: 'error', message };
      }
    },
    [fetchBranches, selectedProject],
  );
```

- [ ] **Step 6: 导入 `DeleteBranchResult` 类型**

在 `useGitPanelController.ts` 顶部的 `import type { ... } from '../types/types';` 块中（该块当前见 `useGitPanelController.ts:5-18`），按字母序把它加在**最前**（`DeleteBranchResult` 的 `D` 排在 `GitApiErrorResponse` 之前）：
```ts
  DeleteBranchResult,
```

- [ ] **Step 7: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck
```
预期：此时会**报错**——`BranchesView.tsx` 的 `onDeleteBranch` 仍声明为 `Promise<boolean>`，与新的 `deleteBranch` 不兼容，以及 `ConfirmActionModal`/`constants.ts` 缺 `forceDeleteBranch` 键。这些在 Task 3、Task 4 修复；本步只需确认没有**其它**新错误。若输出仅包含 `BranchesView.tsx`、`constants.ts`、`ConfirmActionModal.tsx` 的相关错误即可继续。

> 说明：Task 2/3/4 共同构成一次可编译的前端改动，因此本步不单独提交；在 Task 4 的 typecheck 全绿后一起提交。

---

## Task 3: 确认弹窗常量与图标

**Files:**
- Modify: `web/src/components/git-panel/constants/constants.ts:28-81`（5 个 Record）
- Modify: `web/src/components/git-panel/view/modals/ConfirmActionModal.tsx:17-35`

- [ ] **Step 1: 5 个 Record 补 `forceDeleteBranch` 键**

在 `constants.ts` 的每个 `Record<ConfirmActionType, ...>` 对象末尾（`deleteBranch: ...` 那行之后、闭合 `}` 之前）各追加一行。

`CONFIRMATION_TITLES`（删除 `deleteBranch: 'Delete Branch',` 后）：
```ts
  forceDeleteBranch: 'Force Delete Branch',
```

`CONFIRMATION_ACTION_LABELS`（在 `deleteBranch: 'Delete',` 后）：
```ts
  forceDeleteBranch: 'Force Delete',
```

`CONFIRMATION_BUTTON_CLASSES`（在 `deleteBranch: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',` 后）：
```ts
  forceDeleteBranch: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
```

`CONFIRMATION_ICON_CONTAINER_CLASSES`（在 `deleteBranch: 'bg-destructive/10',` 后）：
```ts
  forceDeleteBranch: 'bg-destructive/10',
```

`CONFIRMATION_ICON_CLASSES`（在 `deleteBranch: 'text-destructive',` 后）：
```ts
  forceDeleteBranch: 'text-destructive',
```

- [ ] **Step 2: 图标映射把 `deleteBranch`/`forceDeleteBranch` 指向 `Trash2`**

在 `ConfirmActionModal.tsx` 的 `renderConfirmActionIcon` 中，把首行的：

```ts
  if (actionType === 'discard' || actionType === 'delete') {
    return <Trash2 className="h-4 w-4" />;
  }
```

改为：

```ts
  if (
    actionType === 'discard' ||
    actionType === 'delete' ||
    actionType === 'deleteBranch' ||
    actionType === 'forceDeleteBranch'
  ) {
    return <Trash2 className="h-4 w-4" />;
  }
```

（顺带修正：目前 `deleteBranch` 落到函数末尾的兜底分支，渲染的是 `Upload` 图标。）

- [ ] **Step 3: 类型检查（应仅剩 BranchesView 报错）**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck
```
预期：`constants.ts` 与 `ConfirmActionModal.tsx` 的错误消失；仅剩 `BranchesView.tsx` 中 `onDeleteBranch` 签名不匹配的报错，Task 4 修复。

---

## Task 4: `BranchesView` 的强制删除流程

**Files:**
- Modify: `web/src/components/git-panel/view/branches/BranchesView.tsx:16`（props 类型）、`:164-170`（`requestDelete`）

- [ ] **Step 1: 更新 props 与导入**

在 `BranchesView.tsx:3` 的类型导入行：

```ts
import type { ConfirmationRequest, GitRemoteStatus } from '../../types/types';
```

改为：

```ts
import type { ConfirmationRequest, DeleteBranchResult, GitRemoteStatus } from '../../types/types';
```

把 `BranchesView.tsx:16` 的：

```ts
  onDeleteBranch: (branchName: string) => Promise<boolean>;
```

改为：

```ts
  onDeleteBranch: (branchName: string, options?: { force?: boolean }) => Promise<DeleteBranchResult>;
```

- [ ] **Step 2: 改写 `requestDelete`**

把 `BranchesView.tsx:164-170` 的：

```ts
  const requestDelete = (branch: string) => {
    onRequestConfirmation({
      type: 'deleteBranch',
      message: `Delete branch "${branch}"? This cannot be undone.`,
      onConfirm: () => void onDeleteBranch(branch),
    });
  };
```

替换为：

```ts
  const requestDelete = (branch: string) => {
    onRequestConfirmation({
      type: 'deleteBranch',
      message: `Delete branch "${branch}"? This cannot be undone.`,
      onConfirm: async () => {
        const result = await onDeleteBranch(branch);
        // The safe delete only fails this way when the branch has unmerged
        // commits — offer the irreversible `-D` escalation as a second prompt.
        if (result.status === 'notMerged') {
          onRequestConfirmation({
            type: 'forceDeleteBranch',
            message: `Branch "${branch}" has commits that are not merged. Force delete it? This cannot be undone and those commits may be lost.`,
            onConfirm: () => void onDeleteBranch(branch, { force: true }),
          });
        }
      },
    });
  };
```

> 交互说明：`GitPanel.executeConfirmedAction`（`GitPanel.tsx:78`）先 `setConfirmAction(null)` 再 `await onConfirm()`。这里在 `onConfirm` 里再次调用 `onRequestConfirmation`（即 `setConfirmAction`），第二次弹窗会正常出现；若结果是 `error`/`success`，则不再弹，行为与现状一致（error 走顶部 `operationError`，success 已刷新列表）。

- [ ] **Step 3: 类型检查（应全绿）**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck
```
预期：无输出（通过）。若报出 `types.ts`、`useGitPanelController.ts`、`constants.ts`、`ConfirmActionModal.tsx`、`BranchesView.tsx` 之外文件的错误，说明是 pre-existing 问题，与本任务无关。

- [ ] **Step 4: Lint（仅新增文件范围）**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx eslint src/components/git-panel
```
预期：无**新增**错误（仓库既有 lint 基线不干净，见 `CLAUDE.md`/记忆「backend baseline not clean」；只关注本任务触碰的 5 个文件是否引入新问题）。

- [ ] **Step 5: 提交前端改动**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/git-panel/types/types.ts \
        web/src/components/git-panel/hooks/useGitPanelController.ts \
        web/src/components/git-panel/constants/constants.ts \
        web/src/components/git-panel/view/modals/ConfirmActionModal.tsx \
        web/src/components/git-panel/view/branches/BranchesView.tsx
git commit -m "feat(git-panel): offer force delete when a branch is not fully merged"
```

> 注意：**不要** `git add -A`——`web/src/components/file-tree/hooks/useFileTreeOperations.ts` 有无关的未提交改动。

---

## Task 5: 端到端验证

**Files:** 无（仅验证）

- [ ] **Step 1: 后端全量 git 模块测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git.routes.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/git/tests/git-parsing.test.ts
```
预期：两个文件全部 `# fail 0`。

- [ ] **Step 2: 后端类型检查（零新增）**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm run typecheck
```
预期：与改动前同样的 pre-existing 错误集合（`git.routes.ts` 带 `@ts-nocheck`，不应新增）。先跑一次记录基线，再跑一次对比。

- [ ] **Step 3: 前端类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck
```
预期：通过。

- [ ] **Step 4: 手动验证（浏览器）**

前置：本地 dev server 已在跑（web `:5188` → 后端 `:3188`）；用 IP 访问而非 localhost（`http://<lan-ip>:5188`）。

1. 在一个含未合并分支的测试项目里打开 Git 面板 → Branches 页。
2. 点某未合并分支的删除（垃圾桶）图标 → 出现「Delete Branch」确认 → 确认。
3. **预期**：出现第二个弹窗，标题「Force Delete Branch」、红色「Force Delete」按钮、图标为垃圾桶，文案含 "not fully merged … may be lost"。
4. 点 Cancel → 分支仍在列表里，顶部无错误条。
5. 再次删除 → 在第二个弹窗点「Force Delete」→ **预期**：列表刷新，该分支消失。
6. 反例：删一个**已合并**的分支 → **预期**：一次确认即删除，不出现第二个弹窗。
7. 反例：删当前所在分支 → **预期**：直接报「Cannot delete the currently checked-out branch」，不弹第二个弹窗。
8. （可选）故障注入：对 `/api/git/delete-branch` 返回 `500 {error:'boom'}`，确认只走顶部错误条、不弹强制删除。

- [ ] **Step 5: 更新 spec 状态**

把 `docs/superpowers/specs/2026-10-14-branch-force-delete-design.md` 顶部的 `**状态**：已确认（…）` 改为 `**状态**：已实现（…）`，并把实现涉及的确切提交号列在文末。

```bash
cd /mnt/b/workdir/github/lovdex
git add docs/superpowers/specs/2026-10-14-branch-force-delete-design.md
git commit -m "docs(git-panel): mark force-delete-branch spec implemented"
```

---

## Self-Review

**Spec coverage：**
- 需求 1（未合并失败提示 + 强制删除入口）→ Task 1（结构化 409）+ Task 4（二次确认）。✓
- 需求 2（确认后改 `-D`）→ Task 1 `shouldForce ? '-D' : '-d'` + Task 4 `{ force: true }`。✓
- 需求 3（只对「未合并」提供强制删除）→ Task 1 仅在 `!shouldForce && isNotFullyMergedError` 时返回 409，其余 500。✓
- 需求 4（不可逆需明确确认）→ Task 4 复用 `ConfirmActionModal`，文案明示 commits may be lost。✓
- Spec § 类型/控制器/常量/图标/测试 各节 → Task 2/3/4、Task 1 Step 1。✓

**Placeholder scan：** 无 TBD/TODO；每个改动步骤均含完整代码与确切路径/行号。

**Type consistency：**
- `DeleteBranchResult`（Task 2 Step 1）在三处使用一致：控制器返回类型（Step 5）、接口签名（Step 4）、`BranchesView` props（Task 4 Step 1）。
- 后端 `code: 'BRANCH_NOT_MERGED'`（Task 1 Step 4）↔ 前端判定 `data.code === 'BRANCH_NOT_MERGED'`（Task 2 Step 5）字符串一致。
- `type: 'forceDeleteBranch'`（Task 4 Step 2）↔ `ConfirmActionType` 成员（Task 2 Step 3）↔ 5 个 Record 键（Task 3 Step 1）名称一致。
- 路由 `force` 字段：后端读 `req.body.force`（Task 1 Step 4）↔ 前端发 `force: options?.force === true`（Task 2 Step 5）一致。

**歧义点已消解：** HTTP 状态码取 `409`（语义为冲突）；控制器在 `notMerged` 时不写 `operationError`（已显式说明）。
