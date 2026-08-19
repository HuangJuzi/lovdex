# 远程文件管理 / 远程源码管理 / 远程 Provider 设计

日期：2026-08-19
状态：已确认（方案 A：扩展 lite RPC 表面 + main 端按 projectId 透明分流）

## 背景与目标

远程项目（见 [[2026-08-18-remote-projects-design]]）已上线，但远程体验只有：

- **会话**：`session/start`（仅 claude，经 claude-agent-sdk）云远程跑 agent
- **文件**：lite 只有只读 `fs/stat` / `fs/list` / `fs/read`，无法编辑、新建、改名、删除、上传下载
- **git**：完全不存在，git 面板在远程项目上是空的/报错
- **provider**：会话创建时前端 4 个 provider 都展示，不区分是否已装；lite 只能跑 claude

目标（三块，均要求与本地功能对齐）：

1. **远程文件管理** — 参考本地文件管理全量：树浏览（完整 stat 元数据）、文本读写、新建/重命名/删除、上传下载、图片/二进制预览
2. **远程源码管理** — 参考本地 git 面板全量（含 worktrees、push/pull/fetch/publish 等网络操作）
3. **远程运行 provider** — 先扫描远程装了哪些 provider，新建 session 只允许选择已安装的（**本地项目同样按本地安装情况筛选**），配置复用本机

已确认决策：

- 支持全部 4 个 provider（claude/codex/opencode/qoder）在远程运行
- 配置按**会话下发**：`session/start` 参数携带所选 provider 的配置/密钥块（apiKey/token/baseUrl/binPath/model），远程不落盘
- 筛选范围：**远程 + 本地**都按安装情况过滤
- git：含 worktrees 全量
- 文件：含上传下载全量；远程上传**单文件上限 32MB**（WS base64 一次载入）
- 传输架构：扩展 lite RPC 表面（方案 A），不走 main 直连 ssh 跑命令——反隧道（VLAN 隔离）主机只能由 lite 拨出

## 现状（关键事实）

- 现有 RPC（lite `rpc-dispatch.ts:58-89`）：`session/start`（仅 claude）、`session/interrupt`、`approval/respond`、`fs/stat`、`fs/list`、`fs/read`；其余抛 `unknown rpc method`。能力上报硬编码 `['session/claude','fs/stat','fs/list','fs/read']`（`remote-agent/src/index.ts:86`）
- lite fs（`remote-agent/src/fs.ts`）root 白名单 `resolveWithinRoots`（fs.ts:93-103），list 上限 2000、read 上限 16MiB
- `registry.rpc(hostId, method, params, timeoutMs=60_000)`（registry.ts:131-167）；`hello` 帧首到为主；push 主题 `session:<appSessionId>` / `approval:<requestId>`
- `rpc_cancel` 帧协议已定义但两端均未接线（protocol.ts；lite 无 cancel handler）
- local git 模块 DI 缺口：`createGitModule` 注入 `fileSystem/spawnProcess/resolveProjectPathById`（git.module.ts:10-16）；~18 个操作 + worktrees 5 个全以 `git` 子进程实现、输出由 `git-parsing.service.ts` 在 main 解析
- 文件端点全部内联在 `index.js`，按 `projectId → projectsDb.getProjectPathById` 解析路径；上传为 multipart
- provider 注册表硬编码 4 个（provider.registry.ts:9-14）；本机 installed 探测 = 各 `auth.getStatus()`（`claude --version` / `codex --version` / `opencode --version` / `qodercli --version`，spawn.sync）；前端 `ProviderSelectionEmptyState` 4 个全展示、不看安装状态
- 本机 provider 配置在 `app.config.json`（`~/.lovdex/data/`），`env-sync.ts` 同步进 `process.env`；本地 claude 远程路由已存在（`remote-spawn.ts wrapSpawn`，仅 claude）
- 远程项目判定：`projects.remote_host_id`（schema.ts:99）→ `lookupRemoteHost(projectPath)`（remote-projects.index.ts:41-44）；`POST /api/projects/create-remote-project` 已用 `statRemote` 校验路径
- 测试基线：tsc/lint 已有 pre-existing 错误，验收标准"零新增"（见 [[lovdex-backend-baseline-not-clean]]）；反隧道主机 main 无法直连 ssh，只能经 lite 通道

## 总体方案（方案 A）

**核心原则：main 端按 `projectId → remote_host_id` 透明分流。** 前端文件/git/worktrees 代码不改，同一批 HTTP handler 内部按项目归属走 RPC 或走本地；唯一前端改动是 provider 选择器过滤。

### §1 RPC 协议扩展（`backend/server/shared/agent-runtime/protocol.ts` + lite `rpc-dispatch.ts`）

#### 文件

| 方法 | 参数 | 返回 |
|---|---|---|
| `fs/tree` | `{ path, maxDepth?, showHidden? }` | `{ path, nodes: FileTreeNode[] }` |
| `fs/write` | `{ path, content, encoding?: 'utf8'\|'base64' }` | `{ success, size }` |
| `fs/create` | `{ parentPath, type: 'file'\|'directory', name }` | `{ success, path }` |
| `fs/rename` | `{ oldPath, newName }` | `{ success, newPath }` |
| `fs/delete` | `{ path, type }` | `{ success }` |
| `fs/read` | 现有 + `encoding?: 'base64'` | `{ content, truncated }` |

- `fs/tree` 镜像本地 `getFileTree`（index.js:1687-1788）的节点形状：`name/path/type/size/modified(ISO)/permissionsRwx/isSymlink/children`；IGNORED_DIRS（node_modules 等）在 lite 侧跳过；maxDepth 由路由传入（项目树用 10），超深提示同本地
- 写面全部沿用 `resolveWithinRoots` 白名单；`fs/create` 已存在同名 → 409；`fs/delete` 禁删 root；`fs/rename` 目标存在 → 409
- base64 读取上限 32MB（与上传一致），超限 413/截断提示

#### git（lite 固定命令集合，不做任意 shell）

| 类别 | 方法 |
|---|---|
| 状态/视图 | `git/status` `git/diff` `git/file-diff` `git/branches` `git/commits`(limit) `git/commit-diff` `git/remote-status` |
| 变更 | `git/init` `git/stage` `git/unstage` `git/commit` `git/initial-commit` `git/revert-local-commit` `git/discard` `git/delete-untracked` |
| 分支 | `git/checkout` `git/create-branch` `git/delete-branch` |
| 网络 | `git/fetch` `git/pull` `git/push` `git/publish` |
| worktrees | `git/worktrees-list` `git/worktree-create` `git/worktree-open` `git/worktree-merge` `git/worktree-remove` |

- 每方法一组写死 argv（如 `git status --porcelain -z`）；参数（project 路径、文件名、branch 等）经 root 校验 + 净化后追加
- 返回 `{ stdout, stderr, exitCode }`，**解析全在 main**（复用 `git-parsing.service.ts`，解析逻辑唯一一份）
- 提交身份：main 从本机 `user_git_config`（或全局 git config）取 `user.name/email` 放进 RPC 参数，lite 以 `git -c user.name=… -c user.email=…` 注入，远程不落身份状态
- push/pull/publish：**远程主机自备网络凭据**（ssh key / credential helper / https token），main 不代管；错误透传本地 git 现有的网络/认证错误映射
- worktree-merge 命令较长，超时策略见 §3

#### provider 探针与 hello

- `providers/probe`：`{ providers: [{ provider, installed, version? }], gitInstalled, nodeVersion, os }`
- `hello` 帧增加可选字段 `providers`（lite 启动探测一次，重连带上来）；registry 缓存供 `GET /api/remote-agents/:hostId/providers`（支持 `?refresh=1` 重探）
- `session/start` 泛化：参数增加 `provider`（LLMProvider）与 `configEnv: Record<string,string>`（本机该 provider 的 apiKey/token/baseUrl/binPath/model 等，由 **main 从本机配置组装，不来自客户端**）；lite 按 provider 分发 run manager，configEnv 注入当前子进程 env，不写全局、不落盘

#### 取消

- 接线 `rpc_cancel`：lite 收到后 abort 对应进行中的 git 命令（spawn 带 AbortSignal）与可中断的 provider run

### §2 lite 端改动（`backend/remote-agent/`）

- **fs.ts**：补 `tree/write/create/rename/delete` + `read(base64)`；复用 IGNORED_DIRS 常量、root 白名单、现有上限
- **git.service.ts（新）**：跨进程 git（cross-spawn），cwd 校验在 roots，`--literal-pathspecs` + `-c` 注入，支持 AbortSignal
- **agents/ 泛化**：`agent-run.ts` 现有 claude SDK 循环保留；新增 codex（SDK）/ opencode（spawn + JSON 协议）/ qoder（spawn + stdio approval 协议）run manager，镜像本地 `openai-codex.js` / `opencode-runner.js` / `qoder-runner.js` 的参数与 approval 逻辑；approval 推送复用 `approval:<requestId>` 主题 + `approval/respond`
- **probe.ts（新）**：`--version` 探测 + hello 携带
- esbuild 捆绑内联新增依赖（codex SDK 等打进 `lite.mjs`）

### §3 main 端改动（`backend/server/`）

#### 文件端点分支

现有文件端点（`GET /files`、`GET /file`、`PUT /file`、`create/rename/delete`、`GET /files/content`、`POST /files/upload`）handler 内按 projectId 归属分支：

- 树 → `fs/tree`；文本读写 → `fs/read`/`fs/write`；改名/删除/新建 → 对应 RPC
- 上传 = 现有 multipart 路由收到后逐文件 base64 经 `fs/write`，单文件 32MB 上限（超限 413）
- 下载/图片预览 = `fs/read(encoding:'base64')` 解码后流式返回，同样 32MB 上限
- 本地实现零改动，块按原逻辑走

#### git / worktrees 路由分支

- `git.routes.ts` 注入 `spawnProcess/fileSystem/resolveProjectPathById` 的 DI 缺口上，按 projectId 归属选 RPC 或本地实现
- worktrees 路由同样加分支（`remote_host_id` 续查）
- 解析复用 `git-parsing.service.ts`

#### RPC 超时策略

`registry.rpc` 默认 60s；`git/fetch|pull|push|publish|worktree-merge` 用 180s；`fs/write`（上传）用 120s；路由 AbortSignal 触发时补发 `rpc_cancel`

#### provider 侧

- `GET /api/providers/installed`（新）：`{ providers: [{ provider, installed }] }`，本机走 `auth.getStatus()`，内存 60s TTL 缓存
- `GET /api/remote-agents/:hostId/providers`（新）：host 探针缓存，`?refresh=1` 经 RPC 重探
- `POST /api/providers/sessions` 增加校验：目标归属（host/本机）校验 provider 已安装，未装 400（防绕过前端）
- `index.js` `spawnFns`：codex/opencode/qoder 也包 `remoteRouting.wrapSpawn`（此前只有 claude）

### §4 provider 选择器（唯一前端改动）

- 新建会话时判定目标：当前项目远程 → 目标 host；否则本机
- 取可用列表（本机 `api.providers.installed` / 远程 host providers）→ 过滤 `PROVIDER_META`，只显示已安装
- 全部未安装 → 空态提示（远程：引导 settings/redeploy；本机：引导装 CLI）
- 已选 provider（localStorage）在目标不可用 → 弹回选择态
- 模型枚举维持 main 现有实现（复用本机配置）

### §5 验证

- lite 单测（`backend/remote-agent/src/tests/`）：临时目录仿 roots，覆盖 fs 写面/tree 裁剪/git 全操作/probe
- main 路由单测：mock registry.rpc，覆盖远程项目文件/git/worktrees 分流 + 未安装 provider 400
- 实机 E2E（172.26.167.52，见 [[lovdex-remote-e2e-host]]）：远程项目建树→改文件→git init/commit→远程 claude 会话冒烟；目标装 codex 则再冒烟 codex
- 验收：tsc/lint "零新增"错误

## 分阶段实施顺序

1. 协议扩展 + lite fs 写面 + main 文件路由分支（远程文件管理闭环）
2. lite git 服务 + main git/worktrees 路由分支（远程源码管理闭环）
3. `providers/probe` + lite run manager 泛化（codex/opencode/qoder）+ session/start 泛化 + installed 接口 + 前端选择器过滤
4. 上传下载/图片预览远程化（大部分随 1 完成，收尾）
5. 实机 E2E + 回归

## 风险与取舍

- **codex/opencode/qoder runner 移植进 lite bundle**：依赖内联（esbuild），qoder stdio 审批协议、opencode JSON 协议按本地实现镜像；冒烟量最大的一步
- **远程 git 网络凭据**：push/pull 依赖远程主机自备凭据，文档化提示；不做代管
- **WS 上行体积**：base64 上传 32MB 上限避免挤爆内存/卡死 WS；超大文件走 scp/sftp（远程终端/引导流程已有 ssh 能力）
- **模型枚举仍在本机**：与远程实际安装可能不一致（用户确认接受，配置复用本机）；运行时的 `model` 参数交给远程二进制消费