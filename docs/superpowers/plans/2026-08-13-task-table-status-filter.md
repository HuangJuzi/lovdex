# Task 表格视图「状态」筛选 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Task 页表格视图加一行按看板列 `status` 的筛选 pills，未选中的状态分组不渲染。

**Architecture:** 纯函数 `toggleStatus` 承载勾选/取消逻辑（可单测）；`TaskTableView` 自持 `useState<TaskStatus[]>` 局部状态，顶部渲染 `PillBar` 筛选行，渲染循环按选中集合过滤分组。共享筛选模型 `TaskFilter`/`TaskFilterBar`/`filterTasks` 与看板视图零改动。

**Tech Stack:** React 18 + TypeScript（lovdex-cli，Vite）；测试用 `node:test` + `assert` + `react-dom/server` 的 `renderToStaticMarkup`。

---

## 前置约定

- 工作目录：`/mnt/b/workdir/github/lovdex/lovdex-cli`（独立 git 仓库）。
- 开跑前先 `git -C . status` 确认工作区干净、确认当前在哪个分支（仓库可能被其它 Claude 会话并行改动，勿劫持他人提交）。
- 建功能分支：`git switch -c feat/task-table-status-filter`。
- 测试命令（lovdex-cli 需 unset 全局 `TSX_TSCONFIG_PATH`）：
  - `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts`
  - `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskTableView.test.tsx`
- 类型检查：`npm run typecheck`。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/components/tasks/taskStatus.ts` | 新增 `toggleStatus` 纯函数（勾选/取消一列，返回归一化新数组） |
| `src/components/tasks/taskStatus.test.ts` | `toggleStatus` 单测 |
| `src/components/tasks/TaskTableView.tsx` | 结构调整 + 状态筛选行 + 渲染循环过滤 + 空占位 |
| `src/components/tasks/TaskTableView.test.tsx` | 静态冒烟：筛选行存在 |

---

## Task 1: `toggleStatus` 纯函数（TDD）

**Files:**
- Modify: `src/components/tasks/taskStatus.ts`
- Test: `src/components/tasks/taskStatus.test.ts`

- [ ] **Step 1: 写失败测试**

在 `taskStatus.test.ts` 顶部 import 增加 `toggleStatus` 与类型 `TaskStatus`：

```ts
import type { Task, TaskStatus } from '../../types/app';
import {
  STATUS_META, STATUS_ORDER, SUB_STATUS_META, SUB_STATUS_ORDER, groupByStatus,
  PRIORITY_ORDER, PRIORITY_META, LABEL_ORDER, LABEL_META,
  toggleStatus,
} from './taskStatus';
```

在文件末尾追加四个测试：

```ts
test('toggleStatus adds an unselected status', () => {
  assert.deepEqual(toggleStatus(['done'] as TaskStatus[], 'todo'), ['todo', 'done']);
});

test('toggleStatus removes a selected status', () => {
  assert.deepEqual(
    toggleStatus(['todo', 'in_progress', 'done'] as TaskStatus[], 'in_progress'),
    ['todo', 'done'],
  );
});

test('toggleStatus keeps result in STATUS_ORDER order', () => {
  assert.deepEqual(toggleStatus(['done'] as TaskStatus[], 'in_review'), ['in_review', 'done']);
});

test('toggleStatus does not mutate the input array', () => {
  const selected: TaskStatus[] = ['todo', 'done'];
  const out = toggleStatus(selected, 'in_progress');
  assert.deepEqual(selected, ['todo', 'done']);
  assert.notEqual(out, selected);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts`
Expected: FAIL，报 `toggleStatus is not a function`（import 未导出）。

- [ ] **Step 3: 写最小实现**

在 `taskStatus.ts` 的 `groupByStatus` 之后插入：

```ts
/** 切换某个看板列在表格状态筛选中的选中与否；返回新数组（不修改入参），按 STATUS_ORDER 排序。 */
export function toggleStatus(selected: TaskStatus[], status: TaskStatus): TaskStatus[] {
  const next = selected.includes(status)
    ? selected.filter((s) => s !== status)
    : [...selected, status];
  return STATUS_ORDER.filter((s) => next.includes(s));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts`
Expected: PASS（全部用例，含既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/taskStatus.ts src/components/tasks/taskStatus.test.ts
git commit -m "feat(tasks): add toggleStatus for table status filter"
```

---

## Task 2: `TaskTableView` 状态筛选行 + 渲染过滤（TDD）

**Files:**
- Modify: `src/components/tasks/TaskTableView.tsx`
- Test: `src/components/tasks/TaskTableView.test.tsx`

- [ ] **Step 1: 写失败冒烟测试**

在 `TaskTableView.test.tsx` 末尾追加：

```tsx
test('table renders status filter row with 全部 reset pill', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
      projectOptions: [],
    }),
  );
  assert.match(html, /data-testid="status-filter"/);
  assert.match(html, /全部/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskTableView.test.tsx`
Expected: FAIL，`data-testid="status-filter"` 与 `全部` 均未命中。

- [ ] **Step 3: 实现**

3a. 顶部 import 增加两行：

- `import type { Task, TaskStatus } from '../../types/app';` 保持不变（`TaskStatus` 已存在）。
- 在现有 `import { SubStatusBadge } from './SubStatusBadge';` 之后、`import { sortTasks ... } from './taskTable';` 附近，补充共享 UI 与 `toggleStatus`：

```ts
import { Pill, PillBar } from '../../shared/view/ui';
import { SubStatusBadge } from './SubStatusBadge';
import { sortTasks, type TaskSortDir, type TaskSortKey } from './taskTable';
import { groupByStatus, LABEL_META, PRIORITY_META, STATUS_META, STATUS_ORDER, toggleStatus } from './taskStatus';
```

（即：`taskStatus` 的 import 行末尾加 `toggleStatus`；新增一行 `import { Pill, PillBar } from '../../shared/view/ui';`。）

3b. 在组件函数体内加状态（放在现有 `const [sortDir, setSortDir] = ...` 之后）：

```ts
const [selected, setSelected] = useState<TaskStatus[]>(() => [...STATUS_ORDER]);
```

3c. 替换整个 return 块（从 `return (` 到函数结尾的 `);`，保留开头的 `if (tasks.length === 0) { ... }` 早退不变）。原 return 是一个 `overflow-x-auto` 卡片包着 `<table>`；换成「外层 flex 列卡片 + 筛选行 + 内层滚动区」：

```tsx
  const visibleStatuses = STATUS_ORDER.filter((s) => selected.includes(s));
  const hasVisibleRows = visibleStatuses.some((s) => groups[s].length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[0_3px_0_rgba(30,27,50,0.07),0_12px_26px_rgba(35,33,41,0.07)]">
      {/* 状态筛选行：固定，不随表格横向滚动 */}
      <div
        data-testid="status-filter"
        className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4"
      >
        <PillBar>
          <Pill
            isActive={selected.length === STATUS_ORDER.length}
            onClick={() => setSelected([...STATUS_ORDER])}
          >
            全部
          </Pill>
          {STATUS_ORDER.map((status) => (
            <Pill
              key={status}
              isActive={selected.includes(status)}
              onClick={() => setSelected((sel) => toggleStatus(sel, status))}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[status].color }} />
              {STATUS_META[status].label}
              <span className="text-xs text-muted-foreground">{groups[status].length}</span>
            </Pill>
          ))}
        </PillBar>
      </div>

      {/* 表格滚动区 */}
      <div className="min-h-0 flex-1 overflow-x-auto px-2 pb-4 sm:px-4">
        <table
          className="w-full min-w-[1080px] border-separate text-sm"
          style={{ borderSpacing: '0 7px' }}
        >
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const sortable = col.key !== undefined;
                return (
                  <th
                    key={col.label}
                    onClick={sortable ? () => toggleSort(col.key as TaskSortKey) : undefined}
                    className={`whitespace-nowrap px-4 pb-1 text-xs font-semibold text-muted-foreground ${
                      col.alignRight ? 'text-right' : 'text-left'
                    } ${sortable ? 'cursor-pointer select-none hover:text-foreground' : ''}`}
                  >
                    {col.label}
                    {sortable && sortKey === col.key && (
                      <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleStatuses.map((status) => {
              const rows = sorted(status);
              if (rows.length === 0) return null;
              return (
                <Fragment key={status}>
                  <tr>
                    <td colSpan={9} className="px-2 pb-1">
                      <div className="flex items-center gap-2 px-2 text-sm font-semibold">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: STATUS_META[status].color }}
                        />
                        {STATUS_META[status].label}
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {rows.length}
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    </td>
                  </tr>
                  {rows.map((task) => (
                    <TaskRow
                      key={task.task_id}
                      task={task}
                      projectOptions={projectOptions}
                      now={now}
                      onStart={onStart}
                      onStatusChange={onStatusChange}
                      onOpenSession={onOpenSession}
                      onProjectChange={onProjectChange}
                      onOpenTask={onOpenTask}
                    />
                  ))}
                </Fragment>
              );
            })}
            {!hasVisibleRows && (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  暂无任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
```

注意：`TaskRow`、`COLUMNS`、`sorted`、`toggleSort`、`groups`、`now` 等既有定义全部保留不动；只改 import、加 `selected` 状态、换 return。

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskTableView.test.tsx`
Expected: PASS（全部用例，含新增冒烟）。

- [ ] **Step 5: 类型检查 + 既有任务相关测试**

Run:
- `npm run typecheck`
- `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/taskStatus.test.ts`

Expected: typecheck 无错误；taskStatus 单测仍全绿。

- [ ] **Step 6: Commit**

```bash
git add src/components/tasks/TaskTableView.tsx src/components/tasks/TaskTableView.test.tsx
git commit -m "feat(tasks): status filter pills in table view"
```

---

## Task 3: 手测验证

- [ ] **Step 1: 起 dev 服务**

Run: `npm run dev`（lovdex-cli 根目录），打开 Task 页并切到「表格」视图。

- [ ] **Step 2: 验证筛选行为**

- 表格顶部出现「全部 · 待办 n · 进行中 n · 评审 n · 完成 n」筛选行，计数与各分组一致。
- 点「进行中」取消 → 该分组消失，其余列保留；再点 → 恢复。
- 点「全部」→ 一键恢复 4 列。
- 项目/日期筛选叠加状态筛选时，计数与分组正确。
- 全部取消勾选 → 表格内显示「暂无任务」占位行。
- 切「看板」→ 无此筛选行、零影响；再切回「表格」→ 状态筛选回到全选。

- [ ] **Step 3: 汇报结果**

确认无异常后向用户汇报；合并 main + push 前先与用户确认（见下）。

---

## 附：集成（合并 main + push，需用户确认）

lovdex-cli 仓库偏好：feature 分支完成后 fast-forward 合并进 `main` 并 push。此为**对外/不可逆操作**，执行前先与用户确认：

```bash
git -C /mnt/b/workdir/github/lovdex/lovdex-cli switch main
git -C /mnt/b/workdir/github/lovdex/lovdex-cli merge --ff-only feat/task-table-status-filter
git -C /mnt/b/workdir/github/lovdex/lovdex-cli push origin main
```

> 注意：仓库可能被其它会话并行改动，合并前先 `git status` + `git fetch` 确认 `main` 干净、无他人提交需要先整合。
