# 看板/表格不再显示定时任务跑出来的任务 设计

日期：2026-09-22
状态：已确认，待写实现计划

## 0. 背景与目标

定时任务跑出来的任务（`tasks.source_schedule_id` 非空）现在和手动建的任务混在任务页的看板/表格里，只在卡片上有个「⏰ 定时」小徽标。上一版设计（`2026-09-21-scheduled-run-history-design.md` §5）**明确把「看板/表格排除定时来源任务」列为不做**，当时的结论是「新页面是按来源查看的入口，不改既有视图语义」。现在用户改主意了：**这些任务不要出现在看板/表格里**。

同时用户明确：**收件箱（页面顶部「需要你处理」）要保留它们，并加「⏰ 定时」标记**。理由成立 —— 无人值守的任务失败/卡在等批准，正是最需要被提醒的，全静默反而危险。

> 本设计**修订**上一版 spec §5 中「看板/表格保持原样，仍显示全部任务」一条。其余（运行记录不套用筛选栏、不做排序等）仍然有效。

## 1. 数据流：只换两个消费者

```
useTasks({}) → tasks（全量，含 archived）
   ├─→ ScheduledTasksPanel（运行记录）           ← 不变，仍需要全量
   └─→ filterTasks(tasks, filter, now) → filteredTasks
            ├─→ TaskInboxPanel（收件箱）          ← 仍收全量，只加标记
            └─→ manualTasksOf(...) → boardTasks
                     ├─→ groups（看板列 + 列计数）
                     └─→ TaskTableView（表格 + 状态 pill 计数）
```

关键点：**只把「看板」和「表格」这两个消费者换成排除了定时来源的那一份**。收件箱与运行记录保持现状。

`filteredTasks` 只算一次（`filterTasks` 是 O(n) 的纯函数，不必为两份列表各跑一遍），`boardTasks` 从它派生一次减法。

## 2. 改动点

### 2.1 `taskFilter.ts` —— 新增 `manualTasksOf`

```ts
/**
 * 手动建的任务（看板/表格只显示这些）。与 `ScheduledRunHistoryView.tsx` 的 `runsOf`
 * **互为补集** —— 定时任务跑出来的任务只去「定时 → 运行记录」里看。
 * 两个谓词必须同步改：这里是 `!source_schedule_id`，那边是 `source_schedule_id`。
 */
export function manualTasksOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.source_schedule_id);
}
```

放在 `taskFilter.ts` 而不是 `ScheduledRunHistoryView.tsx`：这个模块本来就是「任务列表怎么筛」的归属地（`filterTasks` / `isTaskFilterActive` 都在这），而视图文件是运行记录自己的事。

### 2.2 `TaskBoard.tsx` —— 看板/表格改用 `boardTasks`

在 `filteredTasks` 那个 `useMemo` 之后加：

```tsx
  // 看板/表格只显示手动建的任务 —— 定时任务跑出来的去「定时 → 运行记录」里看。
  // 收件箱仍收全量的 filteredTasks（无人值守的任务出问题最需要被提醒）。
  const boardTasks = useMemo(() => manualTasksOf(filteredTasks), [filteredTasks]);
```

然后把两处消费点换掉：

| 位置 | 原来 | 改成 |
|---|---|---|
| `groups` 的 `useMemo` | `groupByStatus(filteredTasks)` | `groupByStatus(boardTasks)` |
| `<TaskTableView tasks={...}>` | `filteredTasks` | `boardTasks` |

**不动**：`<TaskInboxPanel tasks={filteredTasks} …>`、`<ScheduledTasksPanel … tasks={tasks} …>`、批量删除的选中集剪枝（它按全量 `tasks` 剪，定时来源的 id 本来就选不上，无害）。

### 2.3 `TaskInboxPanel.tsx` —— 加「⏰ 定时」标记

在项目名那一段（`<span className="max-w-40 truncate">{info.label}</span>` 之后、远程主机标记之前）加：

```tsx
{item.task.source_schedule_id && (
  <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-3xs font-semibold text-warning">
    ⏰ 定时
  </span>
)}
```

- 视觉对齐 `TaskCard.tsx:85-89` / `TaskDetail.tsx:497` 的同款徽标（`bg-warning/10 … text-warning`），尺寸用 `text-3xs` 与紧邻的远程主机标记（`rounded-full bg-muted px-1.5 py-0.5 text-3xs …`）一致。
- 位置与远程主机标记并列：两者都是「这条任务是什么来路」的补充信息。

## 3. 边界与连带影响

| 情况 | 行为 |
|---|---|
| 看板列计数、表格状态 pill 计数 | **自动排除** —— 两者都从传进去的 tasks 派生，不需要额外处理 |
| 收件箱里的定时来源条目 | 保留，带「⏰ 定时」标记；筛选栏仍照常作用于它（现状不变） |
| 从收件箱点进定时来源任务的详情 | 正常（`TaskDetail` 本来就有「⏰ 定时」徽标，且它跳运行记录） |
| 新建任务后被筛选藏住的提示条（`isHiddenByFilters`） | 不受影响 —— 手动建的任务永远不是定时来源 |
| 批量删除的选中集剪枝 | 不受影响 —— 它按全量 `tasks` 剪，定时来源的行根本渲染不出来、选不上 |
| 看板/表格里一个定时来源任务都没有时 | 不需要空态文案（看板本来就有「暂无任务」的列内空态） |

## 4. 明确不做的

- **不加「显示/隐藏定时任务」开关**。用户要的是「不出现」，加开关是 YAGNI；真需要时再说。
- **不改后端**。`GET /api/tasks` 仍返回全量（`tasks.routes.ts` 的 `listTasks` 只支持 `projectPath` / `status` 两个过滤参数），过滤在前端做 —— 因为**运行记录需要全量**，后端若默认排除掉，运行记录就拿不到数据了。
- **不动侧边栏**。侧边栏没有任务列表（`Sidebar.tsx` 里的 `useTasksSettingsStub` 只是个 settings 桩），本就不受影响。
- **不动运行记录**。它本来就只显示定时来源的任务，与本次改动方向一致。
- **不清理 `TaskCard.tsx:85-89` 的「⏰ 定时」徽标**。看板是 `TaskCard` 的唯一消费者，改完之后这个徽标在看板里变得不可达。但 `TaskCard` 是通用展示组件（接收任意 `Task`），删掉徽标会让它对传入的定时来源任务「撒谎」；`TaskDetail` 的同款徽标也仍然可达（从运行记录点进详情）。保留。

## 5. 测试与验收

web 测试是 `node:test` + `renderToStaticMarkup`，**无 DOM、不跑 effect、不触发事件**，所以断言落在纯函数与静态标记上。

**改 `web/src/components/tasks/taskFilter.test.ts`** —— 新增 `manualTasksOf` 的用例：
- 滤掉 `source_schedule_id` 非空的任务；
- 保留手动任务（`source_schedule_id` 为 `null`）；
- 空数组 → 空数组；
- **与 `runsOf` 互为补集**：对同一个混合列表，`manualTasksOf(x).length + runsOf(x).length === x.length`，且两者 `task_id` 集合无交集。这条是防止两个谓词将来漂移的护栏。

**改 `web/src/components/tasks/TaskInboxPanel.test.tsx`** —— 新增两条：
- `source_schedule_id` 非空的条目渲染出「⏰ 定时」；
- `source_schedule_id` 为 `null` 的条目不渲染「⏰ 定时」。

（该文件已有 `mkTask` 工厂，加这个字段即可。）

**没有单测的部分**：`TaskBoard.tsx` 的接线（它依赖 `useWebSocket` context，仓库里没有它的测试文件，静态渲染也起不来）。这条由浏览器 E2E 覆盖 —— 这是本次改动的核心行为，E2E 不能省。

**回归护栏**：`taskFilter.test.ts`（35 条）、`TaskInboxPanel.test.tsx`、`TaskCard.test.tsx`、`TaskTableView.test.tsx`、`ScheduledRunHistoryView.test.tsx` 必须保持全绿。

**验收**：`npm run typecheck` 与 eslint 对本次改动文件**零新增**（仓库 baseline 本就不干净，先记数字）。web 测试显式跑文件（仓库无 `npm test` 脚本）。

**手工 E2E**（puppeteer-core + 缓存 chromium 连 `:5188`，断言走 DOM / computed style，不靠截图）：
1. 先记下一条**定时来源**任务的标题与一条**手动**任务的标题（从 API 取，按 `source_schedule_id` 是否为空区分）。
2. 开 `/tasks`（看板）→ 定时来源任务的标题**不出现**，手动任务的标题**出现**。
3. 切到表格视图 → 同样：定时来源的不出现、手动的出现；状态 pill 的计数与表格实际行数一致。
4. 开 `/tasks?view=scheduled&tab=runs` → 那条定时来源任务**仍在运行记录里**（没被误伤）。
5. 从运行记录点该任务的「打开任务」→ 详情页正常打开，且仍带「⏰ 定时」徽标。
6. **收件箱标记**（需要合成数据，见下）：插入一条 `source_schedule_id` 非空且 `sub_status='failed'` 的任务 → 它出现在收件箱里且带「⏰ 定时」标记；同时它**不出现**在看板/表格里。验证完删掉这条合成数据。

> **第 6 步为什么必须用合成数据**：实测当前库里 26 条定时来源任务的 `sub_status` 只有 `NULL`(6) 或 `'done'`(20)，而 `'done'` 不在 `taskInbox.ts` 的 `SUB_SIGNAL_TONE` 里；它们也没有 `deadline`（不触发 overdue）。也就是说**今天没有任何定时来源任务会产生收件箱条目** —— 这个标记在当前真实数据下根本看不到，只有将来定时任务失败/等批准时才会出现。所以这一步用一条合成任务验证（只插入我自己创建、跑完即删的那一行，不碰真实记录）。

> E2E 对**真实数据只读**。上一轮删除功能的 E2E 因为脚本选择器写错误删了一条真实任务（见 `2026-09-21-scheduled-run-history-delete-design.md` §8 的事故记录）；本次除第 6 步那条自建自删的合成行外不写库。
