# Lovdex 侧滑终端抽屉 — 设计文档

- 日期：2026-08-13
- 状态：已批准（预览 mockup 确认）
- 预览：`docs/terminal-drawer-preview.html`（交互仿真，非真实实现）

## 1. 背景与目标

### 1.1 起因

开发者在 Lovdex 里新建任务前，经常需要先手动拉取项目最新代码（`git pull`）。目前 UI 没有任何终端或 git 操作入口，只能：

1. SSH 到服务器手动拉，或
2. 把「先 git pull」写进任务描述 —— 容易偏离任务主题。

### 1.2 调研

查看了开源项目 `siteboon/claudecodeui`（CloudCLI）：

- **内置 Integrated Shell Terminal**：直接访问 agent CLI 的 shell，是核心特性之一。
- **第三方插件 Web Terminal**（`cloudcli-ai/cloudcli-plugin-terminal`）：完整 xterm.js 终端，多标签。
- 技术栈：React + Vite + Tailwind + CodeMirror，可选 Electron。

结论：claudecodeui 已支持 Terminal。Lovdex 跟进时采用**成熟方案**（xterm.js + node-pty），不重复造轮子。

### 1.3 目标

在 Lovdex 里加一个**全局侧滑终端抽屉**，让用户在任何页面都能手动执行 shell 命令（典型场景：新建任务前 `cd <project> && git pull`）。

### 1.4 非目标（YAGNI）

- 多标签多会话（v1 单会话；架构上 WS 按连接管理，将来加标签只需前端套壳 + 每标签一条 WS）。
- 会话持久化 / 重连恢复（关抽屉即退出）。
- 终端增强（文件树、命令面板、Git Explorer 等）。
- 在任务描述里自动注入 git pull 步骤（不做，正是用户要避免的）。

### 1.5 设计原则

- **复用成熟方案，避免重复造轮子**：终端是成熟领域，前端用 xterm.js、后端用 node-pty 等事实标准，不自研渲染或 PTY。优先级最高，凡有成熟库/标准做法，优先复用。
- **最小改动，贴合现有架构**：复用现有 WS 网关与统一 JWT 认证，不引入独立端口/独立服务/外部守护进程。
- **YAGNI**：明确非目标，v1 只做单会话抽屉，不为不确定的未来需求提前设计复杂度。

## 2. 技术选型

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. xterm.js + node-pty** | 前端 `@xterm/xterm` 渲染，后端 `node-pty` 起真 PTY shell，走现有 WS。VSCode/Hyper 同款组合 | ✅ 采用 |
| B. xterm.js + 普通 spawn 流 | 不起 PTY，直接 pipe stdout/stdin | 否：无 raw mode，交互式命令（vim/top）错乱 |
| C. 现成终端服务（ttyd 等） | 外部进程反代 | 否：多一个外部守护依赖，部署复杂 |

理由：xterm.js 与 node-pty 分别是前端终端渲染与后端 PTY 的事实标准，稳定、成熟，符合「不重复造轮子」的要求。

## 3. 架构

```
前端 (React)                             后端 (Express + ws)
┌──────────────────────────┐            ┌──────────────────────────────┐
│ 顶栏终端按钮 + Ctrl+`    │  toggle    │                              │
│ ┌──────────────────────┐ │            │  wss 现有实例                 │
│ │ TerminalDrawer (抽屉) │ │  ws://    │   ├─ /ws          (聊天)      │
│ │  └ xterm.js + fit    │◄──────────►│   └─ /ws/terminal (新增)      │
│ └──────────────────────┘ │            │       └ handleTerminal →     │
│  AppContent 顶层挂载      │            │            node-pty shell    │
└──────────────────────────┘            │            (cwd=WORKSPACES_ROOT)│
                                        └──────────────────────────────┘
```

## 4. 后端设计（新增 `server/modules/terminal/`）

### 4.1 依赖

- 新增 `node-pty`（原生模块，需编译）。环境已有 better-sqlite3 原生编译先例，可行。
- 复用现有 `ws`（已有依赖）。

### 4.2 WS 路由

在 `server/modules/websocket/services/websocket-server.service.ts` 的 `connection` 分发处新增：

```ts
if (pathname === '/ws') {
  handleChatConnection(ws, incomingRequest, dependencies.chat);
  return;
}
if (pathname === '/ws/terminal') {
  handleTerminalConnection(ws, incomingRequest, dependencies.terminal);
  return;
}
```

认证自动复用现有 `verifyClient`（升级时 JWT 校验），零新增鉴权代码。

### 4.3 PTY 生命周期

- 连接建立 → `node-pty.spawn(shell, [], { cwd: WORKSPACES_ROOT, name: 'xterm-color', env: {...process.env, TERM: 'xterm-256color'} })`，其中 `shell = process.env.SHELL || '/bin/bash'`。
- cwd 复用 `server/shared/utils.ts` 的 `WORKSPACES_ROOT`（默认 `~`）。
- PTY `onData` → 通过 WS 发 `{ type: 'output', data }` 给客户端。
- WS `message`（`input`/`resize`）→ 写 PTY stdin / `pty.resize(cols, rows)`。
- PTY `onExit` → 发 `{ type: 'exit', code }` 并 `ws.close()`。
- WS `close` → `pty.kill()`。一条 WS 连接对应一个 PTY，互不干扰。

### 4.4 消息协议（JSON 文本帧）

client → server：

```json
{ "type": "input", "data": "git pull\r" }
{ "type": "resize", "cols": 100, "rows": 30 }
```

server → client：

```json
{ "type": "output", "data": "Updating 3a9c41e..d04f2b7\n" }
{ "type": "exit", "code": 0 }
{ "type": "error", "message": "failed to spawn shell" }
```

## 5. 前端设计（lovdex-cli）

### 5.1 依赖

- 新增 `@xterm/xterm`、`@xterm/addon-fit`。

### 5.2 组件

| 组件 / hook | 职责 |
|---|---|
| `useTerminalDrawer.ts` | 全局开关状态（Context），注册 `Ctrl+\`` 快捷键，生命周期单例 |
| `TerminalDrawer.tsx` | 右侧滑出抽屉：半透明遮罩 + 抽屉面板，z-index 高于内容、低于弹窗；宽 `min(72vw, 720px)` 全高；挂在 `AppContent` 顶层，所有路由可见 |
| `TerminalPane.tsx` | 挂载 xterm 实例、`fit` 适配尺寸、管理 WS 连接（open→connect，close→disconnect）、绑定 `addon-fit` 的 resize 观察 |
| `TerminalToggleButton.tsx` | 顶栏图标按钮（终端图标 + 快捷键标签 `Ctrl+\``） |

### 5.3 放置

- 按钮放在三处顶栏（与 `ViewSwitcher` 并列）：`MainContent` header、`TaskBoardPage` header、`TaskDetail` header。
- 抽屉组件挂在 `AppContent` 顶层（`<AppContentInner>` 内、Sidebar 之外），保证 `/`、`/session/:id`、`/tasks`、`/task/:id`、`/assistant` 等所有路由可见。

### 5.4 生命周期语义

- 打开抽屉 = 新建一个 shell（前端连 WS，后端 spawn PTY）。
- 关闭抽屉 = 断开 WS（后端杀 PTY）。
- 重开 = 全新 shell。

这与「开终端 → cd → git pull → 关掉 → 建任务」流程匹配，且最简单可靠。

## 6. 安全

- 复用现有登录门槛（JWT）。**任何能登录 Lovdex 的用户 = 拿到服务器一个 shell**。自托管内部工具可接受，文档注明，不建议开放公网。
- shell 进程以后端进程同一 OS 用户运行，权限与后端一致。
- 与现有聊天 WS 同一认证路径，无新增暴露面。

## 7. 测试

### 后端

- mock `node-pty`，测 `handleTerminalConnection` 协议：
  - `input` → PTY stdin 写入。
  - PTY `onData` → 客户端收到 `output` 消息。
  - `resize` → `pty.resize` 被调用。
  - PTY `onExit` → 客户端收到 `exit` 且 WS 关闭。
  - WS `close` → `pty.kill` 被调用。
- 不真 spawn shell。

### 前端

- 抽屉开关（按钮/快捷键/遮罩点击）。
- `TerminalPane` WS 生命周期：open→connect、close→disconnect。
- `TerminalToggleButton` 渲染与激活态。

## 8. 涉及文件

### 后端（lovdex-backend）

- `package.json` — 新增 `node-pty`
- `server/modules/websocket/services/websocket-server.service.ts` — 新增 `/ws/terminal` 路由
- `server/modules/terminal/terminal-websocket.service.ts` — `handleTerminalConnection`（新建）
- `server/modules/terminal/index.ts` — 导出（新建）
- `server/index.js` — 装配 `dependencies.terminal`
- 测试：`server/modules/terminal/tests/terminal-websocket.service.test.ts`（新建）

### 前端（lovdex-cli）

- `package.json` — 新增 `@xterm/xterm`、`@xterm/addon-fit`
- `src/hooks/useTerminalDrawer.ts`（新建）
- `src/components/terminal/TerminalDrawer.tsx`（新建）
- `src/components/terminal/TerminalPane.tsx`（新建）
- `src/components/terminal/TerminalToggleButton.tsx`（新建）
- `src/components/app/AppContent.tsx` — 挂载抽屉
- `src/components/main-content/view/MainContent.tsx` — 加按钮
- `src/components/tasks/TaskBoard.tsx`、`src/components/tasks/TaskDetail.tsx` — 加按钮
- 测试：对应 `.test.tsx`

## 9. 待确认（已通过问题收敛）

- 落地方案：完整终端 ✅
- UI 形式：侧滑抽屉 ✅
- 技术路线：成熟方案（xterm.js + node-pty）✅
- 初始目录：WORKSPACES_ROOT，手动 cd ✅
- 呼出方式：顶栏按钮 + Ctrl+` ✅
- 会话模型：v1 单会话（多标签留作扩展）
