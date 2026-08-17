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

## 开发

```bash
cd backend && npm run dev      # API + WS，:3188
cd web && npm run dev          # UI，:5188
```