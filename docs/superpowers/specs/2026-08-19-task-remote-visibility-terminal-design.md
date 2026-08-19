# 新建任务远程可见性 / 远程终端设计

日期：2026-08-19
状态：已确认（方案：任务表单按项目过滤 + 终端主控端 ssh 分流）

## 背景与目标

远程项目（见 [[2026-08-18-remote-projects-design]] 与 [[2026-08-19-remote-file-git-provider-design]]）已上线：后端执行层完全 remote-aware（`spawnFns` 全量经 `remoteRouting.wrapSpawn` 按 project_path 透明分流，任务与会话共用），后端 `/api/projects` 已返回 `remoteHostId` / `remoteHostName`。但前端还有两处对本机/远程一视同仁，造成体验断裂：

1. **新建任务**（`TaskBoard.tsx` 新建任务 Modal + `ScheduledTaskForm.tsx` 定时任务表单）
   - 项目下拉不标注远程，用户看不出目标机在哪
   - 执行引擎下拉**硬编码 4 个**（claude/codex/opencode/qoder），不看目标机安装情况：远程主机上没装的引擎也能选，装上没装的（本地有远程无）也照常展示
2. **终端**：`/ws/terminal` 无条件在主控机起本地 shell，cwd 解析只认主控机本地目录（`fs.existsSync` + workspace root 白名单）。远程项目的路径在主控机不存在 → 落到主控机工作区根目录，用户以为连了远程实际在用主控机本地 shell

目标：

1. 新建任务（含定时任务表单）的项目下拉能看出本地/远程；执行引擎按选中项目自动过滤（本地→本机已装引擎，远程→该主机已装引擎，离线/未装→禁用+提示）
2. 远程项目的终端真实落在远程主机、在远程项目目录下起 shell，并在界面上标识连接的主机

已确认决策：

- 执行引擎「选远程」的语义 = **按项目自动过滤**（与聊天侧 Provider 选择器过滤一致），不做显式"远程"开关；后端分流逻辑不变
- 远程终端实现路径 = **主控端 ssh 直连分流**（node-pty 起 `ssh -t`），不在 lite agent 上新增流式 PTY RPC
- 远程终端的连接对象在 UI 上**加主机标识**（`SSH: <hostName>` 徽标）
- 定时任务表单（`ScheduledTaskForm.tsx`）同步改造
- 远程主机探测不到任何引擎（离线/未装）→ 引擎下拉**禁用 + 提示**，不回退本机列表

## 现状（关键事实）

**前端任务表单**（`web/src/components/tasks/`）
- `TaskBoard.tsx:479-498` 项目 `<select>`：label 仅 `displayName`，无远程标识；`taskFormProjects()`（`projectOptions.ts:13-22`）只排 `isOperatorWorkspace`，无远程字段
- `TaskBoard.tsx:499-511` 执行引擎 `<select>`：硬编码 4 个 option
- `TaskBoard.tsx:512-530` 模型下拉：`/api/providers/${engine}/models`（主控机目录），随引擎切换重拉
- `ScheduledTaskForm.tsx:102-119` 项目/引擎下拉同款硬编码
- `Project` 类型（`web/src/types/app.ts:64-81`）已有 `remoteHostId?` / `remoteHostName?`
- 侧边栏远程徽标先例：`SidebarProjectItem.tsx:120-136`（indigo Server 图标 + `remoteHostName`）

**引擎候选的数据源（聊天侧已有先例）**
- 本地：`api.getInstalledProviders()` → `GET /api/providers/installed`（`web/src/utils/api.js:215-219`，本机探测 60s TTL 缓存；非 OK 抛错让调用方降级）
- 远程：`api.getRemoteHostProviders(hostId)` → `GET /api/remote-agents/:hostId/providers`（`api.js:222-227`；`remote-agents.routes.ts` 服务注册表缓存，`?refresh=1` 或空缓存时经 lite `providers/probe` 重探；主机离线抛 `REMOTE_HOST_OFFLINE`）
- 聊天侧消费先例：`ChatMessagesPane.tsx` 按 `selectedProject?.remoteHostId` 二选一；空态在 `ProviderSelectionEmptyState.tsx:143-173`

**远程终端**
- 前端：`TerminalPane.tsx:40-43` 把抽屉 `cwd` 作为 `?cwd=` 追加到 `/ws/terminal` URL；抽屉上下文 `useTerminalDrawer.tsx` 只有 `{ cwd }`；`AppContent.tsx:95-97` 以 `selectedProject.fullPath || path` 设置 cwd
- 后端：`terminal-websocket.service.ts:90-134` `handleTerminalConnection` 无条件 `spawnPty(shell, [], { cwd: resolveTerminalCwd(...) })`；`resolveTerminalCwd`（L63-83）只认 main 本地 workspace root 内 `fs.existsSync` 的目录
- 依赖注入：`index.js:246-250` 注入 `spawnPty` / `shell` / `cwd`
- 主控机→远端 ssh 通道已验证可用：remote-hosts 表（`database/schema.ts:104-109`，`host` / `ssh_user` / `port`）+ 全局 `identityFile`（`index.js:141-147`，`<dataDir>/ssh/lovdex_ed25519`）；引导安装流程（scp 推送 + ssh 执行 install 脚本）已实际走通主控机→远端通道；`bootstrap.service.ts:87` 已有 `sshArgs` 构造先例（`-o StrictHostKeyChecking=accept-new` / `-o ConnectTimeout=15` / `-i identity`）
- lite RPC 总线是请求/响应式（`remote-agents.registry.ts:150-213`），无流式帧协议 → 不适合挪作终端流，这是选 ssh 路径的原因

## 设计

### 第 1 节：新建任务（TaskBoard Modal + ScheduledTaskForm）远程可见性与引擎过滤

**1a. 项目下拉加远程徽标**

两处 `<option>` 渲染：`project.remoteHostName` 有值时，label 前加侧边栏同款 indigo Server 徽标（图标 + hostname），`title="远程主机：<hostname>"`。抽一个共享小函数（如 `web/src/components/tasks/remoteProjectLabel.tsx`）供两处复用，样式对齐 `SidebarProjectItem`。

**1b. 执行引擎按选中项目自动过滤**

引擎候选解析逻辑（两处表单共用一套 hook 或工具函数）：

| 选中项目 | 引擎候选来源 | 行为 |
|---|---|---|
| 🤖 Lovdex助手 | 固定 claude | 提示语照旧，引擎/模型设置被忽略 |
| 本地项目 | `getInstalledProviders()` | 拉取中禁用并显示加载；失败降级为 4 引擎 + 提示（与聊天侧「错误不等于没装」一致） |
| 远程项目 | `getRemoteHostProviders(hostId)` | 主机离线 / 探测为空 → 下拉禁用 + 提示「该主机离线或无可用引擎」，提交被拦截；失败降级同本地 |

细节：
- 切换项目时重新拉取；用请求序号/取消守卫防竞态（参考 `useChatProviderState` 的 `requestIdRef` 模式）
- 引擎候选 shape 对齐聊天侧 `installedProviders` 的消费方式（探测返回已装列表；为空既可能离线也可能真没装，统一按禁用+提示处理）
- 模型下拉不动：仍 `/api/providers/<engine>/models` 主控机目录，与聊天侧远程会话既有约定一致（模型名全局配置，实际执行值由远端 run 决定）

### 第 2 节：远程终端（主控端 ssh 分流 + 主机标识）

**2a. 前端**

- `useTerminalDrawer.tsx` 上下文从 `{ cwd }` 扩为 `{ cwd, hostId, hostName }`；`setCwd(next: string | null, meta?: { hostId?: string | null; hostName?: string | null })`
- `AppContent.tsx:95-97` 设置 cwd 时带 `selectedProject.remoteHostId / remoteHostName`
- `TerminalPane.tsx:40-43`：`hostId` 存在时 URL 追加 `&hostId=`；远程时在抽屉标题/终端栏渲染 `SSH: <hostName>` 徽标（本地不渲染，保持现状）

**2b. 后端**

- `TerminalDependencies` 增加：`resolveRemoteHost(hostId): { host: string; port: number | null; sshUser: string } | null`（注入 remote-hosts repo `getById`）+ `identityFile: string | null`（注入 `index.js:145` 的 `<dataDir>/ssh/lovdex_ed25519`）
- `handleTerminalConnection` 读 URL `hostId`：
  - 有 `hostId` 且查到 host 行 → `spawnPty('ssh', [...sshArgv, `${sshUser}@${host}`, remoteCmd], { cols, rows, env })`
    - `sshArgv`：`-t`、`-o StrictHostKeyChecking=accept-new`、`-o ConnectTimeout=15`、`-i identityFile`、port≠22 时 `-p <port>`
    - `remoteCmd`：`cd ${shellQuote(cwd ?? '~')} && exec $SHELL -l`（单引号转义，对齐 `ssh-runner.ts` 的 argv 纪律，不用 shell 字符串拼）
  - 无 `hostId`（或 host 行不存在）→ 原本地逻辑不动
  - cwd 语义：远程分支**不做主控机 fs 校验**（路径在远端），交给远端 `cd`；失败 → 远端 shell 退出 → exit 帧 → 前端显示 shell 退出
- 依赖注入在 `index.js:246-250` 扩展（remote-hosts repo + identityFile 均已在作用域）

### 错误处理边界

| 场景 | 表现 |
|---|---|
| 远程终端：host 行不存在 / hostId 无效 | 后端 `error` 帧 + 关闭连接，前端终端区显示连接失败 |
| 远程终端：ssh 连不上（不可达/超时） | ssh 输出进 pty 用户可见；15s ConnectTimeout 钳制 |
| 远程终端：远端项目目录不存在 | 远端 cd 失败 → exit 帧，前端显示 shell 退出 |
| 远程项目 + 引擎探测空/离线 | 引擎下拉禁用+提示，提交被拦截 |
| 引擎拉取网络失败 | 降级展示 4 引擎 + 提示（不拦截） |
| 聊天/任务会话终端 | cwd 来自项目级 `setCwd` → 远程项目全面覆盖 |

## 测试

后端单测（node:test，`backend/server/modules/terminal/tests/` 及依赖模块）：
- `resolveTerminalCwd` / 远程 cwd：带 hostId 不做本地 fs 校验，cwd 空落 `~`
- ssh argv 构造：port≠22 带 `-p`、identity 恒带、`remoteCmd` 含单引号/空格正确转义
- 无 hostId 走原本地逻辑（回归）
- `handleTerminalConnection` 经注入 `spawnPty` 假实现断言（现有 `PtyLike` 已抽好）

前端单测（vitest）：
- TaskBoard：切远程项目 → 触发 `getRemoteHostProviders`，引擎选项=探测结果；空/离线 → 禁用+提示；切回本地 → `getInstalledProviders`
- ScheduledTaskForm 同套断言
- TerminalPane：有 hostId 时 URL 含 `&hostId=`；远程时 drawer 标题渲染「SSH: hostName」
- 远程徽标：项目 option label 含 hostname、title 提示

## 明确不做（边界）

- 远程模型的按主机目录（沿用本地目录，与聊天一致）
- 终端自定义 shell 选择
- 经 lite 流式 RPC 的终端（已定走 ssh 直连）
- 任务表单项目下拉以外的远程入口改造（列表中其他选择器保持现状）

## 实现注记（实施后补充）

- 项目下拉的远程标识用**文本前缀** `🌐 <hostName> · <name>` 而非样式徽标——原生 `<option>` 只能渲染文本，无法内嵌 styled badge；终端 pane 的 `SSH: <hostName>` 徽标不受此限（pane 内覆盖层）
- 远端引擎探测失败与“探测为空”统一走 **禁用+提示**（`REMOTE_HOST_OFFLINE` 与网络错误从前端 API 无法可靠区分，且用户已选“空则禁用”）；仅**本地**探测失败降级为 4 引擎 + 提示
- `/ws/terminal` 远程分支的本地 `cwd` 参数传给 node-pty 的 `dependencies.cwd`（ssh 不使用主控端 cwd），远端落点在 argv 的 `cd` 命令里
- 空 cwd 的远程默认：ssh argv 末尾为 `exec $SHELL -l`（不带 `cd`），登录 shell 天然落在远端 $HOME——不能用 `cd '~'`（单引号会取消远端 shell 的 tilde 展开导致 cd 失败）
- 实现覆盖：TaskBoard 新建任务 Modal 与 ScheduledTaskForm 同步（项目前缀 + 引擎按目标机过滤 + 提交守卫）；`/ws/terminal` 按 `?hostId=` 走 `ssh -t` 分流（unknown hostId 直接拒绝，不回落本地 shell）

## 验证

- 手工：已有远程主机 + 远程项目 → 新建任务选远程项目，引擎下拉=远程主机已装引擎；断掉主机再试 → 禁用+提示；打开远程项目终端 → shell 提示符为远端主机、`pwd` 为远程项目目录、UI 显示 `SSH: <hostName>`
- 本地项目回归：引擎下拉=本机已装、终端行为与改造前一致