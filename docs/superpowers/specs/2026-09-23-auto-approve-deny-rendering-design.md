# 自动审批拒绝的会话渲染 设计

日期：2026-09-23
状态：已确认，待写实现计划
上游：[2026-09-21-auto-approve-design.md](./2026-09-21-auto-approve-design.md)

## 0. 背景与问题

自动审批上线后，会话里出现这样的展示：

```
❌ Error
无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。
```

这不是错误，是**功能按预期工作**。链路如下：

| 环节 | 位置 | 行为 |
|---|---|---|
| 策略模块产出理由 | `backend/server/modules/permissions/auto-approve-policy.ts:37-38`、`:122-185` | `decideAutoApproval` 返回 `{behavior:'deny', reason}` |
| SDK 把拒绝写成工具报错 | `backend/server/claude-sdk.js:813-860` | `canUseTool` 返回 `{behavior:'deny', message: reason}`，SDK 将其落成 **`is_error: true` 的 tool_result** |
| 归一化原样透传 | `claude-sessions.provider.ts:450-470`、`qoder-sessions.provider.ts:255-268` | `isError: Boolean(part.is_error)`，不附带任何"这是自动拒绝"的信号 |
| 前端只能看形状 | `web/src/components/chat/view/subcomponents/MessageComponent.tsx:209-227` | `toolResult.isError` → 红框 + 标题取 `messageTypes.error` |

已核实 transcript 里的实际形状（`~/.claude/projects/**/*.jsonl`）：

```json
{ "type": "tool_result", "tool_use_id": "call_…", "is_error": true,
  "content": "无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。" }
```

`content` 是**纯字符串**、与策略常量逐字相等 —— 这是本设计能精确分类的前提。

### 为什么不能只靠现有机制

`claude-sdk.js:846-855` 确实已经发了一条 `permission_auto` 的 ws 帧，前端渲染成 `⚡ 已自动拒绝 …`（`AutoApproveNotice.tsx`）。但：

**`permission_auto` 是纯 ws 帧，不落 transcript。刷新会话后它就没了，只剩那个红 Error 框。**

所以修复必须**只凭 transcript 内容**就能判断。这排除了"补一条持久化提示"之外的纯实时方案，也是本设计把分类下沉到归一化层的直接原因。

## 1. 决策汇总

| 项 | 结论 | 理由 |
|---|---|---|
| 分类位置 | 策略模块导出纯函数，provider 归一化时打标 | 理由文案的唯一来源是策略模块；前端不认识任何后端中文 |
| 分类方式 | 按拒绝理由**精确/前缀匹配** | transcript 里 content 是纯字符串且逐字相等（已核实）；这是唯一可得的信号 |
| 交互型拒绝 | 降级成一行 info | 「没人可问」是预期内结果，不是故障 |
| 危险操作拒绝 | 保留醒目框，标题改「已自动拒绝」、配色转 warning | 值得人看一眼，但同样不是"错误" |
| 真·工具错误 | 红框 Error，一字不改 | 不能把真问题一起抹平 |
| 覆盖 provider | claude + qoder | 两者 auto-approve 均已上线，归一化结构完全对称 |
| 远程主机 | 自动覆盖，无需改协议 | 远程历史走 `assembleHistoryRecords` 解出与本地**同形状**的 record，再进同一个 `normalizeMessage` 分支（`claude-sessions.provider.ts:746`） |

### 被否决的方案

**前端按文案嗅探。** 仓库已有先例（`ToolRenderer.tsx:56` 的 `CLAUDE_DENIAL_MESSAGES` 精确匹配 SDK 原生拒绝文案），只需 2–3 个文件。否决理由：那几条是**第三方 SDK 的文案**，我们只能嗅探；而自动审批的理由**是我们自己写的**，能在源头打标就不该让前端去解析中文。更关键的是失败模式——前后端两份中文，改后端措辞不会让任何测试变红，UI 会**静默**退回红框。而这个功能的全部价值就是"事后翻会话能看出这里被自动拒过"。

**只按工具名降级**（见到 `AskUserQuestion`/`ExitPlanMode` 的 isError 就换渲染）。最省，但有人值守时「无人应答超时」（`Permission request timed out`）也是同一形状，会被一起抹平——那是**真问题**，藏掉是倒退。

## 2. 数据契约

`NormalizedMessage`（`backend/server/shared/types.ts`）增加可选字段，与 `isError` 并列；`toolResult` 子形状同样增加：

```ts
/**
 * 仅 tool_result：这条结果是自动审批按策略拒绝的，不是工具真的失败。
 * 由后端从拒绝理由反推（理由文案的唯一来源是 permissions 策略模块），
 * 前端据此换渲染，因此不需要认识任何后端中文。
 * - 'interaction'：交互型工具没人可问 —— 预期内的正常结果
 * - 'blocked'：危险操作被策略拦下 —— 值得看一眼，但不是错误
 */
autoApproveDeny?: 'interaction' | 'blocked';
```

纯增量、可选：`lovdex-cli`、remote lite、codex/opencode 不认识该字段，忽略即可。

## 3. 策略模块 = 分类的唯一事实来源

`backend/server/modules/permissions/auto-approve-policy.ts` 新增：

```ts
/** 危险操作拒绝理由的统一前缀；COMMAND_RULES 每条 reason 都必须以它开头。 */
export const AUTO_APPROVE_BLOCKED_PREFIX = '拒绝：';

/** 把一条 tool_result 的内容分类成自动审批拒绝；不是自动拒绝就返回 null。 */
export function classifyAutoApproveDeny(content: unknown): 'interaction' | 'blocked' | null
```

判定：

1. `String(content).trim()` 精确等于 `UNATTENDED_INTERACTION_DENY_REASON` → `'interaction'`
2. 以 `AUTO_APPROVE_BLOCKED_PREFIX` 开头 → `'blocked'`
3. 其余（含非字符串、空串）→ `null`

两条路径互斥（交互型那条以「无人值守」开头，不以「拒绝：」开头）。

为让测试能遍历规则、钉住前缀约定，把 `COMMAND_RULES` 导出（`readonly`，仅供测试读取）。凭证路径那条理由（`:250`）是动态拼的 `拒绝：${target} 属于凭证或关键配置路径`，天然符合前缀。

## 4. 后端打标

四个构造点，两个 provider 结构完全对称：

| 文件 | 位置 | 打在哪 |
|---|---|---|
| `claude-sessions.provider.ts` | `normalizeMessage` 的 `tool_result` 分支（`:450`） | 消息**顶层** |
| `claude-sessions.provider.ts` | `fetchHistory` 的 `toolResultMap`（`:760-770`） | `toolResult` **对象** |
| `qoder-sessions.provider.ts` | `normalizeMessage`（`:255`） | 消息顶层 |
| `qoder-sessions.provider.ts` | `fetchHistory`（`:556-570`） | `toolResult` 对象 |

**两处都要**，因为历史路径下 `fetchHistory` 会把结果**预挂**到 tool_use 上（`claude-sessions.provider.ts:782-800`），而前端优先读预挂的那个（`useChatMessages.ts:214`：`msg.toolResult || toolResultMap.get(msg.toolId)`）。

只在 `isError` 为真时才调用分类函数——非错误结果的 content 是正常输出，没必要扫。

## 5. 前端渲染

### 5.1 为什么前端不显示理由原文

`UNATTENDED_INTERACTION_DENY_REASON` 的后半句「请基于现有信息自行判断并继续，不要再次请求确认。」是**写给模型的协议指令**，不是给人看的 UI 文案。而 `'拒绝：…'` 那几条（「拒绝：不允许在无人值守时推送远端（不可逆的外发操作）」）本来就是面向用户的。

所以两条路径分开处理，前端**不复制任何后端中文**：

| 分类 | 渲染 | 文案来源 |
|---|---|---|
| `interaction` | 一行灰字 info：`无人值守，无人可应答 — 已自动跳过 AskUserQuestion` | **前端 UI 文案**（硬编码中文，与 `AutoApproveNotice` 一致）+ `message.toolName` |
| `blocked` | 醒目框，标题「已自动拒绝」，配色 `warning`，正文用理由原文 | 理由原文（面向用户，直接展示） |
| `null` + `isError` | 红框 + `Error` | 不变 |

### 5.2 改动点

| 文件 | 改动 |
|---|---|
| `web/src/stores/useSessionStore.ts:69-73` | `NormalizedMessage` 加 `autoApproveDeny`（顶层与 `toolResult` 形状） |
| `web/src/components/chat/types/types.ts:21-27` | `ToolResult` 加同名字段 |
| `useChatMessages.ts:214-237` | `tool_use` 分支把 `tr.autoApproveDeny` 透传进 `toolResult` |
| `MessageComponent.tsx:209-227` | 红框分支拆成三分支（见上表） |
| `ToolRenderer.tsx:63-71` | `deriveToolStatus` 加 `if (toolResult.autoApproveDeny) return 'denied'` |
| `AutoApproveNotice.tsx` | 判据从 `content.startsWith('已自动拒绝')` 改为结构化字段（见 5.3） |

`ToolStatusBadge.tsx` 已有 `denied`（琥珀色 `bg-warning/10 text-warning`），工具卡徽标直接复用，不再显示红色 `Error`。

### 5.3 ⚡ 实时提示的判据要一起改

`AutoApproveNotice.tsx` 现在靠 `content.startsWith('已自动拒绝')` 决定用 warning 还是 muted 配色。交互型的新文案以「无人值守」开头，会**不再匹配**，配色会意外变化。

不靠巧合，直接把判据换成结构化字段：`useChatMessages.ts:323-334` 的 `permission_auto` 分支已经知道 `toolName` 和 `autoApproveBehavior`，在那里算出分类挂到 `ChatMessage` 上（`autoApproveDenyKind`），`AutoApproveNotice` 按它选配色。判据用 `toolName` 是否属于交互型工具（`AskUserQuestion` / `ExitPlanMode`，与 `toolConfigs.ts:504`、`:548` 同一集合），**不嗅探文案**。

顺带把交互型拒绝的 ⚡ 文案也换成同一句短 UI 文案，避免和工具卡那行重复一长串给模型看的指令。两处并存（⚡ 实时、工具卡持久），各自简短。

## 6. 测试

| 层 | 内容 |
|---|---|
| 策略模块 | `classifyAutoApproveDeny` 三分支（精确命中 / 前缀命中 / 非拒绝）；遍历 `COMMAND_RULES` 断言每条 reason 都以 `AUTO_APPROVE_BLOCKED_PREFIX` 开头；两条路径互斥 |
| provider 归一化 | 造一条 `is_error: true` + 理由文案的 record → `normalizeMessage` 输出带 `autoApproveDeny`；claude / qoder 各一 |
| provider 历史 | `fetchHistory` 预挂到 tool_use 上的 `toolResult` 带该字段 |
| web 转换 | `normalizedToChatMessages` 把字段透传进 `ChatMessage.toolResult` |
| web 渲染 | `renderToStaticMarkup`（无 DOM 环境）：`interaction` 分支**不含** "Error" 字样；`blocked` 分支含「已自动拒绝」且不含 `destructive` 类名；真错误分支仍是红框 |

后端验收标准是**零新增** tsc / lint 错误（基线本就不干净，见 `lovdex-backend-baseline-not-clean` 记忆）。

## 7. 不做的事

- 不改 `decideAutoApproval` 的判定逻辑，一条规则都不动
- 不改 `permission_auto` 帧的字段与发送时机
- 不给 remote lite 加协议字段（远程历史复用同一条归一化路径，无需 lite 侧改动）
- 不处理 `Permission request timed out` 等 SDK 原生拒绝的渲染（那是真问题，应保持红框）
- 不管 `normalizeMessage` 里那条扁平 `raw.type === 'tool_result'` 分支（`:643-666`，`isError` 写死 `false`，不产生红框）
