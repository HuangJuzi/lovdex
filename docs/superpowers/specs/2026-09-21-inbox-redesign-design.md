# 收件箱改版（弹窗轻量化 + 两栏页面 + 保留侧边栏）· 设计文档

日期：2026-09-21
状态：已评审（2026-09-21）

## 1. 背景与目标

用户反馈三条：

1. **收件弹窗太丑、太突兀** —— 通知「啪」地出现在正对视线处，整块染色，零过渡。
2. **收件箱页面太窄** —— `max-w-3xl` 单列，两侧大片留白。
3. **打开收件箱时应用侧边栏消失** —— 只能靠左上角 `←` 摸回去。

对应目标：

1. 弹窗**不换位置**，只降视觉重量 + 补入场动效（已选定方案 5）。
2. 收件箱页改**两栏：列表 + 详情**（已选定方案 B），并补齐每条的信息列。
3. `/inbox` 保留左侧导航侧边栏。

### 非目标（YAGNI）

- **不抽 `AppShell` 布局组件**。`/tasks`、`/stats`、`/settings` 维持现状（独立整页 + 返回按钮）。将来若要让所有整页路由都带侧边栏，再单独做——那是一次覆盖四个页面的大重构，不该搭这次的车。
- **不动 `DialogTitle` 的 `sr-only` 默认值**。全仓 9 个调用点依赖它（自渲染可见头部 + sr-only 标题做 a11y），改默认值是高回归面低收益。
- **不新增后端字段、不改通知表**。两栏所需数据现有 `InboxNotification` 全都有。
- **不做通知搜索、批量选择、分页**。当前量级（个位数到几十条）用不上。
- **不做「来源」的精确归类**（如区分「Lovdex助手」与普通任务）。见 §4.4。

## 2. 现状（已实证）

| 事项 | 位置 | 现状 |
|---|---|---|
| toast 容器 | `web/src/shared/view/ui/Toast.tsx:36` | `w-80 rounded-md border p-3 shadow-lg` + 整块 severity 染色 |
| toast 生命周期 | `Toast.tsx:28-31` | 挂载即出现，6s 后 `onDismiss` **直接卸载**——无入场、无退场 |
| 汇总弹窗 | `web/src/components/app/AppContent.tsx:341-354` | `<DialogTitle>` 是 `sr-only`，**屏幕上没有标题**，只剩裸圆点列表 |
| `DialogTitle` 默认 | `web/src/shared/view/ui/Dialog.tsx:214` | `cn('sr-only', className)` —— 传 `className` 也去不掉 `sr-only` |
| 收件箱页 | `web/src/components/inbox/InboxPage.tsx:47` | `mx-auto h-screen w-full max-w-3xl p-4` |
| 列表条目 | `InboxPage.tsx:68-82` | 只有 `title` + `line-clamp-3` 的 `body`，无时间、无来源、无操作 |
| 路由 | `web/src/App.tsx:134` | `/inbox` 直接渲染 `InboxPage`，**不经过 `AppContent`** → 侧边栏与移动端抽屉都不存在 |
| 数据结构 | `web/src/stores/inboxStore.pure.ts:3-15` | 已有 `first_seen_at` / `last_seen_at` / `occurrence_count` / `read_at` / `code` / `task_id` / `session_id` |
| 内置 code | `backend/server/index.js:2247` | 全仓唯一内置 code 是 `skill_update` |

**关键约束：`code` 是用户自定义的自由文本**（来自 prompt 里的 `lovdex-alert` 块，如 `disk_full`），后端 `EmitInput.code` 是 `code?: string | null` 不枚举。**不能基于 `code` 建来源分类表**——否则用户随手写个新 code 就漏标签。

**设计系统约束**（`web/src/design/scaleGuard.test.ts` / `tokenGuard.test.ts`）：字号与圆角只能用 `tailwind.config.js` 里的具名档位，禁止 `text-[13px]` / `rounded-[10px]`；颜色只能用语义 token，禁止 `bg-gray-800` / `#abcdef` / `rgb(…)`；整块阴影里那 5 个「复现配方」必须用具名 `shadow-raised-*`。

**透明度修饰符只能是 5 的倍数**（2026-09-21 实测）：Tailwind 3.4 对非 arbitrary 的透明度修饰符要求 `theme.opacity` 里有该键，而默认刻度是 5 的倍数。`bg-destructive/12`、`bg-popover/78` 这类值会被**静默丢弃、不产出任何 CSS**（不是报错，是元素直接没有背景）。要非 5 倍数的透明度必须写 arbitrary 形式 `bg-destructive/[0.12]`。本设计的取值一律落在 5 的倍数上。

## 3. 弹窗改版（方案 5：毛玻璃轻量化）

核心判断：**「突兀」主要不是位置问题，是「没有过渡 + 太实」**。位置不动，只改材质和动效。

### 3.1 实时 toast

| 维度 | 现在 | 改为 |
|---|---|---|
| 定位 | `fixed right-4 top-4` | **不变** |
| 底/边框 | 整块 `bg-destructive/10` + `border-destructive/50` | `bg-popover/80` + `backdrop-blur-xl` + `border-border/70` |
| 圆角 | `rounded-md`（6px） | `rounded-2xl`（16px） |
| 阴影 | `shadow-lg`（Tailwind 默认） | `shadow-raised-md`（具名档位） |
| 严重度表达 | 整块染色 | 只落在 **28px 图标块**：`bg-destructive/10` + `text-destructive`；warning / info 同理换 token |
| 入场 | 无 | `opacity 0→1` + `scale .94→1`，260ms `cubic-bezier(.2,0,0,1)` |
| 退场 | 无（直接卸载） | 反向 180ms，动画结束再移除节点 |
| 停留 | 6s | 6s，**新增悬停暂停** |
| 关闭 | `✕` | 不变 |

**退场需要状态机**：`ToastCard` 增加 `closing` 状态，`onDismiss` 不再直接删；先置 `closing` 加退出动画类，`onAnimationEnd` 再调用真正的移除。`useToastStack.dismiss` 语义不变（就是删），动画层在 `ToastCard` 内部完成。

**悬停暂停**用 deadline 时间戳而不是剩余秒数：进入时 `remaining = deadline - now` 并清 timer；离开时 `deadline = now + remaining` 重设定时器。避免「暂停再恢复」累积漂移。

### 3.2 补推汇总弹窗

- `<DialogTitle>` **保持 `sr-only`**（a11y，且不动共享组件）。
- 在 `DialogContent` 内新增**可见标题**：`你有未读通知`（`text-lg font-semibold`）+ 副标题 `共 N 条未读`。这是仓库既有模式——`CommandResultModal` 就是 sr-only 标题 + 自渲染头部。
- **候选集不变**：仍是 `items.filter(it => !it.read_at && it.severity !== 'info').slice(0, 8)` —— `info` 永不进汇总弹窗，这条既有约定不能在这一版改掉。（实时 toast 侧同样只对非 info 弹窗，见 `AppContent.tsx:245-260`。）
- 列表行复用 §3.1 的图标块样式，**按严重度分组**（严重 / 警告），每组一个小写字标签。
- 每行可点击直接跳转，复用 §3.3 的 `inboxTargetPath(it)` 共享函数；返回 `null` 的行不可点。
- 底部按钮改为 `全部已读`（调 `markAllReadLocal()`，与收件箱页头部同一个）+ `去收件箱`。

### 3.3 共享跳转逻辑

现在跳转规则内联在 `InboxPage.openTarget`（`InboxPage.tsx:38-44`）。汇总弹窗需要同一套规则，抽成 `web/src/components/inbox/inboxTarget.ts`：

```ts
export function inboxTargetPath(it: InboxNotification): string | null {
  if (it.task_id) return `/task/${it.task_id}`;
  if (it.session_id) return `/session/${it.session_id}`;
  if (it.code === 'skill_update') return '/settings?tab=skills';
  return null; // 无可跳转目标 → 行不可点
}
```

两个调用方都只关心「有没有目标」，`null` 即不可点。

## 4. 收件箱页面（方案 B：两栏列表 + 详情）

### 4.1 容器与断点

- 容器：`mx-auto flex h-full w-full max-w-7xl flex-col p-4`（`h-screen` → `h-full`，因为要嵌进 `AppContent` 的主内容区）。
- 两栏：`grid gap-4 lg:grid-cols-12`，左栏 `lg:col-span-5`、右栏 `lg:col-span-7`。用 12 栅格而不是 `grid-cols-[5fr_7fr]`，避免任意值。
- **< `lg`（1024px）退回单列**，只渲染列表；详情走 §5 的全屏 sheet。

### 4.2 左栏（列表）

- 筛选 chip（**局部 state，不进共享 filter**，与任务页表格状态筛选的既有约定一致）：`全部` / `未读 N` / `严重 N`。
- 「全部已读」按钮置于头部右侧。
- 每行：
  - 严重度图标块（同 §3.1）
  - 标题 `text-sm font-medium`，超长 `truncate`
  - 时间（相对时间：`刚刚` / `N 分钟前` / `N 小时前` / `昨天` / `M-D`），`text-2xs text-muted-foreground`
  - `occurrence_count > 1` → `×N`
  - 未读圆点；已读行整行降透明度（不再用现在的 `opacity-60`，改为 `opacity-55` + 去掉未读圆点，视觉层次更清楚）
  - 选中态：`bg-primary/10 border border-primary/30`
- 列表 `overflow-y-auto`，头部与筛选行固定。

### 4.3 右栏（详情）

- **空态**：未选中时显示 `从左侧选一条通知`。
- 头部：图标块 + 标题 + 严重度徽章 + 来源标签。
- 元信息行：`first_seen_at` 首次出现、`last_seen_at` 最近一次、`×N` 次数（绝对时间用 `toLocaleString`）。
- 正文：**取消 `line-clamp-3`**，`whitespace-pre-wrap break-words text-sm` —— 保留错误堆栈的换行，这是两栏最大的价值点。
- 操作区（按数据条件渲染）：
  - `打开会话` —— `session_id` 存在时
  - `查看任务` —— `task_id` 存在时
  - `去更新技能` —— `code === 'skill_update'` 时
  - `标记已读` —— 未读时
- **选中态管理**：组件内 `useState<string | null>`；默认选第一条未读，没有未读则选第一条；列表变化导致选中项消失时回落到第一条。

### 4.4 「来源」标签的派生规则

因为 `code` 是用户自由文本（见 §2），来源只能从**关联关系**推，不能从 code 建表：

| 条件 | 标签 |
|---|---|
| `code === 'skill_update'` | 技能 |
| `task_id` 存在 | 任务 |
| `session_id` 存在 | 会话 |
| 都没有 | 系统 |

`code` 本身作为**原始字符串**展示在详情页元信息里（如 `disk_full`），不做翻译——它本来就是用户自己起的名字。

### 4.5 头部与侧边栏入口

- 桌面（`lg` 及以上）：标题 `收件箱` + 未读数徽章 + `全部已读`。**去掉 `←` 返回键**——侧边栏已经在左边了。
- 窄屏：`MobileMenuButton`（复用 `web/src/components/main-content/view/subcomponents/MobileMenuButton.tsx`）+ 标题 + `全部已读`。
- `SidebarInboxEntry` 增加**选中态**（当前在 `/inbox` 时高亮），与侧边栏其他入口一致。

## 5. 移动端详情：全屏 sheet

- 点击列表某条 → 从底部滑入的全屏 sheet（高度 `85dvh`，圆角只保留顶部）。
- 复用现有 `Dialog` 的遮罩、Esc 关闭、焦点陷阱、body 滚动锁，**不另起一套**。
- 做法：给 `DialogContent` 增加**可选** `variant?: 'center' | 'sheet'`，默认 `'center'`（现有 9 个调用点行为完全不变）；`'sheet'` 只改定位类（贴底、全宽、最大高度、圆角方向）与入场动画方向。
- sheet 内容 = §4.3 的右栏详情组件（同一个组件，两种容器）。

## 6. 侧边栏保留

### 6.1 方案

`web/src/App.tsx:134` 的 `/inbox` 从 `<InboxPage />` 改为 `<AppContent />`，让 `AppContent` 的主内容区**按路由分流**：`useLocation().pathname === '/inbox'` 时渲染 `<InboxPage />`，否则渲染现有的 `<MainContent …>`。（`Router` 已设 `basename`，`useLocation().pathname` 返回的是剥掉 basename 的路径，直接用 `/inbox` 比较即可。）

侧边栏接线（`useProjectsState` → `<Sidebar {...sidebarSharedProps} />` + 移动端抽屉）**一行不改**。

### 6.2 为什么不用 AppShell

抽 `AppShell`（持有 `useProjectsState` + Sidebar + 移动端抽屉，`children` 作主区）更"正统"，但要动 `AppContent` 的大段接线，并把回归面扩大到任务页 / 统计页 / 设置页 —— 而这三个页面本轮**不改**。收益与风险不成比例。

### 6.3 已知行为（可接受）

`useProjectsState` 在 `sessionId` 为空时会恢复「上次打开的会话」到 state（`useProjectsState.ts:919-938`），但**只 setState、不 navigate**。所以停在 `/inbox` 时，侧边栏会高亮上次的会话；点它才跳走。这是期望行为——侧边栏本来就是用来显示「我在哪」的。

## 7. 验收

1. `/inbox` 桌面端左侧侧边栏正常显示，可展开项目 / 切换会话 / 进设置；窄屏可点菜单按钮拉出抽屉。
2. 收件箱页在 ≥1024px 下是两栏；<1024px 是单列 + 全屏 sheet 详情。
3. 详情页正文完整显示多行错误堆栈（换行不被吃掉）。
4. 新通知到达时，toast 有可见的缩放淡入，鼠标悬停时不消失，移开后按剩余时间续跑。
5. 汇总弹窗**有可见标题**「你有未读通知」。
6. `npx tsx --test` 跑 `web/src/design/scaleGuard.test.ts` 与 `tokenGuard.test.ts` 全绿（无新增任意值 / 裸色）。
7. `web/src/stores/tests/inboxStore*.test.ts`、`web/src/components/tasks/TaskInboxPanel.test.tsx` 等既有测试不回归。

## 8. 改动文件

**新增**

- `web/src/components/inbox/inboxTarget.ts` —— 跳转目标派生（§3.3）
- `web/src/components/inbox/InboxList.tsx` —— 左栏列表
- `web/src/components/inbox/InboxDetail.tsx` —— 右栏详情（桌面右栏与移动 sheet 共用）
- `web/src/components/app/inboxRouteMatch.ts` —— `/inbox` 路径判定（容忍尾斜杠）

**不新增**时间格式化文件 —— `formatRelativeTime` / `formatAbsoluteTime` 在 `web/src/components/tasks/taskTimestamp.ts` 里已存在且有测试，直接复用。

**修改**

- `web/src/shared/view/ui/Toast.tsx` —— 材质 + 入场/退场 + 悬停暂停（§3.1）
- `web/src/components/app/AppContent.tsx` —— 汇总弹窗可见标题 + 分组（§3.2）；主内容区按路由分流（§6.1）
- `web/src/components/inbox/InboxPage.tsx` —— 改为两栏容器（§4.1）
- `web/src/shared/view/ui/Dialog.tsx` —— `DialogContent` 增加可选 `variant`（§5）
- `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx` —— 选中态（§4.5）
- `web/src/components/inbox/index.ts` —— 导出新增组件
- `web/tailwind.config.js` —— 新增 `toast-in` / `toast-out` keyframes 与 animation
