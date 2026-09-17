# 任务页筛选行可折叠（header「筛选」按钮）设计

- 日期：2026-09-17
- 状态：待实现
- 起因：任务页顶部两条筛选行常驻，纵向占用过大，挤压任务列表的可视行数

## 0. 目的与读者

把任务页顶部**两条常驻筛选行**收进一个 header 按钮后面，默认收起。读者是实现者（人或 agent）。本文只覆盖这一段 UI 与折叠状态；不覆盖筛选逻辑本身（`taskFilter.ts` / `taskStatus.ts` 的判定完全复用，一行不改）。

## 1. 现状

任务页（`web/src/components/tasks/TaskBoard.tsx`，路由 `/tasks`）在表格视图下的纵向结构：

```
<header>                         HomeButton · [看板|表格|定时] ·………· [＋ 新建任务]
<TaskFilterBar>                  项目多选 · 显示归档 · 日期字段 · 快捷项 · 日期范围 · 清除筛选
[琥珀色横幅]                      仅当「新建的任务被筛选藏起来」时出现
[已选 N 项]                       仅当有勾选时出现
<TaskInboxPanel>                 「需要你处理」
<TaskTableView>
  └ 状态 pill 行                  全部 · 待办 · 进行中 · 待审核 · 已完成（带计数）  ← data-testid="status-filter"
  └ 表格滚动区
```

两条筛选行（`TaskFilterBar` 与状态 pill 行）在桌面端**永远展开**，合计约 100px。用户在 1080P 上反馈"占用的面积太大，影响我看项目列表"。

`TaskFilterBar` 已经自带一条移动端（`<sm`）专用的折叠触发行（`TaskFilterBar.tsx:86-99`，`open` state 在 `:66`）；桌面端没有对应的折叠入口。

## 2. 目标行为

- header 里出现一个「筛选」按钮（视图切换器右侧），点击展开、再点击收起。
- 按钮**同时**控制两条筛选行。
- 默认**收起**，选择记入 `localStorage`，下次进页面保持。
- 全端统一：移动端也走这个按钮，删掉 `TaskFilterBar` 自带的移动端触发行。

### 2.1 不做

| 项 | 说明 |
|---|---|
| 展开/收起动画 | 两条行分属两个组件，套过渡要额外包一层 `Collapsible`，收益不抵复杂度 |
| 改筛选逻辑 | 收起只是不渲染，`filterTasks` / `groupByStatus` 一行不改 |
| 重排筛选控件 | 展开后的控件顺序、分组、样式一律不动，只把它们整体藏起来 |
| 把两条筛选行合并成一个浮层 | 见 §3 方案 C，已否决 |
| 折 `TaskInboxPanel`（「需要你处理」） | 它会自动隐藏，且用户未提 |
| 扩大「清除筛选」的作用域 | 它现在只清 `TaskFilter`，不清状态 pill；保持现状 |
| 「筛选生效时自动展开」 | 会让收起状态无法稳定保持 |

## 3. 方案取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采用）** | 折叠状态与状态 pill 的取值一并上提到 `TaskBoardPage`，`TaskFilterBar` 改受控 | 只有一份真相；按钮能准确判断"有没有东西被筛掉" |
| B | 用一个 context 传折叠状态 | 消费者只有两个组件，context 是纯负担；且状态 pill 取值仍要上提才能算激活点 |
| C | 点按钮弹浮层，把两条筛选全塞进去 | 浮层要放 10 个 pill + 日期范围 + 项目多选，窄屏定位 / 外部点击 / Esc / 滚动都要处理；改动面远大于收益。用户要的是"缩回去"，不是"换个地方摊开" |

## 4. 设计

### 4.1 按钮

位置：`TaskBoard.tsx` header 内，紧跟视图切换器那个 `rounded-xl` 分组**之后**、`ml-auto` 之前。放在分组外面，否则会被当成第四个视图。

```
[🏠] [看板|表格|定时]  [⚙ 筛选•]  ···············  [＋ 新建任务]
```

- `effectiveView === 'scheduled'` 时不渲染 —— 定时视图没有筛选。
- 移动端（`<sm`）只留图标，与相邻按钮一致。
- 收起态且**有筛选生效**时，右上角出一个 `bg-primary` 小圆点。
- `title` 三态：展开时 `收起筛选`；收起且无筛选 `展开筛选`；收起且有筛选 `展开筛选（当前有筛选条件生效，列表可能只显示部分任务）`。
  - 不把筛选摘要拼进 tooltip。唯一的摘要在 `filterSummary` 里，它只覆盖项目与日期、不覆盖状态 pill，拼上去是半截信息；而它随移动端触发行一起被删（§4.5），没有现成摘要可用。用固定文案表达"有东西被筛掉了"即可，具体条件点开就能看到。
- `aria-expanded={filtersOpen}`。不加 `aria-controls`：收起时目标元素不存在，会留悬空引用。

### 4.2 折叠范围与状态

| | 展开 | 收起 |
|---|---|---|
| `TaskFilterBar` | 现有一排控件 | 整个组件不渲染 |
| `TaskTableView` 状态 pill 行 | 现有那一行 | 整行不渲染，表格直接顶到卡片上沿 |

- 状态存 `localStorage`，key `taskFiltersOpen`，**默认 `false`**，复用现有 `useLocalStorage`（`web/src/hooks/useLocalStorage.jsx`），与 `taskFilter` / `taskViewMode` 同一套路，无需迁移。
- 两条筛选行的**取值完全不动**：收起只是不渲染，展开后原先选中的项目 / 日期 / 状态原样还在。
- 收起状态下 `TaskTableView` 的滚动区要补顶部内边距，否则 `thead` 会贴住卡片上沿 —— 今天的间距是状态 pill 行的 `py-2.5` 提供的。实现：滚动区现有 `className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4"`（`TaskTableView.tsx:180`）在 `!showStatusFilter` 时追加 `pt-3`。

### 4.3 数据流

```
TaskBoardPage
├─ filtersOpen          useLocalStorage('taskFiltersOpen', false)
├─ filter               已有（taskFilter）
├─ statusFilter         ← 从 TaskTableView 上提，key 仍是 'taskTableStatusFilter'
│
├─ header  ⚙ 筛选 按钮   → setFiltersOpen
├─ <TaskFilterBar open={filtersOpen} … />                    受控
└─ <TaskTableView showStatusFilter={filtersOpen}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter} … />
```

`TaskTableView` 的 prop 签名：

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `statusFilter` | `TaskStatus[]` | 必填 | 上提后不再有内部 state |
| `onStatusFilterChange` | `(next: TaskStatus[]) => void` | 必填 | 同上 |
| `showStatusFilter` | `boolean` | `true` | 折叠时传 `false`；默认 `true` 让不关心折叠的调用方（含测试）不必显式声明 |

**为什么状态 pill 取值必须上提**：`useLocalStorage`（`useLocalStorage.jsx:12-41`）是纯 `useState`，**没有跨实例同步**。若 `TaskBoard` 也开一个同 key 的实例来读，两边各持一份 state，一边写另一边不会更新，圆点会长期失真。上提是唯一干净解法。

**圆点判定的一个边界**：状态 pill 只在表格视图被消费 —— 看板视图固定渲染全部状态列，不看 `statusFilter`。所以在看板视图下，一个非全选的状态 pill 并没有筛掉任何东西，不该点亮圆点。`TaskBoard` 传入"生效的"状态数组来体现这点：

```ts
// 看板视图不消费状态 pill（列固定渲染全部状态），此时它不算「筛掉了东西」。
const effectiveStatusFilter = effectiveView === 'table' ? statusFilter : [...STATUS_ORDER];
const hasActiveFilter = isTaskFilterActive(filter, effectiveStatusFilter);
```

### 4.4 新增纯函数

放 `web/src/components/tasks/taskFilter.ts`（该文件已有 `taskFilter.test.ts`，可单测）：

```ts
/**
 * 是否处于「有东西被筛掉了」的状态：任务级筛选（项目 / 日期）或状态 pill 否掉了某个状态。
 * `showArchived` 不计入 —— 打开它只会多出行、不会藏行；关闭时 archived 本就不渲染，
 * 那是默认值而非用户施加的筛选。与 `TaskFilterBar` 里「清除筛选」按钮的显示条件保持同一套语义。
 */
export function isTaskFilterActive(filter: TaskFilter, statusFilter: TaskStatus[]): boolean {
  if (filter.projectPaths.length > 0) return true;
  if (filter.preset !== 'all' || filter.customFrom !== '' || filter.customTo !== '') return true;
  const renderable = STATUS_ORDER.filter((s) => s !== 'archived' || filter.showArchived);
  return !renderable.every((s) => statusFilter.includes(s));
}
```

`dateField` 不计入 —— 单改日期字段不筛掉任何东西，`TaskFilterBar` 的 `hasFilter`（`:68-72`）同样不算它。

需要给 `taskFilter.ts` 加 `import { STATUS_ORDER } from './taskStatus'` 和 `TaskStatus` 类型。已确认不构成循环依赖：`taskStatus.ts` 只引 `types/app` 与 `taskTimestamp.ts`，不引 `taskFilter.ts`。

### 4.5 `TaskFilterBar` 改受控

- `open` 变成必填 prop，删掉内部 `useState`（`:66`）。
- 删掉移动端触发行（`:86-99`）及其外层 `div` 的 `border-b`（`:84`）—— 收起时整个组件返回 `null`，否则移动端会留一条 1px 横线。
- 控件区（`:102-108`）的类名收敛为「开 → 正常流；关 → 不渲染」。注意 **`hidden` 与 `sm:flex` 不能同时出现在收起分支**：Tailwind 把变体类排在样式表更后面，`hidden sm:flex` 在 `≥sm` 是**可见**的。
- `filterSummary`（`:51-58`）与 `projectFilterLabel`（`:38-48`）**一并删除**。已核实：`filterSummary` 的唯一调用点是即将删掉的移动端触发行（`:81`），`projectFilterLabel` 的唯一调用点在 `filterSummary` 内部（`:52`），删掉触发行后两个函数都无引用。

## 5. 验收

### 5.1 自动化

web 包**没有** `npm test`；跑之前必须 `unset TSX_TSCONFIG_PATH`（该环境变量会劫持 tsx）。

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskFilter.test.ts \
  src/components/tasks/TaskFilterBar.test.tsx \
  src/components/tasks/TaskTableView.test.tsx
npm run typecheck && npm run lint
```

- `taskFilter.test.ts` 新增 `isTaskFilterActive` 用例：全默认 = `false`；选了项目 = `true`；`preset: 'today'` = `true`；只设 `customFrom` = `true`；状态 pill 少选一个 = `true`；**只开 `showArchived` = `false`**。
- `TaskFilterBar.test.tsx` 现有 3 条要改：`open` 变必填；第 3 条断言的移动端触发行与摘要文案已删，改写成"`open={false}` 时控件区不渲染 / `open={true}` 时渲染全部控件"。
- `TaskTableView.test.tsx`：新增 `statusFilter` / `onStatusFilterChange` 必填 prop 后，用 `renderTable(props)` 辅助函数收口默认值，现有 15 条语义不变；另加一条 `showStatusFilter={false}` 时 `data-testid="status-filter"` 不渲染、且 `statusFilter` 仍然生效（只渲染选中状态的组）。
- typecheck / lint **零新增**（仓库 baseline 本就不干净：见 memory `lovdex-backend-baseline-not-clean`）。

测试写明的局限同 `TaskTableView.test.tsx` 现有注释：`node:test` + `renderToStaticMarkup` 无 DOM、无排版引擎，只能证明类名/结构被渲染出来，不能证明视觉结果。

### 5.2 浏览器

:5188 前端 / :3188 后端已在跑，纯前端改动走 vite HMR，**不重启后端**。用 headless Chrome（`~/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome`）量：

1. 点按钮 → 两条行出现；再点 → 消失；`aria-expanded` 同步。
2. 收起后刷新仍是收起；展开后刷新仍是展开（`localStorage.taskFiltersOpen`）。
3. 收起状态下把状态 pill 选成只剩「进行中」→ 圆点出现；展开点「全部」→ 圆点消失。
4. 看板视图下：状态 pill 选成子集、收起 → **圆点不出现**（§4.3 的边界）。
5. 记录收起前后「表格滚动区上沿到 header 下沿」的 px 差，确认省下的高度符合预期。
6. 1280 / 1024 两档宽度 header 不因新增按钮而溢出（`header.scrollWidth <= clientWidth`）。
7. 移动端 375px：按钮只剩图标；点击能展开控件区，控件区竖排且可横向容纳。
8. 定时任务视图下按钮不出现。
9. 深色模式截图（圆点与按钮激活态在深色下可辨）。

## 6. 影响文件

| 文件 | 改动 |
|---|---|
| `web/src/components/tasks/TaskBoard.tsx` | 主要：`filtersOpen` state、header 按钮、上提 `statusFilter`、透传 prop |
| `web/src/components/tasks/TaskFilterBar.tsx` | 改受控、删移动端触发行、删 `filterSummary` / `projectFilterLabel` |
| `web/src/components/tasks/TaskTableView.tsx` | 新增 `showStatusFilter` / `statusFilter` / `onStatusFilterChange` prop，状态行改条件渲染，收起时补 `pt-3` |
| `web/src/components/tasks/taskFilter.ts` | 新增 `isTaskFilterActive` |
| `web/src/components/tasks/taskFilter.test.ts` | 新增用例 |
| `web/src/components/tasks/TaskFilterBar.test.tsx` | 改 3 条 |
| `web/src/components/tasks/TaskTableView.test.tsx` | 加默认值辅助 + 新增 1 条 |
