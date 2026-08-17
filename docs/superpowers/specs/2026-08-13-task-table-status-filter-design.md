# Task 表格视图「状态」筛选 — 设计文档

> 状态：设计定稿 · 2026-08-13
> 定位：为 lovdex-cli Task 页的**表格视图**新增按看板列 `status`（待办/进行中/评审/完成）的筛选，只看选中的状态分组。
> 范围：仅 lovdex-cli 前端（`src/components/tasks/`），零后端改动。

---

## 1. 背景与目标

Task 页已有「项目/日期筛选 + 表格视图」（2026-08-12 上线，见 `2026-08-12-task-filter-table-design.md`）。表格视图按 4 个看板列 `status` 分组渲染，但无法只保留某几列——任务多了以后，用户想「只看进行中」「排除已完成」只能靠滚动定位。

**目标**：在**表格视图**内新增一行状态筛选 pills，勾选/取消 4 个看板列，未选中的分组不渲染。

**不做的**（刻意排除，避免过度建制）：
- 不按 `sub_status`（10 标签）筛选——本次只做第一层 `status`（用户已确认）。
- 不持久化、不联动看板——状态筛选是表格视图的局部状态，切回看板即重置。
- 不动共享筛选栏 `TaskFilterBar` / `TaskFilter` / `filterTasks`，看板视图零影响。
- 不改后端 / API / 数据库。

---

## 2. 方案选型

**选：方案 A —— 表格视图内部局部状态 + pills。**

对比：
| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 表格内局部状态（选）** | `TaskTableView` 自持 `useState<TaskStatus[]>`，顶部渲染一行 pills；渲染循环跳过未选中分组 | ✅ 改动集中在 `TaskTableView` + `taskStatus.ts`；共享筛选模型零改动；天然满足「只在表格视图」。❌ 切视图（组件卸载）后筛选重置——符合预期，无需保留。 |
| B 扩展共享筛选栏 | `TaskFilter` 加 `statuses`，`filterTasks` 参与过滤，`TaskFilterBar` 仅在表格视图渲染状态组 | ❌ 动共享模型；需处理「表格筛完切回看板」的联动（接受或额外门控）；本次诉求明确只在表格，改动面更大。 |
| C 点击分组标题折叠 | 把分组头变成可折叠 | ❌ 语义是「折叠」而非「筛选」，与诉求不符，已排除。 |

---

## 3. 过滤模型（纯函数，可单测）

在 `src/components/tasks/taskStatus.ts` 新增一个纯函数：

```ts
/** 切换某个看板列在表格状态筛选中的选中与否；返回新数组（不修改入参），保持 STATUS_ORDER 顺序。 */
export function toggleStatus(selected: TaskStatus[], status: TaskStatus): TaskStatus[] {
  return selected.includes(status)
    ? selected.filter((s) => s !== status)
    : [...selected, status];
}
```

- 默认选中：全部 4 列 `STATUS_ORDER`（`['todo', 'in_progress', 'in_review', 'done']`）。
- 渲染决策：`STATUS_ORDER.filter((s) => selected.includes(s))` 为可见列；空组照旧跳过（现有逻辑）。
- 若所有可见列都为空（如任务全落在未选中的列），表格体内显示「暂无任务」占位行。

---

## 4. 表格视图 UI

修改 `src/components/tasks/TaskTableView.tsx`：

### 结构调整

外层卡片从「单层 `overflow-x-auto`」改为**纵向两段**：

```text
┌─────────────────────────────────────────┐
│ [状态筛选行] 全部 · 待办 n · 进行中 n · 评审 n · 完成 n   │ ← 固定，不随表格横向滚动，底部 border-b 分隔
├─────────────────────────────────────────┤
│  <overflow-x-auto>  表格（min-w 1080px）          │
└─────────────────────────────────────────┘
```

- 外层：`min-h-0 flex-1 flex flex-col rounded-2xl border border-border/70 bg-card …`（把现有 `overflow-x-auto px-2 pb-4 sm:px-4` 的 padding 与横向滚动下移到内层滚动区，`borderSpacing: '0 7px'` 与 `min-w-[1080px]` 不变）。

### 状态筛选行

复用现有 `PillBar` / `Pill`（与共享筛选栏视觉一致）：

- 最前一个「全部」pill：`isActive` = 4 列全选；点击一键恢复全选。
- 后接 4 个状态 pill，每个 = **色点**（`STATUS_META[status].color`）+ **标签**（`STATUS_META[status].label`）+ **计数**（`groups[status].length`，即项目/日期筛选后该列任务数）。
- 点击某个状态 pill → `setSelected((sel) => toggleStatus(sel, status))`。
- 筛选行加 `data-testid="status-filter"`，便于静态冒烟测试定位。

### 渲染循环

`tbody` 由 `STATUS_ORDER.map` 改为 `STATUS_ORDER.filter((s) => selected.includes(s)).map`，空组跳过逻辑不变；若过滤后无任何可见行，渲染 `colSpan={9}` 的「暂无任务」占位行。

### 边界

- `tasks.length === 0` 时保留现有早退「暂无任务」——无任务时不渲染筛选行。
- 计数始终基于 `groups`（含被取消勾选的列），不随勾选变化，便于用户判断何时恢复。

---

## 5. 文件与测试

### 修改

| 文件 | 说明 |
|---|---|
| `src/components/tasks/taskStatus.ts` | 新增 `toggleStatus` 纯函数 |
| `src/components/tasks/taskStatus.test.ts` | 补 `toggleStatus` 单测 |
| `src/components/tasks/TaskTableView.tsx` | 结构调整 + 状态筛选行 + 渲染循环过滤 + 空占位 |
| `src/components/tasks/TaskTableView.test.tsx` | 补静态冒烟：筛选行存在 + 计数渲染 |

### 测试约定

- 沿用项目现有模式：`node:test` + `assert` + `react-dom/server` 的 `renderToStaticMarkup`（无 DOM 交互，点击行为由 `toggleStatus` 纯函数单测覆盖）。
- `toggleStatus` 单测覆盖：新增一列、移除一列、不修改入参（不可变）、保持 `STATUS_ORDER` 顺序。
- `TaskTableView` 冒烟：`/data-testid="status-filter"/` 命中；含 1 个 todo 任务时筛选行渲染出「待办」与计数「1」。

---

## 6. 验证要点

1. lovdex-cli 测试全绿（`env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts src/components/tasks/TaskTableView.test.tsx`）。
2. 手测：表格视图顶部出现筛选行；点「进行中」取消后该分组消失、再点恢复；「全部」一键恢复 4 列。
3. 手测：项目/日期筛选 + 状态筛选叠加时，计数与分组正确；全部取消勾选时表格内显示「暂无任务」。
4. 手测：看板视图无此筛选行、零影响；切看板再切回表格，状态筛选回到全选。

---

## 7. 附：关键决策

- 状态筛选是**表格视图局部状态**（`useState` 在 `TaskTableView` 内），组件卸载即重置——与「只在表格视图」的诉求一致，不引入持久化。
- 「全部」pill 用于一键恢复，避免逐一点回 4 列的繁琐。
- 计数显示**未筛选前**的分组任务数（含被取消勾选的列），作为恢复参考。
