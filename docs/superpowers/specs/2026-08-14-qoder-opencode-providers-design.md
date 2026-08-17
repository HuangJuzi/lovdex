---
name: 2026-08-14-qoder-opencode-providers
description: 向 lovdex 移植 claudecodeui 的 Qoder + opencode provider 支持（全栈），sophcode 统一重命名为 opencode
metadata:
  node_type: spec
  status: approved
---

# 移植设计：Qoder + opencode provider 支持（全栈）

日期：2026-08-14
状态：设计已获用户批准（2026-08-14）

## 1. 背景与现状

- claudecodeui（`/home/zhijuhuang/workdir/claudecodeui`）已完整支持 `opencode` 与 `qoder` 两种 provider——每个 provider 七面俱全：auth / models / mcp / skills / sessions / session-synchronizer / runtime；前端常量、Logo、空态、设置、任务面也都有覆盖。
- lovdex-backend 复用同一套 provider 模块架构（源自 claudecodeui，已分化），当前 provider 集为 `['claude','codex','sophcode']`。
- **关键事实**：lovdex 的 `sophcode` 就是 opencode v0.3.0 的套壳 fork（CLI 命令面与 opencode 完全一致，见 `sophcode-runner.js` 头注释与 2026-08-11 spec），与真实 opencode 共用 `~/.local/share/opencode/opencode.db` 与 `~/.config/opencode` 配置。`sessionsDb.createSession` 按 `(provider_session_id, provider)` 唯一（`server/modules/database/repositories/sessions.db.ts` L91-97），因此若把 opencode 作为独立 provider 再加一套同步，同一个会话会被同步出 sophcode + opencode 两条重复记录。
- 本机环境：已装 `sophcode`（fork，本地主力）、`qodercli`、`claude`、`codex`；**未装**真实 `opencode` CLI。

## 2. 目标（终态）

lovdex 支持 **claude / codex / opencode / qoder** 四个 provider，全栈可用：

- 后端：会话同步 + 历史读取 + 认证 + 模型目录 + MCP + skills + 实时运行时（流式执行 / abort / token 用量）
- 前端：provider 可选、Logo、空态、effort、设置、任务 executor
- 与 claudecodeui 对齐（不含 cursor）

## 3. 关键决策（用户 2026-08-14 确认）

1. **sophcode 统一重命名为 opencode**：不做独立双 provider（避免同一 opencode.db 双写重复）。
2. **全栈完整移植**：含实时运行时 + 前端 + operator 任务。
3. **opencode 运行时二进制**：`opencode` 优先，缺失时回退 `sophcode`（fork CLI 命令面一致），保证本机日常可用。
4. **opencode 默认模型**：沿用当前 sophcode 的 `opencode/deepseek-v4-flash-free`（不用 claudecodeui 预置的 `anthropic/claude-sonnet-4-5`，本环境不适用）。qoder 默认模型 `auto`（照 claudecodeui）。

## 4. 后端改动（lovdex-backend）

### 4.1 DB 迁移

新增 migration，复用 `server/modules/database/migrations.ts` 已有"重建 tasks 表以扩展引擎"的幂等模式（当前 gate：`tasksSqlForEngine.includes("'sophcode'")`，migrations.ts L479-497）。

```sql
-- 同步器插的会话行 + 任务 executor
UPDATE sessions SET provider='opencode'    WHERE provider='sophcode';
UPDATE tasks SET executor_provider='opencode' WHERE executor_provider='sophcode';
-- tasks 表 CHECK constraint 重建为：
-- EXECUTOR_PROVIDERS = ['claude','codex','opencode','qoder']
-- 同步改 server/modules/database/schema.ts L133
```

### 4.2 opencode：sophcode 重命名（登记点）

`server/modules/providers/list/sophcode/` → `list/opencode/`（`sophcode-*.ts` → `opencode-*.ts`，类名 `Sophcode*` → `OpenCode*`，provider id `'sophcode'` → `'opencode'`）。

| 文件 | 改动 |
| --- | --- |
| `server/shared/types.ts` | L77 `LLMProvider` → `'claude' \| 'codex' \| 'opencode' \| 'qoder'`；L904 `TaskEngine` 同步 |
| `server/modules/providers/provider.registry.ts` | import 与 `providers` 键改为 opencode / 新增 qoder |
| `server/modules/providers/provider.routes.ts` | `parseProvider` 白名单（~L287-289）加 `opencode`、`qoder` |
| `server/modules/providers/services/provider-capabilities.service.ts` | `sophcode` entry（~L55）改名 opencode；新增 qoder entry；按 claudecodeui 校核 supports 字段 |
| `server/modules/providers/services/session-synchronizer.service.ts` | `Record<LLMProvider, number>`（~L20）加 `opencode`、`qoder` 键 |
| `server/modules/database/repositories/tasks.db.ts` | L8 `TASK_ENGINES` → `['claude','codex','opencode','qoder']` |
| `server/routes/commands.js` | L18 `MODEL_PROVIDERS`、L20-24 `MODEL_PROVIDER_LABELS` 改名 + 加 qoder |
| `server/index.js` | L95-113 `spawnFns`/`abortFns` 键改名，新增 `qoder`；token-usage 浏览分支 ~L1158 `provider === 'sophcode'` → `'opencode'`（含错误文案 Sophcode→OpenCode） |
| `server/sophcode-runner.js` | → `server/opencode-runner.js`（二进制解析见决策 3） |

### 4.3 opencode facet 增量合并（claudecodeui 有、lovdex sophcode 缺的）

- **auth**：照搬 claudecodeui `opencode-auth.provider.ts` —— `opencode --version` 探测 installed；凭据解析 `~/.local/share/opencode/auth.json`（逐 providerId → 凭据对象）；**增加 provider API-key 环境变量回退**（ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY 任一）。
- **models**：预置目录（`opencode/<model>` 形态，OpenCode Zen）照搬 claudecodeui `opencode-models.provider.ts`（预置 + `opencode models --verbose` 动态合并），**默认值按决策 4 改为 `opencode/deepseek-v4-flash-free`**。
- **skills**：roots 照搬 claudecodeui `opencode-skills.provider.ts` —— user：`~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`；project：cwd→topmost-git-root 下 `.opencode/skills`、`.claude/skills`、`.agents/skills`，重叠目录去重，前缀 `/`。
- **mcp**：照搬 claudecodeui `opencode-mcp.provider.ts` —— user：`~/.config/opencode/opencode.jsonc`（存在时优先 `.json`）；project：workspace `opencode.jsonc`/`opencode.json`；scope `['user','project']`，transport `['stdio','http']`。
- **必须保留** lovdex sophcode synchronizer 的 `directory` 列修复（新 schema 用 `directory` 存真实路径，`path` 为 git 相对子路径；claudecodeui 反而没有这个修复，不能覆盖掉）。

### 4.4 qoder 新 provider 包

`server/modules/providers/list/qoder/`（照搬 claudecodeui，细节以 claudecodeui 文件为准）：

- `qoder.provider.ts`：`QoderProvider extends AbstractProvider`，`super('qoder')`，含 `runtime`、`models`、`auth`、`mcp`、`skills`、`sessions`、`sessionSynchronizer` 七面。
- `qoder-auth.provider.ts`：`qodercli --version` 探测 installed；`QODER_PERSONAL_ACCESS_TOKEN` env 优先，否则 `~/.qoder/.auth` 任一非空文件（browser OAuth）。
- `qoder-models.provider.ts`：预置 `QODER_PREDEFINED_MODELS`（auto/lite/performance/Qwen3.8-Max）+ `qodercli --list-models` 动态合并；DEFAULT `auto`。
- `qoder-mcp.provider.ts`：`McpProvider('qoder', ['user','project'], ['stdio','sse','http'])`；user → `~/.qoder/settings.json`；project → `<workspace>/.qoder/settings.json` 优先，其次 MCP 标准 `<workspace>/.mcp.json`。
- `qoder-skills.provider.ts`：user → `~/.qoder/skills`；project → workspace→git-root 各层 `.qoder/skills`，去重，前缀 `/`。
- `qoder-sessions.provider.ts`：`normalizeMessage(raw, sessionId)`（`raw.uuid` 基 id）；`fetchHistory` 从 `~/.qoder/projects/<编码cwd>/<uuid>.jsonl` 读历史（优先 session row 的 `jsonl_path`），聚合 `agent-*.jsonl` 子代理消息；分页遵循 `limit: null` 全量 / `limit: 0` 空页 / 返回 total、hasMore、offset、limit 的既有契约。
- `qoder-session-synchronizer.provider.ts`：递归扫 `~/.qoder/projects` 下 `.jsonl`，只收**顶层** session 文件（`path.relative(projectsRoot, file)` 恰好 2 段且无 `..`），跳过 `agent-*.jsonl`；session id = 文件名（去 `.jsonl`）；projectPath = 父目录名解码（`-`→`/`，lossy，用 transcript 中 `cwd` 字段兜底）；标题 = 已存 custom_name（若非 fallback）否则首条 user 消息。

### 4.5 qoder 运行时 `server/qoder-runner.js`

由 claudecodeui `qoder-runtime.provider.js` 移植，**去掉 `context.*` 依赖**，套用 lovdex `sophcode-runner.js` 现有约定：

- `context.resolveProviderSessionId(sessionId)` → 从 session row 读 `provider_session_id`（sessionsDb / provider 无关解析）
- `context.resolveResumeModel(...)` → 按 lovdex 现有 resume 模型解析（`provider-models` / session row 的 active model，参照 sophcode-runner 与 index.js 现状）
- `context.normalizeMessage(...)` → 调 `QoderSessionsProvider.normalizeMessage`
- `context.isProviderInstalled()` → `providerAuthService`（lovdex `sophcode-runner` 已这样用）
- 通知走 `server/services/notification-orchestrator.js` 的 `notifyRunFailed/notifyRunStopped`；输出走 `sendMessage(ws, ...)` 与 `createNormalizedMessage/createCompleteMessage`（`server/shared/utils.ts`）

公开导出 `queryQoder / abortQoderSession / isQoderSessionActive / getActiveQoderSessions`，注册进 `server/index.js` `spawnFns`/`abortFns`。

### 4.6 注册点汇总（qoder + opencode 共用）

`types.ts(LLMProvider/TaskEngine)`、`schema.ts(EXECUTOR_PROVIDERS)`、`migrations.ts(CHECK gate)`、`tasks.db.ts(TASK_ENGINES)`、`provider.registry.ts`、`provider.routes.ts(parseProvider)`、`provider-capabilities.service.ts`、`session-synchronizer.service.ts`、`commands.js`、`index.js(spawnFns/abortFns/token 分支)`。同步改名/新增对应的测试文件（见 §6）。

## 5. 前端改动（lovdex-cli）

- `src/types/app.ts`：`LLMProvider` → `'claude' | 'codex' | 'opencode' | 'qoder'`（去掉 cursor / sophcode 残留）。
- `src/components/chat/hooks/useChatProviderState.ts`：`PROVIDERS = ['claude','codex','opencode','qoder']`；localStorage key（删 `sophcode-model`，保留/合并 `opencode-model`，加 `qoder-model`）；`FALLBACK_DEFAULT_MODEL`（opencode → `opencode/deepseek-v4-flash-free`，qoder → `auto`）；permissionModes（opencode/qoder 均 `['default','acceptEdits','bypassPermissions','plan']`）。
- `src/components/chat/constants/providerEffort.ts`：删 `sophcode`；opencode 保留；加 `qoder: ['none','low','medium','high','xhigh','max']`。
- `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`：`PROVIDER_META`（OpenCode / Qoder）+ 模型选择分支改名。
- `src/components/chat/view/subcomponents/convertToTaskPayload.ts`：`FALLBACK_DEFAULT_MODEL` 局部副本与 provider 判空守卫同步去 sophcode / 加 qoder。
- `src/components/chat/view/{ChatInterface.tsx, subcomponents/ChatMessagesPane.tsx, MessageComponent.tsx, CommandResultModal.tsx}` 与 `src/components/chat/hooks/useChatComposerState.ts`：provider 分支改名/新增。
- `src/components/llm-logo-provider/`：新增 `QoderLogo.tsx`（照 claudecodeui），`SessionProviderLogo.tsx` 改用 OpenCodeLogo + 新增 QoderLogo，删除 SophcodeLogo 引用（文件一并删）。
- `src/components/tasks/{TaskCard,TaskBoard,TaskTableView,TaskDetail}.tsx`：executor_provider 显示/选项改名 + 加 qoder（TaskDetail L696-698 下拉处 sophcode 改 opencode + qoder）。

## 6. 测试

**后端**（`npx tsx --test --tsconfig server/tsconfig.json`，注意 TSX_TSCONFIG_PATH 全局残留需 unset）：

- sophcode 相关测试改名并适配断言：`sophcode-auth.test.ts`、`sophcode-sessions.test.ts`、`sophcode-synchronizer.test.ts`、`sophcode-models.test.ts`（→ `opencode-*.test.ts`）、`websocket/tests/sophcode-runner.test.js`（→ opencode-runner）
- 移植 claudecodeui qoder 测试：`qoder-runtime.provider.test.js`（→ 适配 qoder-runner）、qoder sessions / synchronizer 测试（可参考 `opencode-sessions.test.ts` 等）
- 涉及 provider 列表/迁移的既有测试同步：`commands.test.js`、`tasks-status-migration.test.ts`、`providers/tests/mcp.test.ts`、`providers/tests/skills.test.ts`、`sessions-provider-mapping` 类
- 新增 migration 用例：sophcode→opencode 行迁移 + tasks CHECK 重建幂等

**前端**（`npx tsx --test`，lovdex-cli 无 npm test 脚本，需显式文件跑）：`convertToTaskPayload.test.ts` 等涉及 provider 的用例同步。

## 7. 验收标准

1. 后端/前端测试全绿；`tsc --noEmit` 零新增错误（server baseline 4 个 pre-existing 错误，lovdex-cli 既有检查）。
2. DB 迁移在现库上执行无错：sessions/tasks 中无残留 `sophcode` provider 行。
3. 后端 provider 接口（`/api/providers/:id/(auth|models|skills|mcp)`）对 opencode / qoder 正常响应。
4. 前端 provider 选择出现 OpenCode 与 Qoder；Qoder 发消息流式输出、abort、token 用量正常；opencode（fork 会话）历史正常显示与续聊。
5. 任务 executor 可选 opencode / qoder 且能执行。
6. 无 provider id 硬编码残留 `sophcode`（`grep -r "sophcode" server/ src/` 清空，容忍共用 'sophcode' 的第三方引用）。

## 8. 风险与注意事项

1. **重启后端需用户确认（强约束）**：后端跑着多个依赖它的服务/项目，任何 reload / restart / systemctl / kill 前必须征得同意；优先最小重启（kill 后端 npm/tsx 子进程由 supervisor 拉起，见 memory `lovdex-backend-restart-requires-confirm`）。
2. 重命名是破坏性变更：DB 迁移 + 前后端 + operator + 测试务必一次做完，避免中间态。
3. `~/.qoder/projects` 目录名编码（`/`→`-`）lossy，只需保障 transcript `cwd` 字段兜底逻辑照搬。
4. qoder/opencode runner 移植时去掉 `context.*` 是主要适配点；注意 claudecodeui 的通知/工具 import 路径（`@/modules/notifications/index.js`）在 lovdex 是 `server/services/notification-orchestrator.js`。
5. opencode auth installed 探测应如实反映真实 `opencode` CLI 未装（但 fork 会话可用），不误导用户。
6. 依赖文件（schema/schema.sql 等）若含 provider 枚举一并检查。