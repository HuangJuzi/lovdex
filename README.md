# Lovdex

Lovdex 是一个面向 Claude Code / Codex / OpenCode / Qoder 编码代理的 Web 管理工作台：可视化会话、任务（Task Board）、Operator 助手、文件浏览与终端、Git 面板，并提供各 provider 的凭据与运行参数配置。

## 布局

- `web/` — React 前端（Vite）。`npm install && npm run dev`（:5188），`/api`、`/ws` 代理到后端。
- `backend/` — Express API + WebSocket 后端。`npm install && npm run dev`（:3188）。
- `supervisor/` — 守护进程，可同时拉起前后端（systemd user unit 见 `systemd/`）。
- `docs/` — 设计/计划文档。

## 配置

配置集中存放在 `~/.lovdex/data/app.config.json`，首次启动后端自动生成（含随机 JWT 密钥）。Web UI 侧边栏「设置 → Providers」可视化编辑；敏感字段（API key/token）以掩码展示，写入走 `PUT /api/config`（需登录）。

唯一保留的环境变量为 `AUTH_ENABLED`（逃生阀）：设 `false` 进入免登录本地模式。

## 远程项目（Remote Projects）

在远程机器上原生运行 Claude 会话：远程文件夹可作为「项目」加入，Agent（Claude Code SDK）在**远程机器上**读写文件、跑命令，事件流与审批回传到本工作台。

**架构**：目标机器上部署一个轻量常驻服务 **remote-lite**（`backend/remote-agent/`，node + systemd --user），主动经 WebSocket 连回主站（`/api/remote-agents/ws`，每台主机一个派生 token）。主站把会话 spawn 路由到该连接：`session/start / interrupt / approval/respond` RPC + 事件推送；主站复用 `transformMessage` + `sessionsService.normalizeMessage` 归一化事件，聊天/任务/verdict 全部复用本地管线。

**使用**：

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