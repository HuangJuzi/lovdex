# 看板/表格排除定时任务跑出来的任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务页的看板与表格不再显示定时任务跑出来的任务（`source_schedule_id` 非空），但收件箱仍保留它们并加「⏰ 定时」标记。

**Architecture:** 纯前端，**零后端改动**。`TaskBoardPage` 已经有全量 `tasks` 与筛选后的 `filteredTasks`；本次只把**看板与表格这两个消费者**换成「排除定时来源」的那一份（新纯函数 `manualTasksOf`），收件箱与运行记录保持现状。过滤放前端而不是后端，是因为**运行记录需要全量数据** —— 后端若默认排除，运行记录就拿不到东西了。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind。测试是 `node:test` + `node:assert/strict`，组件用 `react-dom/server` 的 `renderToStaticMarkup` 做静态标记冒烟 —— **没有 DOM**，effect 与交互都不执行，所以逻辑必须抽成纯函数才能测。

**Spec:** `docs/superpowers/specs/2026-09-22-task-board-exclude-scheduled-runs-design.md`

---

## 环境准备（每个任务开始前都要做）

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH          # 全局 export 的 server/tsconfig.json 会让 npx tsx 读错配置
```

**基线数字（2026-09-22 实测，改动前）：**

| 检查 | 基线 |
|---|---|
| `npm run typecheck` | **0 个错误** |
| `npx eslint src/components/tasks/taskFilter.ts` | 0 problems |
| `npx eslint src/components/tasks/taskFilter.test.ts` | 0 problems |
| `npx eslint src/components/tasks/TaskInboxPanel.tsx` | 0 problems |
| `npx eslint src/components/tasks/TaskInboxPanel.test.tsx` | 0 problems |
| `npx eslint src/components/tasks/TaskBoard.tsx` | 0 problems |
| `npx tsx --test src/components/tasks/taskFilter.test.ts` | 35 pass |
| `npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx` | 12 pass |

**验收判据是「这几个文件的数字不增加」，不是「仓库总数为 0」** —— 仓库里有另一个 session 在并发改文件。

**提交注意：** 工作区被两个 session 共用。提交一律用**单条原子命令带 pathspec**，别用 `git commit --amend`、别 rebase、别 `git add -A`：

```bash
git add <file> && git commit -m "<msg>" -- <file>
```

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `web/src/components/tasks/taskFilter.ts` | 改 | 新增纯函数 `manualTasksOf`（`filterTasks` / `isTaskFilterActive` 的同级邻居） |
| `web/src/components/tasks/taskFilter.test.ts` | 改 | `manualTasksOf` 的单测，含与 `runsOf` 的互补性护栏 |
| `web/src/components/tasks/TaskBoard.tsx` | 改 | 新增 `boardTasks`，看板 `groups` 与 `TaskTableView` 改用它；收件箱与运行记录不动 |
| `web/src/components/tasks/TaskInboxPanel.tsx` | 改 | 定时来源的条目加「⏰ 定时」标记 |
| `web/src/components/tasks/TaskInboxPanel.test.tsx` | 改 | 上面这个标记的两条静态标记断言 |

**不改**：后端任何文件、`web/src/types/app.ts`、`web/src/utils/api.js`、`ScheduledRunHistoryView.tsx`（`runsOf` 留在原地）、`ScheduledTasksPanel.tsx`、`TaskCard.tsx`（它的「⏰ 定时」徽标在看板里变得不可达，但它是通用展示组件且 `TaskDetail` 的同款徽标仍可达 —— 删掉会让它对传入的任务撒谎，**保留**）。

---

## Task 1: 看板/表格排除定时来源任务

**Files:**
- Modify: `web/src/components/tasks/taskFilter.ts`
- Modify: `web/src/components/tasks/taskFilter.test.ts`
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/tasks/taskFilter.test.ts` 里，**先补 import** —— 现有的 `from './taskFilter'` 那块加 `manualTasksOf`，并在文件顶部再加一条跨模块 import：

```ts
import { runsOf } from './ScheduledRunHistoryView';
```

```ts
import {
  EMPTY_TASK_FILTER,
  filterTasks,
  isTaskFilterActive,
  manualTasksOf,
  normalizeTaskFilter,
  resolveDateRange,
  toggleProjectFilter,
  type TaskFilter,
} from './taskFilter';
```

然后在文件末尾追加三条测试：

```ts
test('manualTasksOf 滤掉定时任务跑出来的任务', () => {
  const tasks = [
    mkTask({ task_id: 'manual-1' }),
    mkTask({ task_id: 'run-1', source_schedule_id: 's1' }),
    mkTask({ task_id: 'manual-2' }),
  ];
  assert.deepEqual(manualTasksOf(tasks).map((t) => t.task_id), ['manual-1', 'manual-2']);
});

test('manualTasksOf 空数组还是空数组', () => {
  assert.deepEqual(manualTasksOf([]), []);
});

// 护栏：两个谓词互为补集。任何一边改了判据（比如将来加个「仅提醒不算」的例外），
// 这条会立刻红 —— 否则「看板少一行」和「运行记录多一行」会各自漂移很久才被发现。
test('manualTasksOf 与 runsOf 互为补集', () => {
  const tasks = [
    mkTask({ task_id: 'a' }),
    mkTask({ task_id: 'b', source_schedule_id: 's1' }),
    mkTask({ task_id: 'c', source_schedule_id: 's2' }),
    mkTask({ task_id: 'd' }),
  ];
  const manual = manualTasksOf(tasks).map((t) => t.task_id);
  const runs = runsOf(tasks).map((t) => t.task_id);

  assert.equal(manual.length + runs.length, tasks.length);
  assert.deepEqual([...manual, ...runs].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(manual.filter((id) => runs.includes(id)).length, 0);
});
```

（`mkTask` 工厂已存在，默认 `source_schedule_id: null`，无需改。）

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --test src/components/tasks/taskFilter.test.ts
```

Expected: FAIL —— `manualTasksOf is not a function`（或 TS 报 `has no exported member 'manualTasksOf'`）。

- [ ] **Step 3: 写实现**

在 `web/src/components/tasks/taskFilter.ts` 的 `filterTasks` 之后（`isTaskFilterActive` 之前）插入：

```ts
/**
 * 手动建的任务 —— 看板/表格只显示这些。定时任务跑出来的任务去「定时 → 运行记录」里看。
 *
 * 与 `ScheduledRunHistoryView.tsx` 的 `runsOf` **互为补集**：这里是 `!source_schedule_id`，
 * 那边是 `source_schedule_id`。两个谓词必须同步改，`taskFilter.test.ts` 里有互补性护栏。
 */
export function manualTasksOf(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.source_schedule_id);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --test src/components/tasks/taskFilter.test.ts
```

Expected: PASS —— **38 个 test 全绿**（35 + 3）。

- [ ] **Step 5: 接线 `TaskBoard.tsx`**

**5a.** import 那行（约第 29 行）加上 `manualTasksOf`：

```tsx
import { EMPTY_TASK_FILTER, filterTasks, isTaskFilterActive, manualTasksOf, normalizeTaskFilter } from './taskFilter';
```

**5b.** 把这两行：

```tsx
  const filteredTasks = useMemo(() => filterTasks(tasks, filter, now), [tasks, filter, now]);
  const groups = useMemo(() => groupByStatus(filteredTasks), [filteredTasks]);
```

改成：

```tsx
  const filteredTasks = useMemo(() => filterTasks(tasks, filter, now), [tasks, filter, now]);
  // 看板/表格只显示手动建的任务 —— 定时任务跑出来的去「定时 → 运行记录」里看。
  // 收件箱仍收全量的 filteredTasks：无人值守的任务失败/卡住最需要被提醒，全静默反而危险。
  const boardTasks = useMemo(() => manualTasksOf(filteredTasks), [filteredTasks]);
  const groups = useMemo(() => groupByStatus(boardTasks), [boardTasks]);
```

**5c.** 把 `<TaskTableView>` 的 `tasks` prop 换成 `boardTasks`：

```tsx
            <TaskTableView
              tasks={boardTasks}
```

**不要动**：
- `<TaskInboxPanel tasks={filteredTasks} …>` —— 收件箱仍要看全部（含定时来源）。
- `<ScheduledTasksPanel … tasks={tasks} …>` —— 运行记录需要全量。
- 批量删除的选中集剪枝（`const ids = new Set(tasks.map(…))`）—— 它按全量剪，定时来源的行根本渲染不出来、选不上，无害。

- [ ] **Step 6: typecheck 必须 0 错误**

```bash
npm run typecheck
```

Expected: PASS —— 0 个错误。

- [ ] **Step 7: lint 三个文件**

```bash
npx eslint src/components/tasks/taskFilter.ts src/components/tasks/taskFilter.test.ts src/components/tasks/TaskBoard.tsx 2>&1 | grep -E '^✖'
```

Expected: 三个文件都 **0 problems**（与基线一致）。若报 `import-x/order`，按报错行补 import 分组之间的空行。

- [ ] **Step 8: 跑相关测试**

```bash
npx tsx --test src/components/tasks/taskFilter.test.ts
npx tsx --test src/components/tasks/TaskTableView.test.tsx
npx tsx --test src/components/tasks/TaskCard.test.tsx
npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
```

Expected: 全绿（`taskFilter` 38 pass，其余与改动前一致）。

- [ ] **Step 9: 提交**

```bash
git add web/src/components/tasks/taskFilter.ts web/src/components/tasks/taskFilter.test.ts web/src/components/tasks/TaskBoard.tsx && git commit -m "feat(tasks): keep scheduled runs off the board and table" -- web/src/components/tasks/taskFilter.ts web/src/components/tasks/taskFilter.test.ts web/src/components/tasks/TaskBoard.tsx
```

---

## Task 2: 收件箱加「⏰ 定时」标记

**Files:**
- Modify: `web/src/components/tasks/TaskInboxPanel.tsx`
- Modify: `web/src/components/tasks/TaskInboxPanel.test.tsx`

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/tasks/TaskInboxPanel.test.tsx` 末尾追加两条：

```tsx
test('定时任务跑出来的条目带「⏰ 定时」标记', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({
          task_id: 'r1',
          title: '定时跑出来的任务',
          status: 'in_progress',
          sub_status: 'failed',
          source_schedule_id: 's1',
        }),
      ],
      now: NOW,
    }),
  );
  assert.match(html, /定时跑出来的任务/);
  assert.match(html, /⏰ 定时/);
});

test('手动建的条目不渲染「⏰ 定时」标记', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskInboxPanel, {
      tasks: [
        mkTask({ task_id: 'm1', title: '手动建的任务', status: 'in_progress', sub_status: 'failed' }),
      ],
      now: NOW,
    }),
  );
  assert.match(html, /手动建的任务/);
  assert.doesNotMatch(html, /⏰ 定时/);
});
```

（该文件的 `mkTask` 工厂已存在，默认 `source_schedule_id: null`，无需改。）

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx
```

Expected: 第一条 FAIL（`⏰ 定时` 还不存在），第二条 PASS。

- [ ] **Step 3: 写实现**

在 `web/src/components/tasks/TaskInboxPanel.tsx` 里，找到项目名那一段（约第 86 行）：

```tsx
                  <span className="max-w-40 truncate">{info.label}</span>
                  {info.remoteHost && (
```

在两者之间插入：

```tsx
                  {item.task.source_schedule_id && (
                    <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-3xs font-semibold text-warning">
                      ⏰ 定时
                    </span>
                  )}
```

视觉对齐 `TaskCard.tsx:85-89` / `TaskDetail.tsx:497` 的同款徽标（`bg-warning/10 … text-warning`），尺寸 `text-3xs` 与紧邻的远程主机标记（`rounded-full bg-muted px-1.5 py-0.5 text-3xs …`）一致。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx
```

Expected: PASS —— **14 个 test 全绿**（12 + 2）。

- [ ] **Step 5: typecheck + lint**

```bash
npm run typecheck
npx eslint src/components/tasks/TaskInboxPanel.tsx src/components/tasks/TaskInboxPanel.test.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck 0 错误；两个文件 **0 problems**。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/tasks/TaskInboxPanel.tsx web/src/components/tasks/TaskInboxPanel.test.tsx && git commit -m "feat(tasks): mark scheduled runs in the attention inbox" -- web/src/components/tasks/TaskInboxPanel.tsx web/src/components/tasks/TaskInboxPanel.test.tsx
```

---

## Task 3: 全量验收

**Files:** 无（只跑检查与手工验证）

- [ ] **Step 1: typecheck 与 lint 全量复核**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH
npm run typecheck
npx eslint src/components/tasks/taskFilter.ts src/components/tasks/taskFilter.test.ts src/components/tasks/TaskBoard.tsx src/components/tasks/TaskInboxPanel.tsx src/components/tasks/TaskInboxPanel.test.tsx 2>&1 | grep -E '^✖'
```

Expected: typecheck **0 错误**；eslint 五个文件全 **0 problems**。

- [ ] **Step 2: 跑相关测试**

```bash
npx tsx --test src/components/tasks/taskFilter.test.ts
npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx
npx tsx --test src/components/tasks/TaskTableView.test.tsx
npx tsx --test src/components/tasks/TaskCard.test.tsx
npx tsx --test src/components/tasks/TaskFilterBar.test.tsx
npx tsx --test src/components/tasks/ScheduledRunHistoryView.test.tsx
npx tsx --test src/components/tasks/ScheduledTasksView.test.tsx
npx tsx --test src/components/tasks/runHistoryDelete.test.ts
```

Expected: 全绿（`taskFilter` 38、`TaskInboxPanel` 14，其余与改动前一致）。

- [ ] **Step 3: 确认后端零改动**

```bash
cd /mnt/b/workdir/github/lovdex && git log --oneline -3
```

再对本次的两个提交逐个确认 `git show --stat <sha>` 里**没有 `backend/` 文件**。

- [ ] **Step 4: 手工 E2E（浏览器，走 `:5188` → 后端 `:3188` 的 live dev server）**

先确认 vite 在跑：`ss -lntp | grep 5188`。用 puppeteer-core + 缓存 chromium（`~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome`），**断言走 DOM / computed style，不靠截图**。登录走 `POST http://localhost:3188/api/auth/login`（`zhiju.huang@sophgo.com` / `888888`），拿到 token 后 `localStorage.setItem('auth-token', token)`。

先从 API 取样本，各挑一条标题唯一的任务备用：

```bash
TOKEN=$(curl -s -X POST http://localhost:3188/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"zhiju.huang@sophgo.com","code":"888888"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3188/api/tasks -H "authorization: Bearer $TOKEN" | python3 -c "
import sys, json, collections
ts = json.load(sys.stdin)
runs = [t for t in ts if t.get('source_schedule_id')]
manual = [t for t in ts if not t.get('source_schedule_id')]
def uniq(cands):
    c = collections.Counter(t['title'] for t in cands)
    return next((t['title'] for t in cands if c[t['title']] == 1), None)
print('RUN_TITLE   =', uniq(runs))
print('MANUAL_TITLE=', uniq(manual))
print('runs:', len(runs), 'manual:', len(manual), 'total:', len(ts))
"
```

把打印出来的两个标题填进 E2E 脚本当断言目标（**必须标题唯一**，否则「不出现」的断言会被同名的另一条任务打脸）。

逐条走：

1. 开 `/tasks`（看板）→ 那条**定时来源**任务的标题**不出现**；那条**手动**任务的标题**出现**。
2. 切到表格视图（点 header 的「表格」）→ 同样：定时来源的不出现、手动的出现；且**表格实际行数 == 状态 pill 上「全部」的计数**（证明计数也跟着排除了）。
3. 开 `/tasks?view=scheduled&tab=runs` → 那条定时来源任务**仍在运行记录里**（没被误伤）。
4. 从运行记录点该任务的「打开任务」→ 详情页正常打开，且仍带「⏰ 定时」徽标。

**第 5 步需要合成数据**（收件箱标记在真实数据下看不到 —— 实测库里 26 条定时来源任务的 `sub_status` 只有 `NULL` 或 `'done'`，`'done'` 不在收件箱的信号表里，它们也没有 `deadline`）：

```bash
DB="$HOME/.lovdex/data/new-auth.db"
SCHED=$(sqlite3 "file:$DB?mode=ro" -cmd ".timeout 5000" "SELECT schedule_id FROM scheduled_tasks LIMIT 1;")
sqlite3 "$DB" -cmd ".timeout 8000" "INSERT OR REPLACE INTO tasks (task_id, project_path, title, status, executor_provider, position, sub_status, source_schedule_id, created_at, updated_at) VALUES ('e2e-inbox-1','/tmp/e2e','[E2E-INBOX] 定时失败样本','in_progress','claude',9100,'failed','$SCHED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);"
```

然后：
5. 刷新 `/tasks` → 该条出现在**收件箱**（`[data-testid="task-inbox"]`）里，且**带「⏰ 定时」标记**；同时它**不出现**在看板/表格里（收件箱与看板两处断言都要做）。
6. 清理（**必须做，且确认残留为 0**）：
```bash
sqlite3 "$DB" -cmd ".timeout 8000" "DELETE FROM tasks WHERE task_id='e2e-inbox-1'; SELECT '残留: ' || COUNT(*) FROM tasks WHERE task_id LIKE 'e2e-%';"
```

> **E2E 对真实数据只读**，唯一写库的是第 5 步那条自建自删的合成行。上一轮删除功能的 E2E 因为脚本选择器写错（全局按文本找「删除」按钮，撞上每行同名的按钮）误删了一条真实任务，见 `docs/superpowers/specs/2026-09-21-scheduled-run-history-delete-design.md` §8 的事故记录 —— **选择器一律限定作用域**（本次没有删除操作，风险面小，但仍按此纪律写）。

- [ ] **Step 5: 记录验收结果**

把 E2E 的实际结果追加到 spec 文档末尾，然后提交：

```bash
git add docs/superpowers/specs/2026-09-22-task-board-exclude-scheduled-runs-design.md && git commit -m "docs(tasks): record the board-exclusion E2E results" -- docs/superpowers/specs/2026-09-22-task-board-exclude-scheduled-runs-design.md
```

---

## 附：本功能依赖的关键事实（实现时不要重新推导）

| 事实 | 出处 |
|---|---|
| 任务页有全量 `tasks` 与筛选后的 `filteredTasks` 两份 | `TaskBoard.tsx:34`（`useTasks`）、`:85`（`filterTasks`） |
| 收件箱收的是 `filteredTasks` | `TaskBoard.tsx:479` |
| 表格收的是 `filteredTasks`（本次要换成 `boardTasks`） | `TaskBoard.tsx:489` |
| 看板列由 `groups` 驱动（本次要换成 `boardTasks`） | `TaskBoard.tsx:86` |
| 运行记录收的是全量 `tasks` | `TaskBoard.tsx:426` |
| `runsOf` 的判据（补集的另一半） | `ScheduledRunHistoryView.tsx:35-37` |
| 收件箱的信号表（`'done'` 不在其中，所以定时任务跑完不会进收件箱） | `taskInbox.ts:17-26` |
| 同款「⏰ 定时」徽标的视觉 | `TaskCard.tsx:85-89`、`TaskDetail.tsx:497` |
| 后端 `listTasks` 只支持 `projectPath` / `status` 两个过滤参数 | `backend/server/modules/database/repositories/tasks.db.ts:138-153` |
