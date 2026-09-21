# 定时任务页加「运行记录」子标签 设计

日期：2026-09-21
状态：已确认，待写实现计划

## 0. 背景与目标

定时任务跑出来的任务（`tasks.source_schedule_id` 非空）现在和手动建的任务混在同一个看板/表格里，只在卡片上有一个「⏰ 定时」小徽标（`TaskCard.tsx:85`）。用户要按来源分开管理。

**关键前提：需求形态已澄清过 —— 不做任务页的第 4 个顶级标签。** 用户明确要求「直接放到定时任务页面」。所以本次改动落在现有的 `?view=scheduled` 视图里，加一层**子标签**：

```
/tasks?view=scheduled
┌──────────────────────────────────────────────┐
│  [ 调度 | 运行记录 ]                           │  ← 新增，替换原来的静态标题行
├──────────────────────────────────────────────┤
│ 调度：     现有调度表格 / 移动卡片（原样）       │
│ 运行记录： 定时跑出来的任务（新）                │
└──────────────────────────────────────────────┘
```

现状盘点（**这些已经有了，不是本次要做的**）：任务页 header 的 `看板 / 表格 / ⏰ 定时` 三切换（`TaskBoard.tsx:327-342`，2026-08-17 上线）、侧边栏「定时任务」整行入口（`SidebarScheduledEntry.tsx` → `/tasks?view=scheduled`）、卡片与详情页的「⏰ 定时」徽标。

数据量参考（本地库实测）：`tasks` 共 249 行，其中 `source_schedule_id` 非空 6 行；`scheduled_tasks` 1 行（已停用）。规模很小，但字段链路齐全，做起来是纯前端。

## 1. 数据来源：不新增请求

`TaskBoardPage` 已经通过 `useTasks({}, subscribe)`（`TaskBoard.tsx:33`）拿到了**全量**任务（无 `projectPath` / `status` 参数，含 archived），并且带 ws 实时更新。运行记录直接用这份数据，按 `source_schedule_id` 过滤即可 —— **不新增 API 调用、不动后端**。

`ScheduledTasksPanel` 本来就有 `useScheduledTasks` 的调度列表（`ScheduledTasksPanel.tsx:18`），用来做 `schedule_id → title` 的映射。

## 2. 组件改动

### 2.1 `TaskBoard.tsx` —— 子标签 state 上提

新增 `scheduledTab`，**由 `TaskBoardPage` 持有**而非放在面板里。理由与 `statusFilter` 上提同源（`TaskBoard.tsx:40-42` 的注释）：URL 播种必须在页面层做，`useLocalStorage` 又是纯 `useState`、没有跨实例同步。

```ts
const [scheduledTab, setScheduledTab] = useLocalStorage<'schedules' | 'runs'>(
  'scheduledViewTab',
  'schedules',
);
```

URL 播种：把现有只读 `view` 的 effect（`TaskBoard.tsx:48-52`）扩成同时读 `tab`：

```ts
useEffect(() => {
  if (searchParams.get('view') === 'scheduled') {
    setViewMode('scheduled');
    if (searchParams.get('tab') === 'runs') setScheduledTab('runs');
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**URL 优先于 localStorage**：带 `?tab=runs` 进来时覆盖已存值；不带则沿用已存值（默认 `schedules`）。只在挂载时读一次，与现有 `view` 的处理一致。

`TaskBoard.tsx:411` 的传参扩成：

```tsx
<ScheduledTasksPanel
  ref={scheduledPanelRef}
  projectOptions={projectOptions}
  tasks={tasks}
  tab={scheduledTab}
  onTabChange={setScheduledTab}
/>
```

`tasks` 传全量，不过筛选 —— 见 §5。

### 2.2 `ScheduledTasksPanel.tsx` —— 子标签条 + 分流

新增三个 prop：`tasks: Task[]`、`tab`、`onTabChange`。

**先解决命名撞车**：现有第 18 行 `const { tasks, loading, loadError, refresh } = useScheduledTasks(...)` 里的 `tasks` 是**调度**列表（`ScheduledTask[]`），与新传入的 `tasks`（**任务**列表，`Task[]`）同名。必须把 hook 解构改名：

```ts
const { tasks: schedules, loading, loadError, refresh } = useScheduledTasks({}, subscribe);
```

（hook 内部字段名不动，只改调用点。）渲染结构：

```tsx
<>
  <SubTabBar tab={tab} onChange={onTabChange} />
  {tab === 'schedules'
    ? <ScheduledTasksView tasks={schedules} ... />
    : <ScheduledRunHistoryView runs={runs} schedules={schedules} projectOptions={projectOptions} />}
  <ScheduledTaskForm ... />
</>
```

`runs` 的过滤在这里做，一处收口：

```ts
const runs = useMemo(() => tasks.filter((t) => t.source_schedule_id), [tasks]);
```

子标签条复用 header 那套分段控件的视觉（`TaskBoard.tsx:294-343`：`rounded-xl border border-border/70 bg-muted/50 p-0.5` 容器 + 选中项 `bg-card shadow-raised-sm` + `aria-pressed`），保证两处观感一致。

### 2.3 `ScheduledTasksView.tsx` —— 让出标题行

删掉 `90-93` 行那行静态标题「⏰ 定时任务」—— 子标签条已经承担了「这是哪一页」的指示，留着就是两行 chrome。`flex flex-shrink-0 items-center justify-between px-3 py-2 sm:px-4` 这套内边距由子标签条沿用，纵向占位不变。

空态（`81-87`）与桌面表格 / 移动卡片全部不动。现有 `ScheduledTasksView.test.tsx:74` 只断言 `/暂无定时任务/`，不受影响。

### 2.4 新组件 `ScheduledRunHistoryView.tsx`

仿 `ScheduledTasksView` 现成的「桌面表格 + 移动卡片」双渲染结构（同一断点：`lg:` 分界），纯展示组件 —— 所有数据由 props 传入，自己不发请求。这样它能被 `renderToStaticMarkup` 静态测试（web 测试没有 DOM，见 `ScheduledTasksView.test.tsx:1-6`）。

Props：

```ts
type ScheduledRunHistoryViewProps = {
  runs: Task[];                          // 已过滤：source_schedule_id 非空
  schedules: ScheduledTask[];            // 用于 schedule_id → title 映射
  projectOptions: TaskProjectOption[];
  onOpenTask: (task: Task) => void;
  onOpenSession: (task: Task) => void;
};
```

**桌面表格列**：标题 / 所属调度 / 项目 / 状态 / 触发时间 / 操作

| 列 | 内容 |
|---|---|
| 标题 | `font-semibold`，`line-clamp-2` |
| 所属调度 | `schedule_id → title`；查不到（调度已删除）回退「已删除的调度」。加 `truncate` + `title`，防止长标题把表推宽（沿用 `ScheduledTasksView.tsx:115-118` 的处理） |
| 项目 | 复用 `ScheduledTasksView.tsx:21-25` 的 `projectLabel` 口径（`is_operator === 1` → 🤖 Lovdex助手；否则查 `projectOptions`，回退完整路径）。为共用，把它从 `ScheduledTasksView.tsx` 抽到一个小模块导出 |
| 状态 | `STATUS_META[status].label` + 色点；后面跟 `<SubStatusBadge subStatus={task.sub_status} />` |
| 触发时间 | `formatAbsoluteTime(task.created_at)`，`font-mono text-2xs`。用 `created_at` 而非 `started_at`：调度触发时先建任务行、再起运行，`created_at` 才是「这次调度什么时候被触发」，且它对**每条**运行都有值（`started_at` 在未启动/仅提醒的任务上是 NULL） |
| 操作 | 纯跳转：「打开任务」→ `/task/:id`；`canOpenSession(task)` 为真时再加「打开会话」→ `/session/:session_id` |

排序：`created_at` 倒序。用 `sortTasks` 之类的通用排序器没必要，直接按字符串倒序（后端时间戳是裸 UTC 定长格式，字典序即时序，对齐 `taskTimestamp.ts:16` 的约定）。

**移动卡片**（`<lg`）：标题 / 所属调度 / 状态 + 子状态 / 触发时间 / 两个操作按钮，结构对齐 `ScheduledTaskCard`。

空态：「暂无运行记录」，与「暂无定时任务」同款居中样式。

### 2.5 `TaskDetail.tsx` 的徽标深链（小）

`TaskDetail.tsx:486-490` 的「⏰ 定时」徽标已经跳 `/tasks?view=scheduled`。既然页面有了运行记录，**改成跳 `/tasks?view=scheduled&tab=runs`** 更贴它的语义（「这个任务是从定时来的」→ 看运行记录）。一处字符串改动，不额外做「高亮定位到该行」。

## 3. URL 契约

| URL | 落点 |
|---|---|
| `/tasks` | 看板 |
| `/tasks?view=scheduled` | 定时页 · **调度**（默认子标签） |
| `/tasks?view=scheduled&tab=runs` | 定时页 · 运行记录 |

侧边栏「定时任务」入口（`SidebarScheduledEntry.tsx:18`）不变，仍落「调度」。

## 4. header 行为

「新建任务」按钮在定时视图下唤起新建**调度**表单（`TaskBoard.tsx:195-198` → `scheduledPanelRef.current?.openNew()`），**子标签切到「运行记录」时保持不变** —— 这个按钮属于「定时页」，不是属于某个子标签。筛选区折叠按钮在定时视图下本就不渲染（`TaskBoard.tsx:346`），不受影响。

## 5. 明确不做的

- **看板/表格保持原样**，仍显示全部 249 个任务（含定时来源的 6 个）。已与用户确认：新页面是「按来源查看」的入口，不改既有视图语义。真觉得吵，之后再单独加「包含定时任务」开关。
- **运行记录不套用任务筛选栏**（`taskFilter` / 状态 pill）。定时视图本来就没有筛选栏（`TaskBoard.tsx:414` 的 `TaskFilterBar` 只在非定时视图渲染），为运行记录单独引一套筛选是范围蔓延。
- **不做排序 / 多选 / 批量删除** —— 运行记录是只读查看 + 跳转。`TaskTableView` 那套 sort / selection / 状态 pill 的 state 全绑在 `useLocalStorage` 上（`TaskTableView.tsx:106-107`），复用它到第二个位置会撞 key，所以**不复用 `TaskTableView`**，另写精简表格。
- 不做「点调度直接筛出它的运行记录」的联动。`schedule_id → title` 只用于显示。
- 助手工具（`create_scheduled_task` 等）不动。

## 6. 测试与验收

web 测试跑 `node:test` + `renderToStaticMarkup`，**无 DOM、effect 与交互都不执行**，所以断言落在静态标记上。

**新增 `web/src/components/tasks/ScheduledRunHistoryView.test.tsx`**：
- 只渲染 `source_schedule_id` 非空的任务 —— 传一个混合列表（含 `source_schedule_id: null` 的行），断言其标题**不出现**。
- 空列表 → 「暂无运行记录」。
- 调度名映射：`schedules` 里有对应 `schedule_id` → 渲染其 title；查不到 → 「已删除的调度」。
- 无 `session_id` 的任务不渲染「打开会话」。
- fixture 需补全 `Task` 必填字段（照抄 `TaskCard.test.tsx:38` 的 `source_schedule_id` 一带）。

**改 `ScheduledTasksView.test.tsx`**：删标题行后，「⏰ 定时任务」不再出现 —— 现有测试未断言它（只断言 `/暂无定时任务/`，`74` 行），预计无需改动；跑一遍确认。

**`ScheduledTasksPanel` 的 props 变了**，检查其引用点只有 `TaskBoard.tsx:411` 一处（已确认）。

**回归护栏**：`TaskBoard` 相关现有测试、`TaskDetail` 相关测试全绿。

**验收**：`npm run typecheck` 与 `npm run lint` **零新增**（仓库 baseline 本就不干净，先跑一遍记下数字）。web 测试显式跑文件：`npx tsx --test web/src/components/tasks/ScheduledRunHistoryView.test.tsx`（仓库无 `npm test` 脚本）。

**手工验收**（浏览器 E2E，走 `:5188` → 后端 `:3188` 的 live dev server）：
1. 侧边栏点「定时任务」→ 定时页，默认落在「调度」，显示那 1 条调度。
2. 切到「运行记录」→ 列出 6 条定时来源任务；切走再回来，子标签记住（localStorage）。
3. 直接开 `/tasks?view=scheduled&tab=runs` → 落在运行记录（URL 覆盖已存值）。
4. 在任务详情页点「⏰ 定时」徽标 → 落到运行记录。
5. 刷新看板 → 看板与表格的条数**与改动前一致**（249）。
6. 窄屏（<1024px）下运行记录渲染卡片而非表格，操作按钮可点。
