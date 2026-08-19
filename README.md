# Lovdex

Lovdex 是一个面向 Claude Code / Codex / OpenCode / Qoder 编码代理的 Web 管理工作台：可视化会话、任务（Task Board）、Operator 助手、文件浏览与终端、Git 面板，并提供各 provider 的凭据与运行参数配置。

## 布局

- `web/` — React 前端（Vite）。`npm install && npm run dev`（:5188），`/api`、`/ws` 代理到后端。
- `backend/` — Express API + WebSocket 后端。`npm install && npm run dev`（:3188）。
- `backend/remote-agent/` — 远程项目使用的独立轻量部署包（remote-lite），见下方「远程项目」。
- `supervisor/` — 守护进程，可同时拉起前后端（systemd user unit 见 `systemd/`）。
- `docs/` — 设计/计划文档。

## 系统架构（整体）

```
┌─ 访问入口 ────────────────────────────────────────────────┐
│  浏览器（手机/电脑经 IP 访问 :5188）· API/CLI 客户端 :3188  │
└───────────────────────────┬───────────────────────────────┘
                            ▼  REST /api + WebSocket
┌─ web 前端（React + Vite，:5188）────────────────────────────┐
│  侧栏/聊天/任务板/Operator/文件树/终端/Git/设置             │
│  /api、/ws（chat、/ws/terminal）代理到后端                  │
└───────────────────────────┬────────────────────────────────┘
                            ▼
┌─ backend（Express + ws，:3188；由 supervisor 守护拉起）─────┐
│  modules/                                                    │
│    providers {claude, codex, opencode, qoder} · projects     │
│    tasks · scheduler · operators · terminal · websocket      │
│    git · worktrees · assets · auth · config · database       │
│    remote-agents（远程项目子系统，见下）· claude-sdk.js 封装   │
└──────┬───────────────────────────────┬──────────────────────┘
       │ 本地 spawn 各 provider SDK     │ 出站 WS（每台主机一 token）
       ▼                               ▼
  provider API（Anthropic/OpenAI…）   每台远程机 remote-lite
  （本地项目在此执行）                （远程项目在此执行，见「远程项目」）
       │
       ▼
  SQLite ~/.lovdex/data/new-auth.db
  （sessions / projects / tasks / scheduled_tasks / remote_hosts …）
```

- **单后端**：所有 provider（claude/codex/opencode/qoder）共用同一套 REST/WS 管线，`modules/providers` 内按能力面对称组织；`claude-sdk.js` 是本地 Claude 会话的封装。
- **supervisor**（`systemd/`，`systemctl --user lovdex`）负责拉起/重启前后端；本地会话与任务跑在宿主，远程项目经 `remote-agents` 转发到各远程机的 lite 上执行。
- **持久化**：better-sqlite3 单库，路径由 `~/.lovdex/data/app.config.json` 决定（默认 `new-auth.db`）。

### 功能模块清单

| 功能模块 | 主要作用 | 位置 / 后端支撑 |
|---|---|---|
| **会话聊天**（Chat） | 与编码代理（Claude/Codex/OpenCode/Qoder）的对话：消息流、工具审批、会话历史与归档、模型切换 | `/` 工作区 · `providers/` + `websocket/` |
| **任务面板**（Task Board） | 任务看板：任务列表/筛选/状态流转/详情页/重试/表格视图，两层状态模型（`status`+`sub_status`） | `/tasks`、`/task/:id` · `tasks/` |
| **Lovdex 助手**（Assistant） | 内置 Operator 助手：全局助手会话、独立开任务、`execute_skill` 技能执行、凭证白名单/审计 | `/assistant` · `operators/` |
| **文件浏览**（Files） | 项目文件树：浏览/预览/编辑/新建/改名/删除/上传下载；**远程项目全量等价**（走 fs RPC 写面） | `/` Files tab · `projects/` + `remote-agents` |
| **终端**（Terminal） | 交互式 shell（PTY 生命周期、重连缓冲） | `/shell` · `terminal/` + `websocket/` |
| **源码管理**（Git / Worktrees） | Git 面板（提交历史/分支/diff/输出解析）+ worktree 并行开发；**远程项目同样可用**（git RPC，提交身份复用本机） | `/` Git tab · `git/` + `worktrees/` + `remote-agents` |
| **定时任务**（Scheduled） | 到点提醒/执行、错过聚合提醒，侧栏入口 | 侧栏入口 · `scheduler/` |
| **远程项目**（Remote） | 远程机器上的完整项目体验：多 provider 会话（claude/codex/opencode/qoder）、文件管理、Git/Worktrees，全部在远程原生执行；一键添加/部署；新建会话按目标机安装情况过滤。模块细分见「远程项目」章节 | 设置/建项目向导 · `remote-agents/` |
| **设置**（Settings） | Providers 凭据与运行参数、Operator 技能/白名单、远程机器、账号/改密、数据库 | `/settings` · `config/` + `auth/` + `operators/` |
| **登录认证**（Auth） | 登录门槛（固定邮箱+口令）+ JWT；`AUTH_ENABLED=false` 逃生阀 | 全站入口 · `auth/` |

> 支撑基础设施：SQLite 单库（`database/`，`~/.lovdex/data/new-auth.db`）+ `supervisor/` 守护进程（`systemctl --user lovdex`）拉起/重启前后端。

## 配置

配置集中存放在 `~/.lovdex/data/app.config.json`，首次启动后端自动生成（含随机 JWT 密钥）。Web UI 侧边栏「设置 → Providers」可视化编辑；敏感字段（API key/token）以掩码展示，写入走 `PUT /api/config`（需登录）。

唯一保留的环境变量为 `AUTH_ENABLED`（逃生阀）：设 `false` 进入免登录本地模式。

## 远程项目（Remote Projects）

远程机器的目录可作为「项目」加入，获得与本地项目**等价**的完整体验——不只是跑会话，还包括文件管理、源码管理、多 provider。所有执行都发生在**远程机器上**，事件流与审批回传到本工作台。

三条能力线：

1. **远程会话**：在远程项目里开 Agent 会话，四种 provider（claude / codex / opencode / qoder）都可在远程原生运行。新建会话时按**目标机实际安装情况**过滤 provider（本地项目按本机安装过滤，接口 `/api/providers/installed` + `/api/remote-agents/:hostId/providers`）；本机 provider 配置按会话下发（`configEnv`，不落盘）。
2. **远程文件管理**：文件树浏览（完整元数据）、读写、新建/改名/删除、上传下载、图片预览——与本地文件管理全量对齐，后端文件端点按项目归属透明分流（`remote-fs.service.ts` → lite `fs.ts` 写面）。
3. **远程源码管理**：Git 面板（status/diff/commit/branches/log/fetch/pull/push…）与 **worktrees** 在远程仓库上同样可用；提交作者复用本机 git 身份（`-c user.name/email` 注入），push/pull 网络凭据由远程主机自理。

### 系统架构

```
┌── 主站 Lovdex（backend :3188 + web :5188）──────────────────────────────────────────────┐
│  modules/remote-agents/（index.js 装配的单例栈）                                          │
│                                                                                          │
│    registry ←───────────────────── 接收每个 lite 的出站 WS（/api/remote-agents/ws）       │
│    remote-spawn ← 全 provider 的 spawnFns 包装（本地直通 / 远程转 RPC + _remoteNorm 透传）│
│    remote-projects.index ── projectPath▸hostId 路由表（+ lookupHostForPath 按 roots 前缀）│
│    remote-fs.service / remote-git.service / remote-adapters ── 文件/git 的远程客户端       │
│    （routes 内按 projectId 归属透明分流；worktrees 经 host-aware runGitCommand）           │
│    sessions 安装校验（远程走探针缓存/重探，本地走 60s TTL installed）                      │
│    REST（bootstrap/ssh-runner/lite-package）── 一键部署、探针                          │
└─────┬──────────────────────────────────────────────┬───────────────────────────────────┘
      │ outbound WS（每台主机一个 token）               │ ssh/scp/systemd（部署 lite）
      ▼                                               ▼
┌───────────────┐                            ┌───────────────────────────┐
│ 远程机 A lite   │  rpc_req/rpc_res + push    │ 远程机 B lite（同左）        │
│  · session/start（provider 分派 + configEnv）│  · 进程常驻于 systemd --user│
│  · fs/*（tree/write/create/rename/delete）  │  · 重连/心跳/致命码退出      │
│  · git/exec（roots 内固定命令集）           │  · probe：4 个 provider CLI │
│  · providers/probe                        │    + git 版本 → hello/能力上报│
│  · rpc_cancel（中止长跑命令）               │                            │
└───────────────┘                            └───────────────────────────┘

会话数据流：浏览器 chat.send → main chat-websocket → remote-spawn → registry.rpc('session/start')
→ lite（按 provider 分派到 claude/codex/opencode/qoder runner，远程原生执行）→ push 事件
→ remote-spawn（_remoteNorm 透传 / claude 原始事件归一化）→ 聊天 UI
审批：lite 工具询问 → push approval:<requestId> → 浏览器审批面板 → permission-response
→ main → approval/respond RPC → lite 写入对应 CLI 的审批输入（claude SDK canUseTool / codex 审批策略 / opencode / qoder stdio control_response）
```

**路由判定**：文件/git/worktrees 端点在 main 端按 `projectId → remote_host_id`（及在线主机 roots 前缀回退）决定走本地还是 RPC——**前端零改动**，远程项目打开后文件树/Git 面板自动工作。

### 模块清单

**主站侧 — `backend/server/modules/remote-agents/`**

| 模块 | 职责 |
|---|---|
| `shared/agent-runtime/protocol.ts` | 主↔lite WS 帧类型与编解码（hello / rpc_req+rpc_res / push / ping+pong / **rpc_cancel**）；`session/start` 参数 schema（含 `provider` + `configEnv`）；fs/git/probe RPC 参数 schema |
| `shared/agent-runtime/normalize.ts` | SDK 事件最小透传包装 + 合成 `complete` |
| `remote-host.db.ts` | `remote_hosts` 表仓库（CRUD / 状态 / token hash / 按项目路径找主机） |
| `remote-agents.registry.ts` | 在线主机注册表：RPC 待决表（支持 AbortSignal→rpc_cancel）、sessionHost/审批索引、**探针缓存 hostProviders**、离线清扫、离线时清缓存 |
| `remote-agent.server.ts` | 接收 lite 出站 WS（`/api/remote-agents/ws`）：token→hostId、hello（含 providers 上报）、push 总线 |
| `remote-spawn.ts` | 全 provider 的 spawn/abort/approval 路由：`_remoteNorm` 消息透传、非 claude 终态去重、approval cancelled 处理 |
| `remote-projects.index.ts` | `projectPath→hostId` 索引 + `lookupHostForPath`（roots 前缀匹配，覆盖 worktree 等路径） |
| `remote-fs.service.ts` | 主站侧 fs RPC 客户端：stat/list/**tree/write/create/rename/delete**/base64 read；32MiB 上限常量 |
| `remote-git.service.ts` | 主站侧 git RPC 客户端（identity 注入 + 长超时）+ `readLocalGitIdentity` |
| `remote-adapters.ts` | 把 git.routes 的 cross-spawn/fs 注入点替换为远程感知适配器（child-shim + fs 代理） |
| `runtime.ts` | 注入 seam：把 registry+fsClient 交给路由，解耦 index.js |
| `bootstrap.service.ts` | 一键部署：ssh 探测、写 config/.env（0600）、推 install.sh+systemd unit+lite.tgz |
| `ssh-runner.ts` | ssh/scp argv-only 封装 + `sshpass` 一次性公钥注入 |
| `lite-package.ts` | esbuild 打包 lite 为自包含 `dist/lite.mjs`（banner 别名 createRequire 兼容内联 codex SDK） |
| `remote-agents.routes.ts` | REST：机器 CRUD / pubkey / 部署 / 远程目录浏览 / **`GET :hostId/providers` 探针** |

**远程机侧 — `backend/remote-agent/`（独立部署包）**

| 模块 | 职责 |
|---|---|
| `config.ts` | 读 `~/.lovdex-remote/config.json`（serverUrl/token/hostId/roots 白名单） |
| `index.ts` | `createLiteService`：出站 WS、hello、心跳、重连/致命码退出、**Node<19 裸 crypto polyfill**、rpc_cancel 收口、断线打断所有 provider 的 run |
| `rpc-dispatch.ts` | 分发表：`session/start`（按 provider 分派缓存 manager）、fs/*、`git/exec`、`providers/probe`、approval/respond |
| `fs.ts` | 白名单 fs：stat/list/read(+base64)/**write/create/rename/delete/tree**（realpath 根内校验，禁改 root，防 symlink 逃逸） |
| `git.ts` | roots 内的 `git/exec`：cwd 校验、禁 `-C/--git-dir/--work-tree`、identity 注入、进程组 SIGKILL + 立即 settle |
| `probe.ts` | 探测 4 个 provider CLI 的 `--version` + git/node/OS，供能力上报与 `providers/probe` |
| `agent-run.ts` | Claude SDK 会话循环（含 `pathToClaudeCodeExecutable`、configEnv 合入 env、审批+超时自动拒） |
| `providers/registry.ts` | `createRunManagerFor`：claude / codex / opencode / qoder 按 provider 分派 |
| `providers/codex|opencode|qoder-runner.ts` | 三个 provider 的 runner（SDK / CLI JSON 协议 / stdio 审批协议），推送 `_remoteNorm` 消息 |
| `providers/run-shared.ts` / `lite-normalize.ts` | 共享 run 记录/审批注册表/env 合并/complete 标记；NormalizedMessage 信封复刻 |
| `deploy/install.sh` + `systemd-unit.template` | 远程安装：自包含 bundle 免 npm ci；systemd --user 单元（`%h` 家目录、绝对 node 路径、linger） |

**前端 — `web/src/components/`**

| 模块 | 职责 |
|---|---|
| `settings/RemoteHostsSettingsSection.tsx` | 设置「远程机器」Tab：列表 / 部署 / 删除 / pubkey 参考 |
| `settings/AddRemoteHostDialog.tsx` | 一键添加弹窗：名称/主机/端口/用户/密码 → 注入公钥+注册+部署+轮询一条龙 |
| `project-creation-wizard/components/StepRemoteConfiguration.tsx` | 建项目「远程」模式：选在线主机 + 浏览远程目录 |
| `chat/view/subcomponents/ProviderSelectionEmptyState.tsx` | **provider 选择器按目标机安装情况过滤**（本地 installed / 远程探针），未装空态提示 + 自动跳可用 provider |
| `sidebar/…/SidebarProjectItem.tsx` | 远程项目显示 `主机:/路径` 标记 |

### 使用

1. 设置 → **远程机器** → **添加远程机器**（弹窗一站式）：填名称/主机/端口/SSH 用户，选**密码**（或已装 Lovdex 公钥）。密码模式会一次性用 `sshpass` 把你机器的 ed25519 公钥注入目标 `~/.ssh/authorized_keys`，随后自动部署 lite 并轮询到在线。**密码用完即弃、不入库**；之后全部走密钥。
2. 建项目 → 选 **远程** 来源 → 选在线主机 → 浏览/输入远程目录 → 创建；侧栏远程项目显示 `主机:/路径` 标记。
3. 在远程项目里：文件树/Git 面板/worktrees 自动走远程（与本地交互一致）；开会话时 provider 选择器只显示**该主机已安装**的 provider，选好后会话即在远程机器上运行。

**前置/环境**：Lovdex 宿主需要 `sshpass`；目标机需要 `node ≥ 20`（提示：Node 18 也可跑——lite 已 polyfill 裸 crypto，但建议 ≥20）+ `claude` CLI；codex/opencode/qoder 按需安装，未装的会在选择器里隐藏。目标机不是本机回环时，部署环境需设 `LOVDEX_PUBLIC_WS_URL=ws://<主站可达地址>:3188/api/remote-agents/ws`，否则 lite 会去连自己的 localhost。

**安全**：密码一次性注入公钥后即弃；lite 的 `fs/*`、`git/exec` 与会话 `cwd` 均限制在 roots 白名单内（realpath 校验，git 另禁重定向选项）；按会话下发的 `configEnv` 只进当次子进程环境、不落盘；主机 token = HMAC(hostId, 应用 JWT 密钥)，删除/失配主机会让 lite 干净退出。

**v1 已知限制**：远程会话的聊天历史为空（`session/messages` 未实现，Phase 2 补）；远程「打开 worktree 为项目」的新项目行暂不带 remote_host_id（list/create/merge/remove 可用，open 待补）；git push/pull 网络凭据需远程主机自理；断线重连沿用「重发即重开新一轮」，不透明接管。

## 开发

```bash
cd backend && npm run dev      # API + WS，:3188
cd web && npm run dev          # UI，:5188
```