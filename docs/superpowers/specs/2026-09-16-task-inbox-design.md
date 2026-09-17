# 任务页「需要你处理」收件箱段（方案 2）设计

- 日期：2026-09-16
- 状态：已实现（`feat/task-inbox` 分支，`537c12c`…`b4ad56c`）
- 对应视觉稿：`docs/design-html/2026-09-16-task-panel-redesign/b-inbox.html`

## 0. 目的与读者

在任务页顶部加一段**「需要你处理」**聚合区，把散在子状态列 / 看板卡片内部的行动信号（等你批准 / 执行失败 / 待你验收 / 已逾期等）收到一处，聚合条上直接给动作按钮，不必先点进任务。

读者是实现者（人或 agent）。本文只覆盖这一段 UI + 纯函数；不覆盖执行引擎、审批链路、会话内交互（这些都复用现有实现）。

## 1. 范围

### 1.1 包含

1. 一个纯函数 `taskInbox`：判定「哪些任务需要用户介入」+ 每条的可行动作与信号文案。
2. 一个 React 组件 `TaskInboxPanel`：在任务页顶部渲染聚合条，直给动作按钮。
3. 在 `TaskBoard` 顶部接入（看板 / 表格两个视图共用，移动端同段）。

### 1.2 不包含

| 项 | 说明 |
|---|---|
| 新增独立「收件箱」视图 | 已定：顶部常驻段，不新增视图模式 |
| 审批 / 回答 / 验收的实际逻辑 | 全部复用现有 handler：`runTask` / `updateStatus` / 会话跳转 |
| 「为什么在收件箱」的长文案 | 数据模型里没有该字段；信号用 `sub_status` 徽标 + 逾期天数表达 |
| 聚合条分页 / 折叠 | 需要处理项通常很少，全量列出；有项才渲染，无项不渲染 |

## 2. 「需要你处理」的判定

### 2.1 信号集合（全量）

需用户介入的 `sub_status`（取自 `taskStatus.ts` 的 `SUB_STATUS_META`，全集为 10 个值）：

| sub_status | 文案 | 动作 |
|---|---|---|
| `waiting_approval` | 等你批准 | 打开会话 |
| `waiting_answer` | 等你回答 | 打开会话 |
| `waiting_plan` | 等你确认计划 | 打开会话 |
| `pending_acceptance` | 待你验收 | 标记完成 |
| `needs_review` | 待你决策 | 打开会话 |
| `failed` | 执行失败 | 重试 |
| `blocked` | 需协助 | 打开会话 |
| `only_plan` | 计划待执行 | 打开会话（去会话执行计划） |

外加**已逾期**：`deadline` 存在、按本地时区已过当天 23:59:59.999、且 `status` 不在 `done` / `archived`（复用 `taskDeadline.ts` 的 `deadlineInfo`，`overdue: true`）。

不在信号集合里（不出现）：`running`（运行中）、`done`（已完成，待评审）。

### 2.2 优先级

一条任务可能同时命中多个信号（如 `failed` 且已逾期）。**取其一**，按此优先级：

```
sub_status 命中（按 SUB_STATUS_META 声明序） > 已逾期
```

即：有 sub_status 信号就用 sub_status 信号；只有「既无子状态信号、又逾期」的任务才按「已逾期」进聚合区。

### 2.3 纯函数签名

```ts
// taskInbox.ts
export type AttentionAction = 'retry' | 'start' | 'accept' | 'openSession' | 'openTask';

export type AttentionItem = {
  task: Task;
  signal: SubStatus | 'overdue';  // 命中的 sub_status；纯逾期时为 'overdue'
  label: string;                  // 信号文案：SUB_STATUS_META[signal].label 或 `已逾期 N 天`
  tone: 'wait' | 'fail' | 'accept' | 'plan' | 'late';  // 配色族，映射见 §4
  action: AttentionAction;
};

export function attentionItems(tasks: Task[], now: Date): AttentionItem[];
```

- `now` 由调用方传入（对齐 `TaskBoard` 里每分钟刷新的 `now`，避免跨午夜边界陈旧）。
- 返回**不排序**（保持入参顺序）或按状态序排，实现时定一个并写进测试。

## 3. 动作映射（复用现有 handler）

`TaskBoard` 已有这些能力，聚合条直接调用，**不加新 API**：

| action | 调用的 handler | 前提 |
|---|---|---|
| `retry` | `runTask(task)` | `sub_status === 'failed'` |
| `start` | `runTask(task)` | 纯逾期且 `status === 'todo'` |
| `accept` | `updateStatus(task, 'done')` | `pending_acceptance` |
| `openSession` | `task.session_id && navigate(\`/session/${id}\`)` | 等待类信号（`waiting_*` / `needs_review` / `blocked` / `only_plan`），或纯逾期且 `status !== 'todo'`，且 `canOpenSession(task)` |
| `openTask` | `navigate(\`/task/${id}\`)` | 兜底：`openSession` 前提不成立时 |

按钮文案：`retry` → `↻ 重试`；`start` → `▶ 开始执行`；`accept` → `✓ 标记完成`；`openSession` → `打开会话`；`openTask` → `查看`。

「拒绝 / 暂停」等次要动作**不做**（YAGNI：审批本身在会话内完成，聚合条只负责「带你去处理」）。

### 3.1 主操作旁边并排的「打开会话」（2026-09-17 追加）

主操作用于「处理」，但处理前往往要先看现场（失败原因、审批上下文）。所以**每条**在主操作右侧固定补一个次级「打开会话」按钮：

- 显示条件：`hasOpenableSession(task)`（有 `session_id` 且未被清理），**与任务状态无关**——`todo` / `done` 也能点进去看历史。
- 主操作本身就是 `openSession` 时不再重复渲染（否则一行两个「打开会话」）。
- 会话已被清理时不显示，主操作仍是原有的 `openTask`（查看）。
- 于是「失败」行自然变成 **`↻ 重试` + `打开会话`** 两个按钮；没有会话时维持单按钮。

`hasOpenableSession` 放在 `taskActions.ts`，`canOpenSession`（看板卡片 / 表格行用的严格版）改为在它之上加状态判据，两处判据不会漂移。

## 4. UI 形态

顶部段，位于 `TaskBoard` 的筛选栏之后、看板/表格视图之前（对 `filteredTasks` 生效，与下方视图一致）。

- **容器**：圆角卡片 `bg-card` + `1px border`，标题「需要你处理」+ 计数 pill，右侧一句话副标（如 `等你批准 · 执行失败 · …`，可省）。
- **每条**：左侧信号徽标（复用 `SubStatusBadge` 的配色族 / 逾期用红色「已逾期」），中间标题 + id + 项目（含远端 / 助手徽标），右侧动作按钮。
- **配色族**（沿用 `shared.css` / 现网同法，色值来自 `SUB_STATUS_META`）：
  - `wait`（amber）：`waiting_approval` / `waiting_answer` / `waiting_plan` / `needs_review`
  - `fail`（red）：`failed` / `blocked`
  - `accept`（violet）：`pending_acceptance`
  - `plan`（blue）：`only_plan`
  - `late`（red 弱化）：纯逾期
- **空态**：`attentionItems(...)` 返回空数组时**整段不渲染**（`return null`），不占位。
- **移动端**：同一组件；容器在窄屏下横向可滚动或纵向堆叠（实现时选一个并写测试）。

## 5. 接入点

`web/src/components/tasks/TaskBoard.tsx`（`effectiveView !== 'scheduled'` 分支内）：

```
<TaskFilterBar …/>
{filterStillHidesNewTask && …}
{selected.size > 0 && …}
<TaskInboxPanel tasks={filteredTasks} now={now}
   onRetry={runTask} onStart={runTask} onAccept={(t) => updateStatus(t, 'done')}
   onOpenSession={(t) => t.session_id && navigate(`/session/${t.session_id}`)}
   onOpenTask={(t) => navigate(`/task/${t.task_id}`)} />
{effectiveView === 'table' ? <TaskTableView/> : <看板/>}
```

`runTask` 已按 `sub_status === 'failed' && session_id` 走就地重试，直接复用。

## 6. 模块划分

| 模块 | 职责 |
|---|---|
| `taskInbox.ts` | `attentionItems` 纯函数 + 类型 |
| `TaskInboxPanel.tsx` | 聚合段渲染（拿到 `AttentionItem[]` 后渲染行与按钮） |
| `TaskBoard.tsx` | 接入 + 传 handler |

## 7. 错误处理

本段是**纯前端派生 + 复用现有 handler**，无新增失败路径。handler 失败按现有行为（`runTask` / `updateStatus` 各自 `console.error` + 刷新兜底）。`attentionItems` 对 `deadline` 非法 / `sub_status` 未知值要**防御**（未知 sub_status 不命中信号；非法 deadline 不算逾期），不得抛错。

## 8. 测试清单

### 8.1 `taskInbox.test.ts`

- 命中：`waiting_approval` / `waiting_answer` / `waiting_plan` / `pending_acceptance` / `needs_review` / `failed` / `blocked` / `only_plan` 各产生一条，`action` 正确（`only_plan` 的 action 是 `openSession`）。
- 命中：`done` / `running` **不**产生。
- 逾期：`deadline` 早于今天且 `status` 为 `todo` / `in_progress` / `in_review` → 命中 `late`，`label` = `已逾期 N 天`。
- 逾期：`status` 为 `done` / `archived` → **不**命中。
- 逾期：`deadline` 是今天 → **不**逾期（`days === 0`）。
- 逾期：`deadline` 非法格式 → 不命中、不抛错。
- 优先级：`failed` + 已逾期 → 只按 `failed` 计一条，不重复。
- 空数组 → 返回空。

### 8.2 `TaskInboxPanel.test.tsx`

- 有项 → 渲染标题 + 每条的标题、信号徽标、动作按钮。
- 空 → 不渲染（无「需要你处理」标题）。
- 动作按钮点击触发对应 handler（`onRetry` / `onStart` / `onAccept` / `onOpenSession` / `onOpenTask`）。
- 无 `session_id` 或 `canOpenSession === false` 的信号 → 落到 `openTask`（查看）而不是 `openSession`。

### 8.3 手工验收

1. 造一条 `waiting_approval` + 一条 `failed` + 一条逾期任务 → 顶部段各显示一条，按钮分别是「打开会话 / 重试 / 开始执行(或查看)」。
2. 全部处理完（改状态 / 重跑 / 归档）→ 聚合段自动消失。
3. 手机 &lt;640px → 看板顶部同样出现该段。
4. 筛选项目后 → 聚合段只反映当前筛选内的需处理项。
