# Lovdex Backend (Standalone Service)

Pure API + WebSocket backend extracted from `lovdex-product-os`. It does **not** serve any
frontend bundle — point any frontend / business client at it over HTTP + WS.

技术栈：**Node.js (ESM) + Express 4 + ws** · **TypeScript**（`tsx` 直跑源码 / `tsc` 编译到 `dist-server`）· **better-sqlite3**（持久化）· **chokidar**（磁盘监听）· **@anthropic-ai/claude-agent-sdk** + **@openai/codex-sdk**（两个 coding agent 后端）。

## Layout

```
lovdex-backend/
  server/
    index.js                 入口：装配 Express + HTTP + WS，注册路由与 provider spawn
    load-env.js              先于一切 import 加载 .env
    claude-sdk.js            Claude Agent SDK 封装（queryClaudeSDK / abort / 工具审批）
    openai-codex.js          Codex SDK 封装（queryCodex / abort）
    cli.js                   CLI 入口
    constants/               config.js（IS_PLATFORM 等运行时开关）
    middleware/              auth.js（validateApiKey + no-op 鉴权，见下）
    routes/                  commands.js · user.js（模块外的独立 REST 路由）
    services/                notification-orchestrator.js（跨会话通知编排）
    shared/                  types.ts · interfaces.ts · utils.ts · 图片附件/frontmatter 等共享工具
    utils/                   runtime-paths.js · colors.js · commandParser.js …
    modules/                 领域模块（各带 index.ts 作为公共出口）
      database/              SQLite 初始化 + repositories/（sessions/projects/users/api-keys…）
      projects/              projects.routes.ts + services/（clone/delete/star/taskmaster…）
      providers/             provider.routes.ts + services/ + list/{claude,codex}/ + shared/{base,mcp,skills}
      websocket/             WS server + chat 网关 + run registry + 鉴权/状态/写入 services
      assets/                图片上传/读取
  shared/                    networkHosts.js（server/index.js 用来推断可连接 host）
  dist-server/               build 输出（gitignored）
  package.json · .env.example
```

**Provider 抽象**：`modules/providers/list/{claude,codex}/` 下每个 provider 实现同一组能力面
（`*-sessions` / `*-models` / `*-mcp` / `*-skills` / `*-auth` / `*-session-synchronizer`），
由 `modules/providers/shared/base` 统一编排，因此 claude 与 codex 在 REST/WS 层完全对称
（路由中的 `:p ∈ {claude, codex}`）。SDK 细节被隔离在根部 `claude-sdk.js` / `openai-codex.js`。

**架构约束**（`eslint-plugin-boundaries`）：`server/shared/*` 与 `server/modules/*` 被标为
`shared` / `backend-module` 两类边界元素，模块间只应经各自 `index.ts` 公共出口互访。

`server/` + `dist-server/` 双层布局沿用自原仓库，使
`server/utils/runtime-paths.js`（向上找 `server` 目录）与
`server/tsconfig.json`（`rootDir: ".."`, `outDir: "../dist-server"`）无需改动即可工作。

## Quick start

```bash
cp .env.example .env          # adjust SERVER_PORT / CORS_ORIGIN
npm install
npm run build                 # -> dist-server/server/index.js
npm start                     # node dist-server/server/index.js
```

Dev (with tsx, no build step):

```bash
npm run dev                   # tsx 直跑 server/index.js
npm run dev:watch             # 同上，改动自动重启
```

Quality gates:

```bash
npm run typecheck             # tsc --noEmit
npm run lint                  # eslint server/  (加 :fix 自动修复)
```

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `SERVER_PORT` | `3001` | HTTP + WS port |
| `HOST` | `0.0.0.0` | bind host |
| `CORS_ORIGIN` | `*` | `*`, a single origin, or comma-separated allowlist |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | sqlite db location |
| `CONTEXT_WINDOW` | `160000` | Claude context window |
| `CLAUDE_CLI_PATH` | `claude` | custom claude CLI path |
| `VITE_IS_PLATFORM` | `false` | platform mode flag |

## Connecting a frontend

Set on the frontend build/dev env:

```
VITE_API_BASE_URL=http://<backend-host>:<SERVER_PORT>
```

The frontend will then issue all `/api/*` requests and open the `/ws` WebSocket
against that origin. Make sure `CORS_ORIGIN` on the backend includes the frontend origin.

## Health check

```bash
curl http://localhost:<SERVER_PORT>/health
# {"status":"ok","timestamp":"...","installMode":"...","version":"..."}
```

## What was removed vs. the original monolith

- Static hosting of `dist/` and `public/` (no `express.static`, no SPA catch-all)
- `/api/system/update` (no self `git pull` / `npm install -g`)
- Unused deps: `bcrypt`, `jsonwebtoken`, `jszip`, `node-fetch` (auth is a no-op in this build)

---

# API 接口文档

通信以 **WebSocket `/ws`** 为主（流式 chat），辅以 **HTTP REST `/api/*`**（CRUD、列表、搜索、上传）。所有 WS 帧为 JSON，入站按 `type` 路由，出站按 `kind` 区分。

- **WS 路径**：固定 `/ws`，与 HTTP server 同进程升级（`ws.WebSocketServer({server})`）。跨域前端直连 `ws(s)://<host>:<SERVER_PORT>/ws`。
- **REST 信封**：成功 `{ success: true, data: T }`；错误 `{ success: false, error: { code, message, details? } }`。建议读取 `body?.data ?? body`。

  ```jsonc
  // 成功
  { "success": true, "data": { "sessionId": "6f1e…", "provider": "claude", "projectPath": "/repo" } }
  // 错误（经 AppError → error 中间件）
  { "success": false, "error": { "code": "SESSION_NOT_FOUND", "message": "Session not found." } }
  ```

  > 注意：`server/index.js` 里少数文件系统端点（`/api/browse-filesystem`、`/api/create-folder`、`/api/projects/:id/file*`）走的是裸 `{ error: "..." }` 形态、不带 `success` 字段——这正是建议统一用 `body?.data ?? body` 读取的原因。
- **sessionId 语义**：全程使用 **app 侧 sessionId**；provider 原生 sessionId（Claude uuid / Codex thread-id）不外泄，仅后端 DB 内映射。
- **CORS**：由 `CORS_ORIGIN` 控制（见上）。`Authorization`、`Content-Type` 头默认放行；响应暴露 `X-Refreshed-Token` 头供 token 刷新。

## 鉴权

| 层 | 逻辑 | 位置 |
|---|---|---|
| `validateApiKey` | 仅当 `API_KEY` 环境变量设置时启用：校验 header `x-api-key`。未设置则全放行。挂载在 `/api` 之前 | `middleware/auth.js` |
| `authenticateToken` | **OSS 内部构建：鉴权关闭**，直接注入 `req.user = {id:1, username:'local'}`。所有受保护 REST 路由用此 | `middleware/auth.js` |
| `authenticateWebSocket` | 同上，返回 `{id:1, userId:1, username:'local'}` | `middleware/auth.js` |
| WS 握手 `verifyClient` | Platform 模式跳过 token；OSS 模式从 `?token=` 或 `Authorization: Bearer` 读 JWT（当前实现不校验） | `websocket-auth.service.ts` |
| `IS_PLATFORM` | `process.env.VITE_IS_PLATFORM === 'true'` | `server/constants/config.js` |

> 前端 `authenticatedFetch` 自动附加 `Authorization: Bearer <localStorage:auth-token>`，并响应 `X-Refreshed-Token` 刷新本地 token。第三方接入可仿此，或在设置 `API_KEY` 后用 `x-api-key` 头。

## WebSocket 入站帧（客户端 → 服务端）

JSON，按 `type` 路由（`chat-websocket.service.ts`）。

| type | 字段 | 触发动作 |
|---|---|---|
| `chat.send` | `sessionId`* · `content`(string) · `options`?{model, effort, permissionMode, toolsSettings, skipPermissions, sessionSummary, images, includePartialMessages} | 解析 session → 启动 run → 过滤 images（仅允许 `~/.cloudcli/assets` 下）→ 调 provider spawn → 完成后兜底 complete |
| `chat.abort` | `sessionId`* | 取 run → provider abort → 发 `complete{aborted:true}` |
| `chat.subscribe` | `sessions`:[{sessionId, lastSeq?}] | 对每个：若 processing 则挂接连接；查 pending permission；回 `chat_subscribed`；重放 `seq > lastSeq` 的缓冲事件 |
| `chat.permission-response` | `requestId` · `allow`(bool) · `updatedInput`? · `message`? · `rememberEntry`? | 调 `resolveToolApproval`（仅 Claude 有交互式审批） |

非法入站 → `protocol_error` 帧，code ∈ `UNKNOWN_MESSAGE_TYPE / SESSION_ID_REQUIRED / SESSION_NOT_FOUND / UNSUPPORTED_PROVIDER / RUN_IN_PROGRESS / NO_ACTIVE_RUN / INTERNAL_ERROR`。

**入站帧示例**：

```jsonc
// 发起一轮对话（开启逐 token 流式）
{ "type": "chat.send", "sessionId": "6f1e…", "content": "重构这个文件",
  "options": { "model": "sonnet", "effort": "high", "permissionMode": "default",
               "includePartialMessages": true } }

// 打断当前运行
{ "type": "chat.abort", "sessionId": "6f1e…" }

// 重连后订阅若干会话，带各自已读 seq 以便增量重放
{ "type": "chat.subscribe", "sessions": [ { "sessionId": "6f1e…", "lastSeq": 42 } ] }

// 回应工具审批请求（仅 Claude）
{ "type": "chat.permission-response", "requestId": "req_ab12",
  "allow": true, "rememberEntry": { "toolName": "Bash", "scope": "session" } }
```

## WebSocket 出站帧（服务端 → 客户端）

JSON，按 `kind` 区分。每条 live 帧由 `decorateAndRecordEvent` 分配单调递增 `seq` 并把 sessionId 重映射为 app 侧 ID。

### Provider 消息（MessageKind）

| kind | 关键字段 | 何时发 |
|---|---|---|
| `text` | role · content · images? · isCompactSummary? · isLocalCommand? · commandName? | user/assistant 文本（历史或流式） |
| `thinking` | content | AI 推理文本（Claude thinking / Codex reasoning） |
| `tool_use` | toolName · toolInput · toolId · toolResult? | 工具调用（Codex 映射 shell_command→Bash, apply_patch→Edit） |
| `tool_result` | toolId · content · isError · subagentTools? | 工具返回结果 |
| `stream_delta` | content（≤24 字符/chunk） | Claude SDK 流式增量。**仅当 `chat.send` 带 `options.includePartialMessages:true` 时产生**（Codex 不产生）；否则 Claude 每 turn 结束只发一个完整 `text` 帧 |
| `stream_end` | — | Claude SDK 流式块结束。同样依赖 `includePartialMessages` opt-in |
| `error` | content | 运行时错误 |
| `complete` | exitCode · success · aborted · actualSessionId | 运行终态，**每个 run 仅一次**，重复被丢弃 |
| `status` | status · summary? | 运行状态更新 |
| `permission_request` | requestId · toolName? · input? | Claude 工具审批请求 |
| `permission_cancelled` | requestId? | 审批请求取消 |
| `notification` | notificationKind · severity · message · meta · requiresUserAction · code · dedupeKey | 同会话通知（Stop/SessionEnd/hook），带 dedupe，仅当前 run 客户端可见 |
| `session_created` | newSessionId | **后端内部消费，不转发前端**：建立 provider↔app sessionId 映射 |

### 网关事件（GatewayEventKind）

| kind | 字段 | 何时发 |
|---|---|---|
| `chat_subscribed` | sessionId · isProcessing · lastSeq · pendingPermissions | 回复 `chat.subscribe`，权威 processing 状态 + 权限恢复 |
| `session_upserted` | sessionId · providerSessionId · provider · session{...} · project{...}|null | provider 公布 sessionId / 同步器发现文件变更时，**广播给所有客户端** |
| `session_status` | sessionId · provider · state(running\|completed\|failed\|aborted) · exitCode · startedAt · completedAt | run 启动 + 结束时**广播给所有客户端** |
| `protocol_error` | code · error · sessionId | 入站帧非法时 |
| `loading_progress` | — | 已定义，前端 sidebar 消费 |

### 逐 token 流式（`includePartialMessages`）

默认情况下，Claude 会话**每个 turn 结束才发一个完整 `text` 帧**（SDK `query()` 按完整消息块产出），等待期间无任何中间事件——长回复时前端看起来像卡住。

客户端在 `chat.send` 的 `options` 里带 `includePartialMessages: true` 即可开启**逐 token 流式**：SDK 会在生成过程中持续发 `SDKPartialAssistantMessage`（`{type:'stream_event', event:<Anthropic 原始流事件>}`）。`server/claude-sdk.js` 的 `transformMessage` 把 `stream_event` 拆包成原始事件，再经 `claude-sessions.provider.ts` 的 `normalizeMessage` 转成：

- `content_block_delta` → `stream_delta`（每片 ≤24 字符，见 `LIVE_STREAM_CHUNK_SIZE`）
- `content_block_stop` → `stream_end`

**opt-in、默认关闭**：未带该 flag 的客户端（含 lovdex-cli）行为不变。`transformMessage` 的新分支仅在 `stream_event` 出现时触发，否则为死代码，不影响 JSONL 历史回放（回放直接读 JSONL，不经 `transformMessage`）。

**客户端接收约定**（与 lovdex-cli 一致）：

1. `stream_delta` → 累加到一个 transient streaming bubble，按节流（cli 用 50ms）刷新渲染；
2. `stream_end` → 该 turn 流式结束，定型 streaming bubble；
3. 随后的 assistant `text` 帧 → **持久化的权威文本**，替换 streaming bubble（不是追加，否则会双倍）；
4. `complete` → 整个 run 的终态（多 turn 会话里单个 `text` 帧不是终态）。

> thinking 块的增量目前不带 `delta.text`（只有 `delta.thinking`），`normalizeMessage` 不产出 `stream_delta`；thinking 仍会在 turn 结束以 `kind:thinking` 帧发出。

### NormalizedMessage 关键字段

定义在 `server/shared/types.ts`。每条消息的统一形状（节选）：

```ts
{
  id: string;            // 唯一消息 ID
  sessionId: string;     // app 侧 session ID（已重映射）
  timestamp: string;     // ISO
  provider: "claude" | "codex";
  kind: MessageKind;     // 见上
  seq?: number;          // 仅 live 帧有，用于 chat.subscribe 重放
  role?: "user" | "assistant";
  content?: string;
  toolName?: string; toolInput?: unknown; toolId?: string;
  toolResult?: { content?: string; isError?: boolean; toolUseResult?: unknown };
  isError?: boolean;
  // ...开放扩展 [key: string]: unknown
}
```

**出站帧示例**（一轮带流式的回复，seq 单调递增）：

```jsonc
{ "kind": "status",       "sessionId": "6f1e…", "seq": 43, "status": "running" }
{ "kind": "stream_delta", "sessionId": "6f1e…", "seq": 44, "content": "我先读取" }
{ "kind": "stream_delta", "sessionId": "6f1e…", "seq": 45, "content": "这个文件…" }
{ "kind": "stream_end",   "sessionId": "6f1e…", "seq": 46 }
{ "kind": "text",         "sessionId": "6f1e…", "seq": 47, "role": "assistant",
  "content": "我先读取这个文件…" }              // 持久化权威文本，替换 streaming bubble
{ "kind": "tool_use",     "sessionId": "6f1e…", "seq": 48, "toolName": "Read",
  "toolId": "tu_01", "toolInput": { "file_path": "/repo/src/a.ts" } }
{ "kind": "tool_result",  "sessionId": "6f1e…", "seq": 49, "toolId": "tu_01",
  "isError": false, "content": "…文件内容…" }
{ "kind": "complete",     "sessionId": "6f1e…", "seq": 50,
  "exitCode": 0, "success": true, "aborted": false, "actualSessionId": "6f1e…" }
```

工具审批往返（仅 Claude，`chat.send` 未跳过权限时）：

```jsonc
// 出站：服务端请求审批
{ "kind": "permission_request", "sessionId": "6f1e…", "seq": 51,
  "requestId": "req_ab12", "toolName": "Bash", "input": { "command": "rm -rf build" } }
// 入站：客户端回应（见上方 chat.permission-response）
```

## REST 路由

除 `/health` 外，所有 `/api/*` 经 `validateApiKey`；标注 🔒 的额外经 `authenticateToken`（当前 no-op）。SSE 端点标注 `SSE`。

### 系统 / 文件系统

| Method | Path | 说明 |
|---|---|---|
| GET | `/health` | `{status,timestamp,installMode,version}`，无鉴权 |
| GET 🔒 | `/api/browse-filesystem?path=` | 目录浏览 → `{path,suggestions}` |
| POST 🔒 | `/api/create-folder` | `{path}` → `{success,path}` |

> `/api/system/update` 已在本服务移除（原单体的自更新接口）。

### 项目 `/api/projects`

| Method | Path | 说明 |
|---|---|---|
| GET 🔒 | `/api/projects` | `?skipSync=1&sessionsLimit=&sessionsOffset=` → 项目列表含 sessions |
| GET 🔒 | `/api/projects/archived` | 已归档项目 |
| GET 🔒 | `/api/projects/:id/sessions` | `?limit=20&offset=0` 分页 sessions |
| POST 🔒 | `/api/projects/create-project` | `{path, customName?}` → `{success,project,message}` |
| POST 🔒 | `/api/projects/migrate-legacy-stars` | `{projectIds}` |
| GET 🔒 | `/api/projects/clone-progress` | `SSE` Git 克隆进度（progress/complete/error） |
| GET 🔒 | `/api/projects/:id/taskmaster` | TaskMaster 详情 |
| PUT 🔒 | `/api/projects/:id/rename` | `{displayName}` |
| POST 🔒 | `/api/projects/:id/toggle-star` | 切换收藏 |
| POST 🔒 | `/api/projects/:id/restore` | 恢复归档 |
| DELETE 🔒 | `/api/projects/:id` | `?force=true` 删除/归档 |
| GET 🔒 | `/api/projects/:id/file?filePath=` | 读文件内容（文本） |
| GET 🔒 | `/api/projects/:id/files/content?path=` | 读文件（二进制流） |
| PUT 🔒 | `/api/projects/:id/file` | `{filePath,content}` 保存文件 |
| GET 🔒 | `/api/projects/:id/files` | 文件树（depth=10） |
| POST 🔒 | `/api/projects/:id/files/create` | `{path,type,name}` |
| PUT 🔒 | `/api/projects/:id/files/rename` | `{oldPath,newName}` |
| DELETE 🔒 | `/api/projects/:id/files` | `{path,type}` |
| POST 🔒 | `/api/projects/:id/files/upload` | multipart{files,targetPath,relativePaths,requestedFileCount} |
| GET 🔒 | `/api/projects/:id/sessions/:sid/token-usage` | `{used,total,inputTokens,outputTokens,breakdown}` |

### Provider `/api/providers`

`:p` ∈ {claude, codex}。

| Method | Path | 说明 |
|---|---|---|
| GET 🔒 | `/api/providers/:p/auth/status` | Provider 认证状态 |
| GET 🔒 | `/api/providers/:p/models?bypassCache=` | 模型列表（Claude 不缓存，Codex TTL 3 天） |
| POST 🔒 | `/api/providers/:p/sessions/:sid/active-model` | `{model}` 修改会话活跃模型 |
| GET 🔒 | `/api/providers/:p/skills?workspacePath=` | 技能列表 |
| POST 🔒 | `/api/providers/:p/skills` | 新增技能（entries[] 或单条） |
| DELETE 🔒 | `/api/providers/:p/skills/:directoryName` | 删除技能 |
| GET 🔒 | `/api/providers/:p/mcp/servers?scope=&workspacePath=` | MCP 服务器（有 scope 返回单 scope，无 scope 返回 `{user,local,project}`） |
| POST 🔒 | `/api/providers/:p/mcp/servers` | `{name,transport,scope?,command?,args?,env?,url?,headers?...}` upsert |
| DELETE 🔒 | `/api/providers/:p/mcp/servers/:name?scope=` | 删除 MCP |
| POST 🔒 | `/api/providers/mcp/servers/global` | 对所有 provider 并发 upsert |
| GET 🔒 | `/api/providers/capabilities` | 能力矩阵（permission modes, supportsEffort 等） |
| GET 🔒 | `/api/providers/:p/capabilities` | 单 provider 能力 |
| POST 🔒 | `/api/providers/sessions` | `{provider,projectPath}` → 201 `{sessionId,provider,projectPath}` 创建会话 |
| GET 🔒 | `/api/providers/sessions/running` | 运行中的会话 |
| GET 🔒 | `/api/providers/sessions/archived` | 已归档会话 |
| DELETE 🔒 | `/api/providers/sessions/:sid?force=&deletedFromDisk=` | 删除/归档会话 |
| POST 🔒 | `/api/providers/sessions/:sid/restore` | 恢复会话 |
| PUT 🔒 | `/api/providers/sessions/:sid` | `{summary}`（≤500 字符）重命名 |
| GET 🔒 | `/api/providers/sessions/:sid/messages?limit=&offset=` | 会话消息（分页；null=全量） |
| GET 🔒 | `/api/providers/search/sessions?q=&limit=50` | `SSE` 全文搜索（result/progress/done/error） |

### 命令 / 资源 / 用户

| Method | Path | 说明 |
|---|---|---|
| POST 🔒 | `/api/commands/list` | `{projectPath?}` → `{builtIn,custom,count}`（含 /clear /compact） |
| POST 🔒 | `/api/commands/execute` | `{commandName,commandPath?,args?,context?}` → builtin 结果 或 `{type:"custom",content,metadata,isForwarded}` |
| POST 🔒 | `/api/assets/images` | multipart{images}（≤5 个, 5MB each）→ `{images:[]}` |
| GET 🔒 | `/api/assets/images/:filename` | 图片二进制流（SVG 强制下载） |
| GET 🔒 | `/api/user/git-config` | `{success,gitName,gitEmail}` |
| POST 🔒 | `/api/user/git-config` | `{gitName,gitEmail}` |
| GET 🔒 | `/api/user/onboarding-status` | `{success,hasCompletedOnboarding}` |
| POST 🔒 | `/api/user/complete-onboarding` | 完成新手引导 |

## Session 创建与查找调用链

### 双 ID 体系

- `session_id`：app 侧稳定 UUID，对前端可见，全程使用。
- `provider_session_id`：provider 原生 ID（Claude uuid / Codex thread-id），不外泄，仅后端 DB 内映射。
- 两者通过 `assignProviderSessionId()` 关联到同一行。

### 名称字段:custom_name vs summary

- `custom_name`:用户显式改的名(app UI 改名 / Claude `/rename` / Codex `/rename`),可空。
- `summary`:同步器从磁盘自动生成的标题(Claude `ai-title`/`last-prompt`、Codex 首条用户消息/末条 agent),可空。
- 后端在所有 session 输出(列表、`session_upserted`、归档、搜索)只暴露这两个原始字段,**不做 fallback**;显示名 `custom_name || summary || session_id` 由前端算。
- 磁盘是 `custom_name` 的权威来源:同步器把 Claude `custom-title` / Codex `thread_name` 写回 `custom_name`,把自动标题写进 `summary`。
- app 改名(`PUT /api/providers/sessions/:sid`)除写 DB 外,回写 provider 磁盘(Claude 追加 `custom-title` 事件 / Codex 更新 `session_index.jsonl` 的 `thread_name`),使原生 CLI 同步看到。若改名时 provider 尚未启动,在 `recordProviderSessionId` 落地后补写一次。

### 创建 Session（两条路径）

**路径 A — 前端发起创建**（用户点"新建聊天"，`POST /api/providers/sessions`）：

```
路由 handler        provider.routes.ts:530-538
  → Service         sessionsService.createAppSession()        sessions.service.ts:123-140
  → Repository      sessionsDb.createAppSession()             sessions.db.ts:154-166
      └─            projectsDb.createProjectPath()            projects.db.ts:19-45
```

用 `randomUUID()` 生成 app-facing `sessionId` 写入 SQLite，此时 `provider_session_id` 为 NULL；待 provider 真正启动后由 `assignProviderSessionId()` 回填。**前端发首条消息前必须先调此接口预分配 sessionId，后续 WebSocket `chat.send` 复用同一 ID。**

**路径 B — 磁盘同步创建**（启动时全量 / 文件 watcher 增量发现 `.jsonl`）：

```
sessions-watcher.service.ts:245-290  (initializeSessionsWatcher)
  → session-synchronizer.service.ts:17-55  (synchronizeSessions)
  → claude/codex-session-synchronizer.provider.ts
  → sessionsDb.createSession()                sessions.db.ts:70-144   (upsert，以 provider_session_id 为键)
```

> 路径 A 用 `createAppSession`（应用 UUID 为键），路径 B 用 `createSession`（provider 原生 ID 为键），最终合并到同一行。

### 查找 Session（多个端点）

| 场景 | HTTP 端点 | Service 方法 | Repository 方法 |
|---|---|---|---|
| 取消息历史 | `GET /api/providers/sessions/:sid/messages` | `fetchHistory()` :151 | `getSessionById()` :223 |
| 列出运行中 | `GET /api/providers/sessions/running` | `listRunningSessions()` :94 | `chatRunRegistry.listRunningRuns()` |
| 列出已归档 | `GET /api/providers/sessions/archived` | `listArchivedSessions()` :196 | `getArchivedSessions()` :314 |
| 全文搜索（SSE） | `GET /api/providers/search/sessions?q=&limit=` | `sessionConversationsSearchService.search()` | `getAllSessions()` :297（再用 ripgrep 过滤 jsonl） |
| 按项目分页 | `GET /api/projects/:id/sessions?limit=&offset=` | `getProjectSessionsPage()` | `getSessionsByProjectPathPage()` :361 + `countSessionsByProjectPath()` :378 |

内部按 ID 查单条（无独立端点，被 service 内部调用）：

- `getSessionById()` :223 — 按 app ID
- `getSessionByProviderSessionId()` :245 — 按 provider 原生 ID
- `findLatestPendingAppSession()` :278 — 找未绑定 provider id 的最新 session

### 磁盘同步

`sessions-watcher.service.ts` 用 chokidar 监听 `~/.claude/projects/` 与 `~/.codex/sessions/`，变化时经 `session-synchronizer.service.ts` 调度各 provider 同步器更新数据库，并向所有客户端广播 `session_upserted` 帧。

## 环境变量（完整）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_PORT` | `3001` | Express + WS 端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `CORS_ORIGIN` | `*` | `*` / 单源 / 逗号分隔白名单 |
| `VITE_IS_PLATFORM` | `false` | Platform 模式开关 |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI 路径覆盖 |
| `CODEX_PATH_OVERRIDE` | — | Codex CLI 路径覆盖（传给 SDK codexPathOverride） |
| `API_KEY` | — | 设置后启用 `x-api-key` 校验 |
| `JWT_SECRET` | DB 持久化 | JWT 密钥（当前未实际校验） |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | SQLite 路径 |
| `WORKSPACES_ROOT` | homedir | 工作区根 |
| `CONTEXT_WINDOW` | `160000` | Claude 上下文窗口 |
| `FS_CONCURRENCY` | `64` | 文件系统并发 |

## 接入示例（第三方 / 业务）

### REST 常用调用

```bash
# 1) 健康检查（无鉴权）
curl http://localhost:3001/health
# {"status":"ok","timestamp":"...","installMode":"npm","version":"1.0.0"}

# 2) 创建会话 → 拿到 app 侧 sessionId（发首条消息前必须先调）
curl -X POST http://localhost:3001/api/providers/sessions \
  -H 'Content-Type: application/json' \
  -d '{"provider":"claude","projectPath":"/path/to/project"}'
# 201 {"success":true,"data":{"sessionId":"6f1e…","provider":"claude","projectPath":"/path/to/project"}}

# 3) 项目列表（含各自 sessions；skipSync=1 跳过磁盘同步以求快）
curl 'http://localhost:3001/api/projects?skipSync=1&sessionsLimit=20'

# 4) 拉取会话历史消息（分页；不传 limit=全量）
curl 'http://localhost:3001/api/providers/claude/sessions/6f1e…/messages?limit=50&offset=0'
# {"success":true,"data":{"messages":[{kind,role,content,...}],"total":128,"hasMore":true,"offset":0}}

# 5) 模型列表（Claude 不缓存，Codex TTL 3 天；bypassCache=1 强刷）
curl 'http://localhost:3001/api/providers/codex/models?bypassCache=1'
# {"success":true,"data":{"provider":"codex","models":[...],"cache":{...}}}

# 6) 新增 / 更新一个 MCP 服务器（upsert）
curl -X POST http://localhost:3001/api/providers/claude/mcp/servers \
  -H 'Content-Type: application/json' \
  -d '{"name":"filesystem","transport":"stdio","scope":"user",
       "command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/repo"]}'
# 201 {"success":true,"data":{"server":{...}}}

# 7) 重命名会话（summary ≤ 500 字符，同时回写 provider 磁盘）
curl -X PUT http://localhost:3001/api/providers/sessions/6f1e… \
  -H 'Content-Type: application/json' -d '{"summary":"重构 auth 模块"}'
```

### SSE 端点（会话全文搜索）

```bash
# event: result / progress / done / error 依次推送
curl -N 'http://localhost:3001/api/providers/search/sessions?q=refactor&limit=50'
# event: result
# data: {"projectResult":{...},"totalMatches":3,"scannedProjects":1,"totalProjects":4}
# event: progress
# data: {"totalMatches":3,"scannedProjects":2,"totalProjects":4}
# event: done
# data: {}
```

> 其余 SSE 端点：`GET /api/projects/clone-progress`（Git 克隆进度，event ∈ progress/complete/error）。

### 流式对话（WebSocket）

```bash
#    连 ws://localhost:3001/ws，发：
#    {"type":"chat.send","sessionId":"<id>","content":"hello",
#     "options":{"model":"sonnet","includePartialMessages":true}}
#    逐 token 收：stream_delta * → stream_end → text（持久化权威文本，替换 streaming bubble）→ complete
#    不带 includePartialMessages 时：每 turn 结束只收一个完整 text 帧 → complete
```

> 设置了 `API_KEY` 时，所有 `/api/*` 请求需加头 `-H 'x-api-key: <API_KEY>'`；WS 鉴权在本 OSS 构建为 no-op。
> WS 流式协议的完整字段语义详见前端仓 `docs/streaming-api.md` / `docs/api-contract.html`。
