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

## 配置

配置集中存放在 `~/.lovdex/data/app.config.json`，首次启动后端自动生成（含随机 JWT 密钥）。Web UI 侧边栏「设置 → Providers」可视化编辑；敏感字段（API key/token）以掩码展示，写入走 `PUT /api/config`（需登录）。

唯一保留的环境变量为 `AUTH_ENABLED`（逃生阀）：设 `false` 进入免登录本地模式。

## 远程项目（Remote Projects）

在远程机器上原生运行 Claude 会话：远程文件夹可作为「项目」加入，Agent（Claude Code SDK）在**远程机器上**读写文件、跑命令，事件流与审批回传到本工作台。

### 系统架构

```
┌── 主站 Lovdex（backend :3188 + web :5188）──────────────────────────────────────────────┐
│  modules/remote-agents/（index.js 装配的单例栈）                                          │
│                                                                                          │
│    registry ←───────────────── 接收每个 lite 的出站 WS（/api/remote-agents/ws）            │
│    remote-spawn ← chat/task 的 spawnFns 包装（本地路径直通，远程路径转 RPC）                │
│    remote-projects.index ── projectPath▸hostId 路由表（建/删项目时刷新）                    │
│    normalizeRemoteEvent（index.js）── 事件归一化：transformMessage + normalizeMessage      │
│    REST（bootstrap/ssh-runner/lite-package）── 一键部署                                   │
└─────┬──────────────────────────────────────────────┬───────────────────────────────────┘
      │ outbound WS（每台主机一个 token）               │ ssh/scp/systemd（部署 lite）
      ▼                                               ▼
┌───────────────┐                            ┌───────────────────────────┐
│ 远程机 A lite   │  hello + rpc_req/rpc_res   │ 远程机 B lite（同左）        │
│  agent-run.ts ▸ Claude SDK（cwd=远程项目）    │  · 进程常驻于 systemd --user│
│  fs.ts（根白名单） │◂── push session:/approval│  · 重连/心跳/致命码退出      │
└───────────────┘                            └───────────────────────────┘

会话数据流：浏览器 chat.send → main chat-websocket → remote-spawn → registry.rpc('session/start')
→ lite agent-run（远程原生执行）→ push 事件 → remote-spawn → normalizeRemoteEvent → 聊天 UI
审批：lite canUseTool → push approval:<requestId> → 浏览器审批面板 → permission-response
→ main → approval/respond RPC → lite settle → SDK 继续
```

### 模块清单（Phase 1）

**主站侧 — `backend/server/modules/remote-agents/`**

| 模块 | 职责 |
|---|---|
| `shared/agent-runtime/protocol.ts` | 主↔lite WS 帧类型与编解码（hello / rpc_req+rpc_res / push / ping+pong），session/start 参数 schema |
| `shared/agent-runtime/normalize.ts` | SDK 事件最小透传包装（加 eventId）+ 合成 `complete`（主站侧再跑 transformMessage+normalizeMessage） |
| `remote-host.db.ts` | `remote_hosts` 表仓库（CRUD / 状态 / token hash / 按项目路径找主机） |
| `remote-agents.registry.ts` | 在线主机连接注册表：RPC 待决表、sessionHost/审批索引、离线清扫、`closeHost` |
| `remote-agent.server.ts` | 接收 lite 出站连接的 WS 服务（`/api/remote-agents/ws`）：token→hostId、hello 校验（4001/4002）、push 总线 |
| `remote-spawn.ts` | spawn/abort/approval 路由层：远程项目会话转发给 lite、事件归一化进 writer（index.js 里构造**一次**供全 provider 共享） |
| `remote-projects.index.ts` | `projectPath→hostId` 内存索引（启动/建删项目刷新） |
| `remote-fs.service.ts` | 主站侧 fs RPC 客户端（stat/list/read） |
| `runtime.ts` | 注入 seam：把 registry+fsClient 交给路由，解耦 index.js |
| `bootstrap.service.ts` | 一键部署：ssh 探测、写 config/.env（0600）、推 install.sh+systemd unit+lite.tgz、装 systemd --user |
| `ssh-runner.ts` | ssh/scp 的 argv-only 封装 + `sshpass` 一次性公钥注入 |
| `lite-package.ts` | 现场用 esbuild 打包 lite 为自包含 `dist/lite.mjs` 并 tar |
| `remote-agents.routes.ts` | REST：机器 CRUD / pubkey / 部署（阻塞 5-15s）/ 远程目录浏览 |

**远程机侧 — `backend/remote-agent/`（独立部署包）**

| 模块 | 职责 |
|---|---|
| `config.ts` | 读 `~/.lovdex-remote/config.json`（serverUrl/token/hostId/roots 白名单） |
| `index.ts` | `createLiteService`：出站 WS 客户端、hello、心跳、重连/致命码退出、断线打断活动 run |
| `rpc-dispatch.ts` | 分发表：session/start·interrupt、approval/respond、fs/stat·list·read |
| `agent-run.ts` | Claude SDK 会话循环：事件推送、审批等待+超时自动拒、interruptAll、**cwd 根白名单** |
| `fs.ts` | 白名单 fs（realpath 根内校验，stat/list/read） |
| `deploy/install.sh` + `systemd-unit.template` | 远程安装：自包含 bundle 免 npm ci；systemd --user 单元（`%h` 家目录、绝对 node 路径、linger） |

**前端 — `web/src/components/`**

| 模块 | 职责 |
|---|---|
| `settings/RemoteHostsSettingsSection.tsx` | 设置「远程机器」Tab：列表 / 部署 / 删除 / pubkey 参考 |
| `settings/AddRemoteHostDialog.tsx` | 一键添加弹窗：名称/主机/端口/用户/密码 → 注入公钥+注册+部署+轮询一条龙 |
| `project-creation-wizard/components/StepRemoteConfiguration.tsx` | 建项目「远程」模式：选在线主机 + 浏览远程目录 |
| `sidebar/…/SidebarProjectItem.tsx` | 远程项目显示 `主机:/路径` 标记 |

### 使用

1. 设置 → **远程机器** → **添加远程机器**（弹窗一站式）：填名称/主机/端口/SSH 用户，选**密码**（或已装 Lovdex 公钥）。密码模式会一次性用 `sshpass` 把你机器的 ed25519 公钥注入目标 `~/.ssh/authorized_keys`，随后自动部署 lite 并轮询到在线。**密码用完即弃、不入库**；之后全部走密钥。
2. 建项目 → 选 **远程** 来源 → 选在线主机 → 浏览/输入远程目录 → 创建；侧栏远程项目显示 `主机:/路径` 标记。
3. 在该项目开会话/任务即运行在远程机器上。

**前置/环境**：Lovdex 宿主需要 `sshpass`；目标机需要 `node ≥ 20` + `claude` CLI（引导失败会在面板显示原因）。目标机不是本机回环时，部署环境需设 `LOVDEX_PUBLIC_WS_URL=ws://<主站可达地址>:3188/api/remote-agents/ws`，否则 lite 会去连自己的 localhost。

**安全**：密码一次性注入公钥后即弃；lite 的 `fs/*` 与会话 `cwd` 均限制在注册的项目根内（realpath 白名单）；主机 token = HMAC(hostId, 应用 JWT 密钥)，删除/失配主机会让 lite 干净退出（不再重启循环）。

**v1 已知限制**：远程会话的聊天历史为空（`session/messages` 未实现，Phase 2 补）；删除主机后目标机上的 lite 停止不再自启（需重部署才恢复）；断线重连沿用「重发即重开新一轮」，不透明接管。

## 开发

```bash
cd backend && npm run dev      # API + WS，:3188
cd web && npm run dev          # UI，:5188
```