# 删除定时任务连带清理它跑出来的任务与会话 设计

日期：2026-09-22
状态：已实现
起因：用户报障「删除定时任务时并未删除原始 session」

> 本设计**修订** `docs/superpowers/specs/2026-08-13-scheduled-tasks-design.md` §「DELETE /api/scheduled-tasks/:id 删模板（**不动已生成的任务**）」。那条约定不再成立，理由见 §1。

## 0. 症状与根因

**症状**：删掉一个定时任务后，它历次跑出来的任务仍留在「运行记录」里，这些任务关联的**会话**也仍留在会话列表里（对话记录还在，可以继续打开）。

**根因**（代码层面确定，不是推测）：删除路径只有一步，没有任何级联。

```
ScheduledTasksPanel.remove()
  → DELETE /api/scheduled-tasks/:id        (scheduler.routes.ts:50)
  → scheduler.service.remove()             (scheduler.service.ts:405)
      deps.scheduledTasksDb.deleteScheduledTask(scheduleId)   // 只删 scheduled_tasks 这一行
      broadcast({ kind: 'scheduled_task_deleted' })
```

`tasks` 表里 `source_schedule_id = <该调度>` 的行、以及它们的 `sessions` 行，一条都不动。

**对照：删「任务」是会连带删会话的** —— `tasks.service.deleteTask` 会硬删关联会话（`deleteSessionHard`，DB 行 + 转录文件）并打 `WARNING: deleting a task and hard-deleting its linked session`。于是同一件事有两条语义不一致的路径：从运行记录里逐条删会清会话，删调度本身不会。用户报的正是后者。

**现场佐证**（只读查 `~/.lovdex/data/new-auth.db` + 后端 journal）：库里的调度 `同步付款审批并通知`（interval 30min）`last_task_id` 指向的任务行已不存在；journal 显示 10:03:36–37 有 33 条任务被逐条删除（正是运行记录那套「逐条调单个接口」的路径）。也就是说，删调度这一步什么都没清，用户只能事后自己去运行记录里一条条补删。

## 1. 决策：为什么推翻「不动已生成的任务」

那条约定的出发点是「派发后任务自包含，之后改/删定时任务不影响已在跑的那一次」（见 `scheduler.service.dispatch` 的注释）。**这个出发点仍然成立** —— 它说的是「不影响已经发生的那一轮」，而不是「留下无法清理的孤儿」。

实际情况是：调度被删后，它跑出来的行既不属于任何调度、又带着会话散落在会话列表里，用户没有任何一处能成批清掉它们（只能在运行记录里逐条删）。**模板与它跑出来的运行是同一个用户意图的两半**，删一半留一半不是「自包含」，是泄漏。

## 2. 选定语义

| 情况 | 行为 |
|---|---|
| 删除调度 | 硬删该调度跑出来的**全部**任务行 + 它们的**关联会话**（DB 行 + 转录文件，不可恢复） |
| 其中任一轮还在跑（任务 `in_progress`，或会话仍在流式输出） | **整个删除被拒**：409 `SESSION_RUNNING`，一条都不删，模板也留着 |
| 该调度从未跑过 | 正常删除模板，无级联 |
| 别的调度跑出来的任务 / 手工任务 | 一条都不碰 |
| 调度不存在 | 与改动前一致：幂等返回成功（级联查不到运行，删行是空操作） |

**为什么「整批拒绝」而不是「跳过在跑的那一轮」**：边删边判会让用户拿到 409 时已经有几条运行记录消失了，而模板还在 —— 看起来像「删了一半」，且没有任何地方能告诉他少了哪几条。判据与 `deleteTask` 单条路径**完全一致**（同一个 `isUndeletable`），不引入第二套「什么算在跑」的定义。

**为什么不是「先停掉再删」**：那会掐掉正在写的 agent，破坏性更大且用户没有明确要求。

## 3. 改动

**后端（4 个源文件 + 3 个测试文件）**

| 文件 | 改动 |
|---|---|
| `database/repositories/tasks.db.ts` | `listTasks` 增加 `sourceScheduleId` 过滤（走 `idx_tasks_source_schedule`，过滤落在 SQL 而不是取全表再筛） |
| `tasks/services/tasks.service.ts` | 抽出模块级 `isUndeletable(row, isSessionRunning)`（单条删除与级联共用同一判据，避免两处漂移）；`deleteTask` 的实现提为本地函数 `hardDeleteTask`；新增 `deleteTasksBySchedule(scheduleId)`：**先整批判、再动手**，逐条走 `hardDeleteTask`（会话硬删、WARNING 日志、逐条 `task_deleted` 广播都长在那条路径上） |
| `scheduler/services/scheduler.service.ts` | `remove` 改为 async：先 `deleteTasksBySchedule`，再删模板行、广播 `scheduled_task_deleted`，返回 `{ deletedTaskIds }` |
| `scheduler/scheduler.routes.ts` | `DELETE` 改为 await，响应体加 `deletedTaskIds` |
| `operators/operator.tools.ts` | `delete_scheduled_task` 改为 `await`（级联被拒时 remove 会 reject，不接住就是 unhandledRejection，而助手拿到的却是假的 success）；工具描述同步改成「模板与已生成的任务/会话一起删」 |

**顺序**：先清运行、再删模板行。反过来的话，级联被拒（409）时模板已经没了，用户拿着 409 却没有重试入口。

**前端（3 个源文件 + 1 个新纯逻辑模块）**

| 文件 | 改动 |
|---|---|
| `components/tasks/scheduleDelete.ts`（新） | 三个纯函数：确认文案 / 409 等失败文案 / 解析响应里的 `deletedTaskIds`。与 `runHistoryDelete.ts` 同一套分工（视图里加普通导出会触发 react-refresh 规则，且 web 测试无 DOM） |
| `ScheduledTasksPanel.tsx` | `remove()` 重写：确认文案写明会连会话一起删；失败如实报出来（改动前把响应整个丢掉，失败是静默的）；成功把 `deletedTaskIds` 交给 `onRunsDeleted` 做本地摘行（WS 不可靠的兜底，与运行记录删除同一套） |
| `ScheduledTasksView.tsx` | 提示条 prop 从 `runNowError`/`onDismissRunNowError` 泛化为 `actionError`/`onDismissActionError` —— 删除也会撞 409，文案要走同一个渲染口，沿用「立即触发专用」的名字就是撒谎 |

**确认文案**（本次唯一的「会话会被毁掉」告知点）：

```
删除定时任务「X」？它跑出的 N 条任务及关联会话也会一并删除，此操作不可恢复。
删除定时任务「X」？它跑出的任务及关联会话也会一并删除，此操作不可恢复。   // 页面列表里数到 0 条时
```

条数取自页面上那份任务列表（**尽力而为**：WS 掉线时会比后端旧一拍），所以 0 条时退回不带数字的通用承诺，而不是断言「没有运行记录」——陈旧列表不该让弹窗对用户撒谎。

## 4. 明确不做的

- **不删「已删除的调度」这个回退分支**。`ScheduledRunHistoryView.scheduleTitleOf` 的「已删除的调度」在本改动后接近不可达（运行会随调度一起消失），但仍是合法展示兜底：本次上线前就已存在的历史行、以及将来的数据修复场景都还要它。删掉它只会让某一行显示成空白。
- **不动 `deleteTasks`（批量接口）的既有问题**：它仍然既不守卫运行中、也不清关联会话。那是任务页批量删除的坑，与本次无关（运行记录的批量删除本来就是逐条调单个接口绕开它）。
- **不做撤销 / 软删除**。硬删，靠确认弹窗把关。
- **不给助手工具加「只删模板」的开关**。助手走同一条语义 —— 两套行为比一套更容易出错。

## 5. 测试与验收

**新增/扩展的测试（全绿）**

| 文件 | 覆盖 |
|---|---|
| `tasks.service.test.ts` | 级联删全部运行 + 各自的会话、别的调度与手工任务不动、逐条 `task_deleted` 广播；从未跑过 = 空操作；任一轮 in_progress → 409 且**一条都不删**；任务已 settle 但会话仍在流式输出 → 同样拒绝 |
| `scheduler.service.test.ts` | `remove` 的编排：先级联、再删模板行、广播 `scheduled_task_deleted`、返回 `deletedTaskIds`；被拒时**模板原样留着**且不广播；不存在的 id 幂等 |
| `scheduler.routes.test.ts` | `DELETE` 返回 `deletedTaskIds`；409 带 `SESSION_RUNNING` code |
| `tasks.db.integration.test.ts` | **真 SQLite**：`sourceScheduleId` 过滤只回本调度的行、与 status 叠加是 AND、不传过滤仍是全量 |
| `scheduler.delete-cascade.integration.test.ts`（新） | **真 SQLite + 真 tasksService + 真 scheduler service**：删调度后直接查库确认三条运行行消失、干扰项还在；被拒时真库里一条不少、模板还在 |
| `scheduleDelete.test.ts`（新） | 确认文案两个分支（含钉住旧承诺「已生成的任务不会被删除」不许回来）、409 与其它失败的文案、`deletedTaskIds` 解析的各种畸形输入 |
| `ScheduledTasksView.test.tsx` | 提示条渲染 + 可关闭；**同一条提示条也承载删除失败的文案**（证明它不是「立即触发专用」） |

**自动化检查**

| 检查 | 结果 |
|---|---|
| 后端 `npm run typecheck` | 14 个错误 —— 与改动前基线**逐项相同，零新增** |
| 后端全量测试 | **1370 pass / 0 fail** |
| web `npm run typecheck` | **0 错误** |
| web eslint（改动文件） | 4 warnings —— 与改动前基线**逐项相同，零新增** |
| web 全量测试 | **689 pass / 0 fail** |

**未做、以及为什么（如实记录）**

- **没有跑浏览器 E2E / 对真实库的破坏性验证**：验证新删除语义必须让后端跑**新代码**，而后端进程当前跑的是改动前的版本；重启后端需要用户逐次明确许可（本仓库的既定约束），本次未取得，故未重启、未跑。
- 因此「HTTP 全链路 + 真实会话级联」这一环由**集成测试**代偿：`scheduler.delete-cascade.integration.test.ts` 用的是真 SQLite + 真 service，只有 `deleteSessionHard` 是替身（会话硬删是 `deleteTask` 的既有行为，本次未改动，单测已钉住「按正确的 session_id 调用它」）。**「会话行真的从库里消失」在集成层面没有被直接断言过** —— 需要重启后端后补一次真机验证。
- 前端 `remove()` 的接线（调接口 → 解析 id → 交 `onRunsDeleted`）没有自动化测试：web 测试环境无 DOM、不触发事件，而该函数是组件内的事件处理器。它的三个纯逻辑部分（文案 ×2、解析）都有单测。
