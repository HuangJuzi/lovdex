# 自动审批即权限模式 设计

日期：2026-09-23
状态：已确认，待写实现计划
取代：`2026-09-23-session-auto-approve-toggle-design.md`（**已作废**，其实现已从 main 撤销）

## 0. 背景

自动审批（`2026-09-21-auto-approve-design.md`，已上线）是**任务属性**：`tasks.auto_approve` 布尔列。服务端在每次 `chat.send` 时按 `sessionId` 反查任务行，并**硬覆写**客户端传来的 `autoApprove`（防自我授权）。

两个后果：

1. **交互会话里没有任何入口能改它。** 定时任务跑完，你打开那个会话想接着聊——自动审批还开着，工具调用被静默放行或静默拒绝，你不再被询问，也无处可关。UI 上的开关只在「任务详情」和「定时任务表单」里。
2. **权限语义分裂。** composer 有一套权限模式（`default` / `auto` / `acceptEdits` / `bypassPermissions` / `plan`，provider 能力表决定），任务有另一套布尔开关，两者互不相通——同一个「这个 agent 要不要问我」的问题，有两个来源、两套 UI、两种存储。

本设计把「自动审批」并入权限模式体系：它成为**一个模式值**，任务与会话共用同一套语义、同一套选项。

## 1. 决策汇总

| 项 | 结论 | 理由 |
|---|---|---|
| 模式值 | 新增 Lovdex 层模式 `'autoApprove'` | 见 §2 |
| 下发方式 | 网关归一化成 `permissionMode: 'default'` + `autoApprove: true` | SDK 的 `PermissionMode` 是封闭联合，见 §2 |
| provider 运行时 | **零改动** | 四家本来就靠 `options.autoApprove === true` 判断 |
| 任务存储 | 新增 `permission_mode`（TEXT），`auto_approve` 列退场 | 一个模式存不下布尔值；见 §4 |
| 模式解析顺序 | 会话键 → 任务 → provider 上次 → provider 默认 | 见 §5 |
| 「执行 / 重试」按钮 | 走**同一条**解析 | 「一个会话一个权限模式」，见 §5.3 |
| 助手工具 | 仍不暴露该字段 | 助手不能给自己授予无人监督权限（沿用 2026-09-21 设计 §4.4） |
| 任务可选模式 | **排除 `plan`** | 无人值守下 plan = 只规划不执行 = 任务空跑，是纯粹的脚枪 |

## 2. 归一化：唯一的机制核心

### 2.1 为什么不能直接下发 `'autoApprove'`

SDK 的 `PermissionMode` 是**封闭联合**（`@anthropic-ai/claude-agent-sdk/sdk.d.ts:2044`）：

```
'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
```

而 `claude-sdk.js:261` 是：

```js
if (permissionMode && permissionMode !== 'default') {
  sdkOptions.permissionMode = permissionMode;
}
```

任何非 `default` 的值都会被原样交给 SDK 做 schema 校验。`'autoApprove'` 会被拒。

更关键的是**必须落在 `default`**：`canUseTool` 只在非 `bypassPermissions` 时才被调用（`claude-sdk.js:819` 那个分支），而自动审批策略正挂在 `canUseTool` 里。所以 `'autoApprove'` 的内部形态就是「`default` 模式 + `autoApprove` 标志」。

### 2.2 函数

`backend/server/modules/permissions/auto-approve-policy.ts` 新增：

```ts
const KNOWN_MODES = new Set(['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']);

export function normalizePermissionMode(mode: unknown): {
  permissionMode: string;
  autoApprove: boolean;
} {
  if (mode === AUTO_APPROVE_MODE) return { permissionMode: 'default', autoApprove: true };
  if (typeof mode === 'string' && KNOWN_MODES.has(mode)) {
    return { permissionMode: mode, autoApprove: false };
  }
  return { permissionMode: 'default', autoApprove: false };
}
```

`AUTO_APPROVE_MODE = 'autoApprove'` 导出为常量，前后端与测试共用同一个字面量，避免拼写漂移。

**未知值降级为 `default`**：与 `resolvePermissionModeForProvider`（前端）的既有兜底方向一致，也与 `headless-task-run.service.ts` 今天的硬编码一致。多出来的键（比如 `dontAsk`）刻意不进白名单——没验证过的模式不给放行。

### 2.3 两个调用点

| 路径 | 文件 | 改法 |
|---|---|---|
| 交互 + 任务板「执行/重试」 | `chat-websocket.service.ts` `handleChatSend` | 用 `normalizePermissionMode(clientOptions.permissionMode)` 展开进 `runtimeOptions` |
| 定时 / 助手 | `headless-task-run.service.ts` | 用 `normalizePermissionMode(options.permissionMode)` 替换今天写死的 `permissionMode: 'default'` + 条件 `autoApprove` |

两条路都用同一个函数，所以「模式 → 运行时行为」只有一处定义。

`index.js:629` 的 `startTaskRun` 从 `autoApprove: task?.auto_approve === 1` 改成 `permissionMode: task?.permission_mode ?? 'default'`。

### 2.4 被删除的东西

- `applyClientAutoApproveOverride`（本次重做中一度加过，被归一化取代）
- `resolveTaskAutoApprove`（归一化后 `chat.send` 不再查任务行，没有调用点）
- `ChatWebSocketDependencies.getTaskAutoApprove`（同上）
- 三者的测试

## 3. 各 provider 的落点（全部不变）

归一化之后，四家拿到的都是它们**今天已经在处理**的输入：

| Provider | 落点 | 自动审批如何生效 |
|---|---|---|
| claude | `canUseTool`（`claude-sdk.js:840`） | 替换「问人」那一步 |
| qoder 本地 | `control_request` 处理处（`qoder-runner.js:484`） | 不发 `permission_request`，直接写 `control_response` |
| codex | `openai-codex.js:338` | `approvalPolicy: 'never'` |
| opencode | `opencode-runner.js:49` | 已是 `--auto` 非交互，无需改 |

**已知不一致（既有，不在本期扩范围）**：只有 claude 和 qoder 实现了 `decideAutoApproval` 危险规则。codex / opencode 上的「自动审批」= 不再询问，但**不拦危险命令**。这与今天 headless 在这两家的行为完全一致——本设计不改变它。

## 4. 数据模型

### 4.1 加列

走既有 helper `addColumnToTableIfNotExists`（`migrations.ts:32-43`），同时补进 `schema.ts` 的建表语句保证新库一致：

| 表 | 列 | 位置 |
|---|---|---|
| `tasks` | `permission_mode TEXT DEFAULT 'default'` | `schema.ts:163-199`（`auto_approve` 在 `:198`） |
| `scheduled_tasks` | `permission_mode TEXT DEFAULT 'default'` | `schema.ts:201-228`（`auto_approve` 在 `:223`） |

### 4.2 回填

加列之后，一次性把存量布尔翻译成模式：

```sql
UPDATE tasks SET permission_mode = 'autoApprove' WHERE auto_approve = 1;
UPDATE scheduled_tasks SET permission_mode = 'autoApprove' WHERE auto_approve = 1;
```

回填**必须幂等**（迁移每次启动都会跑一遍判断）。用「加列那一刻才回填」的形式：`addColumnToTableIfNotExists` 返回是否真的加了列，只有真加了才回填。否则每次启动都会把用户手动改成 `default` 的任务重新翻回 `autoApprove`。

### 4.3 `auto_approve` 退场

**不做双写。** 两个字段各存一份真值，一旦漂移就是「headless 悄悄不再自动批」——这是本功能最危险的失败模式，而它无声无息。

所有读取点改读 `permission_mode`：

| 位置 | 现在 | 改成 |
|---|---|---|
| `index.js:629` | `autoApprove: task?.auto_approve === 1` | `permissionMode: task?.permission_mode ?? 'default'` |
| `scheduler.service.ts:243-260` dispatch 镜像 | 传 `autoApprove: schedule.auto_approve === 1` | 传 `permissionMode: schedule.permission_mode` |
| `tasks.db.ts:101` createTask | 写 `auto_approve` | 写 `permission_mode` |
| `tasks.db.ts:188` update | `updates.autoApprove` → `auto_approve = ?` | `updates.permissionMode` → `permission_mode = ?` |
| `scheduled-tasks.db.ts:54,103` | 同上 | 同上 |
| `tasks.service.ts:103,539,547` | `autoApprove?: boolean` | `permissionMode?: string` |
| `tasks.routes.ts:53,102,126,142` | 校验 `typeof body.autoApprove === 'boolean'` | 校验 `permissionMode` 在允许集合内 |
| `taskExecution.ts` `buildTaskChatSend` | `permissionMode: 'default'` | 见 §5.3 |
| `scheduledTaskPresentation.tsx:27` 徽标 | `task.auto_approve !== 1` | `task.permission_mode !== AUTO_APPROVE_MODE` |
| `web/src/types/app.ts:127,179` | `auto_approve: number` | `permission_mode: string` |
| 三个表单 | 布尔开关 | 模式选择器（见 §6） |

`auto_approve` 列**留在 schema 里不读不写**——SQLite 删列要 `DROP COLUMN`，在活库上没必要冒这个险，且留着它才能让回填可重放。代码里搜不到任何读取点。

### 4.4 测试夹具

约 18 个前端测试文件构造 `Task` / `ScheduledTask` 夹具时带 `auto_approve: 0`。字段改名后它们会 typecheck 失败——这是**期望的**：让编译器把所有夹具逼出来，比手工搜可靠。批量替换 `auto_approve: 0` → `permission_mode: 'default'`，`auto_approve: 1` → `permission_mode: 'autoApprove'`，剩下的漏网由 typecheck 兜。

## 5. 权限模式的解析

### 5.1 一个纯函数

新增 `web/src/components/chat/utils/resolvePermissionMode.ts`：

```ts
export function resolvePermissionMode(input: {
  sessionMode: string | null | undefined;   // permissionMode-${sessionId}
  taskMode: string | null | undefined;      // 关联任务的 permission_mode
  providerLastMode: string | null | undefined; // permissionMode-last-${provider}
  providerDefault: string;
  validModes: readonly string[];
}): string
```

按序取第一个通过 `validModes` 过滤的值：**sessionMode → taskMode → providerLastMode → providerDefault**。

纯函数，无 localStorage、无 React，可直接单测。

### 5.2 composer

`useChatProviderState.ts:602-616` 的既有回退链插入 `taskMode` 一档。它需要知道关联任务的模式，沿用既有的 `linkedTaskModel` 三段式管道（`MainContent.tsx:188` → `ChatInterface.tsx:44` → hook），加一个 `linkedTaskPermissionMode`。

**跟随任务只是初始值，不是锁定**：`cyclePermissionMode`（`:635-650`）本来就把选择写进 `permissionMode-${sessionId}`，那一档排在任务之前，所以手动切一次就永久压过任务，且刷新页面仍生效（localStorage）。任务行**不动**，所以下一次定时派发（新会话，没有会话键）照常跟随任务。

### 5.3 「执行 / 重试」按钮

`buildTaskChatSend`（`taskExecution.ts:102`）今天写死 `permissionMode: 'default'`。改成走**同一个**解析函数，`sessionMode` 从 `localStorage` 的 `permissionMode-${sessionId}` 读，`taskMode` 从任务行读。

这让「一个会话一个权限模式」成立：你在 composer 里关掉自动审批之后，同一个会话点「重试」也是关的——不会偷偷开回来。`providerLastMode` / `providerDefault` 传 `null` / `'default'`，因为任务运行不关心 provider 的交互偏好。

## 6. 表单

三个入口把布尔开关换成模式选择器，选项 = provider 能力表里该 provider 支持的模式，**减去 `plan`**：

| 位置 | 文件 | 现状 |
|---|---|---|
| 定时任务新建 + 编辑 | `ScheduledTaskForm.tsx:41,65,114-116,169,532-536` | `ScheduledTaskDraft.autoApprove: boolean` |
| 任务新建 | `CreateTaskDialog.tsx:57,174,296-300` | `useState(false)` |
| 任务详情内联编辑 | `TaskDetail.tsx:64,90,340-346,753-761` | `saveAutoApprove` |

`toApiBody` / `toDraft` / `EMPTY_DRAFT` 全部跟着改。文案要说明**开启后会发生什么**，不只是开关名：`autoApprove` 的选项标签写「自动审批（无人值守时自动放行工具调用，危险操作仍会拒绝）」。

**为什么排除 `plan`**：定时任务选 plan = agent 只产出计划、不执行任何工具，任务永远空跑，而你要到第二天看历史才发现。这不是「多一个选项」，是一个静默失败。

## 7. 前端模式值

| 文件 | 改法 |
|---|---|
| `web/src/components/chat/types/types.ts:10` | `PermissionMode` 联合加 `'autoApprove'` |
| `permissionModeLabels.ts` | `LABEL_KEYS` 加一项——`Record<PermissionMode, …>` 会让 typecheck 强制报错，这是现成的守卫 |
| `web/src/i18n/locales/en/chat.json` | `codex.modes.autoApprove` / `codex.modesShort.autoApprove` |
| `useChatProviderState.ts:52-56` | `FALLBACK_PERMISSION_MODES` 四个 provider 各加 `'autoApprove'` |
| `provider-capabilities.service.ts:37,47,57,67` | 四个 provider 的 `permissionModes` 各加 `'autoApprove'` |
| `ChatComposer.tsx:479-507` | 颜色三元链加一个分支（warning 色系，与 `bypassPermissions` 同阶——它也是「不问你就动手」） |

## 8. 测试

| 层 | 内容 |
|---|---|
| `normalizePermissionMode` | 表驱动：`'autoApprove'` → default+true；五个已知模式 → 原样+false；未知串 / `null` / `undefined` / 数字 / 对象 → default+false |
| 迁移 | 加列；`auto_approve=1` 的行回填成 `'autoApprove'`；**重复跑迁移不改变已是 `default` 的行**（幂等） |
| `resolvePermissionMode` | 四档优先级各一个用例；无效值被 `validModes` 滤掉后继续往下找 |
| `buildTaskChatSend` | 任务 `permission_mode='autoApprove'` → 发 `'autoApprove'`；会话键存在时**压过**任务 |
| 表单 | `toApiBody` / `toDraft` / `EMPTY_DRAFT` 往返；`plan` 不在选项里 |
| 徽标 | `permission_mode='autoApprove'` 才显示 |
| 回归 | 后端与前端全量测试 |

## 9. 明确不做

| 不做 | 原因 |
|---|---|
| 给 codex / opencode 补危险规则 | 既有不一致，扩范围会把它变成另一期工程 |
| 双写 `auto_approve` | 见 §4.3，漂移无声 |
| 助手暴露 `permission_mode` | 助手不能给自己授予无人监督权限 |
| 修 `bypassPermissions` 缺 `allowDangerouslySkipPermissions` | 既有的、与本期正交的问题；任务走同一个口子不新增类别 |
| 远程主机 | 沿用 2026-09-21 设计，另立一期 |

## 10. 存量行为对照

| 场景 | 改前 | 改后 |
|---|---|---|
| 交互聊天（无关联任务） | 模式由 composer 决定 | **不变** |
| 任务会话，任务 `auto_approve=1` | 服务端硬覆写 → 静默放行 | 跟随任务 → 静默放行（**不变**） |
| 任务会话，手动切模式 | 切了也没用（被覆写） | **切了就生效并锁进会话** |
| 任务板「执行 / 重试」 | 服务端反查任务行 | 同一条解析（会话键 ?? 任务） |
| 定时 / 助手 headless | `auto_approve === 1` | `permission_mode === 'autoApprove'`（回填后等价） |
| 任何路径 · `disallowedTools` 命中的工具 | deny | deny（不变，自动审批仍只替换「问人」那一步） |
