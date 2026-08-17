# Task 页筛选/排序持久化 — 设计文档

> 状态：设计定稿 · 2026-08-14
> 定位：让 Task 页的筛选（顶部筛选栏 + 表格状态筛选）与表格排序在跨页面导航 / 刷新后**记住**，不再每次重置。
> 范围：仅 lovdex-cli 前端（`src/components/tasks/`），零后端改动。

---

## 1. 背景与目标

Task 页现状（见 `2026-08-12-task-filter-table-design.md`、`2026-08-13-task-table-status-filter-design.md`）：

- 顶部筛选栏 `TaskFilter`（项目 / 只看助手 / 日期字段 / 快捷项 / 自定义范围）由 `TaskBoardPage` 以 `useState<TaskFilter>(EMPTY_TASK_FILTER)` 持有。
- 表格视图的状态筛选 `selected`、排序 `sortKey`/`sortDir` 由 `TaskTableView` 以局部 `useState` 持有。
- 唯一持久化的是视图偏好 `useLocalStorage('taskViewMode', 'board')`。

**问题**：`TaskBoardPage` 随路由卸载，`useState` 全部重置。用户筛选后点进其它页面（如会话/任务详情）再返回，筛选和排序全部丢失，需要重新设置。

**目标**：把这三类状态改用现成的 `useLocalStorage` 持久化，跨导航、跨刷新保留。

**不做的**（刻意排除）：
- 不改后端 / API / 数据库（与既往一致，纯前端）。
- 不做 URL 查询参数同步（可分享/书签），改动大且非诉求。
- 不引入全局 store / context 重构。

---

## 2. 方案选型

**选：方案 A —— 复用 `useLocalStorage` 持久化。**

对比：

| 方案 | 做法 | 优劣 |
|---|---|---|
| **A `useLocalStorage`（选）** | 三处 `useState` 换成 `useLocalStorage`，各自独立 key | ✅ 与 `taskViewMode` 完全一致；改动最小（3 处）；天然覆盖导航 + 刷新 + 重启；node 测试环境 `window` undefined 自动回退初始值，现有测试不受影响。❌ 无 schema 合并（见 §5）。 |
| B URL 查询参数 | 状态写进 `/tasks?...`，`useSearchParams` 编解码 | ✅ 可分享/书签。❌ 需 encode/decode `TaskFilter` 对象与数组、与 react-router 交互、日期/状态默认值双写，改动面大风险高。 |
| C 全局 store/context | 状态提到根组件，路由切换不卸载 | ✅ 不用碰 localStorage。❌ 较大重构；F5 刷新仍丢（除非再叠 localStorage）；偏离现有约定。 |

---

## 3. 改动设计

### 3.1 顶部筛选栏 `TaskBoard.tsx`

```ts
// 原
const [filter, setFilter] = useState<TaskFilter>(EMPTY_TASK_FILTER);
// 新
const [filter, setFilter] = useLocalStorage<TaskFilter>('taskFilter', EMPTY_TASK_FILTER);
```

- 记住：`projectPath` / `assistantOnly` / `dateField` / `preset` / `customFrom` / `customTo`。
- 日期快捷项（今天/本周/本月/今年）是相对值，恢复后按当天的 `now` 重算区间，语义正确；自定义范围是绝对日期，原样恢复。

### 3.2 表格视图 `TaskTableView.tsx`

```ts
// 原
const [sortKey, setSortKey] = useState<TaskSortKey>('created');
const [sortDir, setSortDir] = useState<TaskSortDir>('desc');
const [selected, setSelected] = useState<TaskStatus[]>(() => [...STATUS_ORDER]);
// 新
const [sortKey, setSortKey] = useLocalStorage<TaskSortKey>('taskTableSortKey', 'created');
const [sortDir, setSortDir] = useLocalStorage<TaskSortDir>('taskTableSortDir', 'desc');
const [selected, setSelected] = useLocalStorage<TaskStatus[]>('taskTableStatusFilter', [...STATUS_ORDER]);
```

- `useLocalStorage` 的 setter 已支持函数式更新（`value instanceof Function ? value(storedValue) : value`），因此现有 `setSortDir((d) => …)`、`setSelected((sel) => toggleStatus(sel, status))` 无需改动。
- `selected` 存为数组，JSON 序列化/反序列化安全；默认全选 4 列。

---

## 4. 文件与测试

### 修改

| 文件 | 说明 |
|---|---|
| `src/components/tasks/TaskBoard.tsx` | `filter` 由 `useState` → `useLocalStorage` |
| `src/components/tasks/TaskTableView.tsx` | `sortKey`/`sortDir`/`selected` 由 `useState` → `useLocalStorage` |

### 测试

- 现有单测（`taskFilter.test.ts`、`taskTable.test.ts`、`TaskFilterBar.test.tsx`、`TaskTableView.test.tsx` 等）不受影响：`useLocalStorage` 在 node 下 `typeof window === 'undefined'` 时返回初始值、写入 no-op，行为与 `useState` 一致。
- 验证命令：`env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskFilter.test.ts src/components/tasks/taskTable.test.ts src/components/tasks/TaskFilterBar.test.tsx src/components/tasks/TaskTableView.test.tsx`。
- 持久化本身是 `useLocalStorage` 既有能力，不新增单测；由手测覆盖（见 §6）。

---

## 5. 边界

- **无 schema 合并**：`useLocalStorage` 直接 `JSON.parse` 返回，不做字段级合并。若日后给 `TaskFilter` 加字段，老用户 localStorage 里的旧对象会缺新字段。当前 6 个字段稳定、由本仓库同时读写，不额外处理；如未来加字段，再补 `{ ...EMPTY_TASK_FILTER, ...stored }` 的 merge guard。
- **空选择合法**：`selected` 可为空数组（用户取消全部状态），表格显示「暂无任务」，点「全部」一键恢复——行为与现有一致，只是现在会跨导航保留。
- **多标签页不同步**：沿用 `useLocalStorage` 简单读写，不做 `storage` 事件跨标签同步（与 `taskViewMode` 一致，非诉求）。

---

## 6. 验证要点

1. lovdex-cli 测试全绿（命令见 §4）。
2. 手测：设置项目/日期/助手筛选 → 点进会话再返回 → 筛选保留；刷新页面 → 仍保留。
3. 手测：切到表格视图，勾选状态筛选 + 设置排序 → 切看板再切回表格 / 刷新 → 状态筛选与排序保留。
4. 手测：「清除筛选」后 → 返回再进来仍为全空（清除结果也持久化）。
5. 手测：看板视图无状态筛选行、零影响。

---

## 7. 附：关键决策

- **推翻 2026-08-13 的「状态筛选不持久化」决策**：当时诉求是「状态筛选只是表格局部状态，卸载即重置即可」；现用户反馈跨页面返回后要重新筛选，明确要求「全部筛选 + 排序」都记住，故改为持久化。
- 用 4 个独立 key（`taskFilter` / `taskTableSortKey` / `taskTableSortDir` / `taskTableStatusFilter`）而非单对象，与既有 `taskViewMode` 的单 key 粒度一致、diff 最小。
- 日期快捷项持久化后按当天重算，属预期语义，不做「过期重置」。
