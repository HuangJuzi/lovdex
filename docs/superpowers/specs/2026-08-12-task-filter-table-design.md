# Task 页筛选 + 表格视图 — 设计文档

> 状态：设计定稿 · 2026-08-12
> 定位：为 lovdex-cli 的 Task 页面（任务面板）补齐**项目/日期筛选**，新增**表格视图**，并统一美化返回导航按钮。
> 范围：仅 lovdex-cli 前端（`src/components/tasks/`），零后端改动。

---

## 1. 背景与目标

当前 Task 页（`TaskBoardPage`，`src/components/tasks/TaskBoard.tsx`）是**看板视图**，按 `status` 分 4 列（待办/进行中/评审/完成）。`useTasks({}, subscribe)` 拉取**全部任务**，无任何筛选；WebSocket 实时推送 `task_upserted/task_deleted` 增量更新本地列表。后端 `GET /api/tasks` 已支持 `projectPath`、`status` 查询参数，但无日期参数。

任务多了以后，看板无法回答「这个项目的任务有哪些」「最近一周建了什么」「哪些任务快到截止日期」，也缺少跨状态统一排序/扫描的视角。

**目标**：
1. Task 页支持**项目筛选**（单选下拉 + 「🤖 只看助手」快捷开关）。
2. Task 页支持**日期筛选**（字段可在 创建时间/截止时间/最近活动 间切换；快捷项 + 自定义起止范围）。
3. 新增**表格视图**，看板/表格可切换（偏好持久化）。
4. 美化 TaskDetail / OperatorSettingsPage 的返回导航按钮（outline 描边 + 图标）。

**不做的**（刻意排除，避免过度建制）：
- 不做后端日期过滤参数（任务量对个人看板足够小，前端过滤即可）。
- 不做多选项目过滤（单选 + 助手开关已覆盖主要诉求）。
- 不做看板拖拽排序、列显隐配置、分页加载。
- 不改后端 / API / 数据库。

---

## 2. 方案选型

**选：方案 A —— 纯前端过滤。**

对比：
| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 纯前端过滤（选）** | `useTasks` 仍拉全量，筛选状态存前端 state，纯函数 `filterTasks` 过滤后喂看板/表格 | ✅ 零后端改动；实时推送不受影响（任务照常 upsert，只是不渲染）；看板与表格共享同一份过滤结果，计数一致；切换零延迟。❌ 全量数据在内存中（个人看板规模足够）。 |
| B 项目走后端 | 项目变化时 `useTasks({ projectPath })` 重拉，日期前端过滤 | ❌ 每次切项目 refetch；实时 upsert 的其它项目任务仍需前端过滤一道；两套路径更复杂。 |
| C 后端加日期参数 | `/api/tasks` 加日期参数，服务端 SQL 过滤 | ❌ 动后端 SQL/API/测试；实时增量与过滤条件交互复杂；对当前规模过度设计。 |

---

## 3. 过滤模型（纯函数，可单测）

新增 `src/components/tasks/taskFilter.ts`：

```ts
export type TaskDateField = 'created' | 'deadline' | 'activity';
export type TaskFilterPreset = 'all' | 'today' | 'week' | 'month' | 'year';

export type TaskFilter = {
  projectPath: string;       // '' = 全部项目；ASSISTANT_OPTION_VALUE = 🤖 Lovdex助手
  assistantOnly: boolean;    // 只看助手快捷开关
  dateField: TaskDateField;
  preset: TaskFilterPreset;
  customFrom: string;        // YYYY-MM-DD，空 = 未设
  customTo: string;          // YYYY-MM-DD，空 = 未设
};

export const EMPTY_TASK_FILTER: TaskFilter = {
  projectPath: '', assistantOnly: false,
  dateField: 'created', preset: 'all', customFrom: '', customTo: '',
};
```

### `resolveDateRange(filter, now): { from: number; to: number } | null`

- **自定义优先**：`customFrom`/`customTo` 任一非空时，取 `[from 00:00, to 23:59:59.999]`。
  - 只设「从」→ 下界为 `from 00:00`，**无上界**（该日及以后）。
  - 只设「至」→ 上界为 `to 23:59:59.999`，**无下界**（该日及以前）。
  - 双侧都设 → 闭区间。
- 否则按 `preset` 计算**本地时区**区间：
  - `today` → `[今天 00:00, 今天 23:59:59.999]`
  - `week` → `[本周一 00:00, 今天 23:59:59.999]`
  - `month` → `[本月 1 日 00:00, 今天 23:59:59.999]`
  - `year` → `[今年 1 月 1 日 00:00, 今天 23:59:59.999]`
- `preset = 'all'` 且无自定义 → 返回 `null`（不过滤日期）。

### `filterTasks(tasks, filter, now): Task[]`

按序应用三个维度（AND 关系）：

1. **项目**
   - `projectPath` 为空 → 不过滤。
   - `projectPath === ASSISTANT_OPTION_VALUE` → 只留 `is_operator === 1`（助手任务 `project_path` 为空）。
   - 其它 → `task.project_path === projectPath` 精确匹配。
2. **助手开关**：`assistantOnly === true` → 只留 `is_operator === 1`。
   - **互斥规则**（在 UI 层实施）：开助手开关 → 项目下拉重置为「全部项目」；选具体项目 → 关闭助手开关。避免「选了项目又只看助手」产生空结果的困惑。
3. **日期**：按 `dateField` 取值与 `resolveDateRange` 比较（解析为本地时间戳毫秒）：
   - `created` → `created_at`
   - `deadline` → `deadline`（YYYY-MM-DD）；**无 deadline 的任务在日期过滤激活时被排除**
   - `activity` → `updated_at`（最近活动 = 任务行最后改动时间）
   - 时间戳缺失/解析失败 → 日期过滤不匹配（排除）。

### 边界与错误处理

- `deadline` 非 `YYYY-MM-DD` 格式 → 按不匹配处理。
- `created_at`/`updated_at` 为空或非法 → 日期过滤排除。
- 助手任务 `project_path` 为空：选「全部项目」时正常显示；选具体项目时被过滤（符合预期）。

---

## 4. 筛选栏 UI

新增 `src/components/tasks/TaskFilterBar.tsx`，渲染在 header 下方、看板/表格上方，`flex flex-wrap` 一行可换行。**看板与表格两种视图下都显示**。

组成（从左到右）：
1. **项目下拉**（单选）：全部项目 / 🤖 Lovdex助手 / 各项目。候选复用 `taskFormProjects(projects)`（排除 operator workspace），label 复用看板 create form 的「重名加路径」消歧规则。
2. **「🤖 只看助手」toggle**：高亮 Pill 按钮；与项目下拉互斥。
3. **日期字段 segmented control**：创建时间 / 截止时间 / 最近活动（`PillBar` + `Pill`）。
4. **快捷项 chips**：今天 / 本周 / 本月 / 今年 / 全部（`PillBar`）。
5. **自定义范围**：`从` / `至` 两个 `<Input type="date">`；设任一个生效并清除快捷项高亮。
6. **「清除筛选」**：任一过滤生效时显示，一键回到 `EMPTY_TASK_FILTER`。

复用现有组件：`PillBar`/`Pill`、`Input`、`projectOptions.ts`。

---

## 5. 表格视图（视觉定稿 B3+ B）

新增 `src/components/tasks/TaskTableView.tsx`。

### 列布局

| 标题 | 项目 | 状态 | 优先级 | 子状态 | 截止日期 | 创建时间 | 最近活动 | 操作 |
|---|---|---|---|---|---|---|---|---|

- **标题列**：标题加粗；**副行** = Label 徽标 + `◈引擎 · 模型`（引擎三色 `Claude 绿 / Codex 琥珀 / SophCode 紫`，模型等宽字体）。
- **项目列**：`todo` 且非助手任务给**紧凑下拉**（可改项目，复用看板 `changeProject` 逻辑）；其余显示路径或「🤖 Lovdex助手」。
- **状态列**：色点 + `STATUS_META` 标签。
- **优先级列**：`PRIORITY_META` 色标徽标。
- **子状态列**：`SubStatusBadge`。
- **截止日期列**：`YYYY-MM-DD`，逾期红色加粗（复用 `taskDeadline` 语义）。
- **创建时间 / 最近活动列**：`formatAbsoluteTime`。
- **操作列**：文字胶囊按钮，复用看板按钮逻辑（`▶ 开始执行` / `↻ 重试` / `✓ 标记完成` / `打开会话`），`stopPropagation`；行点击 → `/task/:id`。

### 视觉样式（B3+ B）

- 按状态分 4 组，**分组头**（色点 + 名称 + 计数 + 分割线）。
- **卡片行**：圆角、card 底、行间距、左色条（`border-left: 3px solid statusColor`）、悬停上浮。
- 横向滚动：`overflow-x-auto` + 表格 `min-width: 1080px`。
- 空态：「暂无任务」。

### 排序

- 新增纯函数 `src/components/tasks/taskTable.ts`：`sortTasks(tasks, key, dir)`。
- **组内排序**：每个状态组内按当前排序列排序。
- 可排序列：标题（localeCompare）、项目、状态（`STATUS_ORDER` index）、优先级（`PRIORITY_ORDER` index）、截止日期、创建时间、最近活动。
- 默认：创建时间 desc。
- 点列头切换 asc/desc，列头显示排序箭头（复用 mockup 的 ↑/↕ 表示）。

---

## 6. 视图切换 + 持久化

- header 的 `ViewSwitcher` 旁新增「看板 / 表格」segmented control（`LayoutGrid` / `Table` 图标，`PillBar` 样式）。
- 视图偏好用现有 `useLocalStorage('taskViewMode', 'board')` 持久化。
- 筛选栏在两种视图下都生效；切换视图不重置筛选。

---

## 7. 返回导航按钮美化（outline 描边）

**现状问题**：`TaskDetail.tsx` 头部两个按钮为纯文本（`← 返回任务面板` / `·` / `返回主页`）；`OperatorSettingsPage.tsx` 有同款纯文本「← 返回任务面板」。观感简陋且不统一。

**方案（定稿：outline 描边）**：
- 用 `Button` 组件 `variant="outline" size="sm"` + lucide 图标：
  - 「返回任务面板」→ `ArrowLeft` + 文字
  - 「返回主页」→ `Home` + 文字
  - 图标 `size-4`，按钮 `gap-1.5`
- 新增小组件 `src/components/tasks/TaskBackNav.tsx`：
  - `TaskBackNav`：TaskDetail 头部右侧，渲染两个 outline 按钮。
  - `BackToTasksButton`：单按钮，供 `OperatorSettingsPage` 头部复用。
- `AssistantPanel.tsx` 错误态的「返回任务面板」已是主色按钮，不动。
- 影响面：`TaskDetail.tsx`、`OperatorSettingsPage.tsx`。

---

## 8. 文件与测试

### 新增

| 文件 | 说明 |
|---|---|
| `src/components/tasks/taskFilter.ts` | 过滤纯函数（`EMPTY_TASK_FILTER` / `resolveDateRange` / `filterTasks`） |
| `src/components/tasks/taskFilter.test.ts` | 单测：日期区间（今天/本周/本月/今年/自定义）、项目/助手/日期过滤、deadline 排除、互斥语义、时间戳缺失 |
| `src/components/tasks/taskTable.ts` | `sortTasks` 组内排序纯函数 + 排序列 key 定义 |
| `src/components/tasks/taskTable.test.ts` | 单测：各可排序列 asc/desc、默认排序、稳定性 |
| `src/components/tasks/TaskFilterBar.tsx` | 筛选栏 UI |
| `src/components/tasks/TaskTableView.tsx` | 表格视图（B3+ B） |
| `src/components/tasks/TaskBackNav.tsx` | 返回导航按钮组件 |

### 修改

| 文件 | 说明 |
|---|---|
| `src/components/tasks/TaskBoard.tsx` | 持有 `filter` state（`useState<TaskFilter>`）；渲染 `TaskFilterBar` + 视图切换；按过滤结果渲染看板或表格；把 `projects` / `projectOptions` / 各回调传给表格 |
| `src/components/tasks/TaskDetail.tsx` | 头部导航换成 `TaskBackNav` |
| `src/components/operators/OperatorSettingsPage.tsx` | 头部返回按钮换成 `BackToTasksButton` |

### 测试约定

- 沿用项目现有模式：`node:test` + `assert` + `react-dom/server` 的 `renderToStaticMarkup`。
- UI 文案沿用现有中文硬编码风格（不引入 i18n 词条）。

---

## 9. 验证要点

1. `npm test`（lovdex-cli）全绿，新增 `taskFilter.test.ts`、`taskTable.test.ts` 覆盖上述用例。
2. 手测：项目下拉 / 助手开关 / 日期字段切换 / 快捷项 / 自定义范围 / 清除筛选，看板与表格结果一致。
3. 手测：表格分组头、卡片行、左色条、列头排序、行内操作（开始执行/标记完成/打开会话）、行点击进详情、项目下拉改项目。
4. 手测：看板/表格切换持久化（刷新后保持）；筛选在两种视图下均生效。
5. 手测：TaskDetail 与 OperatorSettingsPage 返回按钮为 outline 样式，hover/focus 正常，浅色/深色可读。

---

## 10. 附：设计定稿过程中的关键决策

- 日期字段语义：**最近活动 = `updated_at`**（任务行最后改动时间），非看板卡片的「开始于/完成于」生命周期时间。
- 项目筛选与助手开关**互斥**。
- 表格分组保留（B3+ B 分组头 + 卡片行），排序为**组内排序**；未采用 B5 的跨状态平面排序（用户选择了 B3+ B）。
- 引擎/模型、Label 折叠进标题副行，不占独立列。
