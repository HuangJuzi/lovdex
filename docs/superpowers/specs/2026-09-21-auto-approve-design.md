# 自动审批模式 设计

日期：2026-09-21
状态：已确认，待写实现计划

## 0. 背景与目标

定时任务在无人值守时**必然被权限卡死**：

| 症状 | 位置 | 后果 |
|---|---|---|
| headless 路径写死 `permissionMode: 'default'` + 空 allowlist | `headless-task-run.service.ts:107-113` | 任何工具调用都要人工批准，没人批就等 60s |
| 普通工具超时默认 **deny** | `claude-sdk.js:85-139`（`toolApprovalTimeoutMs` 默认 60000，见 `config.ts:47`） | 任务大概率空跑或失败 |
| 交互型工具 `timeoutMs: 0` **无限期等待** | `claude-sdk.js:847`、`:54` | 任务永远卡在 `in_progress`，直到手动中断 |
| 前端只对**当前正在看的会话**弹窗 | `useChatRealtimeHandlers.ts:331` | 定时任务触发时你根本没打开那个会话 |

目标：给任务加一个**自动审批**开关。开启后，无人值守执行时工具调用自动放行，危险操作自动拒绝，不再需要人工确认。

## 1. 决策汇总

| 项 | 结论 | 理由 |
|---|---|---|
| 生效范围 | 无人值守 headless 执行 + 任务板「执行」按钮 | 两条路不同（`startTaskRun` / `chat.send`），都要接，见 §2.2 |
| 开关粒度 | 任务级，`tasks.auto_approve` 是唯一权威来源 | 定时任务派发时镜像，任务本身自包含 |
| 安全边界 | 默认放行，命中内置危险规则则拒绝 | 见 §3 |
| 提问类工具 | 自动拒绝并让 agent 自行判断 | 否则任务永远挂起 |
| 远程主机 | **本期不做**，远程仍 120s 超时 deny | 需要改 lite RPC 协议，另立一期 |
| 助手工具 | **不暴露** `auto_approve` 参数 | 助手不能给自己授予无人监督权限 |

### 为什么不走 `bypassPermissions`

`claude-sdk.js:805-810` 的既有注释写明：`bypassPermissions` 模式下 SDK 在权限模式检查那一步就把审批结掉了，**`canUseTool` 根本不会被调用**。这条路同时丢掉两样东西：

1. 危险操作拦不住（与「危险操作拒绝」直接冲突）；
2. 交互型工具会被 classifier **自动生成一个答案**让模型照着 act，答什么不可控。

所以 `permissionMode` **保持 `'default'` 不动**——正因为是 `default`，`canUseTool` 才会被调用，才有插策略的位置。这是整个设计的支点。

同理否决「塞通配 allowlist」：现有 `matchesToolPermission`（`claude-sdk.js:152-180`）只支持精确工具名和 `Bash(前缀:*)`，没有通配语义；而且绕不开 `requiresInteraction` 分支，`AskUserQuestion` 仍然无限期挂起。

### 这不是安全边界

本机制防的是 **agent 顺手干了件危险事**，不是 **恶意 agent 绕过限制**。Bash 里换一种写法（`printf ... > ~/.ssh/authorized_keys`、变量拼接、base64 解码执行）就能绕过 §3 的规则。要把不可信内容喂给能自动执行的定时任务，是另一个量级的问题——那需要真正的隔离，不是一份正则清单。**不要把它当成沙箱。**

## 2. 数据模型与运行时链路

### 2.1 加列

两处加列，走 `migrations.ts:32-43` 的 `addColumnToTableIfNotExists`（既有 helper，`ALTER TABLE ADD COLUMN`），同时补进 `schema.ts` 的建表语句保证新库一致：

| 表 | 列 | 位置 |
|---|---|---|
| `scheduled_tasks` | `auto_approve INTEGER DEFAULT 0` | `schema.ts:201-228` |
| `tasks` | `auto_approve INTEGER DEFAULT 0` | `schema.ts:163-199` |

`tasks` 默认 0 意味着：助手建的任务、会话转任务（`ConvertToTaskDialog`）、存量老任务**全部保持今天的行为**，不会因为这次改动意外放宽。默认值取 0 而非继承 `auto_run` 的 1，是刻意的——`auto_run` 控制「要不要自动跑」，`auto_approve` 控制「跑起来后要不要问你」，两者风险等级不同。

### 2.2 两条启停路径

设计初稿误以为「任务板执行」也走 `startTaskRun`，实际是**两条不同的路**，都要接：

| 触发方式 | 后端入口 | 用户在场 | 接法 |
|---|---|---|---|
| 定时任务 dispatch | `scheduler.service.ts:121` → `startTaskRun` | 否 | task 行直读，见下 |
| 助手 `start_task_execution` | `operator.tools.ts:348` → `startTaskRun` | 否 | 同上（默认 0，助手不能自开） |
| **任务板「执行」按钮** | 浏览器发 `chat.send`（`taskExecution.ts:102-123`）→ `handleChatSend` | 是 | **服务端按 sessionId 反查 task**，见下 |

两条路最终汇到同一个开关上：

```
scheduled_tasks.auto_approve        ← 表单开关（人开的）
        │ dispatch() 镜像，同 is_operator / executor_model 既有套路
        ▼
tasks.auto_approve                  ← 运行时权威来源（唯一真值）
        │
        ├─ startTaskRun 直读 task 行 ──┐
        └─ handleChatSend 按 sessionId 反查 ──┤
                                              ▼
                                  runtimeOptions.autoApprove
                                              ▼
                          claude-sdk.js → sdkOptions.autoApprove
                                              ▼
                          canUseTool 里「询问人类」之前短路（见 §3.3）
```

#### 路径一：headless（`startTaskRun`）

`startTaskRun`（`index.js:614-626`）是唯一的 headless 启动函数，**函数签名不用改**——它本来就先取 `task` 行（`index.js:615`），直接多读一个字段即可。

**为什么镜像到 `tasks` 而不是运行时回查 `source_schedule_id`**：任务一旦派发就自包含——你中途改/删定时任务不会影响正在跑的那一次；`startTaskRun` 也不必依赖 scheduler。同时让助手 `start_task_execution` 这条没有来源定时任务的路也能有这个开关。

| 环节 | 文件 | 改法 |
|---|---|---|
| 建任务落库 | `tasks.db.ts` createTask | 加 `auto_approve` 列 |
| 改任务白名单 | `tasks.service.ts` update | 加 `autoApprove → auto_approve` 映射 |
| dispatch 镜像 | `scheduler.service.ts:243-260` create 调用 | 传 `autoApprove: schedule.auto_approve === 1` |
| 起运行时 | `index.js:614-626` | 读 `task?.auto_approve === 1` → `autoApprove` |
| 运行选项 | `headless-task-run.service.ts:107-130` | `autoApprove: true` 进 `runtimeOptions`（仅在为真时） |

#### 路径二：任务板「执行」（`handleChatSend`）

开关是**任务属性**，所以点「执行」也要生效。但这条路是浏览器发起、选项由前端传，**不能信任前端传来的值**——否则任何客户端发一个 `autoApprove: true` 就自我授权了。

改法：`handleChatSend` 在装配 `runtimeOptions` 时（`chat-websocket.service.ts:254-272`）**服务端反查**：

```ts
const runtimeOptions: AnyRecord = {
  ...clientOptions,          // 客户端值先铺开
  // ...既有 override
  // 放在 ...clientOptions 之后，客户端传来的同名字段一律被丢弃
  autoApprove: resolveTaskAutoApprove(sessionId),
};
```

`resolveTaskAutoApprove` 走 `tasksDb.getTaskBySessionId(sessionId)`（`tasks.db.ts:132`），**仅当 `auto_approve === 1` 时返回 `true`**。没有关联任务的会话（普通聊天、助手会话）返回 `false`，一行都不变。

注入方式沿用本文件既有风格：给 `ChatWebSocketDependencies`（`chat-websocket.service.ts:109-129`）加一个可选依赖 `getTaskAutoApprove?`，默认实现读 DB。这样 service 的单测不用起数据库，跟现有测试一致。

### 2.3 各 provider 落点

策略模块是 provider 中立的，各 runner 在自己的决策点调用：

| Provider | 落点 | 改法 |
|---|---|---|
| claude | `canUseTool`（`claude-sdk.js:811`） | 「询问人类」之前短路，见 §3.3 |
| qoder 本地 | `control_request` 处理处（`qoder-runner.js:471-520`） | 不发 `permission_request`，直接写 `control_response`（`buildQoderControlResponse`，`:112-134`） |
| codex | `openai-codex.js:288-306` | 置 `approvalPolicy: 'never'` |
| opencode | `opencode-runner.js:49-68` | 已是 `--auto` 非交互，**无需改** |

## 3. 策略模块

**新增 `backend/server/modules/permissions/auto-approve-policy.ts`**，纯函数：

```ts
export type AutoApproveDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string };

export function decideAutoApproval(toolName: string, input: unknown): AutoApproveDecision
```

按序判断：

1. **交互型工具** → deny
   `AskUserQuestion` / `ExitPlanMode`。理由文案："无人值守执行中，无人可应答，请基于现有信息自行判断并继续"。`TOOLS_REQUIRING_INTERACTION` 目前写死在 `claude-sdk.js:54`，**挪进本模块共用**，避免两处漂移（`claude-sdk.js` 继续 import 它）。
2. **内置危险规则** → deny + 具体理由（见下）
3. **其余** → allow

### 3.1 内置危险规则

**Bash：**

| 规则 | 理由 |
|---|---|
| `rm` 带 `-r`/`-f` 且目标是 `/`、`~`、`$HOME`、`/*` | 删根/删家目录 |
| `sudo` | 提权 |
| `git push` | 外发、不可逆 |
| `git reset --hard`、`git clean -fdx` | 丢弃未提交工作 |
| `curl`/`wget` 管道进 `sh`/`bash` | 远端任意代码执行 |
| `dd of=/dev/*`、`mkfs` | 毁设备/文件系统 |
| `shutdown`、`reboot` | 停服 |
| `npm publish` 等包发布 | 外发、不可逆 |

**Write / Edit / NotebookEdit 的目标路径：** `~/.ssh/**`、`~/.aws/**`、`~/.gnupg/**`、`~/.lovdex/data/app.config.json`（后者能改掉后端配置，包括关掉登录门槛）。

### 3.2 刻意不拦的

`.env`、`git commit`、普通文件删除、`rm -rf node_modules` 这类**没有**进清单。定时任务里它们是正常操作，误伤的代价（任务无谓失败、你还得去查为什么）比放过的代价更高。清单取保守，宁松勿误伤。

### 3.3 插入位置与优先级

**插在「询问人类」那一步之前**（`claude-sdk.js:834` 的 `createRequestId()` 之前），不是 `canUseTool` 的最开头。位置决定了优先级：

```js
sdkOptions.canUseTool = async (toolName, input, context) => {
  const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

  if (!requiresInteraction) {
    if (sdkOptions.permissionMode === 'bypassPermissions') return allow;
    if (isDisallowed) return deny;          // ← 用户显式拉黑，优先级最高
    if (isAllowed) return allow;
  }

  // ★ 自动审批插在这里：只替换「问人」这一步
  if (sdkOptions.autoApprove) {
    const d = decideAutoApproval(toolName, input);
    return d.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: d.reason };
  }

  ...原有的 createRequestId / ws.send / waitForToolApproval
};
```

**为什么不能放最开头**：那样会盖过用户在聊天设置里显式拉黑的 `disallowedTools`（`claude-sdk.js:819-824`）——用户明明说了"这个工具永远别用"，自动审批却把它放行了，这是安全回退。放对位置后语义就一句话：**自动审批只替换「问人」，不推翻用户已有的显式决定。**

单个插入点同时覆盖两类工具，不需要第二个分支：

| 工具类型 | 走到 `autoApprove` 时 | 结果 |
|---|---|---|
| 普通工具 | `disallowedTools` / `allowedTools` 都已判过 | 按 §3.1 规则放行或拒绝 |
| 交互型工具 | 上面的 `if (!requiresInteraction)` 整块跳过 | `decideAutoApproval` 规则 1 命中 → deny + 自行判断 |

`claude-sdk.js` 没有测试宿主（大 .js 文件、直接起 SDK query），所以**判断逻辑全部下沉到纯函数模块**，这里只剩上面这几行胶水。

## 4. 前端

### 4.1 开关出现的三处

| 位置 | 场景 | 参照 |
|---|---|---|
| `ScheduledTaskForm.tsx` | 新建 **+ 编辑**（同一个表单，你要的「定时任务页面能改」自动覆盖） | 挨着 `autoRun` 开关，`:522-526` |
| `CreateTaskDialog.tsx` | 新建任务 | 挨着模型选择，`:284-288` |
| `TaskDetail.tsx` | 任务详情内联编辑，跟「执行引擎 / 模型」并排 | 同 `:321-331` 的既有套路 |

表单侧改动：`ScheduledTaskDraft` 加 `autoApprove: boolean`（默认 `false`），`EMPTY_DRAFT`（`:56-62`）加默认值，`toApiBody`（`:102-115`）映射，`toDraft`（`:143-167`）回填。`CreateTaskDialog` 的 payload 加同名字段（`:166` 一带）。

### 4.2 徽标

`ScheduledTasksView.tsx` 的卡片（`:55-76`）与表格（`:96-140`）加一个「自动审批」徽标，跟现有 `statusBadge`（`:27-36`）同一形状。目的是让你扫一眼就知道**哪些任务在无人值守时会自己批**——这是这个功能唯一需要被"看见"的地方。

### 4.3 文案

不能只写开关名。用："无人值守执行时自动放行工具调用（危险操作仍会拒绝）"。要让人看懂开启后**会发生什么**，而不只是**这个开关叫什么**。

### 4.4 助手工具不暴露该参数

`create_task`（`operator.tools.ts:278`）、`create_scheduled_tasks` / `update_scheduled_task`（`:499-561`）**都不加** `auto_approve` 参数。

理由：助手若能设置它，就等于能给**自己**授予"无人监督"权限——而自动审批的定义就是没人看着。开关只能由人在 UI 上打开。代价是助手帮你建完巡检任务后，你需要去页面上把开关打开（多一步点击），换来的是这个权限无法被自动授予。

## 5. 可观测性

自动决定：

- **不发** `permission_request` 帧 —— 否则任务板会闪「等你批准」（`chat-run-registry.service.ts:243-258` 的 `taskLinkage.onSessionApproval`）
- **不发** `action_required` 通知（`claude-sdk.js:836-845`）—— 否则又变成打扰，与功能意图相反
- **不注册** `pendingToolApprovals`，因此**没有超时这回事**（`waitForToolApproval` 整个不参与）

但要留痕，否则事后翻会话是一片空白，你不知道那次无人值守自己批了什么。

**新增 normalized 消息 `permission_auto`**，携带 `{toolName, behavior, reason}`，前端在会话里渲染成一行轻量提示："已自动放行 Bash" / "已自动拒绝 Bash（理由）"。拒绝类另写 server log。需要给 `MessageKind` 联合类型（`shared/types.ts`）加一支，并在 `useChatRealtimeHandlers.ts` 加对应分支——不加也不会报错，只是这行提示不会渲染。

## 6. 测试

| 层 | 内容 |
|---|---|
| 策略模块 | `auto-approve-policy.test.ts` 表驱动：放行 / 危险拒绝 / 交互型拒绝 / 大小写与空白变体 |
| 运行选项 | `headless-task-run.test.ts`（已存在）断言 `autoApprove: true` 进了 runtimeOptions；不传时**不出现**该键 |
| dispatch 镜像 | `scheduler.service.test.ts`（已存在）断言 `auto_approve` 透传进 `createTask` |
| **chat.send 反查** | 断言任务行 `auto_approve=0` 时，**即使客户端在 `chat.send` 里传 `autoApprove: true`，`runtimeOptions.autoApprove` 仍为 false**——防自我授权 |
| **优先级** | 断言 `disallowedTools` 命中的工具在 `autoApprove` 开启时**仍然 deny**（§3.3 的语义锁） |
| 迁移 | 断言 `tasks` 与 `scheduled_tasks` 都加上了列、老行取值 0 |
| 任务更新 | `tasks.service` 的 `autoApprove` 白名单映射 |
| 前端 | `ScheduledTaskForm.test.tsx` 的 `toApiBody` / `toDraft` / `EMPTY_DRAFT` 往返（web 测试是 `node:test` + `renderToStaticMarkup`，无 DOM） |
| E2E | 临时项目：`auto_approve=1` 的定时任务 run-now → 断言跑完且全程无 pending approval；反向 `auto_approve=0` 断言仍然等批准 |

注意 `backend` 基线**本来不干净**（typecheck 有 pre-existing 错误、lint 44 errors），验收标准是「零新增」，不是「全绿」。

## 7. 明确不做

| 不做 | 原因 |
|---|---|
| 远程主机自动审批 | 要改 lite RPC 协议 + remote-agent 的 `canUseTool`（`agent-run.ts:222-253`）+ qoder 审批注册表，另立一期 |
| 危险规则可配置化 | 先固定内置清单，跑一段时间看误伤率再决定要不要开放 |
| 服务端权限记忆 / 白名单表 | 权限状态目前全是内存 + 浏览器 localStorage（无 `permissions` 表）。做持久化白名单是另一个功能 |
| 交互型工具「预置默认回答」 | 已选「自动拒绝 + 让 agent 自行判断」，够用 |
| 定时任务外的 `permissionMode` 语义调整 | 交互会话完全不受本设计影响 |

## 8. 存量行为对照

| 场景 | 改前 | 改后（`auto_approve=0`，默认） | 改后（`auto_approve=1`） |
|---|---|---|---|
| 交互聊天（无关联任务） | 弹窗 | 弹窗（不变） | 弹窗（不变） |
| 定时任务 · 普通工具 | 60s 后 deny | 60s 后 deny（不变） | 立即放行或拒绝 |
| 定时任务 · 提问工具 | **无限期挂起** | **无限期挂起**（不变，仍是坑） | 立即拒绝 + 让 agent 继续 |
| 任务板「执行」 | 跟随浏览器 `skipPermissions` 设置 | 不变 | 服务端反查 task 行后自动决定 |
| 任何路径 · `disallowedTools` 命中的工具 | deny | deny（不变） | **仍然 deny**（显式拉黑优先于自动审批，见 §3.3） |
| 远程任务 | 120s 后 deny | 不变 | 不变（本期不做） |

`auto_approve=0` 那一列**全部是「不变」**——这是本设计的硬约束：不打开开关的任务，行为与今天逐字节一致。
