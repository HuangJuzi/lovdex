# 会话级自动审批开关 设计

> ⚠️ **已作废（2026-09-23）**：被 `2026-09-23-auto-approve-as-permission-mode-design.md` 取代。
> 本方案的实现曾提交到 main（`6c17ebe`…`18d6f3a`）后全部撤销——用户判定「自动审批应当是权限模式的一种，
> 不该多出一个独立按钮」，且任务的权限应当与 composer 共用同一套语义。保留本文档仅为记录决策过程。

日期：2026-09-21
状态：已作废，见上方说明
前置：`2026-09-21-auto-approve-design.md`

## 0. 背景与目标

自动审批上线后是**只能开、不能关**的。

原因是它的存储位置：`auto_approve` 是**任务属性**（`tasks.auto_approve`），服务端在每次 `chat.send` 时按 `sessionId` 反查任务行（`chat-websocket.service.ts:266`），并**刻意丢弃客户端传来的同名字段**——这是防自我授权，是对的。代价是交互会话里没有任何入口能改它：开关只存在于「任务详情」（`TaskDetail.tsx:753`）和「定时任务表单」。

于是出现这个场景：定时任务跑完，你打开那个会话想接着聊——**自动审批还是开着的**，工具调用被静默放行或静默拒绝，你不再被询问，也没有地方能关。

实测确认：本文档成稿时，作者所在会话的 `AskUserQuestion` 被自动审批策略当场拒绝（返回的正是 `UNATTENDED_INTERACTION_DENY_REASON`），即该症状本身。

目标：**在不削弱防自我授权的前提下**，让交互会话里能关掉自动审批。

## 1. 决策汇总

| 项 | 结论 | 理由 |
|---|---|---|
| 关闭的语义 | **只关当前会话的交互发送**，任务属性不动 | 用户说的是「继续对话」，不是「改任务配置」；改任务会让下次定时跑卡住，正是开这个开关要避免的事 |
| 客户端权限 | **只能降级，不能升级** | 客户端传 `true` 被忽略，防自我授权性质逐字不变 |
| 按钮可见性 | 仅当 `taskFlag === true` 时渲染 | 聊天框里只能关/恢复，**不能授予**一个本没开自动审批的任务以无人监督权限 |
| 持久化 | 会话级，localStorage | 仿既有 `permissionMode-${sessionId}` 先例；刷新后不该静默恢复放行 |
| UI 落点 | composer 工具栏，紧挨权限模式按钮 | 见 §4.2，**不进模式循环** |
| 远程主机 | **本期不做** | 沿用前置设计，另立一期 |

### 为什么不做成 `permissionMode` 的一种

需求原话是「可以是 mode 的一种」。字面实现（把 `'autoApprove'` 加进 `PermissionMode` 联合类型）有两个问题：

1. **语义漂移**：`permissionMode` 是 per-send 的 provider 选项（`useChatComposerState.ts:709`），会被发给 provider。`resolvePermissionModeForProvider` 用 `validModes.includes()` 过滤，未知模式**静默回退 `default`**——于是自动审批的语义根本不随模式走，只剩下一个名字。
2. **误触代价**：模式按钮是**循环切换**的（`cyclePermissionMode`，`useChatComposerState.ts:635`）。混进去意味着每切一轮都会经过一个「改任务配置」的档位。

真正的区别在生命周期：模式是**单次发送**的选项，自动审批是**跨会话、跨运行持久**的任务属性。所以做成并排的独立开关，视觉同级、不进循环。

## 2. 后端

只有一处，在既有决策点上加一层纯降级。

### 2.1 新增纯函数

`backend/server/modules/permissions/auto-approve-policy.ts`：

```ts
/**
 * The client may only ever turn auto-approval OFF for its own send. A client
 * asking for `true` is ignored — trusting it would let any client grant itself
 * unattended permissions, which is exactly what `resolveTaskAutoApprove`
 * exists to prevent.
 *
 * Only the literal `false` downgrades. `true`, `0`, `'false'` and a missing
 * field all leave the task's value alone, so a malformed client cannot
 * accidentally (or deliberately) disable the feature for a task that has it on.
 */
export function applyClientAutoApproveOverride(taskFlag: boolean, clientRequest: unknown): boolean {
  return taskFlag && clientRequest !== false;
}
```

### 2.2 接线

`backend/server/modules/websocket/services/chat-websocket.service.ts:262-266`：

```ts
const runtimeOptions: AnyRecord = {
  ...clientOptions,
  autoApprove: applyClientAutoApproveOverride(
    resolveTaskAutoApprove(sessionId, getTaskAutoApprove),
    clientOptions.autoApprove,
  ),
  ...
};
```

注释（`「Placed after the ...clientOptions spread so a client-supplied autoApprove is discarded」`）要改成仍然成立的新说法：**客户端值不再是「被丢弃」，而是「只能用于降级」**——否则注释与代码矛盾，下一个人会以为降级路径是漏洞。

### 2.3 为什么定时执行不受影响

前端 override 只挂在 `chat.send` 的 options 上，而定时派发走的是**另一条路**：

```
scheduler.service.ts:179  →  startTaskRun  →  headless-task-run.service.ts
                          （读 task 行，不经过 chat.send）
```

`index.js:276` 的注释也确认「任务板『执行』按钮走的是浏览器的 chat.send，不经过 startTaskRun」——即只有浏览器主动发送才受本设计影响。所以无人值守执行**逐字节不变**。

## 3. 数据流

```
linkedTask.auto_approve === 1  ─────────────┐
                                            ├─► effective = taskFlag && !override
localStorage autoApproveOff-<sessionId> ────┘
        ▲                                            │
        │ 点击按钮切换 override                        │
        │                                            ▼
        └───────────────────────────  override 为真时，chat.send options 带
                                      autoApprove: false；否则**不带该键**
                                                     │
                                                     ▼
                            applyClientAutoApproveOverride(taskFlag, false) → false
                                                     │
                                                     ▼
                                    下一条消息恢复「问人」
```

**生效时机**：服务端每次 `chat.send` 重新解析，所以**下一条消息立即生效**，不需要重连、不需要重启后端。进行中的 run 不受影响（options 已解析完）。

## 4. 前端

### 4.1 新 hook（单一职责）

新增 `web/src/components/chat/hooks/useSessionAutoApprove.ts`，导出纯函数（可单测）+ 一个 hook：

```ts
/** taskFlag && !override —— 纯函数，表驱动测试的落点。 */
export function resolveEffectiveAutoApprove(taskFlag: boolean, override: boolean): boolean;

/** localStorage 键：`autoApproveOff-${sessionId}`，读写走 safeLocalStorage。 */
export function readAutoApproveOverride(sessionId: string): boolean;
export function writeAutoApproveOverride(sessionId: string, override: boolean): void;

export function useSessionAutoApprove(input: {
  sessionId: string | null | undefined;
  taskFlag: boolean;
}): {
  show: boolean;                       // = taskFlag，决定按钮是否渲染
  enabled: boolean;                    // = effective，决定按钮外观
  toggle: () => void;                  // 翻转 override
  clientAutoApprove: false | undefined; // override 为真时是 false，否则 undefined
};
```

`clientAutoApprove` 取 `false | undefined` 而不是 `boolean`，是为了让「不带这个键」和「显式降级」在类型上就分得开——调用方不可能不小心发出一个 `true`。

**`override` 的生命周期**：

- `toggle()` 翻转后**立即写回 localStorage**（`writeAutoApproveOverride`），不延迟到卸载。
- `sessionId` 变化时重新读取；`sessionId` 为空（`null` / `undefined` / 空串）时一律按 `false` 处理，不读也不写 localStorage——无会话可归属。
- 任务本身关掉（`taskFlag === false`）时它变成惰性值，不需要清理；重新打开任务开关时会自然生效，这正是「我上次在这个会话里关了它」的合理延续。

### 4.2 落点与透传

沿用既有 `linkedTaskModel` 的三段式管道，不新造机制：

| 环节 | 文件 | 改法 |
|---|---|---|
| 取关联任务 | `MainContent.tsx:58` | 已有 `linkedTask`，加传 `linkedTaskAutoApprove={linkedTask ? linkedTask.auto_approve === 1 : undefined}` |
| 透传 | `ChatInterface.tsx:44` | 加同名 prop（`undefined` = 无关联任务，与 `linkedTaskModel` 同一约定） |
| 消费 | `ChatInterface.tsx:236` 一带 | 调 `useSessionAutoApprove`；`clientAutoApprove` 进 `useChatComposerState` |
| 注入 options | `useChatComposerState.ts:706-720` | `...(clientAutoApprove === false ? { autoApprove: false } : {})` |
| 渲染 | `ChatComposer.tsx:516` 之后 | 紧挨权限模式按钮 |

`linkedTaskAutoApprove` 是**三态**（`undefined` 无关联任务 / `true` / `false`），与 `linkedTaskModel?: string | null` 的既有约定一致。

### 4.3 按钮

- 位置：composer 工具栏，权限模式按钮之后、模型按钮之前。
- 视觉：`enabled` 为真时用 warning 色系（放行语义，与 `bypassPermissions` 同色阶，刻意不做得像普通开关）；`!enabled` 时用 `default` 模式的灰阶。
- 文案：「自动审批」。窄屏用短标签，照抄权限模式按钮的双 span 写法（`ChatComposer.tsx:509-515` 的 `sm:hidden` / `sm:inline` 两个 span，不合并到同一元素——那里的注释已说明原因）。标签直接内联在本按钮里，不走 `permissionModeLabels.ts`：那个模块的 `LABEL_KEYS` 是 `Record<PermissionMode, …>`，本开关不是 `PermissionMode`，硬塞会污染该类型。
- tooltip：**必须写清作用范围**——「仅影响你在此会话手动发送的消息；该任务的定时执行仍会自动批准」。只说开关名会让人以为改的是任务。
- 关掉时不弹 toast：按钮外观变化本身就是反馈，且这是一个可逆的本地状态。

### 4.4 边界

| 场景 | 行为 |
|---|---|
| 会话无关联任务（普通聊天） | 按钮不渲染，options 不带该键，行为与今天一致 |
| 任务 `auto_approve = 0` | 按钮不渲染（聊天框不能授予无人监督权限） |
| 任务 `auto_approve = 1`，未覆盖 | 按钮 warning 高亮，服务端按任务值自动批 |
| 任务 `auto_approve = 1`，已覆盖 | 按钮灰态，options 带 `autoApprove: false`，恢复问人 |
| 任务在别处被关掉 | `task_upserted` 更新 `linkedTask` → `taskFlag` 变 false → 按钮消失 |
| 会话正在运行中切换 | 进行中的 run 不受影响；下一条消息生效 |
| 刷新页面 | override 从 localStorage 恢复，不会静默回到放行 |

## 5. 测试

| 层 | 内容 |
|---|---|
| 纯函数（后端） | `applyClientAutoApproveOverride` 表驱动：`false` → `false`；`true` / `0` / `'false'` / `null` / `undefined` / 对象 → 保持 `taskFlag` |
| 纯函数（后端） | `taskFlag = false` 时，**任何** client 值都返回 `false`（不能升级）——这是安全锁 |
| 纯函数（前端） | `resolveEffectiveAutoApprove` 四象限 |
| 纯函数（前端） | `readAutoApproveOverride` / `writeAutoApproveOverride` 往返；损坏值按 `false` 处理；`sessionId` 为空时不读不写 |
| 渲染（前端） | `AutoApproveToggle` 两种状态都渲染出标签，`aria-pressed` 反映状态，tooltip 含作用范围 |
| 渲染（前端） | `taskFlag = false` 不渲染按钮；`= true` 渲染且外观反映 `effective` |
| options（前端） | `clientAutoApprove === undefined` 时 options **不含** `autoApprove` 键；`=== false` 时含且为 `false` |

前端测试沿用既有 `node:test` + `renderToStaticMarkup`（无 DOM）与纯函数单测，不引入新测试设施。

### 安全锁为什么不在 `chat.send` 层断言

初稿写的「chat-websocket 层断言客户端传 `autoApprove: true` 时 `runtimeOptions.autoApprove` 仍为任务值」，**做不到**：`handleChatSend` 没有导出、也没有测试宿主——它需要 DB 行、WebSocket 与 provider spawn。本仓库对这个函数的既有做法就是把可判定的部分抽成纯函数再测（见 `filterImagesToUploadStore` / `chat-image-filter.test.ts`）。

所以安全锁落在**两层**：

1. `applyClientAutoApproveOverride` 的纯函数测试把「客户端永远不能升级」这条语义钉死；
2. E2E 手工验证覆盖接线本身（关掉开关 → 恢复弹窗；定时执行 → 仍自动批）。

**未覆盖的回归风险**（明确记下）：如果将来有人把 `chat-websocket.service.ts` 里的调用拆掉、直接把 `clientOptions.autoApprove` 传下去，现有自动化测试**不会**报警。届时只能靠 review 或 E2E 发现。不为它引入 DB 测试宿主——代价大于收益。

后端基线**本来不干净**（typecheck 有 pre-existing 错误、lint 44 errors），验收标准是「零新增」。

## 6. 明确不做

| 不做 | 原因 |
|---|---|
| 写回任务属性 | 那正是被否决的方案 B——关掉会话会连带让下次定时跑卡住 |
| 把 `autoApprove` 加进 `PermissionMode` 联合类型 | 见 §1「为什么不做成 permissionMode 的一种」 |
| 从聊天框给任务**开启**自动审批 | 聊天框只能关/恢复；授予无人监督权限留在任务页，与前置设计 §4.4 同一条边界 |
| 覆盖状态持久化到后端 | 它是纯客户端的显示/发送偏好，与任务属性正交；存后端反而要回答「定时跑算谁的」 |
| 远程主机 | 沿用前置设计，另立一期 |

## 7. 存量行为对照

| 场景 | 改前 | 改后 |
|---|---|---|
| 交互聊天（无关联任务） | 弹窗 | 弹窗（不变） |
| 任务会话，`auto_approve=1`，未动开关 | 静默放行 | 静默放行（不变） |
| 任务会话，`auto_approve=1`，关掉后 | ——（无此能力） | 恢复弹窗 |
| 任务会话，`auto_approve=0` | 弹窗 | 弹窗（不变） |
| **定时 / 助手 / 任务板 headless 执行** | 按任务值自动批 | **逐字节不变**（不走 `chat.send`） |
| 任何路径 · `disallowedTools` 命中的工具 | deny | deny（不变） |

除「任务会话里主动关掉」一行外，整张表都是「不变」——这是本设计的硬约束。
