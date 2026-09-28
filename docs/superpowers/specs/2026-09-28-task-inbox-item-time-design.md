# 任务页「需要你处理」每条显示产生时间（替换 task_id）设计

日期：2026-09-28
状态：已批准（方案 B）

## 背景与痛点

任务页顶部聚合段「需要你处理」的每行末尾渲染的是 `item.task.task_id` —— 一整串 36 字符 UUID（`TaskInboxPanel.tsx:103-105`，窄屏 `hidden sm:inline`）。它既占宽度又不携带信息（点行本身就能进任务详情），而真正想知道的是「这条提醒是什么时候冒出来的」：消息一多，分不清哪条是刚发生的、哪条已经积了三天。

## 目标

- 每行末尾改为显示该条提醒**进入当前状态的时刻**，相对时间（如「12 分钟前」），悬停显示精确时间（如「2026-09-28 14:20」）。唯一例外是纯逾期条目 —— 它没有「产生时刻」（deadline 是日期不是时间），该位置留空，行的「已逾期 N 天」徽标已表达该信息。
- 界面上不再出现 task_id —— 那颗位置让给时间；需要 id 时进任务详情页（行本身可点）。
- 窄屏同样显示（不再 `hidden sm:inline`）：手机上「不知道什么时候产生」同样成立，且时间文案比 UUID 短得多。

## 非目标

- **不加数据库列**（方案 C）：要加迁移、要改所有写 `sub_status` 的路径，而且存量行回填不出真实值；`waiting_approval` 本来就是不落库的实时态，加列也照样得靠内存。
- **不改命中规则**：哪些任务算「需要你处理」完全不变（仍由 `attentionItems` 的 sub_status / deadline 判据决定），本次只换展示的那一列。
- 不修 `updated_at` 会被字段编辑顶动的问题（见「已知取舍」第 1 条）。

## 取值口径

「进入当前状态的时刻」按信号分两类。关键事实：**除实时审批外，`tasks.updated_at` 本来就精确等于进入该状态的时刻** —— 每一次转移都与它同一个 UPDATE 写入，所以不需要 `verdict_at` 参与。

| 信号 | 进入该状态的写入点 | `since` 取值 |
|---|---|---|
| 执行失败 `failed` | `updateTaskSubStatus(…, 'failed')` / `writeSummary` | `updated_at`（verdict 路径下与 `verdict_at` 同一条 UPDATE，必然相等） |
| `blocked` / `needs_review` / `only_plan` | `writeSummary`（verdict 折进 sub_status） | `updated_at` |
| 待你验收 `pending_acceptance` | 引擎把任务移到 `in_review` | `updated_at` |
| 等你回答 / 等你确认计划 | 运行停在 AskUserQuestion / ExitPlanMode 闸门，持久化 `waiting_*` | **等待进行中**：registry 记的提问到达时刻（与「等你批准」同路径，见下）；**运行已结束只剩持久化标签**：`updated_at`（即 `waiting_*` 落库的时刻） |
| **等你批准 `waiting_approval`** | **纯实时**：会话内存 registry 里有待批 tool，后端无任何时刻记录 | **新增**：registry 记录首个 `permission_request` 到达时刻 |
| 纯逾期 | deadline（`YYYY-MM-DD`，无时刻） | 不显示（「已逾期 N 天」已表达该信息） |

> 实现口径说明：「等你回答 / 等你确认计划 / 等你批准」三者都是 `approvalPending`，
> `decorate()` 走的是同一条分支 —— 只要审批标记还在，就取 registry 的等待起点。
> 上表把前两者写成 `updated_at` 是设计初稿的粗分类；实际实现更准确：提问到达的那一刻
> 正是提醒产生的时刻，而 `updated_at` 只在运行结束、`waiting_*` 落库时才被写。
> 运行结束后标记消失、时间自然落回 `updated_at`，两种口径在各自的时间窗内都成立。

## 后端改动

### 1. `chat-run-registry.service.ts` —— 记住审批请求到达的时刻

- 新增模块级 `approvalRequestedAt = new Map<string, string>()`：`appSessionId` → ISO 时间串。
- 写入点：`permission_request` 分支（`:243-251`）。条件是**以 `approvalRequestToSession` 为准**的「该会话当前没有任何待批请求」—— 不写成「本表里没有条目」，否则一次「批准 A → 又来 B」的连续等待会被误判成新等待（见下方时序）。
- 清理点 —— 该会话待批请求数归零时删除本表条目：
  - `clearApprovalRequestsForSession`（`:208-215`）：清完请求映射后一并删；
  - `takeApprovalRequestSession`（`:466-475`）：取走一个请求后，若 `approvalRequestToSession` 里已无以该会话为值的条目，一并删；
  - `clearAll`（`:567-571`）：一并清。
  - `takeApprovalRequestSession` 是批准 / 拒绝的唯一出口，所以「批准最后一个待批」也会走到；会话崩溃 / abort 走 `clearApprovalRequestsForSession`（`:305`），无需另加路径。
- 语义（时序自证）：
  - A 10:00 到、B 10:01 到、A 10:05 被批准 → 条目仍在、时刻仍是 10:00 —— 从未离开等待，正确；
  - A 10:00 到、A 10:05 被批准（条目删除）、B 10:06 到 → 重新写 10:06 —— 中间确实不处于等待，是新的等待段，正确。
- 新导出 `getApprovalRequestedAt(sessionId: string): string | null`（无条目返回 `null`）。
- `listPendingApprovalSessions` 的签名与返回**保持不变**（仍是 `Map<sessionId, toolName>`）：不把时间塞进这个既有契约，`tasks.service` 里 5 处测试 stub 与既有调用零改动。

### 2. `tasks.service.ts` —— decorate 派生 `attention_since`

`decorate()`（`:260-289`）本来就已经在查 `pendingApprovalSessions()`，同一处派生：

```
attention_since = approvalPending ? getApprovalRequestedAt(row.session_id) : row.updated_at
```

- 新注入 `getApprovalRequestedAt?: (sessionId: string) => string | null`，可选，缺省 `() => null`（与 `getPendingApprovalSessions`（`:228`）同款可选注入，既有单测不受影响）。
- `approvalPending === true` 但取不到时刻（如请求早于本进程启动）→ `null`，前端不渲染时间，不编造。
- 广播帧经 `emit → decorate`（`:293`）自带该字段；列表读路径 `listTasks` 走 `.map(decorate)`（`:616`），重建 / 重连同样带上。实时与重连两条路径不会漂移。

### 3. `index.js` —— 接线

`backend/server/index.js:548` 现有 `getPendingApprovalSessions: () => chatRunRegistry.listPendingApprovalSessions()` 一行旁边，补 `getApprovalRequestedAt: (sessionId) => chatRunRegistry.getApprovalRequestedAt(sessionId)`。漏了这行不会报错，只是审批条目永远不显示时间（可选注入的静默失败），实现后必须按验收第 2 条实测。

### 4. 类型

- `backend/server/shared/types.ts`：`TaskRow` 加 `attention_since?: string | null`，紧挨既有 `approval_pending` / `pending_tool`，注释写明「realtime-decorated，不落库；审批等待取 registry 时刻，其余取 updated_at」。
- `web/src/types/app.ts`：`Task` 加同名可选字段与同款注释。

## 前端改动

- **`taskInbox.ts`**：`AttentionItem` 加 `since: string | null`；`attentionItems` 里持久信号赋值 `since: task.attention_since ?? null`，纯逾期条目赋值 `since: null`。信号 → 时间戳的映射**只在后端一处**，前端不重复猜测（否则两侧判据迟早漂移）。
- **`TaskInboxPanel.tsx`**：`TaskInboxPanel.tsx:103-105` 那颗 task_id `<span>` 换成时间；`since` 为空时该元素不渲染：

```tsx
{item.since && (
  <span className="shrink-0 text-2xs text-muted-foreground" title={formatAbsoluteTime(item.since)}>
    {formatRelativeTime(item.since, now)}
  </span>
)}
```

- 相对时间每分钟重算所需 `now` 已由 `TaskBoard` 提供（`TaskBoard.tsx:63-67` 的 60s 定时器），本组件不新增定时器。
- 时间文案最长「3 天前」约 4 字，比原来的 36 字符 UUID 短，窄屏只会更宽松；实现后仍要实测 375px 一行不被挤坏（见验收）。

## 已知取舍

1. **`updated_at` 会被字段编辑顶动**：等你回答期间去改标题 / 优先级 / 备注，时间会漂到编辑时刻。可接受的失真（是「最近动过」而非「等待开始」）；要根治得走方案 C 加列，本次不做。
2. **后端重启补标的 failed**：`reconcileFailedTasks`（`:955-970`）只写 `sub_status` 不写独立时刻，`since` = 重启发现时刻而非真实失败时刻。语义上「这条提醒何时产生」正是重启那一刻，接受。
3. **`waiting_approval` 跨后端重启会丢**：时刻存在内存，重启后该条退化为不显示时间。这是既有限制（审批标记本身就是实时态），本设计不扩大也不缩小它。
4. **task_id 不再上屏**：需要 id 的场景（排查 / 对日志）本就该进详情页；界面不再为它留位置。
5. **时钟回拨 / 跨机部署下相对时间可能失真**：等待起点由后端 `new Date().toISOString()` 生成，前端 `formatRelativeTime` 拿浏览器时钟相减。两者同一台机器时无此问题；若前端跑在另一台时钟偏慢的机器上，会出现「刚刚」被压成负差（既有实现已把负值归到「刚刚」）或显示的时间比真实偏短。与 `verdict_at` 等既有时间字段同一性质，本次不额外处理。

## 测试计划

1. `chat-run-registry.test.ts`
   - 首个 `permission_request` 写入时刻；同会话第二个请求**不覆盖**；
   - 「批准 A 后 B 才到」→ 时刻更新为 B 的到达时间（新等待段）；
   - `takeApprovalRequestSession` 取走全部后 `getApprovalRequestedAt` 归 null；
   - 终态 `complete`（含 abort / 崩溃合成路径）清空；
   - `clearAll` 清空；无记录会话返回 null。
2. `execution-linkage.test.ts`
   - `approval_pending` 行取注入的时刻；
   - 非审批行 `attention_since === updated_at`；
   - 注入缺省 / 返回 null 时为 `null`，不抛错。
3. `TaskInboxPanel.test.tsx`
   - 渲染相对时间文案；界面上**不再出现** task_id；
   - `since` 为 null 时不渲染时间元素（纯逾期条目）；
   - `title` 为绝对时间。
4. `taskInbox.test.ts`
   - `attention_since` 透传到 `AttentionItem.since`；逾期条目 `since === null`。

## 手工验收

任务页造三类条目（一条 failed、一条 waiting_approval、一条逾期）：

1. 每行末尾显示「N 分钟前」，悬停显示「2026-09-28 14:20」；
2. 审批那条在批准 / 拒绝后条目消失（既有行为），重新触发一次待批则时间重新从「刚刚」起算；
3. 逾期那条不显示时间，仍是「已逾期 N 天」；
4. 375px 窄屏下一行不被时间挤坏，动作按钮仍可点。

## 实测记录（2026-09-28，重启后端后）

后端重启于 16:17（kill `tsx server/index.js`，supervisor 拉起新进程）。以下均为 live 环境实测，非单元测试结论。

**1. `attention_since` 出现在 API 响应里（接线未漏）**

`GET /api/tasks` 返回 381 行，**381 行全部带 `attention_since`**。这条针对的正是「注入漏了不报错、任何单测都抓不到」的风险 —— 已排除。

**2. 普通信号取 `updated_at`**

当前 7 条收件箱条目的 `attention_since` 与各自 `updated_at` **逐字节相等**（`pending_acceptance`、`failed` 各若干条）。

**3. 审批路径确实走 registry，而不是退化成 `updated_at`**

实测样本（「调查并修复：清理定时任务后…」）：

| 字段 | 值 |
|---|---|
| `attention_since` | `2026-09-28T08:19:20.712Z` |
| `updated_at` | `2026-09-28T08:17:58.000Z` |
| `started_at` | `2026-09-28T08:08:58.000Z` |

判据有两重，任一即可定案：

- **值不同**：`since`（16:19:20）晚于 `updated_at`（16:17:58）—— 问题是在运行开始之后才提出的，取 `updated_at` 会早报 1 分 22 秒。
- **精度签名**：`since` 的毫秒位是 `.712`，而所有 SQLite 时间戳都是整秒（`.000`）。只有 registry 的 `new Date().toISOString()` 能产出毫秒 —— 该值是 registry 路径的原生产物，不是落库字段。

**4. 浏览器渲染（headless Chrome，dev 服务器 :5188）**

| 检查 | 结果 |
|---|---|
| 每行末尾是相对时间 | 「1 小时前」「3 分钟前」「刚刚」 |
| 悬停 `title` 是精确时间 | `2026-09-28 15:04` / `16:17` / `16:19` |
| 界面上还有 task_id 吗 | **没有了**（逐行 `hasUuid` 全 false） |
| 动作按钮完好 | 「✓ 标记完成 / 打开会话」「↻ 重试 / 🗄 忽略 / 打开会话」 |
| 375px 窄屏 | 时间 `display: block`、可见；行 `scrollWidth === clientWidth === 375`，**无横向溢出**；动作按钮仍在 |

唯一一条控制台报错是 `WebSocket error: [object Event]` —— headless 环境下的既有噪声，与本次改动无关。

**5. 重启的连带影响（如实记录）**

`reconcileFailedTasks` 在启动时把 4 条断线任务的 `sub_status` 补成 `failed`，`attention_since` 因而等于 16:17:18（重启发现时刻）—— 与「已知取舍」第 2 条的预期一致，即「这条提醒何时产生」= 重启那一刻。这 4 条现在会出现在收件箱「执行失败」组里，属于预期行为而非回归。

**仍未实测的一项**：审批条目的时间是否随等待时间增长（「刚刚」→「1 分钟前」）。本次实测时该条目出现不足一分钟即无法再观察。判据 3 的两重证据已足以证明取值路径正确，但「相对时间随 `now` 重算」这一环未在浏览器里跨分钟验证过；它依赖的是 `TaskBoard` 既有的 60s 定时器，不是新代码。
