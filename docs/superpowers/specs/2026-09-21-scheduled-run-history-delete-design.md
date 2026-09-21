# 运行记录支持逐条删除与批量删除 设计

日期：2026-09-21
状态：已确认，待写实现计划

## 0. 背景与目标

上一版设计（`2026-09-21-scheduled-run-history-design.md`）在 §5 明确把「多选 / 批量删除」列为不做，运行记录是**只读查看 + 跳转**。现在用户要求补上：运行记录要能**逐条删除**和**勾选批量删除**。

> 本设计**修订**上一版 spec §5 中「不做排序 / 多选 / 批量删除」一条：多选与删除本次做，「不做排序」仍然有效。

## 1. 关键调研：两条删除路径的语义不一样

这是本次设计的核心约束，不是实现细节 —— 它决定了「批量删除」**不能**复用现成的批量接口。

| 路径 | 后端 | 运行中守卫 | 关联会话 |
|---|---|---|---|
| 单个 | `DELETE /api/tasks/:taskId` → `tasks.service.ts:604` `deleteTask` | ✅ `status === 'in_progress'` **或** 会话仍在流式输出 → 抛 `SESSION_RUNNING` / **409** | ✅ 硬删（`deleteSessionHard`） |
| 批量 | `POST /api/tasks/batch-delete` → `tasks.service.ts:635` `deleteTasks` | ❌ **完全没有** | ❌ **不删 → 留下孤儿会话** |

`deleteTasks` 只是一个 `for` 循环里调 `resolveDb.deleteTask`，既不看状态也不清会话。而 `deleteTask` 会打一条 `WARNING: deleting a task and hard-deleting its linked session` 日志 —— 说明「删任务连带删会话」才是设计意图，批量路径没跟上。

**这条不对称在现有代码里已经生效**：`TaskBoard.tsx:130` 的批量删除走 `removeMany`（不安全路径），`TaskDetail.tsx:368` 的单条删除走 `remove`（安全路径）。运行记录这 6 条里有 1 条正是 `in_progress`，不是理论风险。

**本设计的处置：不改后端。** 批量删除在前端**循环调用单个删除接口**（用户选定方案），于是每条都拿到 `deleteTask` 的完整语义 —— 运行中被拒、成功的连带清会话。代价是 N 次往返（运行记录规模在几十条量级，可接受）。

批量接口那个孤儿会话的坑**本次不修**，仅在此记录备查（见 §7）。

## 2. 交互语义

- **可删除性**：`status === 'in_progress'` 的运行**不可删除**。这些行：
  - 不渲染勾选框（桌面表格的单元格与移动卡片上的勾选框都不渲染）
  - 「删除」按钮渲染但 `disabled`，`title` 说明原因（「运行中，先停止再删除」）
  - 表头「全选」只选中**可选**的那些行
- **仍可能撞 409**：前端只能看到 `status`，看不到「会话是否还在跑」（`isSessionRunning` 是后端运行时的判断）。所以即便做了上面的前置过滤，删除仍可能被拒 —— 必须把失败如实报出来，不能静默吞掉。
- **连带删会话**：单条删除会硬删关联会话（对话记录不可恢复）。确认弹窗**必须写明**这一点。
- **确认**：单条与批量都走 `window.confirm`（对齐本模块既有约定：`TaskDetail.tsx:366` 单条、`TaskBoard.tsx:115` 批量）。
  - 单条：`确定删除该运行记录？其关联会话也会一并删除，此操作不可恢复。`
  - 批量：`确定删除选中的 N 条运行记录？其关联会话也会一并删除，此操作不可恢复。`
- **结果反馈**：删除完成后在列表上方显示一条内联结果条（**不引入 Toast** —— 本模块既有约定是 `console.error` + 内联提示条，见 `TaskBoard.tsx` 的「已选 N 项」与「任务已创建但被筛选隐藏」两条）。结果条可手动关闭；下一次发起删除时被替换。文案规则见 §3.1 的完整真值表（`deleteOutcomeMessage`）。

## 3. 组件改动

### 3.1 新模块 `runHistoryDelete.ts` —— 类型 + 纯函数

**为什么单独成模块，而不是塞进 `ScheduledRunHistoryView.tsx`：**

1. **依赖方向**：`DeleteOutcome` 同时被视图（prop 类型）、纯函数（`deleteOutcomeMessage` 入参）和面板（`deleteRuns` 返回值）需要，而面板已经 import 视图 —— 定义在面板里会让视图反过来 import 面板，**形成循环依赖**。独立模块两边都指向它，方向干净。
2. **lint**：`ScheduledRunHistoryView.tsx` 现在带 3 条 `react-refresh/only-export-components`（该规则对「组件文件里同时导出普通函数」报警）。再往它里面加 3 个导出函数会变成 6 条。纯逻辑放无组件的 `.ts` 模块不触发这条规则。
3. **仓库惯例**：纯逻辑本来就放同级 `.ts` 模块（`taskTable.ts` / `taskFilter.ts` / `taskStatus.ts` / `projectLabel.ts` / `taskDeadline.ts`）。

新文件 `web/src/components/tasks/runHistoryDelete.ts`（web 测试是 `node:test` + `renderToStaticMarkup`，**无 DOM、不跑 effect、不触发事件**，所以逻辑必须离开组件才能测）：

```ts
export type DeleteOutcome = {
  deleted: string[];
  failed: { taskId: string; reason: string; running: boolean }[];
};

/** 可删除的运行：运行中的删不掉（后端 409），从源头不给勾。 */
export function selectableRuns(runs: Task[]): Task[];

/** 表头全选：只作用于可选行；全部已选则清空。 */
export function toggleSelectAll(prev: Set<string>, selectableIds: string[]): Set<string>;

/** 结果条文案。null 表示没有结果条要显示。 */
export function deleteOutcomeMessage(outcome: DeleteOutcome): string | null;
```

`running` 单独标记「因运行中被拒」，好让结果文案说人话。

`deleteOutcomeMessage` 拼装规则：按「已删除」「因运行中失败」「其它失败」三段各自计数，**非零的段按此顺序用 `，` 连接**；唯一例外是「一条都没删掉、且失败全部因运行中」时，补一句可操作的原因。

完整真值表（实现与测试都以此为准）：

| `deleted` | `failed` | 返回 |
|---|---|---|
| 空 | 空 | `null`（没发生过删除，不显示结果条） |
| N | 空 | `已删除 N 条` |
| N | M 条全为 `running` | `已删除 N 条，M 条因运行中未能删除` |
| 空 | M 条全为 `running` | `M 条未能删除：运行中的运行需先停止`（唯一带提示的例外） |
| N | X 条 `running` + Y 条其它（X,Y>0） | `已删除 N 条，X 条因运行中未能删除，Y 条删除失败` |
| N | 空 running + M 条其它 | `已删除 N 条，M 条删除失败` |
| 空 | X 条 `running` + Y 条其它（X,Y>0） | `X 条因运行中未能删除，Y 条删除失败` |
| 空 | 0 条 running + M 条其它 | `M 条删除失败` |

即：**先按「运行中」与「其它失败」两类分别计数**，两类都非零时两条信息都要出现（`running` 是用户能自己去处理的，值得单说；其它失败用泛化文案兜底）。

### 3.2 `ScheduledRunHistoryView.tsx` —— 加选择与删除 UI

新增 prop：

```ts
onDelete: (taskIds: string[]) => Promise<DeleteOutcome>;
```

**选择状态留在组件内部**（`useState<Set<string>>`）。理由：只有这一个视图消费它，不存在 `TaskBoard` 那种「看板/表格两个视图共享同一份选中集」的需求 —— `TaskBoard` 把 `selected` 上提正是为了跨视图共享（`TaskBoard.tsx:76-77` 注释）。上提反而会让 `ScheduledTasksPanel` 多背一份与它无关的状态。

UI（全部对齐 `TaskTableView` 的既有实现）：

| 位置 | 改动 | 参照 |
|---|---|---|
| 桌面表头 | 新增勾选列（`aria-label="全选"`，`h-4 w-4 accent-primary`）；**没有可选行时 `disabled`** | `TaskTableView.tsx:200-212` |
| 桌面行 | 新增勾选单元格；该单元格 `onClick` 要 `stopPropagation`（行本身可能有跳转） | `TaskTableView.tsx:320-329` |
| 移动卡片 | 卡片顶部放勾选框 | 无直接参照，样式同上 |
| 每行操作区 | 「删除」按钮排在「打开任务 / 打开会话」之后，`text-destructive`；运行中的行 `disabled` + `title="运行中，先停止再删除"` | `ScheduledTasksView.tsx:72` 的删除按钮配色 |
| 选中 > 0 | 列表上方出现操作条：「已选 N 项 / 取消选择 / 删除」 | `TaskBoard.tsx:440-459` |

**列表上方的两条横条的叠放顺序**（都出现在同一个位置，必须定死）：**结果条在上、操作条在下**。结果条描述「上一次删除发生了什么」，操作条描述「当前选中了什么」；把结果条放最上面更贴近「刚刚发生」的阅读顺序，也与 `TaskBoard.tsx` 里提示条（`filterStillHidesNewTask`）排在批量操作条之前的既有顺序一致。

**选中集的清理**：运行被删或被别的会话删掉后，`runs` 里不再有那些 id，选中集要跟着剪掉，避免「幽灵勾选」（对齐 `TaskBoard.tsx:99-110` 的做法）。

### 3.3 `ScheduledTasksPanel.tsx` —— 实现删除

```ts
async function deleteRuns(taskIds: string[]): Promise<DeleteOutcome>
```

循环 `api.tasks.remove(id)`（`web/src/utils/api.js:360`），逐条收集到 §3.1 定义的 `DeleteOutcome`：

- 成功（`res.ok`）→ 计入 `deleted`
- 失败 → 读 `err?.error?.message` 作 `reason`；读不到就用 `res.status` 兜底。**409 单独识别**（`err?.error?.code === 'SESSION_RUNNING'`）置 `running: true`，好让结果文案说人话。
- 无论成败，`console.error` 记失败项（对齐本模块的错误处理约定）。
- 结束后把 `deleted` 通过新 prop `onRunsDeleted(ids)` 往上抛。

新增 prop：`onRunsDeleted: (taskIds: string[]) => void`。

### 3.4 `TaskBoard.tsx` —— 本地列表兜底清理

```tsx
<ScheduledTasksPanel ... onRunsDeleted={(ids) => ids.forEach(remove)} />
```

`remove` 来自 `useTasks`（`web/src/hooks/useTasks.ts:67`），与 `TaskBoard` 自己 `deleteSelected` 的兜底写法一致（`TaskBoard.tsx:125`）。

**这条不能省。** 正常路径下 `task_deleted` WS 事件会自己把行从 `useTasks` 里摘掉，但 E2E 里实测到控制台每次都报 `WebSocket error: [object Event]`（已在未改动路由 `/` 上复现，与本次功能无关）—— 只靠 WS 刷新不可靠，必须有本地兜底。

## 4. 边界情况

| 情况 | 行为 |
|---|---|
| 选中项里混了运行中的 | 前端根本不会选中它们（勾选框不渲染、全选跳过） |
| 删除时后端返回 409（会话仍在跑但 status 不是 in_progress） | 计入 `failed`，结果条报「因运行中未能删除」 |
| 全部失败 | 结果条报错，**保留选中集**让用户能直接重试 |
| 部分成功 | 成功的行消失，失败的行仍在列表里（选中集按 §3.2 剪掉已删的） |
| 删除过程中用户切到「调度」子标签 | 请求照常完成；结果条状态随组件卸载丢弃（可接受，不额外持久化） |
| 运行记录为空 | 保持现有空态「暂无运行记录」，不渲染操作条 |
| 只有运行中的运行 | 表头全选框 `disabled`（没有可选项） |

## 5. 明确不做的

- **不改后端**。`deleteTasks`（批量接口）不守卫运行中、不清关联会话这两个问题本次不修 —— 修它要动 `tasks.service.ts` 与任务页的调用点，是独立的一件工作。**只在 §7 记录。**
- **不引入 Toast**。本模块既有约定是 `console.error` + 内联提示条。
- **不做撤销 / 软删除**。删除是不可恢复的硬删，靠确认弹窗把关。
- **不做排序**（上一版 spec 的这条仍然有效）。
- **不把选中状态持久化**（不像 `taskViewMode` / `scheduledViewTab` 那样进 localStorage）—— 选中是一次性操作意图，刷新后不该还在。
- **不给「打开任务/打开会话」之外的操作做权限区分** —— 运行记录里的删除与任务页的删除是同一件事，没有额外权限模型。

## 6. 测试与验收

**新增 `web/src/components/tasks/runHistoryDelete.test.ts`**（纯函数跟模块走，与 `projectLabel.test.ts` 同惯例）：
- `selectableRuns`：滤掉 `in_progress`；其余状态（todo / in_review / done / archived）都保留；空数组 → 空数组。
- `toggleSelectAll`：未全选 → 全选；已全选 → 清空；只传可选 id 时不会把不可选的塞进去；`selectableIds` 为空 → 返回空集。
- `deleteOutcomeMessage`：§3.1 真值表的**八条分支逐条断言**（含 `deleted`/`failed` 都为空 → `null`，以及 `running` 与普通失败混合的那两条）。

**静态标记测试**（扩展 `ScheduledRunHistoryView.test.tsx`）：
- 含 `in_progress` 行的列表里，`aria-label="选择任务"` 的 checkbox 数量 = 可选行数（即不包含运行中那行）。
- `in_progress` 行的「删除」按钮带 `disabled`。
- 空列表仍渲染「暂无运行记录」。

**回归护栏**：`ScheduledRunHistoryView.test.tsx` 现有 12 条、`ScheduledTabBar` 4 条、`ScheduledTasksView` 7 条必须保持全绿。注意：加勾选列会改变桌面表格的**列序**，现有断言若依赖列位置需同步更新（当前断言只匹配列头文案，预计不受影响 —— 跑一遍确认）。

**验收**：`npm run typecheck` 与 eslint 对本次改动文件**零新增**（仓库 baseline 本就不干净，先记数字）。web 测试显式跑文件（仓库无 `npm test` 脚本）。

**手工 E2E**（puppeteer-core + 缓存 chromium 连 `:5188`，断言走 DOM / computed style，不靠截图）：
1. 运行记录列表里，`in_progress` 那行**没有**勾选框，「删除」按钮是 `disabled`。
2. 勾选 1 条已完成的 → 点「删除」→ 确认弹窗文案含「关联会话也会一并删除」→ 确认后该行消失、结果条显示「已删除 1 条」。
3. 勾选 2 条 → 批量删除 → 两行都消失、结果条「已删除 2 条」。
4. 删除后**刷新页面**，被删的运行确实不在了（验证不是只从 DOM 移除）。
5. 验证连带删会话：删除前后直接查库 `sessions` 表（`~/.lovdex/data/new-auth.db`，只读连接 `file:...?mode=ro`）确认该 `session_id` 行已消失 —— 前端没有「按 id 查单个会话」的接口，查库是唯一直接的证据。**这是本次唯一能证明「语义正确」而非「看起来对」的检查**，不能省。
6. 全选 → 只选中可选行；若列表里只有运行中的运行，全选框 `disabled`。
7. 窄屏（<1024px）卡片上也有勾选框，且能完成批量删除。

## 7. 记录备查：批量接口的孤儿会话问题（本次不修）

`POST /api/tasks/batch-delete` → `tasks.service.ts:635` `deleteTasks`：

- **不守卫运行中**：可以直接删掉一个正在跑的任务行，其会话继续流式输出，成为无主会话。
- **不清关联会话**：删完任务行，会话还留在会话列表里（`deleteTask` 会 `deleteSessionHard`，`deleteTasks` 不会）。

现有调用点 `TaskBoard.tsx:130`（任务页的批量删除）已经在吃这两个问题。修法是把 `deleteTasks` 改成逐条委托 `deleteTask` 的语义并返回逐条结果，但那是独立的一件工作（要动后端 + 任务页调用点 + 后端测试），不在本次范围。**本次的批量删除走前端循环调单个接口，因此不受此问题影响。**
