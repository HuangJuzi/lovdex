# 任务详情页「执行结果」区 — 设计文档（Phase 1，只读）

> 状态：待审 · 2026-08-08
> 定位：任务详情页加一个只读「执行结果」卡片，展示关联会话里 agent 最后一条 assistant 文本结论，免去点进会话查看。

---

## 1. 背景与目标

任务详情页（`TaskDetail.tsx`）目前只有标题/描述/状态/属性/执行按钮，**没有结果区**。用户想看 agent 干出了什么结论，必须点「打开会话」跳到会话页翻到最后一条 assistant 消息。这一步对「验收」前置判断不友好——结论应该直接在详情页可见。

**目标**：在详情页加只读「执行结果」卡片，渲染关联会话最后一条 assistant 文本。

**Phase 1 边界（刻意排除，留 Phase 2）**：
- 不改 `tasks` 表结构，不新增 `result` 列。
- 不改后端状态机、不写库。
- 不可手动编辑结果。
- 不做流式 delta 渲染。

---

## 2. 产品方案

### 2.1 一句话定位

> 任务的状态是引擎写的，但结论 agent 自己说了算——详情页直接把会话最后一句 assistant 话贴出来，验收前先看一眼。

### 2.2 数据来源

- 仅当 `task.session_id` 存在时，前端调用现成接口 `api.unifiedSessionMessages(sessionId, provider, {})`（`limit=null` 返回全部）。
- 取**最后一条** `kind === 'text' && role === 'assistant'` 且 `content.trim()` 非空的消息。
- 用现成 `MarkdownContent` 渲染（复用会话页 markdown 管线，含文件路径自动链接等）。
- 任务会话是「一个任务一个会话」的有界会话，全量拉取可接受。

### 2.3 触发时机（刷新策略）

1. 详情页加载且 `task.session_id` 存在时拉取一次。
2. 订阅 `task_upserted` WS 事件：任务状态进入 `in_progress`/`in_review`（即会话有新产出）时重新拉取。
3. 卡片标题旁带「刷新」按钮，手动兜底。

进行中（`in_progress`）也展示当前最新 assistant 文本，作为「实时最新结论」；但不做流式 delta，避免与看板/会话页重复实现流式逻辑。

### 2.4 布局

- 在现有 `grid`（描述 + 属性/执行）**下方**加一张**全宽**卡片「执行结果」。
- 卡片标题：「执行结果」+ 右侧「刷新」按钮。
- 空态：
  - 无 `session_id` →「尚未开始执行」。
  - 有会话但无 assistant 文本 →「agent 还没产出结论」。
  - 加载中 →「加载中…」。
  - 拉取失败 → 错误态 + 重试按钮。

---

## 3. 改动文件（lovdex-cli/）

| 文件 | 内容 |
|---|---|
| `src/components/tasks/TaskDetail.tsx` | 新增「执行结果」卡片 + 拉取/刷新逻辑；遵循现有 `load` 的 `loadSeq` 防并发模式 |
| `src/components/tasks/taskResult.ts`（新建） | 纯函数 `pickLastAssistantText(messages)`：从消息列表取最后一条 assistant 文本，便于测试 |
| `src/components/tasks/taskDetail.test.ts` | 补测试：有 session_id 时拉取并渲染最后 assistant 文本 / 无 session 时空态 / WS 推送后刷新 / 纯函数测试 |

`taskResult.ts` 内联 vs 独立文件：独立，便于单测且保持 TaskDetail 文件聚焦（详情页文件已 285 行，结果逻辑抽出后更清晰）。

---

## 4. 边界与不做

- 不存库、不可编辑（Phase 2）。
- 不上会话页的流式渲染、不做 tool 调用展示——只取最后一条 assistant 文本。
- 看板卡片不加（只要求详情页）。

---

## 5. Phase 2（本次不做，留口）

- `tasks` 表加 `result` 列；会话 `completed` 时后端把最后 assistant 文本写入；`GET /api/tasks/:taskId` 直接带回；支持手动编辑。
- 届时 Phase 1 的前端拉取逻辑可替换为直接读 `task.result`，前端回退到「拉会话」仅作 `result` 为空时的兜底。

---

## 6. 验收标准

- 有 session_id 且会话有 assistant 文本：详情页底部显示结论（markdown 渲染）。
- 无 session_id：显示「尚未开始执行」，不发起请求。
- 有 session_id 但无 assistant 文本：显示「agent 还没产出结论」。
- 状态流转到 `in_review`/`done` 后，结论自动刷新（WS 触发）。
- 「刷新」按钮可手动重拉。
- 拉取失败显示错误态 + 重试，不崩溃整个详情页。
