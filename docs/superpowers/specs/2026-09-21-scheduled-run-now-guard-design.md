# 定时任务「立即触发」的运行中守卫 设计

日期：2026-09-21
状态：已确认，待写实现计划

## 0. 背景与目标

定时任务列表每行都有一个 ▶ 立即触发（`ScheduledTasksView.tsx:94` 移动卡片 / `:160` 桌面表格），
它无条件可点、后端也从不拒绝。而 `dispatch`（`scheduler.service.ts:102`）每触发一次就是
`createTask` + `startExecution`，**新建一个任务并起一个 agent**。

于是：某条定时的上一轮还在跑时再点一次，同一个提示词会在同一个项目里跑起第二个 agent。用户要求
把这条路堵上——「正在运行的任务不能再触发，防止误触」。

> 已有的 `task-create-dedup` 指望不上：`tasks.service.ts:478` 的注释写明调度器**不传**
> `dedupIdentical`（定时任务本来就要反复建同名任务），所以重复提交闸门不覆盖这条路径。

## 1. 判定口径（核心）

```
blocked ⇔ 上一轮任务存在 && ( status === 'in_progress' && sub_status !== 'failed'
                             || 该任务的会话仍在流式输出 )
```

**为什么拿 `getTask` 的行**：`tasksService.getTask` 返回的是 `decorate()` 之后的行
（`tasks.service.ts:228`），`sub_status` 是**计算后**的值 —— 跑着的是 `running`，等你回答/
计划是 `waiting_answer` / `waiting_plan`，跑挂的仍停在 `in_progress` 槽位但标 `failed`。
所以「运行中 + 等人工都挡、跑挂的放行」恰好就是 `!== 'failed'` 这一条，不需要枚举标签。

> 注意：`!== 'failed'` 这个形式对**裸 DB 行**与 decorate 后的行结果相同（实现时逐输入比对过）。
> 用 `getTask` 的真正理由是「与 `deleteTask` 等守卫同一个查表口」以及**判据一旦从 `!== 'failed'`
> 改成按 `running` / `waiting_*` 枚举，decorate 算出的有效值才是前提** —— 不是「不用它就错」。

被 `!== 'failed'` 挡住的标签必须是有意识的选择（它们是 `decorate` 里合法的 in_progress 标签）：
`running` / `waiting_answer` / `waiting_plan` / `waiting_approval` / `blocked` / `only_plan` /
`needs_review` / 以及 `null`（无标签=正在跑）。**只有 `failed` 是明确的「上一轮已经终止、可以重来」**，
其余一律算「还没走完」——宁可让用户先去处理上一轮，也不放行第二个 agent。

**为什么还要看会话**：`status` 会骗人。任务页的「✓ 标记完成」在 `in_progress` 时也渲染
（`TaskDetail.tsx` 操作区），人工把一个正在跑的任务标成 `done` 之后 `status` 就不是
`in_progress` 了，但 agent 还在同一个项目里写文件。这一段与 `deleteTask`
（`tasks.service.ts:609`）、`session-transfer`、`operator-delete` 用的是同一个守卫。

**前后端的能力差**：前端只看得到 `status` / `sub_status`，看不到 `isSessionRunning`
（那是后端运行时的判断）。所以前端可能**漏挡**（上一条那情形），后端 409 兜底 —— 与
`2026-09-21-scheduled-run-history-delete-design.md` §2「仍可能撞 409」是同一条约束，
失败必须如实报出，不能静默吞掉。

**非目标口径**（记录在此以免后人以为是漏判）：
- 停用（`enabled=0`）的调度仍可手动触发 —— 现状如此，本次不改。
- `auto_run=0`（仅提醒）的上一轮建出来的是 `todo` 任务，不是 `in_progress` → 不挡，
  提醒可以反复触发。
- 上一轮跑完进了 `in_review` / `done` / `archived` → 不挡。

## 2. 后端

### 2.1 `scheduler.service.ts`

新增导出纯函数（与 `computeNext` / `initialNextRun` 同惯例，可被单测直接钉）：

```ts
/** 「上一轮还没结束」：in_progress 且不是 failed（跑挂的可以重来）。 */
export function isRunActive(task: Pick<TaskRow, 'status' | 'sub_status'> | null): boolean;
```

（`TaskRow` 要补进 `:7` 的 `@/shared/types.js` import —— 现在只导了 `ScheduledTaskRow` / `TaskEngine`。）

`SchedulerDeps`（`:10`）加两项：

```ts
tasksService: Pick<TasksService, 'createTask' | 'startExecution' | 'getTask'>;  // 加 getTask
isSessionRunning: (sessionId: string) => boolean;                               // 新增，必填
```

`isSessionRunning` 设**必填**而不是像 `deleteTask` 那样可选：漏注入会让整个守卫静默失效，
这正是本次要做的事，宁可在类型层面卡住。`index.js:637` 的 `createSchedulerService({...})`
补一行，复用 `chatRunRegistry.listRunningRuns()`（与 `index.js:540` 同一写法）。

`runNow`（`:358`）在 `dispatch` **之前**守卫：

```ts
async runNow(scheduleId: string): Promise<unknown> {
  const schedule = deps.scheduledTasksDb.getScheduledTask(scheduleId);
  if (!schedule) return null;
  if (blockingRunOf(schedule)) {
    throw new AppError(
      `schedule ${scheduleId} still has an unfinished run; settle or interrupt it first`,
      { code: 'SCHEDULE_RUNNING', statusCode: 409 },
    );
  }
  await dispatch(schedule);
  return { ok: true };
}
```

`blockingRunOf` 是 service 内部的非导出小函数：

```ts
function blockingRunOf(schedule: ScheduledTaskRow): TaskRow | null {
  const lastId = schedule.last_task_id;
  if (!lastId) return null;                      // 没跑过 → 放行
  const task = deps.tasksService.getTask(lastId);
  if (!task) return null;                        // 上一轮的任务已被删 → 放行
  if (isRunActive(task)) return task;
  // status 可能被人工改成 done，但会话其实还在流式输出
  if (task.session_id && deps.isSessionRunning(task.session_id)) return task;
  return null;
}
```

**守卫只加在 `runNow`，不加在 `dispatch`** —— 用户明确把范围限定在「立即触发」，自动到点补跑
的行为不变（见 §5 与 §7）。`scheduler.routes.ts` 不用改：`AppError` 由 `index.js:1994`
统一映射成 `{ success: false, error: { code, message } }` + `statusCode`。

**测试代价**：`scheduler.service.test.ts:88` 的 fake `tasksService` 要补 `getTask`，
`createSchedulerService` 的调用处要补 `isSessionRunning`。

### 2.2 在途闸门：`last_task_id` 是 dispatch 末尾才写的

§2.1 的守卫读的是**落库的** `last_task_id`，而它在 `dispatch` 的最后一步才更新
（`scheduler.service.ts:131`）。两次挨得很近的触发（两个标签页、或一次点击的请求还在路上）
可能**都读到旧的 `last_task_id`**，于是双双放行 —— 前端那道 ref 闸门只管得住同一个组件实例，
跨标签页管不到（`task-create-dedup.ts` 的注释把这件事说得很清楚）。

调度器是单进程，所以一个进程内的在途集合就够：

```ts
const inFlight = new Set<string>();   // scheduleId
```

`runNow` 进入时若 `inFlight.has(scheduleId)` → 抛 `SCHEDULE_RUNNING` / 409（文案区分：
「上一次触发还在派发中」），否则加入、`try/finally` 移除，`dispatch` 全程被覆盖（含
`last_task_id` 的写入）。**这是本次守卫里唯一能挡住「连点」的服务端保证**，前端 disabled 只是
让误触在点下去之前就被劝住。

残余窗口：`tick` 派发中的那一拍不在集合里（tick 不经过 `runNow`），理论上仍可能与一次手动触发
撞上 —— 窗口是 `dispatch` 的毫秒级，且下一拍才可能再撞，不在本次处理。

## 3. 前端

### 3.1 新模块 `web/src/components/tasks/scheduleRunNow.ts`

纯函数**不能**放进 `ScheduledTasksView.tsx`：那会触发 `react-refresh/only-export-components`
（该文件目前只导出组件与类型，是干净的），理由与 `runHistoryDelete.ts` 完全一致。也不引
组件依赖 —— 它只吃 `ScheduledTask` / `Task` 两个类型。

```ts
/** 每条调度「上一轮还没结束」的那个运行；map 里没有 = 可以触发。 */
export function blockingRunsBySchedule(schedules: ScheduledTask[], tasks: Task[]): Map<string, Task>;

/** 禁用原因的 title 文案，按 sub_status 说人话。 */
export function runNowBlockedReason(run: Task): string;

/** 立即触发失败的提示条文案（409 与其它失败分开说）。 */
export function runNowErrorMessage(title: string, status: number, body: unknown): string;
```

`runNowErrorMessage` 抽出来的理由与 `deleteOutcomeMessage` 一样：web 测试是
`node:test` + `renderToStaticMarkup`，**无 DOM、不跑 effect、不触发事件**，面板里的
`async function` 根本测不到。把「读 `error.code` / 拼标题」这段唯一有分支的逻辑挪到纯函数里，
面板就只剩接线（接线由 typecheck + E2E 兜）。

| 输入 | 返回 |
|---|---|
| `body.error.code === 'SCHEDULE_RUNNING'` | `「<title>」上一轮还没结束，先处理或中断它再触发` |
| 其它，`body.error.message` 是非空串 | `「<title>」<message>` |
| 其它，读不到 message | `「<title>」立即触发失败 (<status>)` |

`blockingRunsBySchedule` 用**全量任务列表**（panel 的 `tasks` prop）按 `task_id` 查，不复用
`runsOf` 的 `source_schedule_id` 过滤：这里的判据是「`last_task_id` 指向的那一行」，与运行记录
列表的筛选条件恰好重合只是巧合，绑上去会让两件事一起变。判定条件与后端 §1 的前半段逐字一致
（`status === 'in_progress' && sub_status !== 'failed'`）。

`runNowBlockedReason` 的四个分支（用测试逐条钉死）：

| `sub_status` | 文案 |
|---|---|
| `running` / `null` / 其它 | `上一轮还在运行中，先等它结束或中断它` |
| `waiting_answer` | `上一轮在等你回答，去会话里回复后才会继续` |
| `waiting_plan` | `上一轮在等你确认计划` |
| `waiting_approval` | `上一轮在等你批准权限请求` |

### 3.2 `ScheduledTasksPanel.tsx` —— 算 blocked、防连点、接 409

```ts
const blockedRuns = useMemo(() => blockingRunsBySchedule(schedules, tasks), [schedules, tasks]);
const [pendingRunNow, setPendingRunNow] = useState<Set<string>>(new Set());
const pendingRunNowRef = useRef<Set<string>>(new Set());
const [runNowError, setRunNowError] = useState<string | null>(null);
```

**在途闸门用 ref + state 双写**，理由与同文件 `submittingRef`（`:39` 注释）一样：`setState`
要等下一轮渲染才生效，同一 tick 里的第二次点击读到的还是旧值 —— 双击正好是这个 tick 内的场景。
ref 负责挡住第二次派发，state 负责把按钮渲染成 disabled。

`runNow`（`:86`）改为：

```ts
async function runNow(t: ScheduledTask) {
  const id = t.schedule_id;
  if (pendingRunNowRef.current.has(id) || blockedRuns.has(id)) return;   // 双保险
  pendingRunNowRef.current.add(id);
  setPendingRunNow(new Set(pendingRunNowRef.current));
  setRunNowError(null);
  try {
    const res = await api.scheduledTasks.runNow(id);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setRunNowError(runNowErrorMessage(t.title, res.status, body));
      console.error('runNow failed', body ?? res.status);
    }
    void refresh();
  } catch (e) {
    // 请求根本没发出去（断网 / 后端没起来）：没有 status 可用，直接说清。
    setRunNowError(`「${t.title}」立即触发失败：无法连接后端`);
    console.error('runNow failed', e);
  } finally {
    pendingRunNowRef.current.delete(id);
    setPendingRunNow(new Set(pendingRunNowRef.current));
  }
}
```

`void refresh()` 挪进 try（原来只在 `res.ok` 时刷新，失败时列表已经不同步了 —— 例如真的被
别的标签页抢先派发了一轮）。**不引入 Toast**：错误落到列表上方的内联条，与运行记录的结果条同位置。

### 3.3 `ScheduledTasksView.tsx` —— 禁用态与错误条

新增 props：

```ts
blockedRuns: Map<string, Task>;
pendingRunNow: Set<string>;
runNowError: string | null;
onDismissRunNowError: () => void;
```

桌面表格行（`:160`）与移动卡片（`:94`，需给 `ActionButton` 加 `disabled` 透传）：

```tsx
const blocked = blockedRuns.get(task.schedule_id) ?? null;
const pending = pendingRunNow.has(task.schedule_id);
const disabled = Boolean(blocked) || pending;
const title = blocked ? runNowBlockedReason(blocked) : pending ? '正在触发…' : '立即触发';
```

- `aria-label="立即触发"` 保持不变（现有断言依赖不到它，但保持可寻址）
- 禁用态换成 `text-muted-foreground/50 cursor-not-allowed`（对齐删除按钮的禁用样式），
  与可用态的 `text-info` 形成可见差别 —— **移动端没有 hover，title 看不到**，颜色是唯一线索
- 错误条渲染在列表**上方**（与 `ScheduledRunHistoryView` 的结果条同一位置）：把现有的
  「空态 / 表格+卡片」两个分支用一层容器包起来，错误条作为第一个子元素。空态下不可能有
  run-now 错误，但保持单一渲染点，不给两个分支各写一遍

## 4. 边界情况

| 情况 | 行为 |
|---|---|
| `last_task_id` 为空（没跑过） | 放行 |
| `last_task_id` 指向的任务已被删除 | 放行（查不到就不挡） |
| 上一轮 `auto_run=0`（仅提醒） | 建出来的是 `todo` → 放行，提醒可反复触发 |
| 上一轮 `failed` | 放行（跑挂了要能重来） |
| 上一轮进了 `in_review` / `done` / `archived` | 放行 |
| 上一轮 `blocked` / `only_plan` / `needs_review` | **挡**（仍算「没走完」，见 §1） |
| 人工把在跑的任务标成 `done` | 前端放行、后端 409 拒绝，错误条如实报出 |
| 连点两次 ▶ | 前端 ref 同步闸门 → 只派一次；即使漏网，§2.2 的服务端在途闸门再挡一次 |
| 两个标签页各点一次 | 前端互不可见；由 §2.2 的服务端在途闸门挡住 |
| 想强行再触发 | 去会话页「中断」上一轮（`ChatInterface` 的 `handleAbortSession` → `ActivityIndicator` 的中断按钮），不做 force 开关 |
| 停用（`enabled=0`）的调度 | 仍可手动触发（现状不变） |

## 5. 明确不做的

- **不改 `dispatch`**：自动到点补跑仍会在上一轮没跑完时照常派新一轮。这是用户明确划出的范围
  （「间隔 60s 的任务跑 10 分钟」会并发堆叠这件事仍然存在），**仅在 §7 记录备查**。
- **不做排队**（等上一轮结束自动补一次），只做拒绝。
- **不挡任务页的「开始执行 / 重试」与助手的 `start_task_execution`**：那是针对**某个具体任务**的
  显式操作（有会话时走「打开会话 / 重试当前会话」而非新建），与定时任务的「模板再派发」不是
  同一件事；本次只做后者。
- **不引入 Toast**，沿用 `console.error` + 内联提示条。
- **不做 force / 跳过守卫的开关**：需要时先中断上一轮。
- **不改停用逻辑**：停用不阻止手动触发，维持现状。

## 6. 测试与验收

**后端 `scheduler/tests/scheduler.service.test.ts`**（fake `tasksService` 补 `getTask`、
调用处补 `isSessionRunning`）：
- `isRunActive` 纯函数：`in_progress` + `null`/`running`/`waiting_answer`/`blocked` → true；
  `in_progress` + `failed` → false；`todo`/`in_review`/`done`/`archived` → false；`null` → false。
- `runNow`：上一轮 `in_progress` → 抛 `SCHEDULE_RUNNING` / 409，且**没有**建任务（`createTask`
  未被调用）；上一轮 `failed` → 正常派发；`last_task_id` 为空 → 正常派发；`last_task_id` 指向
  已不存在的任务 → 正常派发；上一轮 `done` 但 `isSessionRunning` 返回 true → 409。
- 在途闸门：让 `createTask` 返回一个未 resolve 的 Promise，两次 `runNow` 并发调用 →
  第二次 409，且 `createTask` 只被调用一次；第一次 settle 之后再调用 → 正常派发（闸门已释放）。
- `scheduler.routes.test.ts` 补一条：`runNow` 抛 `AppError(409)` 时路由把 409 + code 透出
  （现有 stub 只覆盖 `null` → 404）。

**新增 `web/src/components/tasks/scheduleRunNow.test.ts`**：
- `blockingRunsBySchedule`：`in_progress`+`null` → 在 map 里；`in_progress`+`failed` → 不在；
  `todo`/`in_review`/`done`/`archived` → 不在；`last_task_id` 为 `null` → 不在；`last_task_id`
  指向不在 `tasks` 里的 id → 不在；多条调度各归各的键；空 `schedules` → 空 map。
- `runNowBlockedReason`：§3.1 表格四条分支逐条断言（含 `null` 走默认文案那条）。
- `runNowErrorMessage`：§3.1 表格三条分支逐条断言（`SCHEDULE_RUNNING` 走专用文案；
  有 message 时原样带出；`body` 为 `null` / 结构不对时走 `(status)` 兜底）。

**`ScheduledTasksView.test.tsx`**（静态标记）：
- blocked 行的 ▶ 带 `disabled` 且 `title` 含「上一轮」。
- pending 行的 ▶ 带 `disabled`（无 blocked）。
- 正常行的 ▶ **不带** `disabled`。
- 传 `runNowError` 时渲染出该文案；不传时不渲染错误条。
- 桌面表格与移动卡片**两条渲染分支都要覆盖**（沿用 `ccbfa7c` 的做法：一次断言两套 DOM）。
- 回归护栏：现有 `ScheduledTasksView.test.tsx` **12 条**（实测全绿）、
  `ScheduledRunHistoryView.test.tsx` 12 条、`ScheduledTabBar.test.tsx` 4 条、
  `ScheduledTaskForm.test.tsx` 38 条必须保持全绿（现有用例没有「立即触发」断言，
  预计无回归 —— 跑一遍确认）。

**验收**：`npm run typecheck` 与 eslint 对本次改动文件**零新增**。web 测试显式跑文件
（仓库无 `npm test` 脚本）；后端测试带 `--tsconfig server/tsconfig.json`。

**手工 E2E**（puppeteer-core + 缓存 chromium 连 `:5188`，断言走 DOM / computed style，不靠截图）：
1. 制造一条「上一轮还在跑」的调度（点一次 ▶，等任务进入 `in_progress`），刷新页面 →
   桌面表格与窄屏卡片两套布局里的 ▶ 都是 `disabled`，`title` 是 §3.1 的文案。
2. **直接打后端**：`POST /api/auth/login {email, code}` 拿 token 后
   `POST /api/scheduled-tasks/:id/run-now` → 断言 **409 + `code: 'SCHEDULE_RUNNING'`**，
   且查库没有新增行（只读连接 `file:~/.lovdex/data/new-auth.db?mode=ro`，查 `tasks` 表
   `source_schedule_id` 计数）。**这是唯一能证明后端守卫真的生效的检查 —— UI 的 disabled
   只是前置过滤，绕过它就绕过了。**
3. 上一轮跑完后刷新 → 按钮恢复可点；点击 → 新建一条任务，运行记录里出现。
4. 上一轮 `failed` 的调度 → 允许触发。
5. 连点两次 ▶ → 查库 `tasks` 表只多出一条（`last_task_id` 对应的那条）。

## 7. 记录备查：自动到点补跑仍会并发（本次不修）

`tick` → `dispatch` 这条路没有任何「上一轮是否还在跑」的判断。`interval_seconds` 60 的任务
单轮跑 10 分钟，就会稳定堆起约 10 个并发 agent —— 它们还共用同一个 `project_path`。
`runNow` 的守卫**不覆盖**这条路径（守卫只在 `runNow` 里，按用户的显式范围）。

真要修，选项是「跳过这一拍」（简单，但 `computeNext` 的相位推进要跟着改，否则会追着一串
过期时刻补跑）或「排队等上一轮结束」（要引入待跑队列与状态）。两者都是独立的一件工作，
不在本次范围。

## 8. 记录备查：`isSessionRunning` 那类 409 之后，按钮仍是可点的（本次不修）

实现完成后的审查发现的用户可见瑕疵，不是 bug：

- 面板的 `refresh` 是 `useScheduledTasks` 的，只重取**调度表**；而 `blockingRunsBySchedule`
  用的任务行来自 props（`TaskBoard` 的 `useTasks`），面板刷不到它。
- 于是「人工把一个在跑的任务标成 done」那类 409（前端看不见 `isSessionRunning`，§1）之后：
  错误条在说「上一轮还没结束」，但按钮**仍是可点的**。
- 后果有限：后端权威，再点只会再拿一个 409，不会重复派发；WS 的 `task_upserted` 正常时
  也会自愈（上一轮真正结束后，该行状态变化会重算禁用态）。用户的处置与错误条给的建议一致。

要收口得给面板加一个「刷新任务列表」的回调（`TaskBoard` 已有 `onRunsDeleted` 这个先例，
`refresh` 就在手边），是独立的一小件工作，不在本次范围。
