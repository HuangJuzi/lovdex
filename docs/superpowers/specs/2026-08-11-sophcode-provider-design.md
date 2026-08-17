# Lovdex 支持 Sophcode Provider 设计

- 日期：2026-08-11
- 状态：设计待评审
- 范围：`lovdex-backend` + `lovdex-cli`
- 相关：`docs/superpowers/specs/2026-08-10-operator-agent-design.md`、`docs/superpowers/specs/2026-08-10-session-to-task-convert-design.md`

## 1. 背景与目标

用户本机安装了 `sophcode`（v0.3.0，opencode 的套壳 fork，CLI 命令面与 opencode 完全一致），并通过 SophNet / OpenAI / Cloudflare AI Gateway 配置了凭据。当前 lovdex 后端只支持 `claude`（`@anthropic-ai/claude-agent-sdk`）和 `codex`（`@openai/codex-sdk`）两个 SDK 型 provider；前端可选列表 `PROVIDERS = ['claude', 'codex']`。

目标：把 `sophcode` 加为一等公民 Provider，与 claude/codex 并列。用户在 lovdex Web UI 里可以选择 Sophcode 发消息，会话历史、模型列表、MCP、skills、auth 状态完整可用。

### 关键事实（已实测确认）

| 事实 | 值 |
|---|---|
| sophcode 版本 | v0.3.0，位于 `~/.nvm/versions/node/v22.22.0/bin/sophcode` |
| CLI 命令面 | 与 opencode 一致：`sophcode run --format json --dir --session --model --variant --agent --auto` |
| 会话数据库 | 共享 opencode 的 `~/.local/share/opencode/opencode.db`（`sophcode db path` 返回此路径） |
| 配置文件 | 共享 opencode 的 `~/.config/opencode/opencode.jsonc` + 工作区 `opencode.json` |
| 凭据 | `~/.local/share/opencode/auth.json`（SophNet api） |
| `sophcode run --format json` 输出 | NDJSON 事件流：`step_start` / `text` / `step_finish`；`step_finish.part.tokens` 含 total/input/output/reasoning/cache |
| 模型列表 | `sophcode models`（实测约 0.4s），输出 `provider/model` 行 |
| 无官方 SDK | `@opencode-ai/sdk` 存在但硬编码 spawn `opencode` 二进制且协议版本与 sophcode 0.3.0 有漂移风险，不可用 |

### 边界（不在本次范围）

- **不注册** `opencode` / `cursor` provider（前端 `LLMProvider` 联合类型里的历史槽位保持休眠）。
- **tasks 表** `executor_provider` 的 `CHECK (executor_provider IN ('claude','codex'))` 约束**不动**——sophcode 不作为任务执行器（用户未选此项）。
- codex skills 测试 `providerSkillsService lists codex repository, user, and system skills` 的既有失败（`undefined vs 'repo'`，环境依赖）不在本次范围，记录不修。

## 2. 架构

sophcode 复用现有 provider 抽象（`IProvider`：models/mcp/auth/skills/sessions/sessionSynchronizer）。与 claude/codex 的唯一结构性差异：**运行时不是 SDK，而是 spawn CLI**（sophcode 无官方 SDK）。这是 lovdex 第一个 CLI 型运行时。

sophcode 与 opencode 共享 DB/配置 → sophcode 的会话来源即 `opencode.db`（用户机器上只有 sophcode，无歧义）。

## 3. 后端改动

### 3.1 类型与注册

| 文件 | 改动 |
|---|---|
| `server/shared/types.ts` | `LLMProvider = 'claude' \| 'codex' \| 'sophcode'` |
| `server/modules/providers/provider.registry.ts` | 注册 `sophcode: new SophcodeProvider()` |
| `server/modules/providers/provider.routes.ts` | `parseProvider` 允许列表加 `'sophcode'` |
| `server/modules/providers/services/provider-capabilities.service.ts` | 新增 sophcode 条目 |

capabilities 条目：

```
provider: 'sophcode'
permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan']
defaultPermissionMode: 'default'
supportsImages: true
supportsAbort: true
supportsPermissionRequests: false   // CLI 非交互模式，无工具审批弹窗
supportsTokenUsage: true            // step_finish.part.tokens
supportsEffort: true                // --variant
```

### 3.2 Provider 模块 `server/modules/providers/list/sophcode/`（7 文件，仿 codex 结构）

| 文件 | 职责 |
|---|---|
| `sophcode.provider.ts` | `SophcodeProvider extends AbstractProvider`，装配 6 个子模块 |
| `sophcode-models.provider.ts` | `getSupportedModels()`：spawn `sophcode models`，按行解析 `provider/model`；失败回退静态表。`getCurrentActiveModel(sessionId?)`：读 opencode.db `session.model` 列，回退 catalog 默认。`changeActiveModel`：`writeProviderSessionActiveModelChange('sophcode', input)` |
| `sophcode-auth.provider.ts` | `sophcode --version` 判安装；读 `~/.local/share/opencode/auth.json` 判认证（有 credential 即 authenticated） |
| `sophcode-mcp.provider.ts` | 继承 `McpProvider`。user 范围读写 `~/.config/opencode/opencode.jsonc`（JSONC 兼容读取），project 范围读写 `<workspace>/opencode.json`。格式：`type:'local'`（`command: string[]` + `environment`）、`type:'remote'`（`url` + `headers`）。transports：stdio / http |
| `sophcode-skills.provider.ts` | 继承 `SkillsProvider`。opencode 技能路径：user `~/.config/opencode/skills`；repo 顶层 git root 下 `.opencode/skills` + `.claude/skills` + `.agents/skills`。命令前缀 `/`。`getGlobalSkillSource` 指向 user 目录 |
| `sophcode-sessions.provider.ts` | `fetchHistory(sessionId)`：查 opencode.db `session`/`message`/`part` 表，归一化为 `NormalizedMessage`（复用文本解码 util）。`normalizeMessage(raw)` 供运行时/历史共用 |
| `sophcode-session-synchronizer.provider.ts` | `synchronize(since?)`：查 opencode.db `session` 表（join `project`/`project_directory` 拿路径），`sessionsDb.upsertSessionByProviderSessionId('sophcode', ...)` 去重合并。`synchronizeFile(filePath)` 返回 `null`（DB 单文件，无逐文件映射） |

opencode.db `session` 表可用列（已实测）：`id`、`title`、`model`、`agent`、`path`（项目 cwd）、`time_created`/`time_updated`/`time_archived`、`tokens_input`/`tokens_output`/`tokens_reasoning`/`tokens_cache_read`/`tokens_cache_write`、`cost`。

### 3.3 运行时 `server/sophcode-runner.js`（镜像 `openai-codex.js` 接口）

导出 `querySophcode` / `abortSophcodeSession` / `isSophcodeSessionActive` / `getActiveSophcodeSessions`。

`querySophcode(command, options, writer)`：

1. **拼参**：`['run', '--format', 'json', '--dir', cwd]`；`options.sessionId`（provider-native）→ `--session`；`options.model` → `--model`；effort → `--variant`；权限映射：
   - `plan` → `--agent plan`
   - `bypassPermissions` → `--auto`
   - `acceptEdits` → env `OPENCODE_PERMISSION={"edit":"allow"}`
   - `default` → 不传（交给用户 config）
2. **spawn**：`cross-spawn('sophcode', args, { cwd, env })`，行缓冲解析 stdout NDJSON。
3. **图片附件**：`options.images`（已过 `filterImagesToUploadStore` 校验）经 `appendImagesInputTag(prompt, images)`（`server/shared/image-attachments.ts` 现成工具）拼进 prompt。
4. **事件映射**：
   - `step_start` → 捕获 `sessionID`（新会话首次出现时通过 writer 上报给 gateway，与 claude-sdk 同一机制），发 processing 态
   - `text`（`part.type==='text'`）→ 流式助理消息（增量/整段文本）
   - `step_finish` → 发 terminal complete + token 用量（`part.tokens` → `{kind:'status', text:'token_budget', tokenBudget}`，前端 `useChatRealtimeHandlers.ts:355` 消费此形状）
5. **错误处理**：非零退出 → error 消息；exit code 127 或 null 且未安装 → 「sophcode CLI 未安装，见 https://opencode.ai/docs/」。
6. **abort**：kill 进程树。

待实现时验证：`OPENCODE_PERMISSION` 环境变量在 sophcode v0.3.0 的兼容性（用编辑类 prompt 实测 acceptEdits 模式）。

### 3.4 接线

`server/index.js`：
- `spawnFns` / `abortFns` 各加 `sophcode` 条目。
- `GET /api/projects/:projectId/sessions/:sessionId/token-usage`（约 line 983）加 sophcode 分支：读 `~/.local/share/opencode/opencode.db` 的 `session` 表，按 `provider_session_id` 取 `tokens_input/output/reasoning/cache_*`，返回与 codex 分支同构的 `{used, total, inputTokens, outputTokens, breakdown}`。前端会话加载时走此 REST（`useChatSessionState.ts:715`），运行中走 websocket `token_budget`，两条路径都要通。

## 4. 前端改动（lovdex-cli）

| 文件 | 改动 |
|---|---|
| `src/types/app.ts` | `LLMProvider` 联合类型加 `'sophcode'` |
| `src/components/chat/hooks/useChatProviderState.ts` | `PROVIDERS` 加 `'sophcode'`；`FALLBACK_DEFAULT_MODEL.sophcode`（用已知首个模型作首屏 fallback，catalog 加载后 reconcile）；`FALLBACK_PERMISSION_MODES.sophcode`；新增 `sophcodeModel` state + `setStoredProviderModel` 分支 + `providerModels` memo + reconcile effect |
| `src/components/chat/constants/providerEffort.ts` | 加 sophcode 的 effort fallback（catalog 优先，fallback 兜底） |
| `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx` | `PROVIDER_META` 加 `{id:'sophcode', name:'Sophcode'}`；`getCurrentModel` / `getProviderDisplayName` / `setModelForProvider` / `readyPrompt` 分支 |
| `src/components/llm-logo-provider/SessionProviderLogo.tsx` | 加 sophcode → `SophcodeLogo.tsx`（图形可复用 OpenCodeLogo 或新画） |
| i18n | 各 locale `chat.json` 的 `providerSelection.readyPrompt.sophcode` |

其余会话列表、权限模式选择、MCP/skills 管理界面均由后端 `/api/providers/capabilities` 驱动，前端只需类型通过 + 显示名，无 per-provider 分支。

## 5. 测试策略

### 5.1 修红（8 个现有失败中的 7 个，均因 opencode/cursor 未注册）

- `server/modules/providers/tests/mcp.test.ts`：
  - `providerMcpService handles opencode MCP config and capability validation` → 改指 `sophcode`（断言路径 `~/.config/opencode/opencode.jsonc`、`<workspace>/opencode.json` 不变）
  - `providerMcpService handles cursor MCP JSON config formats` → 删除（cursor 不注册）
  - `providerMcpService global adder writes to all providers` → 期望 provider 数 4 → 3；断言从 `opencode.json` + `.cursor/mcp.json` 改为仅 `opencode.json`（sophcode）
- `server/modules/providers/tests/skills.test.ts`：
  - opencode skills 两个测试 → 改指 `sophcode`
  - cursor skills / 全局 skills 测试中的 cursor 断言 → 删除
- codex skills `undefined vs 'repo'` 失败：既有环境问题，不在范围。

### 5.2 新增

- `sophcode-runner` 单测：NDJSON 解析 → 消息/complete/token_usage 映射（mock spawn 输出真实样例事件行）
- `sophcode-models` 单测：mock `sophcode models` 输出 → catalog；失败 → fallback
- `sophcode-sessions` / `sophcode-session-synchronizer` 单测：mock opencode.db → 归一化消息 / upsert

### 5.3 E2E

起后端 + 前端，选 Sophcode 发消息，验证：流式回复、会话历史、token 用量、MCP/skills/auth 接口、权限模式切换（plan/bypass/acceptEdits/default）。

## 6. 风险与决策记录

| 项 | 决策 | 理由 |
|---|---|---|
| sophcode 与 opencode 共用 DB/配置 | sophcode 的会话/配置来源即 opencode.db + opencode.jsonc | 用户机器只有 sophcode，无歧义；复用现成 `getOpenCodeDatabasePath()` 等工具 |
| 运行时方式 | spawn CLI（非 SDK） | `@opencode-ai/sdk` 硬编码 `opencode` 二进制且协议版本有漂移风险 |
| 首个 CLI 型运行时 | 进程生命周期（abort/孤儿/超时）重点写稳 | 与 SDK 型不同的管理复杂度 |
| 权限交互 | `supportsPermissionRequests: false` | CLI 非交互模式无法弹工具审批；`ask` 规则默认拒绝，`--auto` 全批 |
| opencode/cursor 注册 | 不注册 | 超出本次范围；相关测试改指 sophcode 或删除 |
| tasks 执行器 | 不加 sophcode | 用户未选；`executor_provider` CHECK 约束不动 |
| 模型默认值 | 后端 catalog DEFAULT = `sophcode models` 首个模型；前端首屏 fallback 用已知模型，加载后 reconcile | 与 codex 行为一致 |
