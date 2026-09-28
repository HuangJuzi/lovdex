# 任务页缩略面板与内联待办 设计

日期：2026-09-28
状态：已确认，待写实现计划
上游：`2026-09-24-inbox-ignore-action-design.md`（任务页当前形态）
预览：`docs/preview/tasks-final.html`（可交互，已用无头浏览器逐项验证）

## 0. 问题

任务页现在的每一次操作都要离开列表：

1. `TaskCard` 点卡片就 `navigate('/task/${task_id}')`（`TaskCard.tsx:54`），表格行同理（`TaskBoard.tsx:480` 传入 `onOpenTask`）。想看一条任务的完成度，就得跳走再跳回来。
2. `TaskDetail` 里会话卡在 `waiting_answer` / `waiting_plan` / `waiting_approval` 时，只有一个「去处理」按钮做纯导航（`TaskDetail.tsx:630`），拿不到 `input`，所以**必须**进会话页才能回答。
3. 电脑端默认是看板。四列在宽屏上横向拉得过开，一屏能看的任务反而比表格少。

用户诉求原话：「点击任务之后并不是直接跳转到任务详细页，显示任务的缩略信息，我不想每次操作都跳转到任务详细……尽量能够实现我只看任务面板就够了」。补充约束：「每次只能展开一个会话」。后续追加：「电脑端可以关闭看板视图，只保留表格视图，和手机端刚好相反」「这个页面里面能够快速回复一些消息，且不要搞黑底」「如果有弹窗，或者需要会选择的时候需要怎么操作」。

### 与既有实现的关系

- **快速回复已存在**：全局（非项目级）的 `quick_replies` 表 + `/api/quick-replies` 接口 + `useQuickReplies` 钩子 + `QuickRepliesMenu` 组件。语义是「点击**填入**输入框，刻意不自动发送」（`useChatComposerState.ts:1285` 有明确注释）。本设计**复用**它，不新造一套。
- **发送通道已存在**：`buildTaskChatSend`（`taskExecution.ts:120`）+ `chat.send`。任务页的「开始执行 / 重试」已经在用（`TaskBoard.tsx:247`、`TaskDetail.tsx:401`），所以任务页能直接给会话发消息，无需新接口。
- **待办数据已存在**：`permission_request` 帧（`claude-sdk.js:917`）带 `{ requestId, toolName, input, sessionId }`，`input` 里就是 AskUserQuestion 的 `questions[]` 或 ExitPlanMode 的计划全文。答复帧 `chat.permission-response`（`chat-websocket.service.ts:498`）已实现。
- **浅色是默认主题**：`web/src/index.css` 的 `:root` 就是浅色，`.dark` 才是深色（`tailwind.config.js` 的 `darkMode: ["class"]`）。「不要黑底」不需要任何改动，是既有默认。

所以本设计的实质是**换挂载点 + 放开一处作用域**，而不是新建一套机制。

## 1. 决策汇总

| 维度 | 决定 | 理由 |
|---|---|---|
| 面板形态 | 右侧 428px 停靠栏；窄屏降级为底部 sheet | 与仓库既有 `ScheduledTasksPanel`（桌面 420px 右栏 + `Dialog variant="sheet"`）同一套模式。列表只是变窄、不被遮罩，可连着点下一行换内容 |
| 电脑端默认视图 | 表格 | 看板四列在宽屏横向拉太开，一屏可见任务反而少。看板不删，改为需主动打开并持久化 |
| 手机端视图 | 看板（不给表格） | 与现状一致——本来就是 `isMobile ? 'board' : viewMode`（`TaskBoard.tsx:51`），本次只把桌面默认值从 `'board'` 翻成 `'table'` |
| 进入详情 | 面板底部「任务详情 →」才跳全页 | 把「点卡片 = 跳页」改成「点卡片 = 展开面板」，跳转变成显式动作 |
| 关闭面板 | 右栏整体收起，列表回到全宽 | ✕ 与工具栏「隐藏面板」等效。收起态点任意一行自动重新展开 |
| 「关闭」的语义 | ≠「取消选中」 | 重新展开时回到刚才那一条，不丢上下文。关面板的动机通常是「先看看全宽的列表」 |
| 快速回复 | 点「常用语」= 填入输入框，不自动发送 | 与会话页既有行为一致，因此复用同一份全局列表 |
| 发送通道 | 沿用 `chat.send` / `buildTaskChatSend` | 任务页已在用，无需新接口 |
| 多个待办 | 串行队列，一次显示一个 | 一个任务一个会话；后端 `canUseTool` 本就 await 完一个才走下一个。数据层仍按数组存，真并发也不丢 |
| 待办排序 | 会超时的排前面 | 普通工具 60 秒后**自动拒绝**（会自己死掉，必须先救）；AskUserQuestion / ExitPlanMode 是 `timeoutMs: 0` 永远等 |
| 倒计时 | 只在会超时的条目上显示；<15 秒变红脉动 | 显示真信息，防静默自动拒。对「永远等」的条目显示倒计时是假紧迫感 |
| 答完反馈 | 乐观移除 + 自动前进到下一个 | 现有实现已是乐观移除（`useChatComposerState.ts:1351`）。答失败或被 `permission_cancelled` 时标灰说明原因，不静默消失 |
| 兜底入口 | 底部小链接「在会话里处理 →」 | 从现在的唯一按钮降级。防的是时序、断线重连、客户端版本不一致时无路可走 |
| 「总是允许」 | 标注「仅本次会话有效」 | 写进的是会话级 `sdkOptions.allowedTools`（`claude-sdk.js:952`），不是全局设置 |
| 无待办时 | 待办区条件渲染，整个不出现 | `auto` / `bypassPermissions` 下 SDK 跳过 `canUseTool`（`claude-sdk.js:860`）；无人值守任务按策略直接拒交互工具（`auto-approve-policy.ts:41`）。不能假设「一定有东西要答」 |
| 执行中发消息 | 进前端待发队列 | 后端 `RUN_IN_PROGRESS` 无服务端队列（`chat-websocket.service.ts:230`），排队靠已有的 `queuedDraft` 机制，本次不重造 |

## 2. 机制

### 2.1 面板

新增面板容器，按 `ScheduledTasksPanel` 的模式：

- 桌面（≥1024px）：列表左、面板右，`flex` 布局。面板 `w-[428px] shrink-0 border-l`。
- 窄屏：`Dialog variant="sheet"`，`max-h-[85dvh]`，卡片点击打开。

面板内部自上而下：头部（状态点 + 标题 + ✕）→ chip 行 → **待办区（条件渲染）** → 完成度 → 最近结果（可折叠）→ 属性（引擎 / 创建 / 活动）→ 快速回复区 → 底部（「在会话里处理 →」+「任务详情 →」）。

收起态由容器的 `.closed` class 控制，`display:none` 让右栏完全不占位。

### 2.2 内联待办（本设计的核心）

三种提示都由 `PendingPermissionRequest`（`web/src/components/chat/types/types.ts:105`）渲染：

```ts
interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;        // AskUserQuestion 的 questions[] / ExitPlanMode 的计划
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
}
```

| toolName | `input` 里的东西 | 渲染 | 答复载荷 |
|---|---|---|---|
| `AskUserQuestion` | `questions[]`（含每个选项的 label + description） | 选项按钮 +「其他…」自由输入 | `{requestId, allow:true, updatedInput:{...input, answers}}` |
| `ExitPlanMode` / `exit_plan_mode` | 计划 markdown | 计划全文 + 「↺ 让它改 / ✓ 开始执行」 | `allow:true` 执行；`allow:false, message:'User asked to revise the plan'` |
| 其余 | toolName + 工具参数 | 命令原文 + 「✕ 拒绝 / ✓ 允许一次 / ✓ 总是允许」 | `{requestId, allow, updatedInput, rememberEntry}` |

渲染直接复用既有组件：`AskUserQuestionPanel`、`PlanDisplay` 的底部按钮、`Confirmation`。**不重写交互逻辑**，只换挂载点。

**唯一的结构性改动**：前端现在只在「当前打开的会话」接收 pending 请求——`useChatRealtimeHandlers.ts:179` 的 `isViewedSession = sid === activeViewSessionId`（`:296/:315/:332` 同款判断），以及 `:180` 处理 `chat_subscribed` 的 `pendingPermissions` 时的同一判断。要放开到「当前展开的任务所对应的会话」。

注意现状：`permission_request` / `permission_cancelled` 帧**刻意不进消息流**（`shouldPersist` 在 `:264-268` 排除它们），pending 请求活在独立的 React state 里（`useChatProviderState.ts:158`）。所以放开作用域不需要碰消息持久化。

### 2.3 队列与排序

一个任务一个会话，所以队列实际长度几乎总是 1。仍然实现为队列是为了：

- 后端 `pendingToolApprovals` 是无锁 `Map`（`claude-sdk.js:46`），`chat-run-registry.service.ts:501` 的注释也明确处理了「一个会话多个 pending」的情形。
- 真出现并发时不丢待办。

排序键：**超时时刻升序，无超时的排最后**。超时判定：

| 类别 | 超时 | 来源 |
|---|---|---|
| `AskUserQuestion` / `ExitPlanMode` | `timeoutMs: 0` = 永远等 | `claude-sdk.js:152`（注释：「0 = wait indefinitely (interactive tools)」），集合见 `auto-approve-policy.ts:38` |
| 其余工具 | `providers.claude.toolApprovalTimeoutMs`，默认 60000ms | `config.ts:47`，读取处 `claude-sdk.js:53` |

显示规则：
- 队列长度 > 1 才渲染队列条（「还有 N 件事等你」+ 步骤点 + 当前项高亮），单条时不渲染，面板更干净。
- 倒计时只出现在会超时的条目上。剩余 <15 秒转红并脉动。
- 超时后不静默消失：出现说明条（「授权请求已超时，被自动拒绝（N 秒未响应）。会话停在 <工具名> 那一步，没有执行」）+ 被划掉的条目 + 一句「继续」的快捷语重新放行。

### 2.4 无待办 / 不可回复的三种情形

| 情形 | 判据 | 面板表现 |
|---|---|---|
| `auto` / `bypassPermissions` 模式 | SDK 跳过 `canUseTool`（`claude-sdk.js:860`） | 待办区不渲染，面板回到「看任务 + 快速回复」 |
| 无人值守任务 | 策略直接拒交互工具（`auto-approve-policy.ts` 的 `UNATTENDED_INTERACTION_DENY_REASON`） | 同上 |
| 会话被清理 | 无 `session_id` | 待办区与回复区都不渲染，只留「任务详情 →」 |

### 2.5 执行中的回复

会话正在跑时后端拒 `chat.send`（`RUN_IN_PROGRESS`，`chat-websocket.service.ts:230`），**没有服务端队列**。所以回复区：

- 显示提示条说明「正在执行，回复要等这一轮结束」。
- 输入框可用，但明确标注「会排进待发队列」。排队复用既有机制——`queuedMessageKey()` 写 `queued_message_<sessionId>`（`web/src/components/chat/utils/chatStorage.ts:59`），由 `useQueuedMessageAutoSend.ts:26` 在会话离开处理态时自动发送。
- 本次不改动该机制。

## 3. 平台分流

现状 `TaskBoard.tsx:51`：

```ts
const effectiveView = isMobile ? 'board' : viewMode;   // 断点 640，与 Tailwind `sm:` 对齐
```

改动：

- `taskViewMode` 默认值 `'board'` → `'table'`（`TaskBoard.tsx:37`）。
- 桌面视图切换器保留（看板可主动打开、开关持久化）。
- 手机端维持强制看板，切换器里的「表格」按钮继续隐藏（`hidden sm:inline-flex`）。

即：两端各只有一种适用形态，但**桌面保留手动切换**（用户明确说「可以关闭看板视图」，是能力而非删除）。

## 4. 改动范围

### 4.1 新增

- 面板容器组件（桌面右栏 + 窄屏 sheet），参考 `ScheduledTasksPanel.tsx:229-333`。
- 待办区组件：按 `toolName` 分派到既有渲染器 + 队列条 + 倒计时。
- 面板内的快速回复区：复用 `useQuickReplies` 与 `buildQuickReplyInput`。

### 4.2 修改

| 文件 | 改动 |
|---|---|
| `web/src/components/tasks/TaskBoard.tsx` | `taskViewMode` 默认 `'table'`；持有所展开任务的 id；容器加 `.closed` 状态 |
| `web/src/components/tasks/TaskCard.tsx` | `navigate('/task/:id')`（:54）改为回调展开面板 |
| `web/src/components/tasks/TaskTableView.tsx` | 行点击（:316-318 的 `onOpenTask`）改为展开面板 |
| `web/src/components/chat/hooks/useChatRealtimeHandlers.ts` | pending 请求的作用域从「当前打开会话」放开到「当前展开任务的会话」 |
| `web/src/components/tasks/TaskDetail.tsx` | 等待横幅（:599-627）可简化为指向面板；保留兜底 |

### 4.3 不新增

- 数据库表、REST 接口、WS 帧类型。
- 快速回复数据模型（复用全局 `quick_replies`）。
- 消息队列机制（复用 `queuedDraft`）。

## 5. 验收

### 5.1 面板与视图

1. 电脑端进 `/tasks` 默认表格；`localStorage['taskViewMode']` 为空时也走表格。
2. 点表格行 → 右侧面板展开，行高亮；点另一行内容替换，**选中行恒为 1**。
3. 点同一行 → 收起。点 ✕ 或「隐藏面板」→ 右栏不占位，列表回到全宽。
4. 收起态点任意一行 → 自动重新展开并回到该任务。
5. 1280 / 1440 / 1920 / 2560 宽度下无横向溢出。
6. 手机端（<640px）只有看板；点卡片 → 底部 sheet。

### 5.2 待办

7. `waiting_answer` 任务 → 面板出现选项按钮，文案与 `input.questions[].options[].label` 一致。
8. `waiting_plan` → 计划全文 + 「让它改 / 开始执行」。
9. 普通工具 → 命令原文 + 三按钮，且**显示倒计时**；AskUserQuestion / ExitPlanMode **显示「不会超时」**而非倒计时。
10. 剩余 <15 秒倒计时转红并脉动。
11. 点选项 → 选中态 → 待办区淡出 → 队列前进到下一个（若有）。
12. 超时后出现说明条 + 划掉的条目 + 「继续」快捷语，**不是静默消失**。
13. 无 `session_id` 的任务：待办区与回复区都不渲染。

### 5.3 回复

14. 点常用语 → 文字进输入框、光标就位、**不自动发送**（与 `handleInsertQuickReply` 一致）。
15. 空内容发送被拦下并提示。
16. 执行中的任务：回复区显示等待提示，发送进待发队列。
17. 发送后任务状态经 `task_upserted` 就地刷新，无需手动刷新页面。

### 5.4 回归

18. `chat.send` / `chat.permission-response` 帧格式未变（前端既有测试应全绿）。
19. 会话页的待办渲染不受影响（放开作用域是**增加**订阅目标，不是替换）。
20. 后端无改动 ⇒ 后端测试基线不变。

## 6. 风险

1. **超时方向**：超时是**自动拒绝**，不是自动通过。方向搞反就是灾难，因此倒计时必须显眼，且只在会超时的条目上。
2. **作用域放开的影响面**：待办请求会同时被会话页和任务页接收。需确认答复后两处都正确移除（现有乐观移除是按 `requestId` 的，理论上安全），并验证不会重复渲染。
3. **`RUN_IN_PROGRESS`**：执行中发消息必然失败，面板必须提前说明，不能让你发完才发现。
4. **`useLocalStorage` 不跨实例同步**：它是纯 `useState`（`TaskBoard.tsx:41-43` 有注释），默认值变更对已存 `'board'` 的老用户不生效——这是可接受的（老用户已表达过偏好），但需在实现说明里记一笔。

## 7. 未决

无。设计阶段抛给用户的三个问题（多待办排序、兜底入口、倒计时范围）已由实现方决定并记录于 §1；用户已确认。
