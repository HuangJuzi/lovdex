# 分支删除失败时提供「强制删除」

**日期**：2026-10-14
**状态**：已实现（方案：控制器返回结构化结果 + 复用确认弹窗）
**范围**：Git 面板 → Branches 页删除**本地**分支的路径。远程分支只读不可删，无关；Worktrees 目录下 `RemoveWorktreeModal` 自带的 `deleteBranch` 勾选（已走 `-D`）**不改**。

## 背景

现状（`web/src/components/git-panel/view/branches/BranchesView.tsx:164` → `hooks/useGitPanelController.ts:298` → `backend/server/modules/git/git.routes.ts:836`）：

- 前端删除分支只弹一次确认，`onConfirm` 调用 `deleteBranch(branch)`，返回 `Promise<boolean>`。
- 后端 `POST /api/git/delete-branch` 固定执行 `git branch -d <branch>`：任何失败都吞成一个 `500 { error: error.message }`。
- 结果：当一个分支有未合并提交时，`git branch -d` 会失败：

  ```
  error: The branch 'feat/unmerged' is not fully merged.
  If you are sure you want to delete it, run 'git branch -D feat/unmerged'.
  exit=1
  ```

  且这段输出落在 **stderr**。用户只看到「删除失败」，没有任何途径强制删除，只能自己去命令行跑 `-D`。

`spawnAsync`（`git.routes.ts:25`）在非零退出时把 `stdout`/`stderr` 都挂在抛出的 error 对象上，因此后端可以据此判定失败原因。

## 需求

1. `git branch -d` 因「分支未合并」失败时，向用户提示删除失败，并提供「强制删除」入口。
2. 用户确认强制删除后，改用 `git branch -D` 重试。
3. 只对「未合并」这一种可救的失败提供强制删除；其他失败（例如分支不存在、被占用等）保持普通报错，不弹强制删除。
4. `-D` 会丢弃未合并的提交，属不可逆操作，必须先经用户明确确认。

## 设计

### 1. 后端 — `POST /api/git/delete-branch`（`git.routes.ts:836`）

- 请求体新增可选 `force: boolean`（默认 `false`，非 `true` 一律按 `false` 处理）。
- 命令按 `force` 选择：`force ? ['branch', '-D', branch] : ['branch', '-d', branch]`。
- 现有「不能删除当前已 checkout 的分支」的 400 保护**保留**，`force` 也先过这条检查。
- 当 `force === false` 且失败原因为「未合并」时，返回结构化错误（**不是**通用 500）：

  ```json
  { "error": "The branch 'x' is not fully merged", "code": "BRANCH_NOT_MERGED" }
  ```

  判定依据：捕获到的 error 对象的 `stderr`（fallback 到 `stdout`/`message`）包含 `' is not fully merged'`。该句式由 git 按分支名拼接、在非交互式（无 TTY）语言环境下输出英文，`spawnAsync` 走的是 `shell:false` 管道，满足该前提。
- 其他失败保持现状：`500 { error: error.message }`。
- `force === true` 时若仍失败，同样走通用 500（不再是 not-merged）。

### 2. 前端控制器 — `useGitPanelController.deleteBranch`（`useGitPanelController.ts:298`）

返回类型从 `Promise<boolean>` 改为结构化结果，并新增可选 `force` 参数：

```ts
export type DeleteBranchResult =
  | { status: 'success' }
  | { status: 'notMerged' }                 // 触发强制删除二次确认
  | { status: 'error'; message: string };   // 其他错误，走 operationError

deleteBranch: (branchName: string, options?: { force?: boolean }) => Promise<DeleteBranchResult>;
```

- `status === 'notMerged'` 时**不**写 `operationError` —— 它不是错误，是要走二次确认的中间态。
- `status === 'error'` 时保持现有行为：`setOperationError(...)`。
- `status === 'success'` 时 `void fetchBranches()` 刷新（保持现有行为）。
- 判定 `notMerged` 依据响应体 `code === 'BRANCH_NOT_MERGED'`；`force` 透传到请求体。
- 新增类型 `GitOperationResponse` 的 `code?: string` 字段（`types.ts:144`）。

### 3. 前端视图 — `BranchesView`（`BranchesView.tsx:164`）

`requestDelete` 的 `onConfirm` 改为先删、按结果决定是否再弹强制确认：

```ts
const requestDelete = (branch: string) => {
  onRequestConfirmation({
    type: 'deleteBranch',
    message: `Delete branch "${branch}"? This cannot be undone.`,
    onConfirm: async () => {
      const result = await onDeleteBranch(branch);
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

props 类型 `onDeleteBranch` 相应改为新签名（`BranchesView.tsx:16`）。

### 4. 确认弹窗 — `types.ts` / `constants.ts` / `ConfirmActionModal.tsx`

- `ConfirmActionType`（`types.ts:6`）新增 `'forceDeleteBranch'`。
- `constants.ts:28+` 中所有 `Record<ConfirmActionType, ...>` 常量（`CONFIRMATION_TITLES` / `CONFIRMATION_ACTION_LABELS` / `CONFIRMATION_BUTTON_CLASSES` / `CONFIRMATION_ICON_CONTAINER_CLASSES` / `CONFIRMATION_ICON_CLASSES`）补齐该键：
  - 标题：`Force Delete Branch`
  - 按钮：`Force Delete`
  - 按钮/图标样式复用 `deleteBranch` 的 destructive 红。
- `renderConfirmActionIcon`（`ConfirmActionModal.tsx:17`）为 `forceDeleteBranch`（及顺带修正 `deleteBranch`）渲染 `Trash2`，而非当前落到兜底分支的 `Upload` 图标。

### 5. 数据流

```
点击删除 → ConfirmActionModal(deleteBranch) → onConfirm
  → deleteBranch(branch)                      // backend: git branch -d
      ├ success    → fetchBranches()           → 列表刷新，结束
      ├ notMerged  → ConfirmActionModal(forceDeleteBranch)
      │                → onConfirm → deleteBranch(branch,{force:true})  // backend: git branch -D
      │                    ├ success → fetchBranches() → 结束
      │                    └ error   → setOperationError(...)
      └ error      → setOperationError(...)     → 顶部错误条
```

### 6. 测试

- **后端**（`backend/server/modules/git/tests/git.routes.test.ts`）：真实临时仓库中建一个带未合并提交的分支：
  - `POST /delete-branch {branch}`（无 force）→ 断言返回体 `code === 'BRANCH_NOT_MERGED'`，且分支仍在。
  - `POST /delete-branch {branch, force:true}` → 断言成功，分支已消失。
- **前端**：`web/` 无 DOM 测试环境；`deleteBranch` 的结果映射逻辑若可抽成纯函数则单测，否则以后端契约测试为准。

## 不做（YAGNI）

- 不区分「未合并」以外的失败情形。只有「未合并」这一种确知 `-D` 能救，其余失败（分支已不存在、被其他 worktree checkout 等）保持普通报错。
- 不改远程分支（只读）。
- 不改 Worktrees 目录下 `RemoveWorktreeModal` 的删除分支流程。
- 前端不新增独立的专用弹窗组件，复用现有 `ConfirmActionModal`。

---

## 实现与验证记录（2026-10-14）

**提交**
- `5eec8e5` — 后端 `/delete-branch` 支持 `force` + 结构化 `409 BRANCH_NOT_MERGED`，含真实仓库集成测试。
- `b821f35` — 前端：`DeleteBranchResult` 类型、控制器结构化返回、`forceDeleteBranch` 弹窗文案/图标、`BranchesView` 二次确认流程。
- 注：后端的两处评审补强（`validateBranchName` 守卫 + 反例测试）因共享工作区并发提交，实际落在了 `1694405`（另一个 session 的 file-tree 提交）里，非本特性的独立提交。内容正确、已在 main 上。

**验证（全部通过）**
- 后端集成测试：`git.routes.test.ts` 2/2、`git-parsing.test.ts` 5/5。
- 前端 `tsc --noEmit` 绿；`eslint src/components/git-panel` 无新增错误。
- 后端真实 HTTP E2E（新代码独立实例，端口 3199）：未合并安全删除 → `409 BRANCH_NOT_MERGED`（分支保留）；已合并 → 200；当前分支 → 400；未知分支 → 500 无 code；非法分支名 → 500；`force:true` → 200 且分支消失。
- 浏览器 E2E（puppeteer，前端指向 3199）：
  - 强制删除路径：模态1「Delete Branch」→ 确认 → 模态2「Force Delete Branch」（文案含 "not merged … may be lost"）→ 确认 → 弹窗关闭、分支从列表与 git 中消失。PASS
  - 取消路径：模态2 点 Cancel → 弹窗关闭、分支仍在、无错误条。PASS
  - 已合并分支：模态1 确认即删除，**不**出现模态2。PASS
