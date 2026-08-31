# 新建任务可选携带来源会话上下文（自动压缩注入）设计

- 日期：2026-08-31
- 状态：设计稿（待用户审阅）
- 关联：任务、「新建任务」表单、会话 transcript、chat.send 链路

## 背景与痛点

从任务面板「新建任务」开启的任务，其会话是全新创建的、零历史上下文。agent 执行时缺少四类基础信息：

1. **项目背景/决策**——代码结构、技术栈、约定、以往方案的取舍理由；
2. **前序任务交接**——上一任务的产物、结论、待办；
3. **环境详情**——端口、凭据位置、远程主机等环境事实；
4. **其它跨项目常识**——这些信息存在于历史会话 transcript，但代码/描述里没有。

现状里只有「会话转任务」（`ConvertToTaskDialog` 传 `sessionId`，强关联整段会话）和「失败重试」（原地续聊）能延续上下文；「新建任务」这条路完全漏掉了上下文衔接。

## 需求（用户已确认）

1. 新建任务表单增加一个**可选的**「上下文来源」下拉（默认无 = 白纸开始，行为与现在完全一致）。
2. 选定来源会话后，**不预览、不打断**——后台自动把该会话历史**压缩成一份摘要**。
3. 新任务**首次执行前自动注入**这份摘要，agent 在完整语境下开工。
4. 「上下文来源」是**可选项，不是必选**——不选时新建任务流程零变化，存量行为完全保留。现有「会话转任务」入口保持原样，不合并。

## 方案：摘要落任务字段，首次执行注入（方案 A，一期交付）

### 数据模型

任务行新增可空字段 `context_summary`（TEXT）。

- 数据库：`tasks` 表加列 `context_summary TEXT NULL`。
- 结构：固定模板的 LLM 生成文本，含以下块（标题 + 要点）：
  - 项目背景/决策
  - 前序任务交接
  - 环境详情
  - 注意事项/约束

### 建任务流程（选了来源时）

```
POST /api/tasks { ..., sourceSessionId?: string }
        │
        ▼
createTask 创建任务行（context_summary=null）
        │
        ▼ (fire-and-forget，不阻塞响应)
后台异步任务：
  │  1) 用 sourceSessionId 取会话行；校验归属 project（SESSION_PROJECT_MISMATCH 同现有逻辑）
  │  2) 取会话 transcript
  │     - 本地项目：sessions.service 读 jsonl
  │     - 远程项目：remote-history fetchMessages（lite RPC）
  │  3) LLM 压缩 → 固定模板摘要 → 写回任务 context_summary
  │  4) 失败置 context_summary = NULL 并记日志（不失败任务、不影响执行）
  ▼
任务照常创建，响应立即返回
```

- 异步兜底：若用户启动得比摘要生成早，本次执行不带摘要；**下次执行/重试时若摘要已就绪则带上**。任务本身不会被压缩流程阻塞或失败。
- 幂等：并发 only-once guard，避免双击/重复触发写两次。

### 执行注入

`buildTaskChatSend`（web `taskExecution.ts`）构建 `chat.send` 时，若任务 `context_summary` 非空，将其拼进首条 user 消息前缀再发。

- 落入现有 `chat.send` 链路 → 四 provider（claude/qoder/codex/opencode）通用，无需逐个 runner 改造。
- 首轮发送时读取当时的 `context_summary`；retry（原地续聊）沿用现有 `TASK_RETRY_MESSAGE` 逻辑，若字段已有值也可在其前追加摘要（二期可调，一期只做首轮注入）。

### 前端

「新建任务」表单（`TaskBoard.tsx` 的 `createTask`）新增可选下拉：

- 数据源：沿用侧边栏已有的项目会话列表（`/api/projects` 的 sessions）。
- 默认值：空（无 = 白纸开始）。
- 提交：选中时 body 带 `sourceSessionId`。
- 不选中时 body 不带该字段 → 后端走纯现状路径。

「会话转任务」对话框（`ConvertToTaskDialog`）**不改**。

## 关键决策记录

| 议题 | 决定 |
|---|---|
| 实现路径 | 方案 A（摘要落任务字段 + 首次执行注入）；方案 B（真 fork）不做一期 |
| 来源选择 | 手动选一个会话；默认空值 |
| 压缩产物使用 | 自动注入、不打断、不预览 |
| 压缩时机 | 建任务后后台异步，不阻塞创建 |
| 摘要未就绪就启动 | 本次不带、下次/重试带上（兜底，非阻塞） |
| 摘要结构 | 固定模板（背景/决策/交接/环境/注意事项） |
| 注入点 | 首条 user 消息前缀，走 chat.send |
| provider 覆盖 | 全 provider（摘要为纯文本，注入链路已通用） |
| 会话转任务入口 | 保持原样，不合并 |

## 明确不做（YAGNI / 边界）

- **真 fork + 压缩**（方案 B）：仅 claude 支持、token 重，不做一期。
- **自动聚合项目最近多个会话**：用户确认只手动选一个。
- **压缩前预览/可编辑 UI**：用户确认自动注入不打断。
- **多来源拼接 / 引用关注度排序**：一期不做。
- **context_summary 手动编辑入口**任务详情页：一期不做（字段可空储，API 可读写即可，UI 编辑后续再说）。

## 错误处理

| 场景 | 处理 |
|---|---|
| sourceSessionId 不存在 | 400/404（沿用 SESSION_NOT_FOUND） |
| 来源会话不属于所选项目 | 409（沿用 SESSION_PROJECT_MISMATCH） |
| transcript 读取失败 / 压缩 LLM 失败 | context_summary 保持 NULL，记日志，任务照常 |
| 压缩并发写 | only-once guard |
| 旧任务无该字段 / 值为空 | 首次执行不注入，行为不变 |

## 测试

**后端**（`npx tsx --test`，node:test）
- `createTask` 带 sourceSessionId 时创建即返回、异步压缩写入 context_summary（注入 stub 压缩函数断言调用 + 写回）。
- sourceSessionId 不存在 / 项目不匹配 → 对应错误码。
- 压缩失败 → context_summary NULL，任务状态与执行不受影响。
- `buildTaskChatSend` 等价逻辑（若为存库字段测试迁后端，则测注入辅助函数）：context_summary 非空时首条消息带前缀，空时不带。

**前端**（现有测试跑 `npx tsx --test`）
- 表单默认无来源；选中后提交 body 含 sourceSessionId；不选时无该字段。

**手工验收**
- 建任务不选来源 → 行为和之前完全一样。
- 建任务选一个历史会话 → 稍后任务 context_summary 有值；首次执行首条消息带摘要前缀。
- 建任务后立刻启动（摘要未就绪）→ 任务正常启动，重试后带摘要。

## 影响面

- 后端：`tasks` 表 + `createTask` + 新压缩服务（读 transcript → LLM → 写回）。
- 前端：`TaskBoard.tsx` 新建任务表单 + `taskExecution.ts` 注入。
- 不动：现有「会话转任务」、retry 逻辑、四 provider runner、远程会话历史。