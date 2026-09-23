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

这条前提在 **claude** 上用真实数据验证过，不是推断：扫全部 `~/.claude/projects/**/*.jsonl` 的 9928 条 tool_result，命中 `interaction` 3 条、**逐字不等的 0 条**。同期命中 `blocked` **0 条**（还没有危险命令被拒过的记录），所以 `'拒绝：'` 前缀那条路径目前只有单测覆盖、没有真实数据背书。

### ⚠️ 但这条前提**不跨 provider** —— qoder 有 CLI 包装（2026-09-23 实测更正）

初稿把上面那条结论当成了通用前提，**这是错的**。qoder 侧的完整链路实测如下：

| 环节 | 证据 |
|---|---|
| 宿主发出裸串 | `qoder-runner.js:528` `message: 'Permission request timed out'` |
| CLI 日志 | `permission.resolved … allowed:false, outcome:"cancel", reason:"Permission request timed out"` |
| **CLI 落盘** | 同一 `tool_call_id` 在 transcript 里是 `content: "Error: Permission request timed out"`，`is_error: true` |

**qoder CLI 会在 `control_response.message` 前加 `Error: `。** 自动拒绝走的是同一条通道（`qoder-runner.js:498`），所以真实落盘是 `Error: 无人值守执行中，无人可应答。…` —— 而 `classifyAutoApproveDeny` 做的是 trim 后全等/前缀匹配，**在 qoder 上 100% 落空**（把本机全部 33 条真实 qoder error tool_result 喂进分类函数，命中 0 条）。

#### 「自动拒绝也会被同样包装」的论证强度

严格说，本机 32 条带前缀的记录里没有一条来自 `decideAutoApproval`（来源是 CLI 自产错误 25 条 + 超时拒绝 5 条）。但两条拒绝路径用的是**完全相同的调用形状**：

```js
// 自动拒绝 (qoder-runner.js:498)
buildQoderControlResponse(requestId, { allow: !denied, message: denied ? decision.reason : undefined, updatedInput: parsed.input })
// 超时拒绝 (qoder-runner.js:528) —— 这条已实测落盘为 "Error: Permission request timed out"
buildQoderControlResponse(requestId, { allow: false, message: 'Permission request timed out' })
```

同一个函数、同一个 `message` 字段、同样 `allow: false`，**只有字符串不同**；而 CLI 的 `Error: ` 包装是加在**字段**上的（不是针对特定字符串）。所以这不是「同通道外推」，是「同一字段、同一包装点」的直接推广。

**仍未闭环的部分**：没有在真机上跑过一次真实的自动拒绝并核对落盘。这是 Task 7 的端到端项。

**教训**：核实「文案是否逐字相同」必须查到**落盘那一层**。初稿的核实步骤只 grep 了宿主（`qoder-runner.js` 确实没加工），漏了 CLI 这一层，而加工恰恰发生在那里。

**修法**：在 qoder 归一化层剥掉这个已知包装后再分类（`stripQoderErrorPrefix`），**不改 `classifyAutoApproveDeny` 本身** —— 它是两个 provider 共用的唯一事实来源，让 claude 也容忍这个前缀会削弱 claude 侧的精确契约（claude 落盘是裸串，有真实记录背书）。

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

/** 把一条 tool_result 分类成自动审批拒绝；不是自动拒绝就返回 undefined。 */
export function classifyAutoApproveDeny(
  isError: unknown,
  content: unknown,
): 'interaction' | 'blocked' | undefined
```

判定：

1. `isError` 非真 → `undefined`。**`isError` 必须参与分类**：只有被拒的工具调用才会拿到这段文案，正常输出即使碰巧相等也不是拒绝。
2. `String(content).trim()` 精确等于 `UNATTENDED_INTERACTION_DENY_REASON` → `'interaction'`
3. 以 `AUTO_APPROVE_BLOCKED_PREFIX` 开头 → `'blocked'`
4. 其余（含非字符串、空串）→ `undefined`

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

### 4.1 分类输入用 `.text` 约定解码，不是展示值

provider 里 `content:` 的展示值对数组形态走 `JSON.stringify`（保持既有显示行为不变），但分类必须走 `shared/utils.ts` 的 `toolResultTextForClassification`（数组按 `.text` 拼，与 `transcript-history.ts` 的既有约定一致）。用 `JSON.stringify` 喂分类会让数组形态**静默**丢标（序列化后以 `[{` 开头，前缀匹配不成立）。真实 transcript 里数组形态确实存在（claude 侧 `str` : `list` = 78744 : 2005）。

### 4.2 qoder 要额外剥掉 CLI 的 `Error: ` 包装

见 §0 的实测更正。`qoder-sessions.provider.ts` 的两处分类调用点都先过 `stripQoderErrorPrefix`。

## 5. 前端渲染

### 5.1 为什么前端不显示理由原文

`UNATTENDED_INTERACTION_DENY_REASON` 的后半句「请基于现有信息自行判断并继续，不要再次请求确认。」是**写给模型的协议指令**，不是给人看的 UI 文案。而 `'拒绝：…'` 那几条（「拒绝：不允许在无人值守时推送远端（不可逆的外发操作）」）本来就是面向用户的。

所以两条路径分开处理，前端**不复制任何后端中文**：

| 分类 | 渲染 | 文案来源 |
|---|---|---|
| `interaction` | 一行灰字 info：`无人值守，无人可应答 — 已自动跳过 AskUserQuestion` | **前端 UI 文案**（硬编码中文，与 `AutoApproveNotice` 一致）+ `message.toolName` |
| `blocked` | 醒目框，标题「已自动拒绝」，配色 `warning`，正文用理由原文 | 理由原文（面向用户，直接展示） |
| `null` + `isError` | 红框 + `Error` | 不变 |

### 5.1b ⚠️ qoder 的 `blocked` 正文会带 `Error: ` 前缀，必须处理

`blocked` 分支直接展示 `toolResult.content`，而 **qoder 的 content 是 `Error: <理由>`**（CLI 包装，见 §0 的实测更正）——用户会在「已自动拒绝」标题下看到 `Error: 拒绝：不允许在无人值守时推送远端…`，自相矛盾。

**必须解决，不能带着这个上**。两条可选路径，实现时二选一并说明理由：

- **(A) 后端剥**（推荐）：qoder 归一化时，对**已判定为自动拒绝**的结果，把 `content` 也剥掉 `Error: ` 前缀。好处：一处解决，下游（渲染、复制）都拿到干净文本；代价：normalized `content` 不再逐字复现 transcript —— 但仅限自动拒绝这一类，而这类结果的呈现本来就要被重新框定。
- **(B) 前端剥**：`AutoApproveDenyNotice` 的 `blocked` 分支剥掉开头的 `Error: `。好处：后端保持忠实；代价：前端又要认识一段 CLI 文案，与本节「前端不复制任何后端中文」的原则直接冲突。

选 (A) 时测试要断言：自动拒绝的结果 `content` 已无 `Error: ` 前缀，而**非**自动拒绝的错误结果 `content` **原样保留** `Error: `（不能被顺手改坏）。

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

#### ⚠️ Bash 是一条独立的渲染路径（2026-09-23 实施时发现，初稿漏了）

初稿的 §5.1 表格只描述了 `MessageComponent.tsx` 的红框分支，**漏了 `MessageComponent.tsx:211` 的 `message.toolName !== 'Bash'` 排除**（继承自「Bash 输出画在命令行里」）。后果：**被拦的 Bash 命令永远进不了新组件**，只能走 `ToolRenderer` 的 input 路径 → `BashCommandDisplay.tsx`，而那里 `:70` / `:147` 在 `isError` 时仍用 `destructive` 染红边框与正文 —— 只有徽标从红 `Error` 变成琥珀 `Denied`。

**这不是边缘情况**：`COMMAND_RULES` 里多数是 Bash 命令规则，全量 transcript 的真实拒绝中 **Bash 占 109/173**。也就是说 `blocked` 的「琥珀框 + 标题『已自动拒绝』」在多数场景下不会生效，用户看到的仍是红框。

**修法**：两处，缺一不可。

1. **放宽 gate**：`message.toolName !== 'Bash' || Boolean(message.toolResult.autoApproveDeny)`，让**带标记的** Bash 也走 `AutoApproveDenyNotice`。被拦的 Bash 会同时显示命令行那一行（说明**尝试了什么**）+ 下方的琥珀框（说明**为什么被拒**）——信息互补。
2. **命令行那一行也要走同一个判据**：`ToolRenderer.tsx` 传给 `BashCommandDisplay` 的 `isError` 由裸的 `Boolean(toolResult?.isError)` 改为 `toolStatus === 'error'`（复用已归一的 `deriveToolStatus`）。否则只做第 1 步的话，命令行那行仍按 `isError` 染红，「不含 destructive」的目标落空。

> **第 2 步不是「把 warning 配色复制到第二处」**：它没有引入任何新文案或新配色，只是让「这行该不该看起来像故障」走**同一个** status 判据。真故障（`isError` 且无标记）时 `deriveToolStatus` 仍返回 `'error'`，行为不变。

**否决的替代方案**：在 `BashCommandDisplay` 里按 `autoApproveDeny` 自己判一次配色。那会把「已自动拒绝」的标题与配色**复制到第二处**，且需把字段透传进 `BashCommandDisplayProps`——两处判据也会漂开。

#### ⚠️ 接线测试不要用「读源码断言」

初稿在「无 DOM 环境渲染不了 `MessageComponent`」的前提下，退而用读源码 + `indexOf` 的结构断言。**该前提是错的**：只需 `import './i18n/config.js'`（同目录的 `ProviderSelectionEmptyState.test.tsx` 已有先例），`renderToStaticMarkup` 一个 `MessageComponent` 13ms 跑通。

结构断言两个方向都会误判：**误红**（多行书写、等价的可选链、改写成 `switch` 都会让字面量匹配失败）与**漏红**（路由写成 `!== 'auto-denied'` 时字面量与顺序都还成立，测试全绿而行为全错）。**用真渲染，不要用读源码。**

### 5.3 ⚡ 实时提示的判据要一起改

`AutoApproveNotice.tsx` 现在靠 `content.startsWith('已自动拒绝')` 决定用 warning 还是 muted 配色。

**注意这不是在修一个已经出错的行为**：交互型的新文案以「无人值守」开头，旧判据下落到 muted，而交互型本来就该是 muted —— 结果碰巧是对的。要改是因为**这个「对」完全依赖文案前缀碰巧一致**，后端改一次措辞（比如把理由改成「无人值守中…」以外的主语）就会静默错色，而且没有任何测试会红。

所以把判据换成结构化字段：`useChatMessages.ts:323-334` 的 `permission_auto` 分支已经知道 `toolName` 和 `autoApproveBehavior`，在那里算出分类挂到 `ChatMessage` 上（`autoApproveDenyKind`），`AutoApproveNotice` 按它选配色。判据用 `toolName` 是否属于交互型工具（`AskUserQuestion` / `ExitPlanMode`，与 `toolConfigs.ts:504`、`:548` 同一集合），**不嗅探文案**。

因为这是纯契约收紧、不改变现有三种输入下的观感，测试必须**让文案与分类正交**才能真正钉住它（同一段文案、只换分类字段，断言颜色跟着字段走）——否则新旧实现都会绿。

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

### 7.1 已知缺口：subagent 子工具（显式不含，非疏漏）

Task 2 的代码审查发现的**计划本身**的缺口，记在此处以免变成默认沉默：

**问题**：subagent 内部工具调用的结果走的是**另一条构造路径** —— `providers/list/shared/transcript-history.ts` 的 `parseAgentToolsContent` 构造 `toolResult: {content, isError}`，不带 `autoApproveDeny`；前端 `SubagentContainer.tsx:126` 同样认 `isError` 画红色 `(error)`。所以一个被自动拒绝的 `AskUserQuestion` 若发生在 subagent 内，红字照旧。

**为什么本次不做**：

1. 实测全量 transcript（9928 条 tool_result）里 **subagent 内的 deny = 0 条**；
2. 它是独立的构造路径 + 独立的渲染组件，混进来会让 Task 5 的边界变模糊；
3. 修它需要动 shared 层 + 前端子工具渲染，属于另一处 UI 语义决策（子工具卡片该不该有 info 态）。

**若要做**（backlog）：在 `parseAgentToolsContent` 里复用 `classifyAutoApproveDeny`（该文件与策略模块同在 shared 层，导入无环），并让 `SubagentContainer` 对带标记的子工具不画红。

### 7.2 已知架构债：`AutoApproveDenyKind` 的住处（记录，暂不处理）

`AutoApproveDenyKind` 是**线协议**概念（后端 `shared/types.ts` 定义），前端却把权威副本放在 `components/chat/utils/` 这个 **UI 目录**里。而 `web/src/stores/useSessionStore.ts` 的 `NormalizedMessage` 自述是线协议契约（「mirrors server/adapters/types.js」），是线协议类型的既有住处。

后果：store 要么从 UI 层反向 import（方向拧），要么再抄一份字面量（现状，且这份**没有任何测试或编译期约束**——wire-value 钉死测试只冻结了 `utils/` 那一份）。

**暂不处理**：Task 4 的代码审查判定「不阻塞合并」。若将来还要再动这块，把类型挪到一个中立的 web 模块（例如挨着 `web/src/types/app.ts`），让 `stores/` 与 `components/` 都从那里 import，store 那两份内联字面量就自然消掉。

**另一条同时记录的边界**：`autoApproveDeny.test.ts` 的 wire-value 测试**防不住跨进程漂移**——它只能冻结前端侧字面量，后端改了它不会红。真正的跨包 guard 成本高、可能不值得，但注释里不应声称已解决漂移。
