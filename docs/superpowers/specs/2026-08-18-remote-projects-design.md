# 远程文件夹（Remote Projects）设计

日期：2026-08-18
状态：已确认（方案 A：remote-lite agent-core 切片）

## 背景与目标

Lovdex 目前的项目都是 **Lovdex 宿主机上的本地路径**：建项目时 `fs.mkdir` 本地目录，会话/任务启动时由 `claude-sdk.js` 在本地 spawn Claude Code SDK（`cwd = 本地项目路径`），文件读写与命令执行全部发生在宿主机。

目标：把远程机器上的一个目录作为「项目」添加进来，并且是**完整项目体验**——在远程项目里开 Agent 会话、建任务，Agent 在远程机器上原生读写文件、跑命令（npm install / test / git 等），体验和本地项目一致。

约束与已确认决策：

- 目标机器是**自己的机器，可装软件**（Node、Claude CLI 等）。
- 传输层**直接上 hostagent daemon**（而非纯 SSH 管道）。
- 用户本意是「把我现在的后端简化一下放过去」——因此 hostagent 不另起炉灶，而是**复用现有后端 agent-core 切片**（即方案 A），不是搬整个 Express 后端，也不是从零写 daemon。
- Key 管理默认：Lovdex 生成 ed25519 密钥对，一键植入远程 `authorized_keys`（ssh-copy-id 式），机器注册表常驻，支持「添加之前已远程过的机器上的目录」。

调研参照：OpenAI Codex 远程开发调研报告（`backend/docs/` 或 `/tmp/codex-remote-dev-research.html`）。核心借考点：行为执行与 UI 解耦、远程原生文件系统（不做本地镜像）、远端主动注册 + 客户端配对、事件流回传；不照搬 codex exec-server 的 process/fs/http 转发模型。

## 现状（关键事实）

- `projects` 表：`project_path TEXT UNIQUE`（本地绝对路径），创建走 `validateWorkspacePath` + `fs.mkdir`。
- `sessions` 表：`provider / project_path / provider_session_id` 等；会话行为与 `project_path` 绑定。
- `claude-sdk.js`（`queryClaudeSDK` + 运行循环）：本地 `@anthropic-ai/claude-agent-sdk` spawn claude CLI；事件归一化、工具审批（`waitForToolApproval`）、`AskUserQuestion/ExitPlanMode` 交互、中断、resume 全在这里。
- **执行层已留缝**：`chat-websocket.service.ts` 与 `headless-task-run.service.ts`（operator 的 `start_task_execution` 走它）都通过 `spawnFns: Record<LLMProvider, ProviderSpawnFn>` 启动会话。远程落地点 = 在这层加 `resolveSpawnFnForSession()`，按 session 所属 project 是否远程路由。
- 会话 transcript：本地由 SDK 写 `~/.claude/projects/.../*.jsonl`，`claude-session-synchronizer.provider.ts` 读取用于历史消息。
- 密钥存储：已有 `user_credentials` 表（github token 等，明文存储），可复用做 SSH 私钥。
- 当前**没有**任何 SSH/远程概念（仅 git clone 支持 ssh URL）。

## 总体方案（方案 A：remote-lite）

### 1. 拓扑与组件

```
┌────────────────────────── 主 Lovdex（浏览器连它）──────────────────────────┐
│  · 新增模块 modules/remote-agents（WebSocket 服务端 + registry: host_id→连接）
│  · 新增 remote-host 服务：machine registry + ssh 引导 + 密钥管理
│  · projects 加 remote_host_id（project_path 存远程绝对路径）+ 校验分支
│  · spawnFns 层加 resolveSpawnFnForSession()：远程 session → remoteSpawnFn
│  · 审批透传：chat.permission-response → remote-agents → lite
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ 出站 WS（远程主动注册，可穿 NAT）
                                ▼
┌────────────────────── 远程机器 remote-lite（node 服务）───────────────────┐
│  · agent-core 切片：queryAgentSDK()（由 queryClaudeSDK 跑循环抽取，事件/     │
│    审批 seam 化），在远程原地 spawn claude CLI
│  · 会话/transcript 在远程原生落盘（复用 synchronizer 逻辑读远程 JSONL）
│  · 允许根白名单（只允许操作注册过的远程项目路径）
│  · fs RPC（list/read/stat）→ 文件树/编辑器读取
│  · systemd --user 常驻，断线重连 + 心跳
└──────────────────────────────────────────────────────────────────────────────┘
```

- remote-lite 是**现有后端 provider + agent 循环的切片**（共享一份抽取出的模块），不是新 daemon 协议，行为本地/远程一致。
- lite 主动出站连主 Lovdex；主站是固定入口，无需 rendezvous 服务器。

### 2. 线上协议与会话数据流

一条持久出站 WS，两端双向：

```
lite ──出站──▶ 主
  connect → hello{hostId, agentVersion, nodeVersion, os, roots, capabilities}
  ← rpc.req {id, method, params}
        session/start {sessionId, providerSessionId?, command, cwd, options}
        session/interrupt | session/stop
        approval/respond {requestId, decision}
        fs/stat | fs/list | fs/read {path}          [v1 只读]
        session/messages {providerSessionId}        [拉取远程 transcript]
  → rpc.res {id, ok, data|error}
  → push: session.event {sessionId, event}          [实时事件流]
  → push: approval.request {sessionId, requestId, approval}
  ↕ ping/pong（心跳 + 离线判定）
```

`chat.send`（远程项目）链路：

1. 浏览器 `chat.send` → 主 `chat-websocket` 解析 session，发现 project 是远程。
2. 主走 `remoteSpawnFn`（替代本地 `queryClaudeSDK`）：注册 relay adapter（sessionId→事件翻译器），发 `session/start.req`（cwd=远程路径）。
3. lite 用 `queryAgentSDK()` 在远程 spawn claude CLI，`--session-id` 显式传 providerSessionId（断线重连后 `--resume` 可确定性续）。
4. lite 推 `session.event` → 主翻译成与本地同构的归一化事件，复用现有 chat websocket 扇出；**transcript 由 lite 远程原生落盘**，主不重复写本地 JSONL。
5. 打开聊天/任务详情要 history → 主问 lite `session/messages` → lite 在远程读，返回归一化消息。

审批链路：lite 触发审批 → push `approval.request` → 主 → 浏览器审批面板 → 用户决定 → 浏览器 `chat.permission-response` → 主 `resolveToolApproval` → 转发 `approval/respond` → lite 本地 `waitForToolApproval` resolve → SDK 继续。

断线（v1 简化）：WS 断开 → 主标记 host 离线，在途 session 标 interrupted；用户重发 → 复用 providerSessionId `session/start` + resume。v1 不做透明会话接管，重连渲染靠 `session/messages` 重拉。

任务继承：`headless-task-run.service.ts` 与 chat 共用 `spawnFns` 缝，远程 session 的 executor 会话同样经 remoteSpawnFn 启动；operator 全局助手仍跑在主上，任务/verdict 状态机在主页，不受影响。

### 3. 引导、密钥与机器注册表

新表 `remote_hosts`：

```
remote_hosts
  host_id TEXT PK
  name TEXT                -- 显示名
  host TEXT                -- 主机名/IP
  port INTEGER DEFAULT 22
  ssh_user TEXT
  auth_type TEXT           -- 'lovdex_key' | 'existing_key' | 'password'
  key_credential_id INTEGER → user_credentials.id（私钥/密码/lovdex 密钥引用）
  agent_token_hash TEXT    -- lite 鉴权 token 的 hash（主库存 hash）
  os TEXT                  -- probe 结果
  status TEXT              -- 'offline' | 'online' | 'deploying' | 'error'
  last_error TEXT
  last_seen_at DATETIME
  created_at / updated_at
```

添加远程机器（引导流程）：

1. 向导：host / port / user / 认证方式（① Lovdex 生成 ed25519 公钥一次性植入 `authorized_keys`——有 sshpass 自动执行，否则给出待复制命令；② 复用宿主既有密钥）。
2. probe：`uname`、`node -v`、`claude -v`；缺啥给一键安装命令。
3. `scp` 推送 lite 预构建包到 `~/.lovdex-remote/`，写 config（`serverUrl + token`，0600）；Claude API key 以 0600 env 文件落远程（`~/.lovdex-remote/.env`），不落主库。
4. 装 `systemd --user` unit，`systemctl --user enable --now`。
5. 首次 `hello` → status=online。

「添加之前远程过的机器上的目录」：注册表常驻；建项目的远程 Tab 选在线 host → `fs/list` 浏览远程目录 → 选文件夹，可对同一 host 添加多个项目。

### 4. 安全红线

- lite 只允许操作已注册项目根内路径（`fs/*` 与 SDK cwd 都做 realpath 白名单校验，复用 `resolveRealPath` 逻辑）。
- lite 不提供裸 shell，一切进程走 SDK/claude CLI 子进程。
- WS 共享 token 鉴权（主库存 hash，远程 0600 config）；v1 默认内网，Phase 3 默认 TLS。
- 事件/输出过 `output-sanitizer` 再前传（凭证不回流主控）。
- v1 限制：远程会话不注入 operator 工具集（operator 全局助手仍跑主上；任务 executor 会话在远程是纯 claude，任务/verdict 状态机不受影响）。

### 5. 错误处理

- WS 断开 → host=offline，在途会话 interrupted；重发走 `--resume`；history 靠 `session/messages` 重拉。
- 部署/健康失败 → status=error + last_error（可在引导日志查看）。
- 远程 SDK 报错（API key 无效、claude 未装）→ 映射为现有会话错误事件 + 中文 hint。

### 6. 测试策略

沿用 `npx tsx --test` 配方（`--tsconfig server/tsconfig.json`）。

- 单测：WS 协议编解码、（宿主）remote-agents 注册表状态机、`resolveSpawnFnForSession` 路由、bootstrap 服务（注入假 ssh/exec runner）、lite 白名单校验。
- 集成：**loopback lite**——lite 与主走 localhost WS 在同一进程内跑通全链路（spawn→events→approval），CI 不需第二台机器。
- E2E（可脚本化）：ssh 到 127.0.0.1（宿主开 sshd）或容器，验证 部署→建项目→会话→审批→resume。

### 7. 分阶段范围

- **Phase 1（本文档范围）**：注册表 + 引导 + 密钥；远程建项目；远程 Claude 会话全 parity（事件/审批/中断/resume）；transcript 经 RPC 拉取；文件树只读浏览。任务经 `spawnFns` 缝自动继承。
- **Phase 2**：远程 fs 写 + 编辑器/ git 面板、终端接 lite pty、operator 工具远程化、lite 升级通道。
- **Phase 3**：lite 多 agent（codex/qoder）、NAT 兜底中继、默认 TLS。

## 数据模型变更

- 新增 `remote_hosts` 表（见上）。
- `projects` 增加 `remote_host_id INTEGER NULL REFERENCES remote_hosts(host_id)`；`project_path` 仍 UNIQUE，远程行存**远程绝对路径**（运行时的 cwd 语义与本地一致，现有读取 `project_path` 的代码零改动）；展示时 UI 显示 `host:/path`。
- **路径冲突取舍**：远程绝对路径可能恰好等于宿主本地某项目路径（或两台远程同名）。UNIQUE 冲突时 create-project 直接返回 `PROJECT_ALREADY_EXISTS`，靠 `remote_host_id` 区分归属——接受该限制，不做合成 key（避免破坏现有把 `project_path` 当 cwd 的代码路径）。
- `user_credentials` 复用：`credential_type='ssh_key'`（Lovdex ed25519 私钥 / 既有密钥引用）。注意与 github token 同属明文存储——与现有威胁模型一致。`host_id` 引用以 `credential_name = 'remote-host:<host_id>'` 关联。

## 关键文件改动清单（Phase 1）

后端：

- `modules/database/schema.ts`：`remote_hosts` 表；`projects.remote_host_id`。
- `modules/remote-agents/`（新）：WS 服务端、连接 registry、RPC 客户端描述、推送扇出。
- `modules/remote-agents/remote-host.service.ts`（新）：机器注册表 + bootstrap（ssh 探测/推包/systemd）+ 运行状况。
- `modules/projects/services/project-management.service.ts`：远程路径校验分支（走 lite `fs/stat` 而非本地 `fs.mkdir`）。
- `modules/providers/services/`：`resolveSpawnFnForSession()` 路由；`remoteSpawnFn` 适配器。`chat-websocket.service.ts` / `headless-task-run.service.ts` 的调用点改为经路由解析。
- `claude-sdk.js`：抽取 `queryAgentSDK()` 运行循环（事件 sink / 审批 resolver / 持久化 seam 化），主站本地路径仍用它。
- `shared/remote-*`：协议类型、编解码、常量。

remote-lite（新包，如 `backend/remote-agent/`）：

- 复用抽取出的 `queryAgentSDK()` + synchronizer 切片 + `output-sanitizer` + `resolveRealPath` 白名单。
- WS 客户端（出站连接主、重连、心跳）、`session/start|interrupt|stop|messages`、`fs/list|read|stat`、`approval/respond` 处理器。
- `systemd --user` unit 模板 + 引导安装脚本（与主站 bootstrap 配套）。

前端（Phase 1）：

- 设置页新增「远程机器」Tab：机器列表/添加/删除/状态。
- 建项目向导新增「远程」模式：选 host → `fs/list` 选目录。
- 侧栏/项目列表：远程项目显示 `host:/path` 标记。

## 风险与开放问题

- `queryClaudeSDK` 抽取是最大工作量与重构风险项（claude-sdk.js 当前与 notification/operator/task-guard 耦合）——通过 seam 注入隔离，且主站本地路径行为不回归（测试兜底）。
- 远程 transcript 读取的性能：`session/messages` 按需拉取，不做全量同步。
- 断线重连的 UX（Phase 1 为「手动重发续跑」）是否可接受——如可接受，透明接管推迟到 Phase 2/3。
- ws 非 loopback 鉴权：v1 仅共享 token；如暴露公网需尽快 TLS。
- 远程 API key 来源：允许从主站已有 claude 配置复制，或引导时单独输入。