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

> **（2026-09-21 写计划时修正）** 子标签条单独成文件 `ScheduledTabBar.tsx`（连同导出的 `ScheduledTab` 类型），不内联进面板 —— 面板依赖 `useWebSocket` context，在没有 DOM 的测试环境里渲染不起来，而标签条要能被静态断言。

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
};
```

> **（2026-09-21 写计划时修正）** 初稿的 props 里还有 `onOpenTask` / `onOpenSession` 两个回调。改成组件内部直接用 `Link`：props 更少，且 `Link` 在静态标记里渲染成 `href`，测试能直接断言跳转目标 —— 回调在无 DOM 的测试环境里断言不到。

同文件导出三个纯函数供单测（`runsOf` / `scheduleTitleOf` / `sortRunsByTriggeredDesc`）—— 过滤逻辑放在这里而不是面板里，就是为了能脱离组件被测。

**过滤**：`runsOf(tasks)` 只保留 `source_schedule_id` 非空的行。删调度不会删它跑出来的任务，所以判据只看任务自身字段。

**调度名映射**：`scheduleTitleOf(scheduleId, schedules)`；调度已删除（或 `scheduleId` 为 null）回退「已删除的调度」。

**排序**：`sortRunsByTriggeredDesc`，按 `created_at` 字符串倒序（后端时间戳是定长裸 UTC，字典序即时序，对齐 `taskTimestamp.ts:16` 的约定），返回新数组不改原数组。

**桌面表格列**：标题 / 所属调度 / 项目 / 状态 / 触发时间 / 操作

| 列 | 内容 |
|---|---|
| 标题 | `font-semibold`，`line-clamp-2` |
| 所属调度 | `schedule_id → title`；查不到（调度已删除）回退「已删除的调度」。加 `truncate` + `title`，防止长标题把表推宽（沿用 `ScheduledTasksView.tsx:115-118` 的处理） |
| 项目 | 复用 `ScheduledTasksView.tsx:21-25` 的 `projectLabel` 口径（`is_operator === 1` → 🤖 Lovdex助手；否则查 `projectOptions`，回退完整路径）。为共用，把它从 `ScheduledTasksView.tsx` 抽到新模块 `projectLabel.ts` 导出（参数用结构化类型 `{ is_operator: number; project_path: string | null }`，`Task` 与 `ScheduledTask` 都能传） |
| 状态 | `STATUS_META[status].label` + 色点；后面跟 `<SubStatusBadge subStatus={task.sub_status} />` |
| 触发时间 | `formatAbsoluteTime(task.created_at)`，`font-mono text-2xs`。用 `created_at` 而非 `started_at`：调度触发时先建任务行、再起运行，`created_at` 才是「这次调度什么时候被触发」，且它对**每条**运行都有值（`started_at` 在未启动/仅提醒的任务上是 NULL） |
| 操作 | 纯跳转：「打开任务」→ `/task/:id`；`canOpenSession(task)` 为真时再加「打开会话」→ `/session/:session_id` |

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

侧边栏「定时任务」入口（`SidebarScheduledEntry.tsx:18`）不带 tab 参数，所以落在**上次记住的子标签**（首访是「调度」）—— 与 `viewMode` 一样持久化。

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
- `runsOf`：混合列表（含 `source_schedule_id: null` 的行）只留下定时来源的那条。
- `sortRunsByTriggeredDesc`：按 `created_at` 倒序，**且不改原数组**。
- `scheduleTitleOf`：命中调度 → title；查不到 → 「已删除的调度」；传 `null` 同理。
- 静态标记：桌面表格列头含「所属调度」「触发时间」；移动卡片分支存在（`lg:hidden`）；标题 / 调度名 / 项目名 / 状态都渲染出来。
- 「打开任务」恒渲染且 `href="/task/:id"`；「打开会话」只在 `canOpenSession` 为真时渲染（`status: 'in_progress'` + 有 `session_id`）。
- 空列表 → 「暂无运行记录」。

**新增 `web/src/components/tasks/ScheduledTabBar.test.tsx`**：两个标签都渲染；恰好一个 `aria-pressed="true"`；激活/未激活样式类不同。

**新增 `web/src/components/tasks/projectLabel.test.ts`**：`is_operator=1` / 无路径 → 助手标签；命中 `projectOptions` → label；未命中 → 回退完整路径。

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

## 7. 实现与验收结果（2026-09-21）

**实现**：10 个提交，全部落在 `web/src/components/tasks/`，**后端零改动**（逐个提交核对 `git show --stat` 无 `backend/` 文件）。新增 4 个文件：`projectLabel.ts` + `.test.ts`、`ScheduledTabBar.tsx` + `.test.tsx`、`ScheduledRunHistoryView.tsx` + `.test.tsx`；改 3 个：`ScheduledTasksView.tsx`（删标题行）、`ScheduledTasksPanel.tsx`（子标签分流）、`TaskBoard.tsx`（state + URL 播种 + 传参）、`TaskDetail.tsx`（徽标深链）。

**自动化检查**（全绿）：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | **0 错误**（我改动的文件；见下方「共享工作区」说明） |
| eslint 逐文件 | TaskBoard 0 / Panel 1 / View 2 / TaskDetail 8 —— 与改动前基线**逐项相同，零新增** |
| web 单测（8 个文件） | **98 pass / 0 fail**（projectLabel 6、ScheduledTabBar 4、ScheduledRunHistoryView 12、ScheduledTasksView 7、TaskCard 13、TaskTableView 18、TaskFilterBar 4、taskFilter 35） |

> 口径补充：**新增文件**另有 3 条 `react-refresh/only-export-components` 警告（`ScheduledRunHistoryView.tsx`，来自「从组件文件导出纯函数以便无 DOM 测试」这一设计），以及 `ScheduledTabBar` / `ScheduledRunHistoryView` 的 `.test.tsx` 各 0 条。这 3 条不是「新增的回归」——`ScheduledTaskForm.tsx`（5 条）、`CreateTaskDialog.tsx` 早就是同一个模式的既有代价，但上一版表格只列了 4 个被改文件的基线，账面上漏了它们，特此更正。

**浏览器 E2E**（puppeteer-core + 缓存 chromium 连 `:5188`，断言走 DOM / computed style，不依赖截图）：**19/19 通过**。

实测数据：`tasks` 249 行，`source_schedule_id` 非空 6 行；这 6 行分属 **4 个不同的** `source_schedule_id`，而 `scheduled_tasks` 只剩 1 条 —— 也就是说**其中 3 条指向已删除的调度**。E2E 因此顺带在真实数据上验证了回退分支：3 行显示真名「同步付款审批并通知」、3 行显示「已删除的调度」，与 API 算出的期望值逐一对上。

覆盖到的点：默认落「调度」；切到「运行记录」后列头含「所属调度」「触发时间」、行数 6；刷新后记住子标签；`?tab=runs` 覆盖已存的 `schedules`；定时来源任务**仍在看板里**（不回归）；窄屏（900px）桌面表格 `display:none`、卡片网格 `display:grid` 且 6 个卡片、卡片里带调度名与「打开任务」；「运行记录」下点 header「新建任务」弹的仍是定时任务表单；详情页「⏰ 定时」徽标落到 `/tasks?view=scheduled&tab=runs`。

**过程中修掉的三个真问题**（都由审查发现、非计划预见）：

1. **冷启动谎报「已删除的调度」**（Important）：面板挂载时 `useScheduledTasks` 请求刚发出（`loading=true`、`schedules=[]`），而「运行记录」刻意不等它 —— 于是每一行都显示「已删除的调度」。加载中会闪几百毫秒；若调度请求失败而任务请求成功，则是**永久**的假信息，且重试按钮在另一个子标签里。修法：新增 `ScheduleLookup = 'loading' | 'error' | 'ready'`，只有 `ready` 才允许断言「已删除」。见提交 `eb15d26`。
2. **组件的排序没有测试钉住**：`const ordered = sortRunsByTriggeredDesc(runs)` 被删掉后 9 个测试照样全绿。补了一条断言渲染顺序的测试，并用「临时改实现确认它变红」验证过它真的咬得住。
3. **`ScheduledTabBar` 的断言钉不住「哪个标签是激活态」**（终审发现）：原测试只数「1 个 `aria-pressed="true"` + 1 个 `"false"`」、只看「两串样式类都出现」—— 把 `aria-pressed` 取反、或把两串样式对调，3 条测试全部照绿。补了一条把「激活态落在当前 tab 上 + 样式方向不反向」钉死的断言，同样用变异验证过（取反 `aria-pressed` 后新断言变红、原 3 条仍绿）。见提交 `b2269c0`。

**已知遗留**（非阻塞，记录备查）：

- `loadError` 为真但内存里仍有有效调度名时（加载成功后的某次刷新失败），「所属调度」会翻成「调度列表不可用」。属**少说**而非谎说，且下一次成功刷新即自愈，故本次未处理。
- **运行记录子标签下调度请求失败时没有自救入口**：重试按钮只在「调度」分支里，用户在运行记录里只能看到「调度列表不可用」而无法就地重试。文案本身是诚实信号，但 UX 缺口成立，记录备查。
- `?tab=runs` 深链会先渲染一帧「调度」再切过去（`useLocalStorage` 初值来自 localStorage，URL 播种在 `useEffect` 里）。这是沿用 `?view=scheduled` 既有的播种方式，不是本次引入。
- **`tab` 这个 query key 被两套深链共用**：工作区深链是 `?project=&tab=chat|files|git`，本次是 `?view=scheduled&tab=runs`。今天靠 `AppContent` → `useProjectsState.ts:361` 的 `isValidTab`（白名单 `{chat, files, git}` + `plugin:` 前缀）互不干扰，但没有结构性护栏。已在 `TaskBoard.tsx` 的挂载 effect 上方加注释说明；将来工作区若新增叫 `runs` 的 tab，应把这里改名成 `subtab`。
- 控制台每次加载都有一条 `WebSocket error: [object Event]`。已在**未改动的**路由 `/` 上复现，确认与本次改动无关，未追查。
- 面板的三态接线（`ScheduledTasksPanel.tsx` 里 `loading ? 'loading' : loadError ? 'error' : 'ready'`）本身无单测覆盖（面板依赖 `useWebSocket` context，静态渲染不起来），E2E 也只走通了 `ready` 分支。三态的**判定逻辑**已被 `scheduleTitleOf` 的单测钉住，未覆盖的只是「面板把 hook 状态映射成三态」那一行。

**共享工作区说明**：本次全程在 `main` 上与另一个 session 并发提交。上面「typecheck 0 错误」是**本次改动完成时**的实测值；此后对方开始做 auto-approve 功能，其未提交的 `ScheduledTaskForm.tsx` / `ScheduledTaskForm.test.tsx` / `types/app.ts` 会让全仓 typecheck 出现 2 个 `autoApprove` 相关错误 —— 与本功能无关，本功能涉及的文件不受影响。
