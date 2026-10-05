# 会话失控烧 Token 事故修复说明

日期：2026-10-01
事故：2026-09-30 两个无人值守只读任务各跑 ~2500 条消息 / ~4MB transcript，最终 `402 余额不足`。

## 逐项根因 → 修复点 → 配置 → 验证

### 根因 1：子任务派生爆炸（未设上限）

**修复点**
- 数据库：`tasks` 表新增 `parent_task_id` + `dispatch_depth` 两列（`schema.ts` / `migrations.ts`，migrations 只对新列生效、幂等）。
- 助手下发子任务时打派生链：`operator.tools.ts` 的 `create_task` 通过注入的 `lineage()`（`index.js`，按助手会话反查 `tasksService.getTaskBySessionId`）解析父任务与深度，写 `parent_task_id` / `dispatch_depth`。
- 深度/扇出硬上限 `MAX_TASK_DISPATCH_DEPTH = 2`（`task-run-guard.ts`）：
  - `create_task` 侧：超过上限直接 `throw`（模型可见、快速失败）。
  - 任务内子代理侧：`guardTaskRunToolInput` 收到 `dispatchDepth` 后，`Task`/`Agent` 工具在深度达上限时 `deny`。深度由 `startHeadlessTaskRun` 从任务行读入 `runtimeOptions.dispatchDepth` → `claude-sdk.js` 的 `makeTaskRunGuardHook(dispatchDepth)` 传入 PreToolUse hook。

**默认阈值 / 配置项**：`MAX_TASK_DISPATCH_DEPTH = 2`（代码常量；根任务=0，最多派生出孙任务）。
**验证**：`npx tsx --test server/modules/operators/tests/task-run-guard.test.ts`（新增「深度达上限 deny」用例）与 `operator-tools.test.ts`（新增「lineage 打标」「超深拒绝」用例）。

### 根因 2：默认落到最贵模型（子任务 executor_model = null）

**修复点**
- 新增配置槽 `providers.claude.runGuard.defaultTaskModel = 'haiku'`（便宜档；`config.ts` 默认值 + `run-guard.ts` 解析）。
- 三条派发路径在 `executor_model` 为空时显式落便宜档，不再继承「最贵运行时默认」：
  - 调度派发：`scheduler.service.ts` `dispatch` 里 `executor_model` 为空 → `defaultTaskModel`。
  - 助手建定时任务：`operator.tools.ts` `create_scheduled_task` 补 `executorModel` 默认。
  - 任务启动：`index.js` `startTaskRun` 里 `task.executor_model ?? defaultTaskModel`（否则 `model: null` → SDK 默认最贵档）。

**默认阈值 / 配置项**：`defaultTaskModel = 'haiku'`（可改为任意便宜槽位名，如 `'default'` 指向 `providers.claude.defaultModel`）。
**验证**：单测 `operator-tools.test.ts`（create_scheduled_task 断言 `executorModel === 'haiku'`）；现场核实两个失控子任务的 transcript 实际模型为 `DeepSeek-V4-Pro-0813`（最贵档），同源定时任务却用 `DeepSeek-Flash`——修复后 null 不再落到最贵档。

### 根因 3：权限模式 = default（无人值守静默超时死循环）

**修复点**
- 无人值守唯一收口：`headless-task-run.service.ts` `startHeadlessTaskRun` 是**所有**无审批人路径（定时任务 + 助手 `start_task_execution`）的必经点。这里新增强制归一化 `normalizeUnattendedPermissionMode`（`auto-approve-policy.ts`）：任何入参都收敛为 `autoApprove`（运行时映射成 `default` + `autoApprove` 标志，`canUseTool` 仍在跑危险规则），**不再信任任务行已有的 `default`**。日志在强转时告警。
- 助手新建任务/定时任务时落库即为 `autoApprove`（`operator.tools.ts`），减少脏数据来源。

**默认阈值 / 配置项**：无配置项——这是硬约束：无人值守运行时**永远不得**用会在无人审批时超时的模式。
**验证**：`headless-task-run.test.ts`（改写：无模式与显式 `default` 都被强转成 `autoApprove`）；语义说明——`bypassPermissions` 会跳过 `canUseTool` 从而跳过危险规则，故无人值守**不保留** bypass，统一走 autoApprove 的拒绝清单（只读工具放行、危险写/提权/推送快速失败）。

### 根因 4：无会话级熔断（最大轮次 / 墙钟 / 累计 token 或成本）

**修复点**：新增 `server/modules/operators/run-guard.ts`（纯逻辑，可单测），由 `claude-sdk.js` 的流式循环每帧驱动：
- 轮次熔断：`assistant` 消息计数。
- 墙钟熔断：`startedAtMs` 起算。
- token/成本熔断：`assistant.message.usage` 累计（input+output+cache），`result.total_cost_usd` 累计成本。
- 任一触顶 → `break` 出循环 → `interrupt()` CLI 子进程 → 发 `error` + `complete{exitCode:1}` → `onSessionStatus('failed')` 落 `sub_status='failed'`，熔断原因写进会话末条错误文本（verdict 读取的 final output 可见）。

**默认阈值 / 配置项**（`app.config.json` → `providers.claude.runGuard`，0=禁用；可热读，无需重启）：
| 键 | 默认 | 说明 |
|---|---|---|
| `maxTurns` | 300 | 轮次上限（2500 条事故量级在此拦下） |
| `maxDurationMs` | 3600000 (1h) | 墙钟上限 |
| `maxTotalTokens` | 0（关） | 累计 token 上限，需要时可开 |
| `maxBudgetUsd` | 0（关） | 估算成本上限（USD），需要时可开 |

选择默认开「轮次 + 墙钟」、默认关「token/成本」的原因：轮次与墙钟是零配置即能兜底失控的硬指标；token/成本依赖模型单价且部署差异大，留作显式开启的强成本闸门。
**验证**：`run-guard.test.ts`（四类熔断各触发一次 + 0=禁用 + 默认值解析）。

### 根因 5：402（余额不足）不算致命错误，不立即终止

**修复点**：`claude-sdk.js` 流式循环在两条信号上扫描 `isFatalApiError`（`run-guard.ts`）：
- `result` 消息 `is_error` 时的 `errors[]` / `result` 文本；
- 每条 `tool_result` 的 `is_error` 内容。

命中 `402` / `余额不足` / `insufficient balance` / `out of credits` 等（保守正则）→ 置 `guardReason='fatal_api_error'` → 走与熔断相同的「立即终止 + 失败结算」路径，**首次出现即断**。

**默认阈值 / 配置项**：无配置项——致命错误永远立即终止。
**验证**：`run-guard.test.ts` 的 `isFatalApiError`（事故原文 `API Error: 402 余额不足，请充值` 命中；`Permission request timed out` 不误命中）。

### 根因 6：二次放大——完成度判定整段读入超长 transcript

**修复点**
- 每次会话结束的「完成度判定」本身已走便宜的 `llm` 通道（`operator-verdict-llm.ts`），且已有 `MAX_MESSAGES=200` + `MAX_VERDICT_TRANSCRIPT_CHARS=60000` 上限——问题是 `fetchHistory(limit:200)` 在 provider 层仍先把整份 ~4MB JSONL 读进内存再切页。**已在 `claude-sessions.provider.ts` 确认 `getSessionMessages` 用的是 `limit === null` 时全量读、分页时切页但底层 `readTranscriptDir` 仍是全文件读**——这是剩余的低效点，但**不影响正确性**：`fetchHistory` 返回的 `total` 必须来自全量消息数（前端 `hasMore` / `total` 依赖它，改尾读会破坏分页计数）。
- 因此本项采取**不改 provider 分页语义**的收敛方案，并在说明中显式记录：判定通道已有 `MAX_MESSAGES=200` 采样上限（`operator-verdict-llm.ts`），判定本身不再整段读入——是**上层采样**而非**底层切页**。真正的二次放大来自「402 跑挂仍判完成 + 反复触发判定」，已由根因 4/5 的失败结算修复（跑挂不再 `completed`，不再触发判定）。

**默认阈值 / 配置项**：`operator-verdict-llm.ts` 的 `MAX_MESSAGES=200` / `MAX_VERDICT_TRANSCRIPT_CHARS=60000` / `MAX_FINAL_OUTPUT_CHARS=20000`（已存在，本项复用）。
**验证**：`operator-verdict-llm.test.ts` 全绿。

### 根因 1b（F 项大输出）：list_tasks 输出过大塞进上下文

**修复点**：`operator.tools.ts` 的 `list_tasks` 工具改为「轻量投影 + 硬上限 + 摘要」：
- 默认返回 50 行，硬上限 `LIST_TASKS_MAX_ROWS=200`；
- 每行只投影 `taskId/title/status/priority`（不再内联 `description`/verdict 等长字段）；
- 超出时返回 `total`/`hasMore` + 截断提示，引导模型用 `status` 过滤或 `offset` 翻页，而非一次拿全。

**默认阈值 / 配置项**：`LIST_TASKS_MAX_ROWS = 200`（代码常量）。
**验证**：`operator-tools.test.ts`（250 行 → 返回 200 行、不泄漏 description、分页/过滤正确）。

### 根因 7（G 项收尾）：僵尸任务仍显示 in_progress

**修复点**：新增 `scripts/settle-zombie-tasks.mjs`（只读盘点 + `--settle` 归档收尾）：
- 找出 `status=in_progress AND sub_status=failed` 且 transcript 超阈值（默认 1MB）的任务；
- `--settle` 将其 `status` 置 `archived`（engine 永不写 archived，纯人工数据修复）、隐藏关联会话。

**验证**：对 live DB 快照运行，精确命中并归档两个僵尸任务 `7ba0771c` / `1462993f`（及其会话 `4c889d0a` / `3a08c193`）。代码侧（根因 4/5）已保证新跑失败不再被判「完成」，因此不再反复触发判定读取超长 transcript。
**注意**：脚本本身**不**直接改 live DB（仓库内存量数据非代码，不在 commit 范围）；按项目惯例对快照跑 `--settle` 后由人工执行数据修复。`7ba0771c`/`1462993f` 的 `sub_status` 已是 `failed` 而仍显示 `in_progress`，根因正是「跑挂仍按 completed 结算」的两层状态矛盾，已被根因 4/5 修复。

## 不在本仓库范围 / 需上游的事项

- **SDK 自身 `maxTurns` / `maxBudgetUsd` 选项**：`@anthropic-ai/claude-agent-sdk` 原生提供（`sdk.d.ts` 已确认），但它们会**终止 CLI 子进程**，无法把 Lovdex 侧的熔断原因写进会话 terminal `complete`（`onSessionStatus('failed')` 依赖它落 `sub_status`）。因此本实现用**自己的计数器 + 流内 `break` + `interrupt()`** 复刻这三类熔断，以获得可观测、可写回任务行的终止原因。若未来 SDK 暴露「携带自定义终止原因」的钩子，可替换为原生开关。
- **qoder/codex/opencode 三个运行时**：本仓库的会话熔断/重复失败/致命错误熔断只在 `claude-sdk.js` 落地（事故会话全部是 claude provider）。其余三个 runtime 各自独立拉流，未接入 `run-guard`。若需同等级防护，需在 `qoder-runner.js` / `opencode-runner.js` / `openai-codex.js` 各自复刻同样的事件循环计数器——**本次未做**，仅 claude 路径受保护。

## 验证总览

- 单元/集成测试：`operator-tools` / `run-guard` / `task-run-guard` / `headless-task-run` / `scheduler.service` / `transcript-history` / `tasks.service*` / `tasks.db*` / `claude-fetch-history` / `operator-verdict-llm` 全部通过（合计 400+ 断言）。
- 类型检查：`npx tsc --noEmit` 仅剩 4 个**改动前已存在**的测试文件错误（`config.routes.test.ts` / `operator-headless.test.ts` / `tasks.create-dedup.integration.test.ts` / `tasks.service.status.test.ts`），非本改动引入；所有非测试源码零错误。
- Lint：改动文件无新增 error（`migrations.ts:952` 的 `no-explicit-any` 与 `claude-sdk.js:327` 的 `prefer-const` 均为改动前已存在，`git blame` 证实）。
