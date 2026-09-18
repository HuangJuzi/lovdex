# 定时任务弹窗风格统一 + 模板名称 LLM 自动生成 设计

日期：2026-09-18
状态：已确认，待写实现计划

## 0. 背景与目标

定时任务不是独立页面，而是任务页的第三种视图（`TaskBoard.tsx` 的 `viewMode === 'scheduled'`），新建入口也共用同一个头部按钮（`TaskBoard.tsx:193-198` 的 `handleHeaderNew`）。但它的表单 `ScheduledTaskForm.tsx` 与普通任务的 `CreateTaskDialog.tsx` 观感完全脱节：

| 维度 | `ScheduledTaskForm`（现状） | `CreateTaskDialog` |
|---|---|---|
| 弹窗宽度 | `max-w-lg`（512px） | `sm:max-w-[66.7vw]` |
| 主输入 | 单行 `Input`（标题）+ 单行 `Input`（描述） | 大 `textarea`（`min-h-[180px] sm:min-h-[240px]`） |
| 选择器 | 原生 `<select>` × 4 + 原生 checkbox | `ChipSelect` 胶囊芯片 × 6 |
| 提交 | 底部「取消 / 保存」按钮 | 右下角圆形 `ArrowUp` |

本设计做两件事：

1. 把 `ScheduledTaskForm` 改成与 `CreateTaskDialog` 同构的混合布局 —— 主输入区、chip 工具条、圆形提交全部对齐，唯独「调度」保留一个常驻区块（调度是定时任务的核心字段，收进「更多」弹层会太藏）。
2. 定时任务模板的 `title` 支持留空由 LLM 生成，**时机与普通任务一致：保存时生成并落库**。

选择「保存时生成」而非「每次触发时生成」的理由：定时任务模板是长期存在的，每天触发都产出不同名字的任务会让任务列表难以辨认；且每次 dispatch 都调一次 LLM 会在调度路径上引入 3s 阻塞窗口。落库后每个实例共用同一个名字，LLM 只调用一次。

## 1. 前端组件结构

**改写 `web/src/components/tasks/ScheduledTaskForm.tsx`**，保持现有对外契约不变：

```tsx
export type ScheduledTaskFormProps = {
  open: boolean;
  initial?: ScheduledTask | null;
  projectOptions: TaskProjectOption[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (draft: ScheduledTaskDraft) => void;
};
```

`ScheduledTaskDraft` / `EMPTY_DRAFT` / `toDraft` 的结构不变（字段一一对应，`ScheduledTasksPanel.toApiBody` 无需改动）。

**新增导出纯函数**（对齐 `CreateTaskDialog.tsx:34-36` 的 `canSubmitNewTask`，供无 DOM 环境下的测试直接调用）：

```ts
export function canSubmitScheduledTask(description: string, submitting: boolean): boolean {
  return description.trim() !== '' && !submitting;
}
```

**复用现有原语**：`Dialog` / `DialogContent` / `DialogTitle` / `Input` / `Button`（`web/src/shared/view/ui/`）、`ChipSelect`、`AnchorPopover`、`useTaskEngineAvailability`、`useDeviceSettings`、`PRIORITY_*` / `LABEL_*` 元数据 —— 全部沿用 `CreateTaskDialog` 的用法，不新增任何共享组件。

**不再使用**：`TaskEngineSelect`（其 `<select>` 形态与 chip 语言冲突；引擎改由 `ChipSelect` 承载，可用性语义通过 `disabled` + 提交时内联报错保留）。

## 2. 字段映射与交互

```
┌ 新建定时任务（副标题：说清楚要做什么就行，其余都可以之后再补）┐
│  ┌──────────────────────────────────────────────────────┐ │
│  │ [大 textarea → description，autoFocus，min-h 180/240px] │ │
│  │                                                        │ │
│  │ 名称▾ 项目▾ 引擎▾ 优先级▾ 标签▾                     ↑  │ │ ← chip 行
│  └──────────────────────────────────────────────────────┘ │
│  ┌ 调度 ─────────────────────────────────────────────────┐ │
│  │ [单次 | 间隔 | Cron]   [条件字段]   [自动执行]        │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                     [取消] │
└────────────────────────────────────────────────────────────┘
```

- **`DialogContent`**：`max-h-[85vh] w-full sm:max-w-[66.7vw] overflow-y-auto`。
- **头部**：`DialogTitle`（无障碍）+ `<h2>`/`<p>` 副标题，照抄 `CreateTaskDialog.tsx:243-247` 的两行结构，标题文案随 `initial` 在「新建定时任务 / 编辑定时任务」间切换。
- **主输入**：`textarea` 绑 `draft.description`，外层包 `rounded-2xl border` 盒子，`focus-within` 高亮；`onKeyDown` 里 Enter 提交、Shift+Enter 换行。
- **名称 chip**：`AnchorPopover` 内放一个 `Input`。芯片文案为当前名称，名称为空时显示「名称」并使用虚线边框（`.border-dashed`）以暗示「还没填」。placeholder：「留空则由 AI 从描述生成」。
- **项目 / 优先级 / 标签 / 引擎 chip**：`ChipSelect`。项目选项沿用现有 `projectOptions`（含远端主机 `hint`）；引擎选项来自 `useTaskEngineAvailability`，助手项目下 `disabled`（与 `CreateTaskDialog.tsx:298-306` 一致）。
- **调度区块**：独立边框盒，常驻不折叠。
  - 分段控件 `单次 / 间隔 / Cron`，复用 `CreateTaskDialog.tsx:408-418`「摘要 / 原文」那套 `rounded-lg border bg-muted p-1` 的按钮分段样式，替换原来的 `<select>`。
  - `once` → `Input type="datetime-local"`；`interval` → `ChipSelect`（`INTERVAL_PRESETS`）；`cron` → `Input placeholder="0 9 * * *"`。三者互斥，只渲染当前分支对应的那一个（保留现有行为）。
  - `自动执行` → `aria-pressed` 开关 chip，右侧一行 `text-xs text-muted-foreground` 说明「关闭则仅生成提醒任务，不自动开跑」。
- **提交按钮**：`ml-auto` 的圆形 `bg-primary` 按钮，图标 `ArrowUp`；`submitting` 时换 `Loader2` 转圈并 `cursor-wait`（照抄 `CreateTaskDialog.tsx:325-340`，含 `aria-label` / `aria-busy`）。
- **底部**：只保留「取消」收尾行，**不设「重置」**。定时任务表单的实时校验只卡描述非空，误改几个 chip 的成本远低于误重置一整张填好的表单；而编辑态一旦有「重置」，「恢复初始值」与「丢弃本次修改」两种语义还会互相打架。取消/重开弹窗即可回到初始状态（`ScheduledTasksPanel` 本就用 `formKey` 强制重挂载）。

  注：`CreateTaskDialog` 是有「重置」的，但那是纯新建弹窗、重置即清空、语义无歧义，不能直接照搬。

## 3. 校验与提交

`ScheduledTaskForm.submit()` 的校验顺序（在现有基础上调整）：

1. 引擎不可用 → 内联报错 `engineAvailability.hint`（保留）
2. **`draft.description.trim()` 为空 → 内联报错「请先描述这个定时任务要做什么」**（新增）
3. ~~`draft.title.trim()` 为空 → 「标题不能为空」~~（**删除**）
4. `cron` 缺 `cronExpr` / `once` 缺 `runAt` / `interval` 间隔 ≤ 0 → 保留现有报错

`onSubmit(draft)` 仍然只负责把 draft 交出去，异步与错误处理留在 `ScheduledTasksPanel.submit()`。

**`toApiBody` 不改**：它本来就每次发送 `title: d.title`（`ScheduledTasksPanel.tsx:15`）。名称留空时传空串，后端据此触发取名；编辑时把名称清空即等于「重新生成」。这是本次改动**最容易踩的坑** —— 前端若在本地做任何兜底填名，后端的取名分支就永远不会进入（`CreateTaskDialog.tsx:178-181` 有同样的注释）。

**连击守卫**：取名最长会让 `POST` 阻塞一个 3s 阻塞窗口，期间弹窗仍开着。需要在 `ScheduledTasksPanel.submit()` 里加一个同步的 `submittingRef` 守卫（与 `CreateTaskDialog.tsx:170` 同因同法：`setState` 要等下一轮渲染，同一 tick 内的第二次调用读到的是旧值）。弹窗的 `onOpenChange` 关闭守卫也要一并改用这个 ref（现在是 `!submitting`，读 state 同样有窗口期）。

提交按钮的 `disabled` **只看 `canSubmitScheduledTask(draft.description, submitting)`** —— 即「描述非空 + 不在途」，调度字段（cron / 触发时间 / 间隔）的缺失仍走提交时的内联报错。这是刻意保留现状：现有表单的「保存」按钮也是常驻可点、点击后校验。不把调度字段并进 disabled 条件，是为了让按钮可用性判据保持单一，避免 `canSubmitScheduledTask` 的签名被撑成一个伪校验器。

## 4. 后端 · 模板标题留空时生成（保存时）

### 4.1 抽出共享函数

`tasks.service.ts:297-320` 的 `resolveCreateTitle` 与定时任务的需求完全一致。把它搬进 `backend/server/modules/tasks/services/task-title.ts`（该文件已是「纯逻辑、不触网、依赖注入」的定位）：

```ts
export async function resolveGeneratedTitle(input: {
  title?: string | null;
  description?: string | null;
  generateTitle: (input: { description: string | null }) => Promise<string | null>;
  blockingMs?: number;   // 默认 TITLE_BLOCKING_TIMEOUT_MS
}): Promise<{ title: string; writeBack: Promise<string | null> | null }>
```

行为与现状逐条对齐：

- 调用方给了非空 `title` → 原样返回，**永不触模型**
- 否则先 `deriveFallbackTitle(description)` 作兜底
- `description` 为空 → 直接返回兜底名，不调模型
- 有 `description` → 调 `generateTitle`（同步抛错吞掉，退回兜底）
- `raceTaskTitle(pending, fallback, blockingMs)` 决出要落库的标题，超时则把仍在途的 promise 作为 `writeBack` 交出去

`tasks.service.ts` 的 `resolveCreateTitle` 退化为对该函数的薄包装。**行为不变**，由 `tasks.service.title.test.ts`（242 行）兜住回归。

### 4.2 scheduler 接线

`backend/server/modules/scheduler/services/scheduler.service.ts`：

- `SchedulerDeps` 增加与 `TasksService` 同契约的可选依赖：
  ```ts
  generateTitle?: (input: { description: string | null }) => Promise<string | null>;
  titleBlockingMs?: number;
  ```
- 新增内部函数 `applyGeneratedTitle(scheduleId, generated, placeholderTitle)`，形态照搬 `tasks.service.ts:269-283`：重新读行 → 做 CAS → 更新 → 广播；全程 try/catch。
- `create()` / `update()` 改为 `async`：先 `validateScheduleInput`，再 `await resolveGeneratedTitle(...)`，落库拿到 `writeBack` 时 `void writeBack.then((generated) => applyGeneratedTitle(row.schedule_id, generated, 落库用的兜底名))`（与 `tasks.service.ts:434-436` 同形）。

  **顺序不能反**：解析标题必须放在校验之后 —— 会 400 的请求不该花阻塞窗口（与 `tasks.service.ts:293-295` 同理）。

### 4.3 回写与广播

超时后模型迟到返回时：

- CAS：重新读一次当前行，**仅当 `title` 仍等于我们写入的兜底名**才覆盖（用户在这期间改了名就让位）。定时任务行没有 `status` 字段，所以不复用 `shouldApplyGeneratedTitle`，只做 `title` 比较。
- 覆盖成功 → 再广播一次 `scheduled_task_upserted`。
- 全程 try/catch，失败只 `console.error`，绝不冒泡（fire-and-forget 漏挂 catch 就是一次 unhandledRejection）。

前端 `useScheduledTasks` 已经在监听 `scheduled_task_upserted`，这条广播白拿。

### 4.4 路由与接线

- `scheduler.routes.ts`：`POST /` 与 `PATCH /:scheduleId` 改为 `await svc.create(...)` / `await svc.update(...)`（`asyncHandler` 已在用）。
- `SchedulerServiceLike` 的 `create` / `update` 返回类型改为 `Promise<unknown>`。
- `backend/server/index.js`：把 `createTasksService` 里内联的 `generateTitle` 闭包（L478-483）提成一个 `const generateTitle = ({ description }) => requestTaskTitle({ description, runOneShot: runOneShotClaudeText, model: getAppConfig().get().oneshot.titleModel })`，定义在 `createTasksService`（L469）**之前**，同时喂给 `tasksService` 和 `schedulerService`（L576-585）。

### 4.5 调度路径的既有行为

`dispatch()`（`scheduler.service.ts:74-84`）传的是 `title: schedule.title`。标题在保存时已生成并落库，因此**调度触发路径不再进入取名分支**，`scheduler.service.ts:71-73` 那条「模板标题为空时最多阻塞一个 blocking window」的注释可以删掉。仅当历史遗留的空标题模板被触发时才会走一次取名（此时行为与现状一致，不会更差）。

## 5. 降级与错误处理

| 场景 | 行为 |
|---|---|
| 模型失败 / 超时 / 没配 key | 落库描述首行（`deriveFallbackTitle`，50 字素截断）；**保存绝不因此失败** |
| 描述为空 | 不调模型，直接用 `FALLBACK_TITLE`（`未命名任务`）。前端已把描述设为必填，正常路径到不了 |
| 阻塞窗口超时 | 先落兜底名并返回 201，模型回来后 CAS 回写 + 补广播 |
| 回写时用户已改名 | 让位，不覆盖 |
| 回写时任务已被删除 | 读不到行，静默返回 |

## 6. 测试计划

### 前端（`node:test` + `renderToStaticMarkup`，无 DOM 环境）

- `canSubmitScheduledTask`：描述为空 / 纯空白 / 在途 → false；描述非空且不在途 → true
- `toApiBody`：名称留空时 `title === ''`（**关键回归点**，防止有人在本地兜底填名）
- `ScheduledTaskForm` 静态渲染：默认渲染出调度分段且停在「单次」；名称 chip 存在
- **改现有 `ScheduledTaskForm.test.tsx`**：`引擎 select 在 availability loading 时 disabled` 一条断言的是 `<select>`，改成 chip 后需重写；`远端项目选项 host 前缀` 一条断言的是 `<option>`，同样需改成 chip 弹层内的选项

### 后端

- `task-title.ts` 的 `resolveGeneratedTitle`：给了标题不调模型 / 描述空不调模型 / 模型返回 null 降级 / 同步抛错存活 / 超时返回兜底 + 带出 `writeBack`
- `scheduler.service`：空标题走模型 / 给了标题不调模型 / 超时降级 + 迟到回写 + 二次广播 / 回写时已被改名则让位 / 回写失败不抛
- `scheduler.routes`：`POST /api/scheduled-tasks` 传空 title 时返回体里是生成后的名字

测试基座沿用现有写法：`node:test` + `node:assert/strict`，`@/` 路径别名，手工函数替身（不用 mock 框架），见 `backend/server/modules/tasks/tests/task-title-llm.test.ts`。

## 7. 不在范围内

- **模型 chip**：定时任务表单目前没有 `executor_model` 字段，编辑时后端保留原值。补它属于扩功能，不是风格统一。
- 定时任务列表（`ScheduledTasksView.tsx`）的手写表格 / 卡片：本次不动。
- `ScheduledTaskForm` 之外的任何弹窗。
- 移动端适配调整：chip / `AnchorPopover` 本身已带 `<640px` 抽屉形态，沿用即可。

## 8. 影响面与风险

- **`ScheduledTaskForm.test.tsx` 必然失败**，需同步重写（见 §6）。
- **描述改必填的副作用**：编辑一条 `description` 为 null 的历史定时任务时，会被要求补描述才能保存。已确认接受 —— 模板没有描述本来也没有意义，且后端会拿它取名。
- **`ScheduledTasksPanel.submit()` 无测试覆盖**（现状即如此），连击守卫只能靠代码审查，本次不补 panel 层测试。
- **`resolveGeneratedTitle` 的抽取**触碰了已上线且测试充分的建任务取名路径；`tasks.service.title.test.ts` 是主要安全网，实现时必须先跑通它再动 scheduler。
