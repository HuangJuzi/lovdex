# Task 页多项目筛选 + 任务批量删除 — 设计文档

> 状态：设计定稿 · 2026-08-17
> 定位：Task 页顶部筛选栏的项目维度从单选改为**多选**（🤖 Lovdex助手 并入多选），并在**表格视图与看板视图**都支持**批量删除**任务。
> 范围：前端 `web/src/components/tasks/`（+ `web/src/utils/api.js`）+ 后端 `backend/server/modules/tasks/`。

---

## 1. 背景与目标

Task 页现状（见 `2026-08-12-task-filter-table-design.md`、`2026-08-14-task-filter-persistence-design.md`）：

- 顶部筛选栏 `TaskFilter` 的项目维度是**单选** `<select>`，绑定 `projectPath: string`，且「🤖 Lovdex助手」作为一个特殊选项与项目互斥；另有独立的「只看助手」开关 `assistantOnly: boolean`。
- 任务只能逐个删除：详情页「删除」按钮走 `DELETE /api/tasks/:taskId`；列表页（表格/看板）没有删除入口。

**目标**：

1. 项目筛选支持**同时勾选多个项目**（含助手），一次筛出多个项目下的任务。
2. 表格视图与看板视图都支持**勾选多个任务并批量删除**，一次删除 N 个任务。

**不做的**（刻意排除）：

- 不改「只看助手」以外的其它筛选维度（日期字段 / 快捷项 / 自定义范围保持不变）。
- 不做批量修改项目 / 批量标记完成等其它批量操作（YAGNI）。
- 不做撤销（删除即删，与现有单删一致）。
- 不引入复杂下拉组件库，复用仓库现有 Tailwind 风格自建轻量多选下拉。

---

## 2. 方案选型

### 2.1 项目筛选：助手并入多选（已确认）

`TaskFilter.projectPath: string` → `projectPaths: string[]`；`assistantOnly` 删除，助手以 `ASSISTANT_OPTION_VALUE` 哨兵作为多选集里的一个普通可选项。理由：语义统一（助手本就是「一个项目」）、UI 更简洁、避免「多选 + 独立开关」的双重心智负担。

### 2.2 批量删除：新增后端批量接口（选方案 A）

| 方案 | 做法 | 优劣 |
|---|---|---|
| **A 新增批量接口（选）** | `POST /api/tasks/batch-delete`，body `{ taskIds: string[] }`，service 循环删库并逐个 `emit task_deleted` | ✅ 单请求、失败好处理、符合 route→service→db→ws 分层；ws 事件自动把看板/表格里对应行移除。❌ 需加一条路由 + service 方法 + 校验。 |
| B 前端循环调用 | 前端 `for` 逐个 `DELETE /api/tasks/:id` | ✅ 零后端改动。❌ N 个请求、部分失败需自行兜底、选得多时慢且易闪断。 |

---

## 3. 改动设计

### 3.1 筛选数据模型与逻辑 `taskFilter.ts`

```ts
export type TaskFilter = {
  projectPaths: string[];   // 原 projectPath: string；含 ASSISTANT_OPTION_VALUE 表示选了助手
  dateField: TaskDateField; // 不变
  preset: TaskFilterPreset; // 不变
  customFrom: string;       // 不变
  customTo: string;         // 不变
};                            // assistantOnly 删除

export const EMPTY_TASK_FILTER: TaskFilter = {
  projectPaths: [],
  dateField: 'created',
  preset: 'all',
  customFrom: '',
  customTo: '',
};
```

**迁移函数** `normalizeTaskFilter(raw: unknown): TaskFilter`：

- 入参是「旧形状」`{ projectPath: string, assistantOnly?: boolean, ... }` 或「新形状」`{ projectPaths: string[], ... }`，或 `undefined/null`。
- 规则：
  - `projectPaths` 缺失时，若旧 `projectPath` 非空则 `projectPaths = [projectPath]`；否则 `[]`。
  - 若旧 `assistantOnly === true` 且 `projectPaths` 未包含助手哨兵，则 `projectPaths = [ASSISTANT_OPTION_VALUE]`（与旧「只看助手」语义等价）。
  - 其它字段（`dateField`/`preset`/`customFrom`/`customTo`）缺省补 `EMPTY_TASK_FILTER` 对应值。
- 用途：`TaskBoard` 读取 `useLocalStorage('taskFilter')` 后过一遍此函数，实现老用户无感迁移（见 §3.4）。

**过滤逻辑** `filterTasks` 项目维度：

```ts
const paths = filter.projectPaths;
if (paths.length > 0) {
  const match =
    (paths.includes(ASSISTANT_OPTION_VALUE) && task.is_operator === 1) ||
    paths.includes(task.project_path);
  if (!match) return false;
}
```

日期维度不变。助手任务 `project_path` 为空、`is_operator === 1`，普通任务反之，故二者不重叠。

### 3.2 筛选栏 UI `TaskFilterBar.tsx`（+ 新 `ProjectMultiSelect.tsx`）

- 单 `<select>` 换成自建多选下拉组件 `ProjectMultiSelect`：
  - **触发器**：一个按钮显示「项目 · 全部项目 / N 个 / 已选标签」（复刻现有「项目」胶囊外观）。
  - **展开**：绝对定位 popover，内含可滚动勾选列表 —— 首项「🤖 Lovdex助手」，其后 `projectOptions`；底部「全选 / 清空」。
  - 点击外部关闭（`useRef` + `useEffect` mousedown 监听）；勾选项 `stopPropagation`。
  - 勾选即 `onChange({ ...filter, projectPaths: next })`。
- 移除「🤖 只看助手」按钮。
- `hasFilter`：`filter.projectPaths.length > 0 || preset !== 'all' || customFrom || customTo`。
- `filterSummary`（移动端摘要）：项目维度显示 `全部` / `N 个` / 已选标签拼接（过长截断）。

### 3.3 批量删除

**选择状态提升到 `TaskBoard.tsx`**（两个视图共享同一份 `selected`）：

```ts
const [selected, setSelected] = useState<Set<string>>(new Set());
const toggleSelect = (id: string) => setSelected(prev => {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
});
const selectAll = (ids: string[]) => setSelected(prev => {
  const next = new Set(ids);
  // 已全选则取消全选（表头复选框三态）
  if (ids.length > 0 && ids.every(id => prev.has(id))) return new Set();
  return next;
});
const clearSelection = () => setSelected(new Set());
```

- **剪枝**：`useEffect` 将 `selected` 里已不在 `tasks`（全量列表）中的 id 移除，避免已删/被刷新掉的 id 残留。
- **删除** `deleteSelected`：`window.confirm('确定删除选中的 N 个任务？此操作不可恢复。')` → `api.tasks.removeMany(ids)` → 成功后 `clearSelection()`；`task_deleted` ws 事件由 `useTasks` 自动把行从本地列表移除（`remove` 幂等，必要时也可本地补删）。

**操作条**（`selected.size > 0` 时渲染，位于视图上方一条横幅）：`已选 N 项 · 删除 · 取消选择`。删除按钮 `disabled` 于请求进行中，避免重复提交。

**表格视图 `TaskTableView.tsx`**：

- `COLUMNS` 前新增一列「选择」（`alignRight` 无需，无排序 `key`），表头是**全选复选框**（勾选当前 `filteredTasks` 全部 id），行首是**行复选框**。
- 新增 props：`selected: Set<string>`、`onToggleSelect(id)`、`onToggleSelectAll(ids)`。
- 复选框 `onClick={(e) => e.stopPropagation()}` 防止触发行点击跳转详情。

**看板视图 `TaskCard.tsx`**：

- 卡片右上角加一个小复选框（`stopPropagation`），勾选状态由 `selected.has(task.task_id)` 决定；`TaskBoard` 渲染卡片时传入 `selected` / `onToggleSelect`。

**`api.js`**：新增 `tasks.removeMany: (taskIds) => authenticatedFetch('/api/tasks/batch-delete', { method: 'POST', body: JSON.stringify({ taskIds }) })`。

### 3.4 后端批量接口

- 路由（`tasks.routes.ts`，置于 `/:taskId` 之前不影响，独立路径即可）：
  - `POST /api/tasks/batch-delete`，body `{ taskIds: string[] }`。
  - 校验：`Array.isArray(taskIds)`、每项为 string、去空、长度 ≤ 500（超限抛 `AppError` 400 `INVALID_REQUEST`）。
  - 返回 `{ success: true, deleted: n }`。
- service（`tasks.service.ts`）：

```ts
deleteTasks(taskIds: string[]): number {
  let n = 0;
  for (const id of taskIds) {
    resolveDb.deleteTask(id);
    emit({ kind: 'task_deleted', taskId: id, actor: 'user' });
    n++;
  }
  return n;
}
```

（与单删一致：只删 tasks 行，不级联删 session，不加状态守卫。）

### 3.5 迁移接线 `TaskBoard.tsx`

```ts
const [storedFilter, setFilter] = useLocalStorage<unknown>('taskFilter', EMPTY_TASK_FILTER);
const filter = useMemo(() => normalizeTaskFilter(storedFilter), [storedFilter]);
```

后续 `filter` / `setFilter` 均走新形状；首次用户交互即回写新形状到 localStorage。

---

## 4. 文件与测试

### 修改

| 文件 | 说明 |
|---|---|
| `web/src/components/tasks/taskFilter.ts` | `TaskFilter` 类型、`EMPTY_TASK_FILTER`、`normalizeTaskFilter`、`filterTasks` |
| `web/src/components/tasks/TaskFilterBar.tsx` | 多选下拉替换单选 + 移除只看助手 + 摘要/hasFilter |
| `web/src/components/tasks/ProjectMultiSelect.tsx` | 新增：多选下拉组件 |
| `web/src/components/tasks/TaskBoard.tsx` | filter 归一化、`selected` 状态、操作条、删除逻辑、给两个视图传 selection props |
| `web/src/components/tasks/TaskTableView.tsx` | 选择列 + 全选表头 + props |
| `web/src/components/tasks/TaskCard.tsx` | 卡片复选框 |
| `web/src/utils/api.js` | `tasks.removeMany` |
| `backend/server/modules/tasks/tasks.routes.ts` | `POST /api/tasks/batch-delete` |
| `backend/server/modules/tasks/services/tasks.service.ts` | `deleteTasks(ids)` |

### 测试

- **前端**（`node:test` + `tsx --test`；组件用 `react-dom/server` `renderToStaticMarkup` 冒烟）：
  - `taskFilter.test.ts`：多项目过滤、助手哨兵 + 项目混合、`normalizeTaskFilter` 旧→新迁移（`projectPath` 字符串、`assistantOnly:true`、缺字段）。
  - `TaskFilterBar.test.tsx`：多选下拉渲染（触发器文案、勾选项）、移除只看助手。
- **后端**（`node:test`）：`tasks.service` 新增 `deleteTasks` 用例（删除数量、逐个 `task_deleted` 事件、空数组、不存在 id 幂等）。
- 命令（参考）：前端 `cd web && npx tsx --test src/components/tasks/taskFilter.test.ts src/components/tasks/TaskFilterBar.test.tsx`；后端 `cd backend && npx tsx --test server/modules/tasks/tests/tasks.service.test.ts`。

---

## 5. 边界

- **迁移只做一次语义转换**：`normalizeTaskFilter` 只读时归一化，不主动回写；首次用户交互后新形状自然落盘。
- **空多选 = 全部项目**：`projectPaths: []` 表示不过滤项目（与现状 `projectPath: ''` 等价），下拉显示「全部项目」。
- **助手与真实项目可同时勾选**：过滤为 OR 关系（选了助手 + A 项目 → 显示助手任务 + A 项目任务），符合「多选同时看多个项目」的诉求。
- **批量删除无状态守卫**：running/in_progress 任务也可删（与现有单删一致）。若删除一个正在执行的任务，session 仍在后台，属既有单删语义的延伸，不新增处理。
- **选择剪枝范围**：以全量 `tasks` 为准（不是 `filteredTasks`），任务被筛掉但仍在列表里时选择保留。
- **全选范围**：表头「全选」勾选传入表格的 `filteredTasks`（即顶部筛选后的集合）；表格内部的状态筛选不影响「全选」范围。

---

## 6. 验证要点

1. 前端/后端测试全绿（命令见 §4）。
2. 手测：项目下拉勾选多个项目 → 表格与看板同时显示多个项目任务；勾选助手 → 只显示/叠加助手任务；取消全部 → 显示全部。
3. 手测：老用户 localStorage 里是旧 `{ projectPath: '/a', assistantOnly: true }` → 刷新后筛选正确迁移并生效，不报错。
4. 手测：表格视图勾选若干行 → 顶部出现「已选 N 项」操作条 → 删除 → 确认后行消失、选择清空；表头全选/取消全选。
5. 手测：看板视图卡片勾选 → 批量删除；跨视图切换后选择保持一致。
6. 手测：删除中按钮禁用，避免重复提交；删除失败给出错误且选择保留。
