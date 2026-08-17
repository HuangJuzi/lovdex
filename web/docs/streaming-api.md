# 流式调用接口文档（Codex + Claude Code）

> 本文档描述 `lovdex-cli` 中通过 WebSocket 流式调用 OpenAI Codex 与 Anthropic Claude Code 的完整协议。
> 两个 provider 共用同一条 WebSocket、同一套 `kind` 协议，仅运行时与少量能力不同。
> 源码入口：`server/openai-codex.js`、`server/claude-sdk.js`（运行时）；`server/modules/websocket/services/chat-websocket.service.ts`（网关）；`server/modules/providers/list/{codex,claude}/*`（归一化与同步）。

---

## 1. 概述

- **传输层**：单一 WebSocket 连接，路径 `ws(s)://<host>/ws`。
- **协议模型**：请求-响应 + 服务端流式推送。客户端发一条 `chat.send`，服务端在**同一条连接**上持续推 `kind` 帧，直到收到终止帧 `complete`。
- **多 Provider 共道**：Codex 与 Claude 共用同一 WebSocket 与同一协议，仅 `provider` 字段不同；网关按会话所属 provider 分发到对应运行时。
- **会话寻址**：客户端只使用 **app session id**（DB 主键），永远不感知 provider 原生 id（Codex `thread_id` / Claude session uuid）。网关从 DB 解析 `provider_session_id` 后再交给 SDK。
- **顺序保证**：每个流式帧携带单调递增的 `seq`（按 run 计数），客户端可据此去重、补播、渲染进度。
- **跨会话感知**：服务端在 run 启动 / 完成时向**所有**连接广播 `session_status` 帧（见 §8），客户端无需订阅别的会话即可知道其状态。
- **可执行文件可选**：Codex 默认用 SDK 捆绑二进制，可用 `CODEX_PATH_OVERRIDE` 改用外部 codex（见 §2.1）；Claude 默认即用 PATH 上的 `claude`，可用 `CLAUDE_CLI_PATH` 覆盖（见 §2.2）。

---

## 2. 鉴权

WebSocket 升级请求需携带身份凭证，由 `verifyWebSocketClient` 校验：

| 模式 | 凭证来源 |
|---|---|
| OSS | `?token=<JWT>` 查询参数 **或** `Authorization: Bearer <JWT>` 头 |
| Platform | 自动取首个 DB 用户，无需 token |

校验失败连接被拒绝（不进入 `connection` 处理）。鉴权通过后 `req.user` 注入用户上下文，用于通知与权限隔离。

---

## 2.1 Codex 可执行文件解析（`CODEX_PATH_OVERRIDE`）

运行时通过 `@openai/codex-sdk` 的 `new Codex(options)` 构造，SDK 内部 `spawn(this.exec.executablePath, ...)` 实际拉起 codex 进程。可执行文件的解析规则：

| 场景 | 解析到的二进制 |
|---|---|
| 未设置 `CODEX_PATH_OVERRIDE` | SDK 捆绑的平台二进制：`node_modules/@openai/codex-<platform>/vendor/<triple>/bin/codex`（由 `findCodexPath()` 经 `require.resolve('@openai/codex/package.json')` 定位，**不查 PATH**） |
| 已设置 `CODEX_PATH_OVERRIDE=<绝对路径>` | 该路径指向的 codex（原生二进制或 `bin/codex` JS shim 均可） |

实现（`server/openai-codex.js`）：
```js
codex = new Codex(
  process.env.CODEX_PATH_OVERRIDE
    ? { codexPathOverride: process.env.CODEX_PATH_OVERRIDE }
    : {}
);
```

**使用方式**：启动服务前导出环境变量，或写入 `.env`（由 `server/load-env.js` 自动加载）：
```bash
export CODEX_PATH_OVERRIDE=/home/<user>/.nvm/versions/node/<v>/bin/codex
npm run server:dev
```
适用于 npm/pnpm 全局安装、brew、官方安装器等任何外部 codex。前端无需改动。

**坑（务必注意）**：`Codex` 是 facade，构造签名是 `new Codex(options)` 解构 `{ codexPathOverride, env, config }`。只有对象形式 `new Codex({ codexPathOverride: path })` 生效；写成 `new Codex(path)` 传字符串会被当 options 解构、`codexPathOverride` 取不到，**静默回退 bundled 且不报错**；`new Codex(null)` 会抛 `TypeError: Cannot destructure property 'codexPathOverride' of 'options' as it is null`。

**PATH 上的 `codex`**：仅 `codex-auth.provider.checkInstalled()` 用 `spawn.sync('codex', ['--version'])` 探测，结果只填 `auth.status.installed` 给前端展示，**不参与 query 执行**。

---

## 2.2 Claude Code 可执行文件解析（`CLAUDE_CLI_PATH`）

Claude 路径与 Codex **相反**：`@anthropic-ai/claude-agent-sdk` **不捆绑二进制**，默认 spawn PATH 上的 `claude`。即开箱即用走你已安装的 claude，无需任何配置。

实现（`server/claude-sdk.js` → `mapCliOptionsToSDK`）：
```js
sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
```

`resolveClaudeCodeExecutablePath`（`server/shared/claude-cli-path.ts`）行为：

| 平台 | `CLAUDE_CLI_PATH` 未设 | `CLAUDE_CLI_PATH` 已设 |
|---|---|---|
| Linux/macOS | `'claude'`（PATH 查找） | 该路径原样使用 |
| Windows | `'claude'`（经 `where.exe` 解析 wrapper → 真实 `.exe`） | 解析 wrapper 脚本或直指 `.exe` |

**使用方式**：默认即可用已安装的 claude。若要强制指定某个 claude（多版本/非 PATH 路径），导出环境变量或写入 `.env`：
```bash
export CLAUDE_CLI_PATH=/home/<user>/.nvm/versions/node/<v>/bin/claude
npm run server:dev
```

---

## 2.3 Codex vs Claude 可执行文件对照

| | Codex | Claude Code |
|---|---|---|
| SDK 捆绑二进制 | 是 | **否** |
| 默认可执行文件 | bundled 二进制（不查 PATH） | PATH 上的 `claude` |
| 覆盖 env | `CODEX_PATH_OVERRIDE`（本项目新增） | `CLAUDE_CLI_PATH`（SDK 原生） |
| 用已安装的 CLI | 需显式设 env | **默认即是** |
| 凭据 | `~/.codex/auth.json` | `~/.claude`（settings/credentials） |

---

## 3. 入站消息（Client → Server）

所有入站帧为 JSON 对象，以 `type` 字段分发。

### 3.1 `chat.send` — 发起 / 续接一次流式调用

```jsonc
{
  "type": "chat.send",
  "sessionId": "<app session id>",          // 必填，DB sessions.session_id
  "content": "请帮我重构这个文件",           // 必填，用户 prompt（纯文本）
  "options": {                              // 选填
    "model": "gpt-5.5",                     // 模型 id；缺省由 resolveResumeModel 决定
    "effort": "medium",                     // low|medium|high|xhigh（须在该模型允许列表内，否则忽略）
    "permissionMode": "default",            // default | acceptEdits | bypassPermissions
    "cwd": "/abs/path",                     // 工作目录；缺省取会话 project_path
    "projectPath": "/abs/path",             // 项目根（cwd 优先）
    "images": [                             // 图片附件，见 §6
      { "path": "image-xxx.png", "name": "截图.png", "mimeType": "image/png" }
    ],
    "sessionSummary": "重构讨论"            // 仅用于通知展示名
  }
}
```

**`permissionMode` 行为差异**：

| permissionMode | Codex（sandboxMode / approvalPolicy） | Claude |
|---|---|---|
| `default` | `workspace-write` / `untrusted` | `canUseTool` 回调，工具需审批（见 §3.4） |
| `acceptEdits` | `workspace-write` / `never` | 免审批 |
| `bypassPermissions` | `danger-full-access` / `never` | `bypassPermissions`，全部放行 |

**服务端处理流程**（provider 无关）：
1. `sessionsDb.getSessionById(sessionId)` 解析出 `{ provider, provider_session_id, project_path }`，按 `provider` 分发到 `queryCodex` / `queryClaudeSDK`。
2. `chatRunRegistry.startRun(...)` 占位 + 广播 `session_status{state:"running"}`（见 §8）；若该会话已有 run，回 `protocol_error{code:"RUN_IN_PROGRESS"}`。
3. `filterImagesToUploadStore(options.images)` 过滤图片——**仅 `~/.cloudcli/assets` 直属子文件放行**。
4. 调用对应运行时，进入 §5 的事件循环。

### 3.2 `chat.abort` — 中止当前 run

```jsonc
{ "type": "chat.abort", "sessionId": "<app session id>" }
```
服务端按 `provider` 调用 `abortCodexSession` / `abortClaudeSDKSession`：Codex 标记 `aborted` + `AbortController.abort()`；Claude 调 `queryInstance.interrupt()`。运行时循环检测到中止信号即 `break`，**不再自行发 `complete`**——网关代发 `aborted:true` 终止帧 + 广播 `session_status{state:"aborted"}`。无活跃 run 回 `protocol_error{code:"NO_ACTIVE_RUN"}`。

### 3.3 `chat.subscribe` — 订阅会话状态 / 补播

```jsonc
{
  "type": "chat.subscribe",
  "sessions": [ { "sessionId": "<app id>", "lastSeq": 42 } ]
}
```
可一次订阅**多个**会话。对每个回 `chat_subscribed{ sessionId, isProcessing, lastSeq, pendingPermissions }`，并把该 run 的实时流重新挂到当前 socket + 补播 `seq>lastSeq` 的缺失帧。用于重连/切会话/跨会话观察。

### 3.4 `chat.permission-response` — 工具审批（仅 Claude）

```jsonc
{ "type": "chat.permission-response",
  "requestId": "<id>", "allow": true,
  "updatedInput": { }, "message": "...", "rememberEntry": { } }
```
**Claude 专用**。Codex 用 `approvalPolicy` 在 SDK 层自动决定，不产生交互式审批。Claude 的 `canUseTool` 回调对需要交互的工具（`AskUserQuestion`、`ExitPlanMode`）发 `permission_request`，前端决策后用本消息回传；`waitForToolApproval` 在 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`（默认 55s）内等待。

---

## 4. 出站消息（Server → Client）

每个帧为 JSON 对象，**统一以 `kind` 标识**。所有 provider 消息帧带 `sessionId`（app id）、`provider`、`timestamp`、`id`；流式帧额外带 `seq`。

### 4.1 网关控制帧（广播或按需）

| kind | 触发时机 | 关键字段 | 范围 |
|---|---|---|---|
| `chat_subscribed` | `chat.subscribe` 应答 | isProcessing、lastSeq、pendingPermissions | 请求连接 |
| `session_upserted` | watcher 检测到磁盘会话变化 / provider id 落库 | 会话元数据（侧边栏刷新） | **所有连接** |
| `session_status` | run 启动 / 完成 / 失败 / 中止 | state、exitCode、startedAt、completedAt | **所有连接**（见 §8） |
| `notification` | Claude hook（Notification/Stop/SessionEnd）/ 工具审批 | notificationKind、severity、message | 同会话连接（见 §8） |
| `loading_progress` | 历史加载进度 | progress、sessionId | 请求连接 |
| `protocol_error` | 请求非法或运行时级错误 | code、error、sessionId? | 请求连接 |

`protocol_error.code` 枚举：`SESSION_ID_REQUIRED` / `SESSION_NOT_FOUND` / `UNSUPPORTED_PROVIDER` / `RUN_IN_PROGRESS` / `NO_ACTIVE_RUN` / `UNKNOWN_MESSAGE_TYPE` / `INTERNAL_ERROR`。

### 4.2 流式内容帧（`NormalizedMessage`）

由各 provider 的 `transformCodexEvent` + `normalizeMessage('codex', ...)` 或 Claude SDK 消息 + `normalizeMessage('claude', ...)` 产出。中间增量态处理：Codex `item.started` 忽略、`agent_message` 的 `item.updated` 提取为 `stream_delta`；Claude 的 `streaming` content block delta 合并为 `stream_delta`。各 `kind` 形状：

#### `stream_delta` / `stream_end` — 助手文本流
```jsonc
{ "kind": "stream_delta", "content": "增量文本", "seq": 1 }
{ "kind": "stream_end", "seq": 2 }
```

#### `text` — 文本消息（用户 / 助手）
```jsonc
{ "kind": "text", "role": "assistant" | "user", "content": "...", "seq": 1 }
```

#### `thinking` — 推理过程
```jsonc
{ "kind": "thinking", "content": "...", "seq": 2 }
```

#### `tool_use` — 工具调用（统一形状，按来源细分）

**命令执行**（Codex `command_execution` / Claude `Bash` → `toolName:"Bash"`）
```jsonc
{
  "kind": "tool_use", "toolName": "Bash", "toolId": "<id>",
  "toolInput": { "command": "npm test" },
  "output": "...", "exitCode": 0, "status": "completed",
  "seq": 3
}
```

**文件变更**（Codex `file_change` → `toolName:"FileChanges"`）
```jsonc
{ "kind": "tool_use", "toolName": "FileChanges", "toolInput": { /*changes*/ }, "status": "completed", "seq": 4 }
```

**MCP 工具调用**（`mcp_tool_call`，Codex/Claude 均可）
```jsonc
{
  "kind": "tool_use", "toolName": "<tool>", "server": "<mcp server>",
  "toolInput": { /*arguments*/ }, "result": { }, "error": null, "status": "completed",
  "seq": 5
}
```

**Web 搜索**（Codex `web_search` → `toolName:"WebSearch"`）
```jsonc
{ "kind": "tool_use", "toolName": "WebSearch", "toolInput": { "query": "..." }, "seq": 6 }
```

**Todo 列表**（Codex `todo_list` → `toolName:"TodoList"`）
```jsonc
{ "kind": "tool_use", "toolName": "TodoList", "toolInput": { "items": [ ] }, "seq": 7 }
```

**未知 item 类型** — 透传为 `tool_use`，`toolName` 取 `itemType`，`toolInput` 取原 item。

#### `tool_result` — 工具结果（历史回看时出现）
```jsonc
{ "kind": "tool_result", "toolId": "<id>", "content": "...", "isError": false }
```

#### `permission_request` / `permission_cancelled`（仅 Claude）
```jsonc
{ "kind": "permission_request", "requestId": "<id>", "toolName": "Bash", "input": { }, "context": { }, "seq": 8 }
{ "kind": "permission_cancelled", "requestId": "<id>", "reason": "...", "seq": 9 }
```
对应 §3.4 的 `chat.permission-response`。Codex 不产生这两帧。

#### `status` — token 预算（turn 完成时抽取）
```jsonc
{
  "kind": "status", "text": "token_budget",
  "tokenBudget": {
    "used": 12345, "total": 200000,
    "inputTokens": 10000, "outputTokens": 2345,
    "cacheReadTokens": 0,          // 仅 Claude 有
    "cacheCreationTokens": 0,      // 仅 Claude 有
    "breakdown": { "input": 10000, "output": 2345 }
  },
  "seq": 10
}
```

#### `error` — 运行时错误（非终止）
```jsonc
{ "kind": "error", "content": "Turn failed", "seq": 11 }
```

### 4.3 终止帧 `complete`

每个 run **恰好一个** `complete`，之后该 run 不再发任何帧。

**正常完成**
```jsonc
{
  "kind": "complete", "provider": "codex" | "claude",
  "sessionId": "<app id>", "actualSessionId": "<app id>",
  "exitCode": 0, "success": true, "aborted": false,
  "seq": 12
}
```
**失败完成**（`turn.failed` / Claude `result` 错误 / 异常）
```jsonc
{ "kind": "complete", "exitCode": 1, "success": false, "aborted": false, "seq": 12 }
```
失败时通常先发一帧 `error`，再发 `complete`。未配置时 `error.content` 为 `"Codex CLI is not configured..."`（Codex）或对应 Claude 鉴权错误。

**中止完成**（由 `chat.abort` 触发，网关代发）
```jsonc
{ "kind": "complete", "exitCode": 0 | 1, "success": false, "aborted": true, "seq": 12 }
```

---

## 5. 服务端运行时流程

两个运行时共用网关、registry、writer；差异只在 SDK 调用与 provider 原生事件。

### 5.1 Codex（`queryCodex`）

```
1. resolveResumeModel('codex', sessionId, model)
2. mapPermissionModeToCodexOptions(permissionMode)  → {sandboxMode, approvalPolicy}
3. 校验 effort ∈ model.effort.values，否则置 undefined
4. new Codex(CODEX_PATH_OVERRIDE ? {codexPathOverride} : {})   // 见 §2.1
5. sessionId ? codex.resumeThread(id, opts) : codex.startThread(opts)
6. turnInput = hasImages ? buildCodexInputItems(content, images, cwd) : content
7. thread.runStreamed(turnInput, { signal })
8. for await event:
     thread.started  → 捕获 thread_id，建立 app↔provider 映射（session_created 不上送）
     item.started/updated → 跳过/合并
     turn.completed → 抽 token_budget 发 status 帧
     turn.failed    → 记 terminalFailure，notifyRunFailed
     其余           → transformCodexEvent → normalizeMessage → 逐帧上送
     每轮检查 abort → break
9. 未中止 → 发 complete(exitCode) + notifyRunStopped
```
线程选项：`{ workingDirectory, skipGitRepoCheck:true, sandboxMode, approvalPolicy, model, modelReasoningEffort }`

### 5.2 Claude Code（`queryClaudeSDK`）

```
1. resolveResumeModel('claude', sessionId, model)
2. mapCliOptionsToSDK(options): pathToClaudeCodeExecutable=CLAUDE_CLI_PATH(§2.2),
   env, cwd, permissionMode, hooks{Notification,Stop,SessionEnd}, canUseTool
3. 校验 effort ∈ model.effort.values，resolveClaudeEffort
4. loadMcpConfig(cwd) → sdkOptions.mcpServers
5. buildPromptPayload(command, images, cwd)  // 图片 base64 内联
6. query(sdkOptions) → async generator
7. for await message:
     system_init / result / 等 → 捕获 session uuid，建立 app↔provider 映射
     streaming delta → 合并为 stream_delta
     tool_use / tool_result → 归一化
     需交互工具 → canUseTool 回调 → permission_request（§3.4）
     hooks → notification 帧（§8）
     每轮检查 abort → interrupt()
8. 未中止 → 发 complete(exitCode)
```
SDK 选项要点：`pathToClaudeCodeExecutable`（默认 PATH `claude`）、`resume`、`permissionMode`、`hooks`、`canUseTool`、`mcpServers`、`env`。

---

## 6. 图片附件

- **存储**：图片统一上传至 `~/.cloudcli/assets/`（经 `POST /api/assets/images`），前端引用时用文件名或绝对路径。
- **信任边界**：网关 `filterImagesToUploadStore` 仅放行 `~/.cloudcli/assets` 的**直属子文件**——拒绝子目录、路径穿越、外部绝对路径。
- **喂给 provider（差异）**：
  - **Codex**：`buildCodexInputItems` 生成 `{type:"local_image", path}` 本地路径引用 + `{type:"text"}`，SDK 从路径读取，不经 base64。
    ```jsonc
    [ { "type":"local_image", "path":"/home/u/.cloudcli/assets/image-xxx.png" },
      { "type":"text", "text":"请帮我重构这个文件" } ]
    ```
  - **Claude**：`buildClaudeUserContent` 把图片读回成 base64 `image` content block 内联进 prompt。
- 无图片时 Codex `turnInput` 为 prompt 字符串；Claude prompt 为纯文本。

---

## 7. 会话落盘与回灌

| | Codex | Claude |
|---|---|---|
| 落盘位置 | `~/.codex/sessions/*.jsonl`（含 `thread_id`） | `~/.claude/projects/<encoded-path>/<uuid>.jsonl` |
| 名称映射 | `~/.codex/session_index.jsonl`（thread→name） | 文件名即 session uuid |
| 索引器 | `CodexSessionSynchronizer` | `ClaudeSessionSynchronizer` |
| 历史回看 | `CodexSessionsProvider.fetchHistory` 读 `.jsonl` | `ClaudeSessionsProvider.fetchHistory` 读 `.jsonl` |

两者均由 `sessions-watcher.service`（chokidar）监听对应目录，增量 upsert 进 `sessions` 表并广播 `session_upserted`。历史分页契约：`offset=0` 取最近 `limit` 条，`offset` 递增向过去翻页。归一化产物为同样的 `NormalizedMessage`（`text`/`thinking`/`tool_use`/`tool_result`）。

---

## 8. 跨会话状态与通知（新增）

让"在 A 里知道 B 的状态 / 被通知"成为可能。两条互补信道：

### 8.1 `session_status`（控制帧，广播给所有连接，provider 无关）

由 `chatRunRegistry` 在 run 生命周期点向**所有** `connectedClients` 广播，无需订阅目标会话：

```jsonc
{
  "kind": "session_status",
  "sessionId": "<app id>",
  "provider": "codex" | "claude",
  "state": "running" | "completed" | "failed" | "aborted",
  "exitCode": 0 | 1 | null,
  "startedAt": 1718000000000,
  "completedAt": 1718000012345,
  "timestamp": "..."
}
```

| 触发点 | state |
|---|---|
| `startRun`（run 创建后） | `running` |
| `complete` 帧过 `decorateAndRecordEvent`（正常完成） | `completed`（exitCode=0）/ `failed`（exitCode≠0） |
| `chat.abort` → `completeRun` | `aborted` |
| 运行时崩溃 → `completeRunIfCurrent` 兜底 | `failed`（exitCode=1） |

重复 `complete` 在 registry 顶部被去重，`session_status` 不会二次广播。帧无 `seq`、无流内容，与 `session_upserted` 同级。

**前端处理**（`useChatRealtimeHandlers`）：`running` → `onSessionProcessing(sid)`，终态 → `onSessionIdle(sid)`，**跨会话**更新侧栏 spinner（任意 sid，不限于当前查看的会话）。

### 8.2 `notification`（同会话，经 writer 派发，带 seq）

Claude 原生 hook 触发的注意事件，经复活的 `notification-orchestrator` 派发到**本会话**连接（writer 派发 + 按 `dedupeKey` 5min 去重）：

```jsonc
{
  "kind": "notification",
  "provider": "claude",
  "sessionId": "<app id>",
  "notificationKind": "action_required" | "session_stopped" | "session_ended",
  "code": "agent.notification" | "agent.stop" | "agent.session_end" | "permission.required",
  "severity": "warning" | "info",
  "message": "Claude requires your attention.",
  "requiresUserAction": true | false,
  "meta": { "message" | "toolName": "...", "sessionName": "...", "reason": "..." },
  "dedupeKey": "claude:hook:notification:<sid>:<msg>",
  "seq": 13
}
```

| notificationKind | 触发 hook | 说明 |
|---|---|---|
| `action_required` | `Notification` | Claude 需要用户注意 |
| `action_required` | `canUseTool`（交互工具） | 等同 `permission_request` 的注意信号，`code:"permission.required"` |
| `session_stopped` | `Stop` | turn 结束 |
| `session_ended` | `SessionEnd` | 会话结束（run 已 complete 时为 best-effort） |

**Codex 不产生 `notification` 帧**（Codex SDK 无 hook）；Codex 的"完成/失败"由 `session_status` 覆盖。

### 8.3 两条信道的分工

| 信道 | 范围 | 内容 | 触发 |
|---|---|---|---|
| `session_status` | 所有连接 | 生命周期 running/completed/failed/aborted | registry，provider 无关 |
| `notification` | 本会话连接 | agent 注意事件 | Claude hook（Codex 无） |

`notifyRunFailed` / `notifyRunStopped` 保持 no-op——跨会话完成已由 `session_status` 承担，避免与广播重复。

---

## 9. 完整时序示例

```
Client                                            Server
  │  {type:"chat.send", sessionId, content, options}   │
  │ ─────────────────────────────────────────────────► │ resolveModel / 构造 Codex|Claude
  │  {kind:"session_status", state:"running"}          │ ← 广播给所有连接
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"text", role:"user", content, seq:1}        │
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"thinking", content:"...", seq:2}           │
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"tool_use", toolName:"Bash", seq:3, ...}    │  (Claude: 可能先 permission_request)
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"text", role:"assistant", content, seq:4}   │
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"status", text:"token_budget", seq:5}       │
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"complete", exitCode:0, success:true, seq:6}│
  │ ◄───────────────────────────────────────────────── │
  │  {kind:"session_status", state:"completed"}        │ ← 广播给所有连接
  │ ◄───────────────────────────────────────────────── │
```

**中止时序**：
```
Client                                          Server
  │  {type:"chat.abort", sessionId}                   │
  │ ────────────────────────────────────────────────► │ abort (Codex AbortController / Claude interrupt)
  │  {kind:"complete", aborted:true, success:false}   │
  │ ◄───────────────────────────────────────────────── │ (运行时不再发 complete)
  │  {kind:"session_status", state:"aborted"}          │ ← 广播
  │ ◄───────────────────────────────────────────────── │
```

---

## 10. 错误处理约定

| 场景 | 行为 |
|---|---|
| sessionId 不存在 | `protocol_error{code:"SESSION_NOT_FOUND"}`，不开 run |
| 该会话已有 run | `protocol_error{code:"RUN_IN_PROGRESS"}` |
| Codex CLI 未安装/未认证 | `error{"Codex CLI is not configured..."}` + `complete{exitCode:1}` + `session_status{state:"failed"}` |
| Claude 未认证 | `error{...鉴权错误...}` + `complete{exitCode:1}` + `session_status{state:"failed"}` |
| `turn.failed` / Claude 结果错误 | `error` + `complete{exitCode:1}` + `notifyRunFailed` + `session_status{state:"failed"}` |
| 运行时异常（非 abort） | `error` + `complete{exitCode:1}` |
| 运行时崩溃未发 complete | 网关 `completeRunIfCurrent` 兜底发 `complete{exitCode:1}` + `session_status{state:"failed"}` |
| abort | 网关代发 `complete{aborted:true}` + `session_status{state:"aborted"}`，运行时静默退出 |

---

## 11. 字段速查

### `NormalizedMessage` 公共字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 消息 id（缺省由 `generateMessageId(kind)` 生成） |
| `sessionId` | string | app session id（已重映射，非 provider 原生 id） |
| `provider` | `"codex"` \| `"claude"` | |
| `kind` | string | 见 §4 |
| `timestamp` | ISO string | |
| `seq` | number | 仅流式帧，按 run 单调递增 |

### `complete` 帧字段
| 字段 | 说明 |
|---|---|
| `exitCode` | 0 成功 / 1 失败（缺省 1） |
| `success` | `exitCode===0 && !aborted` |
| `aborted` | 是否被 `chat.abort` 中止 |
| `actualSessionId` | app id（provider 原生 id 不外泄） |

### `session_status` 帧字段（§8.1）
| 字段 | 说明 |
|---|---|
| `state` | `running` \| `completed` \| `failed` \| `aborted` |
| `exitCode` | 终态时携带，`running` 时为 null |
| `startedAt` / `completedAt` | 毫秒时间戳 |

### `notification` 帧字段（§8.2）
| 字段 | 说明 |
|---|---|
| `notificationKind` | `action_required` \| `session_stopped` \| `session_ended` |
| `severity` | `warning` \| `info` |
| `requiresUserAction` | 是否需用户操作 |
| `dedupeKey` | orchestrator 去重键 |

---

## 12. Codex vs Claude 全量对照

| 维度 | Codex | Claude Code |
|---|---|---|
| SDK | `@openai/codex-sdk` | `@anthropic-ai/claude-agent-sdk` |
| 入口 | `new Codex()` / `thread.runStreamed` | `query(sdkOptions)` async generator |
| 捆绑二进制 | 是 | 否，默认 PATH `claude` |
| 覆盖 env | `CODEX_PATH_OVERRIDE` | `CLAUDE_CLI_PATH` |
| 线程模型 | `startThread` / `resumeThread(id)` | `resume` 选项续接 |
| session id 发现 | `thread.started` 事件 | SDK 流中给出 |
| 权限 | `sandboxMode`+`approvalPolicy`（自动） | `canUseTool` 回调 + `chat.permission-response` |
| 工具审批帧 | 无 | `permission_request` / `permission_cancelled` |
| 图片 | `local_image` 路径引用 | base64 `image` block |
| hook | 无 | `Notification` / `Stop` / `SessionEnd` |
| `notification` 帧 | 不产生 | 产生（§8.2） |
| `session_status` 广播 | ✅（provider 无关） | ✅ |
| token 预算 | input/output | + cacheRead/cacheCreation |
| fork | CLI `codex fork`（仅交互） | `--fork-session`（交互+非交互） |
