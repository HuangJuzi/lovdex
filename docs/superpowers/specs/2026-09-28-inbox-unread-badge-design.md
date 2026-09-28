# 收件箱未读角标：计数口径对齐 + 按严重度着色设计

日期：2026-09-28
状态：已批准（方案 A）

## 背景与痛点

用户反馈：**收件箱有新消息时，左侧导航的收件箱没有数字提示，必须点开收件箱才知道有未读。**

根因在 `web/src/stores/inboxStore.pure.ts:26-29` 的 `countUnread`：

```ts
// info 不计入角标（spec §5）：只有 warning/critical 才是"要你看一眼"的。
return items.filter((it) => !it.read_at && it.severity !== 'info').length;
```

它显式排除了 `info`。而用户库里的未读**恰好全是 info**（实测 `~/.lovdex/data/new-auth.db`）：

| severity | 总数 | 未读 |
|---|---|---|
| info | 8 | 3 |
| warning | 15 | 0 |

于是侧栏角标恒为 0，打开 `/inbox` 却能看到 3 条 —— 现象与反馈完全一致。这 3 条都是 yMaaS 自动审批类的 info。

**关键事实：这个排除只发生在侧栏角标这一处。** 系统其它四处早就把 info 算作未读了：

| 消费点 | 口径 | 依据 |
|---|---|---|
| 后端 `GET /api/notifications/unread-count` | 含 info | `notifications.db.ts` `SELECT COUNT(*) WHERE read_at IS NULL` |
| 助手 `list_notifications` 返回的 `unreadCount` | 含 info | 同上（`notifications.service.ts` 直接转发） |
| `/inbox` 页头角标 + 「未读 N」筛选 chip | 含 info | `InboxPage.tsx:79` 用 `!it.read_at` |
| 收件箱列表的未读小红点 | 含 info | `InboxList.tsx:63` 对所有未读一律 `bg-destructive` |
| **侧栏角标** | **排除 info** | `countUnread`（唯一一处） |

也就是说同一屏上「侧栏 0」与「页面里 3 个红点」自相矛盾。这不是一个待讨论的口径选择，而是一处遗留的不一致。

## 目标

1. 侧栏角标与其余四处口径统一：**统计全部未读，含 info**。
2. 在分类不再被计数排除之后，用**颜色**保住「红 = 严重」的辨别力：角标按未读里的最高严重度着色。
3. 不改变 info 的其余降噪语义：**仍然不弹 toast、不进补推汇总弹窗**。

## 非目标

- **`/tasks`、`/scheduled`、`/stats`、`/settings` 不挂侧栏**，本次不给它们加任何收件箱入口或提示。`Sidebar` 组件只在 `/`、`/session/:id`、`/inbox` 三个路由渲染（`App.tsx:130-134`），这是既有结构，不属本次范围。
- **侧栏折叠态**（`SidebarCollapsed`，48px 图标条）本来就没有收件箱入口，故无角标。本次不加。
- 不给 info 加 toast、不让 info 进汇总弹窗。
- 不改后端计数逻辑（它本来就含 info，无需改）。
- 不改 `dedupe_key` 合并规则、不加 `ignored` / 归档类新状态。
- 不 bump `ALERT_SKILL_VERSION`（理由见 §5）。

## 派生逻辑（纯函数层）

`web/src/stores/inboxStore.pure.ts`：

```ts
/** 未读总数 —— 与后端 unread-count、/inbox 页头、列表红点同一口径（含 info）。 */
export function countUnread(items: readonly InboxNotification[]): number {
  return items.filter((it) => !it.read_at).length;
}

/** 未读里的最高严重度；无未读时为 null。决定角标配色。 */
export function selectUnreadTone(items: readonly InboxNotification[]): InboxSeverity | null
```

`selectUnreadTone` 的优先级为 `critical > warning > info`，空集（或全已读）返回 `null`。

**刻意复用 `InboxSeverity` 作为色调类型，不新增 `InboxBadgeTone` 别名。** 一份类型而不是两份语义相同的枚举；将来若严重度分级变化，编译期会把角标一起带上。

**保留不改**：

- `selectUnannouncedImportant`（`inboxStore.pure.ts:38-45`）继续排除 info —— 补推汇总弹窗的候选集不变。
- `applyInboxEvent` 里 `toaster = row.severity !== 'info'`（`inboxStore.ts:65`）不变 —— info 依然不弹 toast、不记 `announced` 账。

这三条合起来即「info 会计数、会有颜色，但依然安静」。

## 订阅方式

`SidebarInboxEntry` 用**两个返回原始值的订阅**，而不是一个返回新对象的：

```ts
const unread = useSyncExternalStore(subscribeInbox, getUnreadCount, () => 0);
const tone = useSyncExternalStore(subscribeInbox, getUnreadTone, () => null);
```

**为什么不用一个返回 `{ unread, tone }` 的订阅**：`useSyncExternalStore` 的 `getSnapshot` 要求返回值在未变更时引用相等（它用 `Object.is` 比较来决定是否重渲染）。返回新对象字面量会导致无限重渲染，要绕开就得在 store 里按快照缓存派生对象、在 `setState` 时失效 —— 为一个 2 字段的派生值引入引用缓存是负收益。两个原始值（number / string|null）天然稳定，全部复杂度消失。代价是两次 `useSyncExternalStore` 调用，可忽略。

两个函数在 `inboxStore.ts` 里各加一个薄包装（与 `getUnreadCount` 同级）：

```ts
export function getUnreadCount(): number { return countUnread(state.items); }
export function getUnreadTone(): InboxSeverity | null { return selectUnreadTone(state.items); }
```

## 角标渲染

`SidebarInboxEntry.tsx:36-40`，按 `tone` 选 `badgeClass`：

| tone | 样式 | 语义 |
|---|---|---|
| `critical` | `bg-destructive text-destructive-foreground` | 红底白字（现状） |
| `warning` | `bg-warning text-warning-foreground` | 琥珀底 |
| `info` | `border border-border bg-muted text-muted-foreground` | 中性灰底 + 细描边 |

info 的灰底刻意与收件箱列表里 info 的图标色块同款 token（`InboxList.tsx:24` 的 `bg-muted text-muted-foreground`），保证同一严重度在列表与角标上看起来是同一件事。浅色主题下 `--muted` 与 `--card` 接近，故必须带 `border border-border`，否则整个角标会糊在侧栏底色上不可见。

其余保持：`>99` → `99+`；整行 `unread > 0 && 'bg-primary/5'` 的弱高亮保留（现在任何未读都会触发）；已读后角标消失。

`unread === 0` 时渲染 `null`（现有行为）。`tone` 与 `unread` 的一致性由构造保证：`tone === null` ⟺ `unread === 0`，两者同源同快照。

文件头注释（`:12`，现写作「未读数用红点角标显示」）同步改为描述按严重度着色。

## 文案与文档同步

行为改了而描述不改会静默漂移，以下四处必须一起改：

| 位置 | 现状 | 改为 |
|---|---|---|
| `backend/server/claude-sdk.js:62` `OPERATOR_INBOX_PROMPT` | 「severity 取 critical/warning/info：critical 和 warning 会弹窗并计未读角标，info 只进收件箱」 | 「critical 和 warning 会弹窗；三种 severity 都计未读角标（info 为中性灰），info 不弹窗」 |
| `backend/server/modules/operators/operator.tools.ts:773` `send_notification` 描述 | `(info lands in the inbox only — no toast, no badge)` | `(info lands in the inbox and counts toward the sidebar badge, but never toasts)` |
| `backend/server/index.js:2245` 注释 | 「进收件箱、不弹窗不计角标」 | 「进收件箱、计角标、不弹窗」 |
| `docs/superpowers/specs/2026-09-20-inbox-notification-design.md` §5 表 | info 行「侧边栏角标 = 不计入」 | 「计入（中性灰）」+ 一条 2026-09-28 修订说明指向本文档 |

**`ALERT_SKILL_VERSION` 不 bump。** 已安装的 `SKILL.md` 正文只写「收件箱会在浏览器弹窗、在侧边栏显示未读角标，并可在 /inbox 页面回看」，对 info 是否计数无任何相反表述，改版后这段话依然准确。bump 会给所有已装用户推一条 `skill_update` 通知，属于无收益打扰。

## 测试

- `web/src/stores/tests/inboxStore.test.ts:16` —— 反转断言：原「countUnread 排除 info（spec §5）」改为「countUnread 计入 info」。
- 新增 `selectUnreadTone` 用例：
  - 空集 → `null`；全已读 → `null`
  - 只 info 未读 → `'info'`
  - warning + info → `'warning'`
  - 含 critical → `'critical'`
  - 已读的 critical 不抬升色调（只按未读判定）
- `SidebarInboxEntry.test.tsx` —— 现有三条只覆盖路由高亮，补：
  - 注入一条 info 未读 → 渲染出文本 `1`，且角标带 `bg-muted`
  - 注入一条 critical 未读 → 角标带 `bg-destructive`
  - 未读为 0 → 不渲染角标（断言 `99+` 之类的数字不出现）
  注入走模块级 store 的 `applyInboxEvent({ kind: 'notification_created', payload: row })`；store 是模块级单例，用例之间用 `stubList([])` + `await refreshInbox()` 清空（同 `inboxStoreCatchUp.test.ts:19-21` 的做法，store 没有可用的公开 reset）。
- 后端无改动、无新测试：`unreadCount()` 本来就含 info，`notifications.db.test.ts:46`「unreadCount 只数未读」已覆盖。
- 守卫测试 `web/src/design/tokenGuard.test.ts` 会自动校验新增 class 是否用了非法色值 —— 上述三档全部是语义 token，无需豁免。

## 验收

真实库里当前有 3 条未读 info，可直接端到端验证：

1. 侧栏收件箱出现**灰色** `3`。
2. 打开 `/inbox`，点「全部已读」→ 返回侧栏，角标消失。
3. 注入一条 `critical` 通知（助手 `send_notification` 或直接 emit）→ 角标为**红底** `1`。

判定用 DOM 读取（`textContent` + `getComputedStyle` 背景色），不用整图截图——整页截图的图像描述会编造内容。

## 已知取舍

1. **info 从此会点亮角标。** 高频巡检产生的 info 会让侧栏长期挂着一个非零灰数字。这是用户明确选择的（「全部未读都计数」），并且与后端 unread-count、/inbox 页头早已一致；若不接受，应改的是全局口径而非只留一处例外。缓解手段是减少高频巡检上报 info 的频次，或在收件箱里及时「全部已读」。
2. **角标颜色只表达「未读里最严重的那条」。** 3 条 info + 1 条 warning 与 1 条 warning 都显示琥珀 `4` / `1`，颜色相同。这是有意的：角标是「有没有事、多急」的一眼信号，精确构成进 /inbox 看。
3. **两个 `useSyncExternalStore` 订阅同一 store**，每次状态变更触发两次 listener 通知。`listeners` 是 `Set`，两次是两次独立注册的回调，开销与一个订阅返回对象相比可忽略。
