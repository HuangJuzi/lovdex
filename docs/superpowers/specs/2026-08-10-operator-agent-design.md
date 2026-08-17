# Lovdex Operator Agent 设计

- 日期：2026-08-10
- 状态：设计待评审
- 相关：`docs/task-board-design.md`、`docs/superpowers/specs/2026-08-08-chat-to-task-link-design.md`、`docs/superpowers/specs/2026-08-10-session-to-task-convert-design.md`

## 1. 背景与目标

后端已经具备 Agent 执行能力：通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 在进程内跑 Claude（`server/claude-sdk.js`），流式推 WebSocket，带工具审批/中断；session 绑在项目上，看板 `tasks` 表用 `backlog → todo → in_progress → in_review → done` 状态机驱动，`completed` 时 `in_progress → in_review`。

当前缺口：

1. 没有跨项目的「全局助手」对话入口——所有 chat 都绑在某个项目的 session/task 上。
2. 没有让 Agent 查 lovdex 自身状态、下发任务的工具集。
3. 完成度判定不准：session 跑完（`completed`）就进 `in_review`，但「agent 跑完一轮」≠「任务真做完了」（例如用 Superpowers 只生成了 plan，根本没动代码）。状态页没有 AI 生成的 summary / 完成度结论。

目标：

- 一个**全局 Operator Agent**：可对话，能用工具查跨项目状态、自然语言建任务（缺信息时反问补充）、下发任务到代办。
- **完成时自动判定**：任务 session `completed` 时，后端自动起一个无人工的 operator 头跑（headless）轮次，读 transcript，生成 summary + verdict，写到任务上，并按 verdict 驱动看板移列（尽量自动化）。
- 一个**设置页**配置 Operator Agent；不配置也能用（安全默认），配了能开更多自动化与对话能力。

## 2. 核心概念

**Operator Agent**：以「operator 模式」跑的 Claude SDK session，复用 `claude-sdk.js` 的 `query()` 循环（流式 / 审批 / 中断全白用）。与普通 session 的区别：

- **不绑任务**，cwd = 可配置的 operator 工作区（默认 `~/.lovdex/operator-workspace`，env `LOVDEX_OPERATOR_WORKSPACE` 可覆盖）。
- **封闭工具集**：只有查状态 + 派活 + 写 summary 的自定义工具，**不给 `bash` / `Edit` / `Write`**。Operator 不直接改代码——要改代码就下发任务（任务自己起 Claude Code 在项目 cwd 里跑）。这样无人工的头跑 auto-verdict 也安全。
- **两种调用方式**：
  - **交互式**：在「助手」面板聊，全流式，能用 `AskUserQuestion` 反问补信息。
  - **头跑 headless**：任务 `completed` 时后端自动起一轮，固定 prompt，无用户、无流式，结果写到任务上。

## 3. Operator 工具集

在 `claude-sdk.js` 里以 mode 判断：operator 模式注册以下自定义工具（SDK 的 `tools` 选项支持带 handler 的自定义工具），普通模式不变。

| 工具 | 入参 | 作用 |
|---|---|---|
| `list_projects` | — | 列项目（包 `projectsDb`） |
| `get_project` | `projectPath` | 项目详情 |
| `list_tasks` | `projectPath?`, `status?` | 列任务（含 ai_summary/verdict） |
| `get_task` | `taskId` | 任务详情 |
| `get_session_transcript` | `sessionId` | 读 session 的 assistant 轮 + 工具调用 + 结果，作为判完成度依据（包 `session-conversations-search.service`） |
| `create_task` | `projectPath`, `title`, `description?`, `status?` | 建任务，默认 `status='todo'`（代办列） |
| `start_task_execution` | `taskId` | 下发执行（复用 `tasksService.startExecution` + session creator） |
| `update_task` | `taskId`, `...` | 改任务字段 |
| `move_task` | `taskId`, `status`, `beforeId?`, `afterId?` | 移列 |
| `write_task_summary` | `taskId`, `summary`, `verdict`, `reason?` | 写 `ai_summary` + `verdict` + `verdict_reason` + `verdict_at` |
| `ask_user` | `question`, `options?` | 缺信息时反问，包一层 `AskUserQuestion` |

工具 handler 直接调用现有 service / db 函数，不重写业务逻辑。

**`start_task_execution` 的语义**：不只建 session，还要把任务 `description`（或 `title`）作为首条 user message 发出去，真正起跑（复用现有 chat 发消息链路）。否则只建 session 不会自动开跑。

**头跑 auto-verdict 的鉴权**：复用 `providerAuthService` 拿 Claude 凭证，和交互式 session 同源；不另起鉴权。

## 4. 自然语言建任务

用户说「新建一个修复登录 bug 的任务」→ operator（Claude）解析意图 → 调 `create_task`。

- **projectPath 推断**：前端打开助手面板时把「当前侧边栏选中项目」传给 operator session 作为上下文；operator 优先用它，拿不到就调 `ask_user` 让用户选。
- **缺字段**（描述模糊 / 缺项目）→ `ask_user` 反问 → 用户补 → 再 `create_task`。
- 建完走现有 `task_upserted` 广播，看板代办列实时多一张卡。

## 5. 完成时自动判定（核心）

### 触发点

`tasksService.onSessionStatus(sid, 'completed')` 内，在现有 `in_progress → in_review` 之后，起一个头跑 operator 轮次。

### 判定 prompt（固定）

```
你是 Lovdex Operator。读 session <sid>（任务 <taskId>: <title>）的 transcript，
判断实际完成度，调 write_task_summary 写入：
  summary: 中文，≤3 句，说清做了什么 / 没做什么
  verdict: done=真完成 | only_plan=只出了计划没动代码 | needs_review=需人判断 | blocked=卡住
  reason: 一句理由
```

### verdict 驱动移列（尽量自动化，可配置）

| verdict | 默认动作（安全默认） | 说明 |
|---|---|---|
| `done` | 留 `in_review`（人确认才进 done） | 完成列保留人工 gate |
| `only_plan` | `in_review → todo` | 只出了计划，明显还要干，自动退回代办 |
| `needs_review` | 留 `in_review` | 本来就在评审 |
| `blocked` | 留 `in_review` + 红徽章 | 卡住，等人 |

设置页可开更激进的规则：`done → done` 全自动、`only_plan → todo` 关闭等。

### 约束

- **并发上限**：`LOVDEX_OPERATOR_MAX_CONCURRENT=2`，超了排队，防一波任务同时完成打爆。
- **递归守卫**：operator 自己的 session 不触发 auto-verdict（session 打 `is_operator=1` 标记，`onSessionStatus` 里早退）。
- **失败不阻塞**：operator 轮次挂了就记日志、verdict 留空，任务照常 `in_review`。
- **开关**：`LOVDEX_OPERATOR_AUTO_VERDICT=on` 可整体关。

## 6. 数据模型

`tasks` 表加四列（走现有 `addColumnToTableIfNotExists` migration 模式）：

- `ai_summary TEXT`
- `verdict TEXT`
- `verdict_reason TEXT`
- `verdict_at TEXT`（ISO 时间）

`sessions` 表加 `is_operator INTEGER DEFAULT 0`（标记 operator session，递归守卫 + 前端历史列表过滤）。

`TaskRow` 类型扩展；`tasks.service.ts` 的 `decorate` 带上这些字段；`task_upserted` 事件携带，看板实时更新。新增 `verdict` 的合法值校验函数（仿 `isTaskStatus`）。

## 7. 设置页（配置 Operator Agent）

### 原则

**不配置也能用**：开箱即用——auto-verdict 开、安全默认移列、交互式助手面板可用、operator session 多段对话。

**配置后多一些自动化与对话**：开 `done→done` 全自动、调模型、改判定 prompt、调并发、开关交互式入口等。

### 配置项

| 配置 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | Operator 总开关 |
| `auto_verdict_enabled` | `true` | 完成时自动判定 |
| `auto_move_enabled` | `true` | verdict 驱动移列 |
| `auto_move_done` | `false` | `done verdict → done 列`（激进） |
| `auto_move_only_plan_to_todo` | `true` | `only_plan → todo` |
| `model` | `claude-*`（沿用现有默认） | operator 用的模型 |
| `workspace` | `~/.lovdex/operator-workspace` | operator cwd |
| `max_concurrent` | `2` | 头跑并发上限 |
| `verdict_prompt_override` | 空 | 自定义判定 prompt |
| `interactive_chat_enabled` | `true` | 助手面板入口开关 |

### 后端

- 复用现有 `app_config`（key-value）持久化配置，不新建表。
- 路由 `GET / PUT /api/operator/settings`（仿现有 `provider-auth` / `app-config` 路由形状）。
- env 变量 `LOVDEX_OPERATOR_*` 仅作 seed 默认 + 调试覆盖，运行时以 DB 配置为准。

### 前端

- 侧边栏设置区新增「Operator Agent」设置页：表单 + 开关 + 模型下拉（复用 `provider-models` 拉的模型列表）。
- 改动实时 `PUT`，失败回滚提示。

## 8. 前端（助手面板 + 看板展示）

### 助手面板

- 侧边栏顶层新入口「助手 / Assistant」（不在某个项目下）→ 路由 `/assistant`。
- 复用现有 chat 视图（`components/chat`），绑 operator session：新建/切换 operator session。
- operator session 在 sessions 表 `is_operator=1`；session 列表过滤出 operator session 作历史。
- 打开助手面板时，前端把「当前选中项目路径」作为 operator session 的元数据字段传给后端（不塞进 user message）；operator 工具集的 `create_task` 在 projectPath 缺省时优先读这个字段，拿不到再 `ask_user`。

### 看板展示

- `TaskCard`：加 `verdict` 徽章（`done` 绿 / `needs_review` 黄 / `only_plan` 蓝 / `blocked` 红）+ `ai_summary` 单行截断。
- `TaskDetail`：完整 `ai_summary` + `verdict_reason` + `verdict_at`。
- i18n：zh + en（复用 `src/i18n/locales`）。

## 9. 边界与安全

- Operator 工具集无 `bash`/`Edit`/`Write` → 头跑 auto-verdict 可无审批自动执行。
- 交互式 operator 聊天：`AskUserQuestion` 走现有 chat 的审批渲染（`TOOLS_REQUIRING_INTERACTION` 已含 `AskUserQuestion`）。
- 派出去的任务用普通 Claude Code 在项目 cwd 跑，能改代码；operator 自己不能。边界清晰。
- Operator cwd 是 scratch 目录，不是任何真实项目——即使将来给工具集加更多能力，也不会误改业务代码。

## 10. 测试

- **工具 handler 单测**（mock service/db，仿 `modules/tasks/tests/`）：`create_task` 默认 `todo`、`write_task_summary` 写列、`get_session_transcript` 读取、`list_tasks` 过滤。
- **auto-verdict 触发逻辑**：`completed` → 起头跑、`is_operator` 递归守卫、并发上限排队、失败不阻塞、`auto_move_enabled` 各分支。
- **配置 API**：`GET/PUT /api/operator/settings` 读写、默认值、env seed 覆盖。
- **前端**：TaskCard verdict 徽章渲染、助手面板开/关 `interactive_chat_enabled`。

## 11. 实施顺序（粗）

1. 数据模型：`tasks` 加 4 列 + `sessions.is_operator` + migration。
2. Operator 工具集 + `claude-sdk.js` mode 分支。
3. auto-verdict 头跑触发 + 移列逻辑 + 并发/守卫。
4. operator_config 表 + 设置 API + env seed。
5. 前端助手面板路由 + 复用 chat 视图。
6. TaskCard / TaskDetail verdict 展示。
7. 设置页表单。
8. 测试。

详细步骤交给实现计划（writing-plans）展开。
