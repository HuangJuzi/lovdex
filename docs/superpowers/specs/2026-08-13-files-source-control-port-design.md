# Lovdex Files + Source Control 面板移植 — 设计文档

- 日期：2026-08-13
- 状态：已批准（brainstorming 收敛）
- 来源：移植 `~/workdir/claudecodeui`（CloudCLI v1.37.1）的 Files（文件树 + CodeMirror 编辑器）与 Source Control（Git 四视图）面板
- 范围：**方案 A（直接移植 + 适配层）+ 分两期交付**

## 1. 背景与目标

### 1.1 起因

Lovdex 主内容区目前是"简化版"：只剩 chat 标签页，`activeTab` 里 `files/git` 分支被移除（`MainContent.tsx` 头注释明确标注）。文件树、shell、git、code-editor 面板全部缺失。用户希望把 claudecodeui 里打磨完善的 Files 与 Source Control 面板移植回来。

### 1.2 调研结论

两个项目技术栈高度重合（React 18 + Vite + Tailwind + lucide-react + shadcn 风格 CSS 变量），且**同源**：`Project` 类型、`api.js`（`authenticatedFetch` + `X-Refreshed-Token` 刷新）、`useProjectsState` 结构几乎一致。

关键差异/现状：

| 能力 | claudecodeui | lovdex 现状 |
|---|---|---|
| 文件 CRUD 后端 | `server/modules/file-tree/` | **已存在**于 `server/index.js`（`/api/projects/:projectId/files|file|create|rename|delete|upload`），方法签名/返回树形状一致 |
| 文件树前端 | `src/components/file-tree/`（15+ 文件） | 无（只有只读 `FilePreviewModal`） |
| 代码编辑器 | CodeMirror 6（`EditorSidebar` 右栏） | 无（无 CodeMirror 依赖） |
| Git 后端 | `server/modules/git/`（routes 1594 行 + parsing service） | **无**（只有 `git-rewind.js` stash/checkout、`gitConfig` stub、clone service） |
| Worktrees 后端 | `server/modules/worktrees/`（链接项目） | 无 |
| Git 前端 | `src/components/git-panel/`（四视图 + commitGraph） | 无 |
| Toast | 组件内 `useState` + 3s 自动隐藏 | 无全局 toast（不需要，照搬即可） |
| 提交作者 | `git commit -m` 靠 git 全局配置 | 同理，忽略 gitConfig stub |

### 1.3 目标

在 Lovdex 恢复两个面板，交互与 claudecodeui **完全一致**：

1. **Files**：文件树浏览/搜索/新建/重命名/删除/上传/右键菜单 + CodeMirror 6 编辑器（可编辑保存、diff 叠加视图）
2. **Source Control**：Changes（状态/暂存/提交/diff/丢弃）+ History（提交历史/图）+ Branches（切换/新建/删除）+ Worktrees（list/create/open/merge/remove）
3. 恢复 MainContent 标签页切换：chat / files / git（tasks 仍走 ViewSwitcher 路由导航）

### 1.4 非目标（YAGNI）

- **AI 生成提交信息**：不做（用户明确选择），提交信息手写 textarea
- Chat 会话内文件引用的打开方式：保持现状（只读 `FilePreviewModal`），不扩 scope
- Shell 面板、Browser 面板、plugin 面板：不在本期范围（MainContent 简版注释里同样被移除的其他面板）
- Git 面板的代码补丁/暂存区 diff 内联编辑：不做
- 会话侧 git 历史联动（rewind）：已有 `git-rewind.js`，不动

### 1.5 设计原则

- **直接移植优先**：用户要求与 claudecodeui 完全一致，因此组件级拷贝 + 最小适配层，不重写。
- **后端零改动 Phase 1**：Files 面板纯前端落地，Phase 1 无需重启后端（避免影响同后端其他项目）。
- **后端只增不改 Phase 2**：git/worktrees 为**新增模块 + 新增路由**，不触碰现有路由/中间件/DB schema，把重启风险降到最低。
- **重启必须确认**：任何一次后端重启（`systemctl --user lovdex`）前先找用户确认。

## 2. 总体架构（两期）

```
Phase 1 Files ── 后端零改动（映射现有 /api/projects/:id/* 文件接口）
　　　　　　　└─ 前端移植 file-tree/ + code-editor/ + CodeMirror 依赖
Phase 2 SC ── 后端新增 server/modules/git/ + server/modules/worktrees/
　　　　　└─ 前端移植 git-panel/ + api.js 追加 git 方法
共同 ──── 恢复 MainContent 标签页(chat/files/git) + EditorSidebar 编辑栏
```

数据流（与 claudecodeui 一致）：
- Files：`FileTree` → `useFileTreeData` → `api.getFiles(projectId)` → `/api/projects/:id/files` → 嵌套树 → 递归渲染。编辑经 `useCodeEditorDocument` → `api.readFile/saveFile`。
- Git：`GitPanel` → `useGitPanelController` → `api.git.*` → `/api/git/...` → `cross-spawn('git', ...)` → 解析 → React 状态。worktree 打开 → `api.worktrees.*` → `/api/worktrees/...`。

## 3. Phase 1 — Files 面板

### 3.1 前端移植清单（lovdex-cli）

从 claudecodeui 拷贝以下目录并适配：

- `src/components/file-tree/`：
  - `constants/constants.ts`（视图模式、上传限制、图片扩展名）、`constants/fileIcons.ts`（扩展名→lucide 图标/颜色）
  - `hooks/useExpandedDirectories.ts`、`useFileTreeData.ts`、`useFileTreeOperations.ts`、`useFileTreeSearch.ts`、`useFileTreeUpload.ts`、`useFileTreeViewMode.ts`
  - `utils/fileTreeUtils.ts`（`filterFileTree`、`formatFileSize`）
  - `view/FileTree.tsx`（根，props `{selectedProject, onFileOpen}`）、`FileTreeBody/List/Node/Header/DetailedColumns/ContextMenu/ImageViewer/EmptyState/LoadingState/UploadProgress`
  - `types/types.ts`
- `src/components/code-editor/`：
  - `hooks/useCodeEditorDocument.ts`（read/save，`diffInfo` 短路径）
  - `hooks/useEditorSidebar.ts`（`editingFile` 状态 + 宽度/拖拽）
  - `view/CodeEditor.tsx`、`view/EditorSidebar.tsx`
- `src/hooks/useFileOpenResolver.ts`：**已有**（lovdex 现存），仅确认类型兼容，不重复移植。

### 3.2 适配层

| 适配点 | 做法 |
|---|---|
| API | claudecodeui `api.getFiles/readFile/saveFile/...` 签名与 lovdex 完全一致，URL 前缀不同（`/api/file-tree/projects/` vs `/api/projects/`），**方法名直接复用，零改动** |
| 共享 UI 原语 | 组件内 import 的 `Button/Input/ScrollArea/Badge/Confirmation/...` 映射到 lovdex `shared/view/ui`；若 claudecodeui 用到了 lovdex 没有的原语（如 `ContextMenu` 相关），照搬对应原语或降级为现有 `ActionMenu` |
| Toast | claudecodeui 是组件内 `useState` + `setTimeout` 自驱，随组件照搬 |
| i18n | 复用 lovdex 已有 `common.json` 的 `fileTree.*`、`fileOperations.*`、`tabs.files` key；缺的 key 补进对应 locale |
| 主题 | 两边同套 shadcn CSS 变量（`bg-background`/`border-border` 等），Tailwind 配置一致，类名直接生效 |

### 3.3 后端

**零改动**。Phase 1 结束前人工验证 lovdex 现有文件接口与 claudecodeui FileTree 的期望响应形状（`{name,path,type,size,modified,permissions,permissionsRwx,isSymlink,children}`、忽略目录列表、深 10 上限）完全匹配。

### 3.4 依赖新增

`lovdex-cli/package.json`：

```
@uiw/react-codemirror
@codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-css
@codemirror/lang-html @codemirror/lang-markdown @codemirror/lang-python
@codemirror/merge
@replit/codemirror-minimap
```

（与 claudecodeui 相同）

## 4. Phase 2 — Source Control

### 4.1 后端（新增模块，按 lovdex `modules/tasks/` 的 barrels+路由模式落地）

**`server/modules/git/`**：
- 移植 claudecodeui `git.routes.ts`（`@ts-nocheck` 单文件路由）：status / diff / file-with-diff / commits / commit-diff / branches / remote-status / init / initial-commit / commit / stage / unstage / checkout / create-branch / delete-branch / fetch / pull / push / publish / discard / delete-untracked / revert-local-commit
- 移植 `git-parsing.service.ts`（`parseGitStatusOutput` porcelain 解析、`parseGitLogWithStats`）
- **去掉 `queryClaude/queryCursor` 注入**（AI 提交信息不做），module 不再依赖 Agent SDK
- `projectPath` 解析改走 lovdex `projectsDb.getProjectPathById`（`server/modules/database/repositories/projects.db.ts`），顺带做路径安全校验
- 错误 envelope **保持 claudecodeui 的 `{success, error}`** 形状（前端 `useGitPanelController` 按此读取），路由内部已有 try/catch
- 用 `cross-spawn`（lovdex `git-rewind.js` 已有先例）
- 挂载：`app.use('/api/git', authenticateToken, gitRoutes)`

**`server/modules/worktrees/`**：
- 移植 worktree list/create/open/merge/remove；`worktree-git.service.ts`（`git worktree list --porcelain` 解析、dirty 计数、ahead/behind）
- `linkedProjectId` 链接 lovdex `projects` 表（open worktree 即切项目）；沿用 `{success, data|error}` envelope
- 挂载：`app.use('/api/worktrees', authenticateToken, worktreesRoutes)`

### 4.2 前端移植清单（lovdex-cli）

`src/components/git-panel/` 全量拷贝：
- `constants/constants.ts`（状态标签/badge、`RECENT_COMMITS_LIMIT=50`）
- `hooks/useGitPanelController.ts`（核心控制器：并行拉 status/branches/remote-status + 每文件 diff；`AbortController` + 项目切换 stale guard；openFile→`/api/git/file-with-diff`）
- `hooks/useRevertLocalCommit.ts`、`useSelectedProvider.ts`（**删除**，AI 提交信息不做）
- `hooks/useWorktreesController.ts`
- `utils/gitPanelUtils.ts`、`utils/commitGraph.ts`（含 `commitGraph.test.ts`）
- `view/GitPanel.tsx`（根）、`GitPanelHeader.tsx`、`GitViewTabs.tsx`、`GitRepositoryErrorState.tsx`
- `view/changes/`（ChangesView、FileChangeList、FileChangeItem、CommitComposer、FileSelectionControls、FileStatusLegend）
- `view/history/`（HistoryView、CommitHistoryItem、CommitGraphStrip）
- `view/branches/BranchesView.tsx`
- `view/worktrees/WorktreesView.tsx`
- `view/shared/GitDiffViewer.tsx`
- `view/modals/`（ConfirmActionModal、NewBranchModal、NewWorktreeModal、MergeWorktreeModal、RemoveWorktreeModal）
- `types/types.ts`

`src/utils/api.js` 追加：
- `git: { status/diff/fileWithDiff/commits/commitDiff/branches/remoteStatus/init/initialCommit/commit/stage/unstage/checkout/createBranch/deleteBranch/fetch/pull/push/publish/discard/revertLocalCommit }`
- `worktrees: { list/create/open/merge/remove }`
- 与 claudecodeui 同形状（`?project=projectId` query 参数）

提交信息为手写 textarea（Ctrl/Cmd+Enter 提交），去掉 AI 生成按钮；非 git 项目 → `GitRepositoryErrorState` 提供 `git init`。

### 4.3 前端 props 对接

- `GitPanel` props `{selectedProject, isMobile, onFileOpen, onProjectSelect, onProjectsRefresh}`：
  - `onProjectSelect` → 调现有 `useProjectsState` 项目切换
  - `onProjectsRefresh` → 调现有 `useProjectsState.refresh`（或等价的 `refreshProjects`）

## 5. 集成层（两期共用）

### 5.1 MainContent 标签页恢复

- `MainContent.tsx` body 按 `activeTab` 条件渲染（与 claudecodeui 同构）：
  - chat：`hidden/block` 切换（现状不动）
  - `files`：`<FileTree selectedProject onFileOpen={handleFileOpen}/>`，外包 `h-full overflow-hidden`
  - `git`：`<GitPanel .../>`，外包 `h-full overflow-hidden`
- 头部新增 chat/files/git 三段开关：放在现有 `ViewSwitcher`（chat↔tasks 路由导航）旁，或与 `MainContentTitle` 相邻；点击调 `useProjectsState.setState({activeTab})`
- `useProjectsState` 已持久化 `activeTab`（`VALID_TABS` 含 `files/git`），**状态层零改动**
- 移除 `MainContent.tsx` 顶部 "Simplified edition" 注释中与本期无关的措辞（仅 git/files 相关分支复活）

### 5.2 文件打开

- **面板内打开**（Files/Git）：`FileTree`/`GitPanel` 自带 `onFileOpen(path)` 回调 → MainContent 的新 `handleEditorOpen` 写入 `useEditorSidebar` 的 `editingFile` state → 渲染 `EditorSidebar`（右侧可拖拽编辑栏，可跨 tab 打开；git 面板打开时经 `/api/git/file-with-diff` 传 `{old_string,new_string}` 给 `<codemirror/merge>` 显示 diff 叠加）。此路径**不经** `useFileOpenResolver`
- **Chat 会话内文件引用** → **保持现状**：`useFileOpenResolver`（已有）解析裸/部分路径 → 只读 `FilePreviewModal`
- 两条路径各自独立，`FilePreviewModal` 与 `EditorSidebar` 并存，互不干扰

### 5.3 错误与空态

- 无选中项目：现有 `MainContentStateView mode="empty"` 兜底（files/git 同样依赖 `selectedProject`）
- Files：加载/错误/空态各自组件内处理
- Git：`notGitRepository` → `git init` 引导；各操作错误（pull 冲突、push 非快进等）沿用 claudecodeui 的错误映射文案

## 6. 安全

- 全部新路由挂 `authenticateToken`（现有 JWT 中间件），与现有路由同暴露面
- 路径安全：git 模块 `validateProjectPath`（必须绝对路径、非根目录）、`validateCommitRef`/`validateBranchName`/`validateFilePath`（防 path traversal）随移植保留
- `projectPath` 只经 `projectsDb.getProjectPathById` 解析，不接受任意路径参数作为工作目录
- 提交/推送等 git 写操作有确认弹窗（`ConfirmActionModal`），与 claudecodeui 一致

## 7. 测试

### 后端

- git-parsing service：porcelain 输出（modified/added/deleted/untracked/staged/renames/conflicts）、log `\x1f` 格式解析（照搬 claudecodeui 单测，适配 import 路径）
- git 路由：mock `spawnAsync`，验证参数、`cwd=projectPath`、错误映射（非 git 仓库、push 拒绝、pull 冲突）
- worktrees：`git worktree list --porcelain` 解析、dirty 计数、ahead/behind
- 挂载/鉴权：`/api/git`、`/api/worktrees` 未带 token → 401

### 前端

- 移植 `commitGraph.test.ts`
- FileTree：加载/空/错误三态、搜索过滤+自动展开、新建/重命名/删除流程、上传进度
- EditorSidebar：read/save 往返、`diffInfo` 短路径、宽度拖拽
- GitPanel：Changes 乐观暂存队列、CommitComposer 手写提交、worktree 操作序列化
- MainContent：chat/files/git 标签切换渲染

### 手工验证

- Files：项目打开 → 文件树 → 编辑保存 → 刷新后内容持久；右键菜单操作
- Git：改动 → 暂存 → 提交 → 历史图 → 分支切换 → worktree 打开切项目
- 不回归：chat 会话、任务页、终端抽屉

## 8. 部署与约束

- **Phase 1（Files）**：纯前端，vite 构建产物经现有服务即时生效，**后端不重启**
- **Phase 2（Source Control）**：后端新增模块 + 路由，**只增不改**现有代码。落地后需要重启后端（`systemctl --user lovdex`）时，**必须先找用户确认**（同一后端跑着其他项目，见 memory：`lovdex-backend-restart-requires-confirm`）
- 后端测试命令沿用：`--tsconfig server/tsconfig.json`（见 memory：`lovdex-tsx-env-gotcha`，跑 lovdex-cli 测试前先 `unset TSX_TSCONFIG_PATH`）

## 9. 涉及文件

### Phase 1 — 前端（lovdex-cli）

- `package.json` — 新增 CodeMirror 依赖组
- `src/components/file-tree/**`（新建，从 claudecodeui 拷贝适配）
- `src/components/code-editor/**`（新建）
- `src/components/main-content/view/MainContent.tsx` — 恢复 `files` 分支 + 标签切换 + 挂 `EditorSidebar`
- `src/components/main-content/view/subcomponents/MainContentTitle.tsx` — 复用现有 `files` 分支（已存在）
- `src/components/main-content/` 相关 types（如需透传 `onFileOpen`）
- `src/i18n/locales/*/common.json` — 补缺的 `fileTree.*` / `fileOperations.*` key
- 测试：对应 `.test.tsx`

### Phase 2 — 后端（lovdex-backend）

- `server/modules/git/index.ts`、`git.routes.ts`、`git-parsing.service.ts`、`git.module.ts`（新建）
- `server/modules/worktrees/index.ts`、`worktrees.routes.ts`、`services/*`（新建）
- `server/index.js` — 挂载 `/api/git`、`/api/worktrees` + `authenticateToken`
- 测试：`server/modules/git/tests/*`、`server/modules/worktrees/tests/*`（新建）

### Phase 2 — 前端（lovdex-cli）

- `src/components/git-panel/**`（新建，从 claudecodeui 拷贝适配，删 AI 提交信息切片）
- `src/utils/api.js` — 追加 `api.git.*`、`api.worktrees.*`
- `src/components/main-content/view/MainContent.tsx` — 恢复 `git` 分支
- 测试：`commitGraph.test.ts` 等移植 + 新组件测试

## 10. 待确认（已通过问题收敛）

- 移植方案：A（直接移植 + 适配层）✅
- Files 范围：与 claudecodeui 完全一致（树 + CodeMirror 编辑器）✅
- Source Control 范围：四视图（Changes/History/Branches/Worktrees）✅
- AI 提交信息：不做 ✅
- 面板位置：MainContent 标签页（chat/files/git）✅
- 后端重启：Phase 2 落地需重启时先找用户确认 ✅
