# 收件箱改版（弹窗轻量化 + 两栏页面 + 保留侧边栏）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把收件弹窗从「整块染色、零过渡」改成毛玻璃轻量卡片（带入场/退场动效与悬停暂停），把收件箱页从 768px 单列改成列表+详情两栏，并让 `/inbox` 保留应用侧边栏。

**Architecture:** 先抽出纯函数层（跳转目标 / 来源标签）与两个纯展示组件（列表、详情），再组装成两栏页面；`/inbox` 改由 `AppContent` 承载、主内容区按路由分流，侧边栏接线一行不改；弹窗侧给 `DialogContent` 加一个可选的 `sheet` 变体供移动端复用。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind（具名尺度，见 `web/tailwind.config.js`）+ react-router-dom + lucide-react + `node:test` + `react-dom/server`。

---

## 关键前置知识（执行前必读）

### 测试怎么跑

web 包**没有 `npm test` 脚本**，必须显式指定文件，且要清掉全局残留的 `TSX_TSCONFIG_PATH`（它会劫持 tsx 的 tsconfig 解析）：

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/inboxTarget.test.ts
```

### 测试环境没有 DOM

仓库的组件测试统一用 `node:test` + `react-dom/server` 的 `renderToStaticMarkup`，**只断言 HTML 字符串，不能模拟点击/悬停**。参考 `web/src/components/tasks/TaskInboxPanel.test.tsx`。

**硬约束（已实测）**：`Dialog` / `DialogContent` 内部用 `createPortal`，SSR 下会抛 `ReferenceError: document is not defined`（`Dialog.tsx:205`）。**任何渲染 `Dialog` 的组件都无法这样测**。因此：

- 能 TDD：纯函数、`ToastCard`（无 portal）、`InboxList`、`InboxDetail`、`SidebarInboxEntry`、`DIALOG_CONTENT_VARIANT_CLASS` 常量。
- 只能手动验收：`ToastStack`、汇总弹窗、`InboxPage` 的移动端 sheet、路由分流。

### 设计系统守卫

`web/src/design/scaleGuard.test.ts` 与 `tokenGuard.test.ts` 会扫全仓源码：

- 禁止 `text-[13px]` 这类任意字号、`rounded-[10px]` 这类任意圆角
- 禁止裸调色板（`bg-gray-800`）与硬编码色值（`#abcdef`、`rgb(...)`）
- 5 个「复现配方」阴影必须用具名 `shadow-raised-*`

字号档位：`4xs` 9px / `3xs` 10px / `2xs` 11px / `xs` 12px / `sm` 14px / `base` 16px / `lg` 18px / `xl` 20px
圆角档位：`xs` 3px / `sm` 4px / `md` 6px / `lg` 8px / `xl` 12px / `2xl` 16px / `3xl` 24px

### 基线（改动前实测）

- `npm run typecheck`（在 `web/`）→ **0 错误**
- `env -u TSX_TSCONFIG_PATH npx tsx --test src/design/scaleGuard.test.ts src/design/tokenGuard.test.ts` → **13 pass**
- `env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx` → **12 pass**

---

## 文件结构

**新增**

| 文件 | 职责 |
|---|---|
| `web/src/components/inbox/inboxTarget.ts` | 纯函数：跳转目标路径、来源标签、严重度中文名 |
| `web/src/components/inbox/inboxTarget.test.ts` | 上者的测试 |
| `web/src/components/inbox/InboxList.tsx` | 纯展示：左栏通知列表（props 驱动，无 store/路由依赖） |
| `web/src/components/inbox/InboxList.test.tsx` | 上者的测试 |
| `web/src/components/inbox/InboxDetail.tsx` | 纯展示：单条通知详情（桌面右栏与移动 sheet 共用） |
| `web/src/components/inbox/InboxDetail.test.tsx` | 上者的测试 |

**修改**

| 文件 | 改动 |
|---|---|
| `web/src/App.tsx:134` | `/inbox` 路由改为渲染 `AppContent` |
| `web/src/components/app/AppContent.tsx` | 主内容区按 `pathname` 分流；汇总弹窗加可见标题与分组 |
| `web/src/components/inbox/InboxPage.tsx` | 改为两栏容器，持有筛选/选中/sheet 状态 |
| `web/src/components/inbox/index.ts` | 导出新增组件 |
| `web/src/shared/view/ui/Dialog.tsx` | `DialogContent` 增加可选 `variant`（`center` \| `sheet`） |
| `web/src/shared/view/ui/Toast.tsx` | 毛玻璃材质 + 入场/退场 + 悬停暂停 |
| `web/src/shared/view/ui/Toast.test.tsx` | 新增测试 |
| `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx` | 选中态 |
| `web/tailwind.config.js` | 新增 `toast-in` / `toast-out` keyframes 与 animation |

**复用（不要新建）**

时间格式化已存在，直接用，别造 `inboxTime.ts`：
`web/src/components/tasks/taskTimestamp.ts` 导出的 `formatRelativeTime(iso, now)` 与 `formatAbsoluteTime(iso)`。

---

## Task 1: 纯函数层 —— 跳转目标 / 来源标签 / 严重度名

**Files:**
- Create: `web/src/components/inbox/inboxTarget.ts`
- Test: `web/src/components/inbox/inboxTarget.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/inbox/inboxTarget.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { InboxNotification } from '../../stores/inboxStore.pure';

import { inboxTargetPath, severityLabel, sourceLabel } from './inboxTarget';

const mk = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1',
  severity: 'warning',
  title: '测试通知',
  body: null,
  code: null,
  task_id: null,
  session_id: null,
  occurrence_count: 1,
  read_at: null,
  first_seen_at: '2026-09-21T00:00:00.000Z',
  last_seen_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

test('有 task_id 时跳任务页（优先级高于 session_id）', () => {
  assert.equal(inboxTargetPath(mk({ task_id: 't1', session_id: 's1' })), '/task/t1');
});

test('只有 session_id 时跳会话页', () => {
  assert.equal(inboxTargetPath(mk({ session_id: 's1' })), '/session/s1');
});

test('skill_update 且无关联时跳技能设置页', () => {
  assert.equal(inboxTargetPath(mk({ code: 'skill_update' })), '/settings?tab=skills');
});

test('无任何关联时返回 null（行不可点）', () => {
  assert.equal(inboxTargetPath(mk()), null);
});

test('来源标签：skill_update 优先于关联关系', () => {
  assert.equal(sourceLabel(mk({ code: 'skill_update', task_id: 't1' })), '技能');
});

test('来源标签：按关联关系兜底，不看 code 字面量', () => {
  // code 是用户自由文本（如 disk_full），不能据此建分类表
  assert.equal(sourceLabel(mk({ task_id: 't1', code: 'disk_full' })), '任务');
  assert.equal(sourceLabel(mk({ session_id: 's1' })), '会话');
  assert.equal(sourceLabel(mk({ code: 'disk_full' })), '系统');
});

test('严重度中文名', () => {
  assert.equal(severityLabel('critical'), '严重');
  assert.equal(severityLabel('warning'), '警告');
  assert.equal(severityLabel('info'), '信息');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/inboxTarget.test.ts
```

预期：FAIL —— `Cannot find module './inboxTarget'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/inbox/inboxTarget.ts`：

```ts
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';

/**
 * 通知的可跳转目标路径；无目标时返回 null（列表行不可点）。
 * 优先级：任务 > 会话 > 技能更新。
 */
export function inboxTargetPath(it: InboxNotification): string | null {
  if (it.task_id) return `/task/${it.task_id}`;
  if (it.session_id) return `/session/${it.session_id}`;
  if (it.code === 'skill_update') return '/settings?tab=skills';
  return null;
}

/**
 * 「来源」标签。只能从关联关系推，**不能按 `code` 建分类表** ——
 * `code` 是用户在 prompt 里自起的自由文本（如 `disk_full`），后端不枚举。
 * 全仓唯一的内置 code 是 `skill_update`（backend/server/index.js:2247）。
 */
export function sourceLabel(it: InboxNotification): string {
  if (it.code === 'skill_update') return '技能';
  if (it.task_id) return '任务';
  if (it.session_id) return '会话';
  return '系统';
}

const SEVERITY_LABEL: Record<InboxSeverity, string> = {
  critical: '严重',
  warning: '警告',
  info: '信息',
};

export function severityLabel(severity: InboxSeverity): string {
  return SEVERITY_LABEL[severity];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/inboxTarget.test.ts
```

预期：PASS，7 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/components/inbox/inboxTarget.ts web/src/components/inbox/inboxTarget.test.ts
git commit -m "feat(inbox): add target/source/severity derivation helpers"
```

---

## Task 2: 路由分流 —— `/inbox` 保留侧边栏

**Files:**
- Modify: `web/src/App.tsx:134`
- Modify: `web/src/components/app/AppContent.tsx`

这是本计划里**唯一无法自动化测试**但影响最大的一步，做完立刻手动看一眼。

- [ ] **Step 1: 改路由**

`web/src/App.tsx` —— 把 `/inbox` 指向 `AppContent`：

```tsx
                  <Route path="/inbox" element={<AppContent />} />
```

同时删掉不再使用的 import（第 12 行）：

```tsx
// 删除这一行
import { InboxPage } from './components/inbox';
```

- [ ] **Step 2: 主内容区按路由分流**

`web/src/components/app/AppContent.tsx`：

第 2 行的 import 增加 `useLocation`：

```tsx
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
```

在 `AppContentInner` 内、`const { sessionId } = useParams...` 附近加：

```tsx
  // /inbox 复用本组件只为拿到侧边栏；主内容区换成收件箱页。
  // Router 已设 basename，useLocation().pathname 是剥掉 basename 的路径。
  const { pathname } = useLocation();
  const isInboxRoute = pathname === '/inbox';
```

把第 297-338 行的 `<div className="flex min-w-0 flex-1 flex-col">` 内部改成条件渲染：

```tsx
      <div className="flex min-w-0 flex-1 flex-col">
        {isInboxRoute ? (
          <InboxPage />
        ) : (
          <MainContent
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onProjectSelect={handleProjectSelect}
            onProjectsRefresh={refreshProjectsSilently}
            ws={ws}
            sendMessage={sendMessage}
            isMobile={isMobile}
            onMenuClick={() => setSidebarOpen(true)}
            isLoading={isLoadingProjects}
            onInputFocusChange={setIsInputFocused}
            onSessionProcessing={markSessionProcessing}
            onSessionIdle={markSessionIdle}
            processingSessions={processingSessions}
            onNavigateToSession={(targetSessionId: string, options) =>
              navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
            }
            onSessionEstablished={(targetSessionId, context) =>
              registerOptimisticSession({ sessionId: targetSessionId, ...context })
            }
            onShowSettings={openSettings}
            onResumeSession={handleSessionSelect}
            onSwitchToNewSession={(newSessionId, summary) => {
              if (!selectedProject) return;
              const provider =
                (selectedSession?.provider ?? selectedSession?.__provider) as
                  | import('../../types/app').LLMProvider
                  | undefined;
              registerOptimisticSession({
                sessionId: newSessionId,
                provider: provider ?? 'claude',
                project: selectedProject,
                summary,
              });
            }}
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
          />
        )}
      </div>
```

在同文件顶部加 import：

```tsx
import InboxPage from '../inbox/InboxPage';
```

- [ ] **Step 3: InboxPage 容器改成可嵌进主区**

`web/src/components/inbox/InboxPage.tsx:47` —— `h-screen` 改 `h-full`：

```tsx
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col p-4">
```

（`max-w-7xl` 与 `h-full` 是本任务的一部分；两栏内部结构在 Task 6 做。）

- [ ] **Step 4: typecheck**

```bash
# 在 web/ 目录下
npm run typecheck
```

预期：0 错误（基线就是 0，不允许新增）

- [ ] **Step 5: 手动验收（必做）**

启动 dev server（若已在跑则跳过），浏览器打开 `http://<lan-ip>:5188/inbox`，确认：

1. **左侧侧边栏在**，能看到项目列表、Lovdex助手、收件箱、定时任务等入口
2. 点侧边栏的项目能正常跳走
3. 窄屏（<768px）下侧边栏变成抽屉，且收件箱页顶部**暂时还没有**菜单按钮（Task 6 补）
4. 通知列表本身仍正常渲染

- [ ] **Step 6: 提交**

```bash
git add web/src/App.tsx web/src/components/app/AppContent.tsx web/src/components/inbox/InboxPage.tsx
git commit -m "feat(inbox): mount inbox page inside AppContent to keep the sidebar"
```

---

## Task 2b: `/inbox/` 尾斜杠容错（代码审查发现）

**Files:**
- Modify: `web/src/components/app/AppContent.tsx`
- Test: `web/src/components/app/inboxRouteMatch.test.ts`（新建，测纯函数）
- Create: `web/src/components/app/inboxRouteMatch.ts`

**为什么有这个任务**：Task 2 用的是 `pathname === '/inbox'`。react-router v6 匹配 `/inbox/` 时会命中同一条 Route，但 `location.pathname` **保留**尾斜杠，于是 `isInboxRoute` 为 false，`/inbox/` 这个 URL 下会渲染出 `MainContent` 空态。

只有手敲 URL 或旧书签能触发（侧边栏入口和汇总弹窗都精确写 `/inbox`），但修起来很便宜。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/app/inboxRouteMatch.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { isInboxPath } from './inboxRouteMatch';

test('精确路径命中', () => {
  assert.equal(isInboxPath('/inbox'), true);
});

test('尾斜杠也命中（react-router 会匹配该 Route，但 pathname 保留斜杠）', () => {
  assert.equal(isInboxPath('/inbox/'), true);
});

test('其他路径不命中', () => {
  assert.equal(isInboxPath('/'), false);
  assert.equal(isInboxPath('/inboxes'), false);
  assert.equal(isInboxPath('/task/inbox'), false);
  assert.equal(isInboxPath('/inbox/123'), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/app/inboxRouteMatch.test.ts
```

预期：FAIL —— `Cannot find module './inboxRouteMatch'`

- [ ] **Step 3: 写实现**

创建 `web/src/components/app/inboxRouteMatch.ts`：

```ts
/**
 * 判断当前路径是否是收件箱页。
 *
 * 不能直接 `pathname === '/inbox'`：react-router v6 匹配 `/inbox/` 时会命中同一条
 * Route，但 `location.pathname` 保留尾斜杠，直接比较会让 `/inbox/` 落到主界面空态。
 */
export function isInboxPath(pathname: string): boolean {
  const normalized = pathname.endsWith('/') && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  return normalized === '/inbox';
}
```

- [ ] **Step 4: 接进 AppContent**

`web/src/components/app/AppContent.tsx` —— 加 import：

```tsx
import { isInboxPath } from './inboxRouteMatch';
```

把 Task 2 加的那两行换成：

```tsx
  // /inbox 复用本组件只为拿到侧边栏；主内容区换成收件箱页。
  // Router 已设 basename，useLocation().pathname 是剥掉 basename 的路径。
  const { pathname } = useLocation();
  const isInboxRoute = isInboxPath(pathname);
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/app/inboxRouteMatch.test.ts
npm run typecheck
```

预期：PASS 3 个测试；typecheck 0 错误

- [ ] **Step 6: 提交**

```bash
git add web/src/components/app/inboxRouteMatch.ts web/src/components/app/inboxRouteMatch.test.ts web/src/components/app/AppContent.tsx
git commit -m "fix(inbox): tolerate a trailing slash on the inbox route"
```

---

## Task 3: `DialogContent` 增加 `sheet` 变体

**Files:**
- Modify: `web/src/shared/view/ui/Dialog.tsx:92-209`
- Test: `web/src/shared/view/ui/Dialog.test.ts`

因为 `DialogContent` 走 `createPortal`（SSR 下 `document is not defined`），**测试对象是抽出来的定位类常量**，不是组件本身。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/shared/view/ui/Dialog.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { DIALOG_CONTENT_VARIANT_CLASS } from './Dialog';

test('center 变体保持居中定位与 max-w-lg', () => {
  const cls = DIALOG_CONTENT_VARIANT_CLASS.center;
  assert.ok(cls.includes('left-1/2'), '应含 left-1/2');
  assert.ok(cls.includes('top-1/2'), '应含 top-1/2');
  assert.ok(cls.includes('-translate-x-1/2'), '应含 -translate-x-1/2');
  assert.ok(cls.includes('-translate-y-1/2'), '应含 -translate-y-1/2');
  assert.ok(cls.includes('max-w-lg'), '应含 max-w-lg');
});

test('sheet 变体贴底、全宽、只保留顶部圆角', () => {
  const cls = DIALOG_CONTENT_VARIANT_CLASS.sheet;
  assert.ok(cls.includes('bottom-0'), '应含 bottom-0');
  assert.ok(cls.includes('inset-x-0'), '应含 inset-x-0');
  assert.ok(cls.includes('rounded-t-2xl'), '应含 rounded-t-2xl');
  assert.ok(cls.includes('rounded-b-none'), '应含 rounded-b-none');
});

test('sheet 变体不带任何居中位移（否则会飘到屏幕中间）', () => {
  const cls = DIALOG_CONTENT_VARIANT_CLASS.sheet;
  assert.ok(!cls.includes('translate'), '不应含 translate 类');
  assert.ok(!cls.includes('top-1/2'), '不应含 top-1/2');
  assert.ok(!cls.includes('max-w-lg'), '不应含 max-w-lg');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Dialog.test.ts
```

预期：FAIL —— `DIALOG_CONTENT_VARIANT_CLASS` 未导出

- [ ] **Step 3: 抽出定位类常量**

`web/src/shared/view/ui/Dialog.tsx` —— 在 `DialogContent` 定义之前（约第 96 行 `FOCUSABLE_SELECTOR` 附近）加：

```tsx
/**
 * DialogContent 的定位变体：
 * - `center`：屏幕居中弹窗（默认，现有行为不变）
 * - `sheet`：移动端底部全宽 sheet，只保留顶部圆角
 *
 * 定位类抽成常量是为了可测 —— DialogContent 走 createPortal，SSR 下渲染不了。
 */
export const DIALOG_CONTENT_VARIANT_CLASS = {
  center: 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-lg rounded-2xl',
  sheet: 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl rounded-b-none',
} as const;

export type DialogContentVariant = keyof typeof DIALOG_CONTENT_VARIANT_CLASS;
```

- [ ] **Step 4: 接进 DialogContent**

`Dialog.tsx` —— `DialogContentProps` 增加 `variant`：

```tsx
interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  onEscapeKeyDown?: () => void;
  onPointerDownOutside?: () => void;
  wrapperClassName?: string;
  /** 定位变体，默认 `center`。 */
  variant?: DialogContentVariant;
}
```

解构参数加 `variant = 'center'`：

```tsx
  ({ className, children, onEscapeKeyDown, onPointerDownOutside, wrapperClassName, variant = 'center', ...props }, ref) => {
```

把 `className` 里写死的定位与圆角类换成变体查表（**其余类一个字符都不要动**）：

```tsx
          className={cn(
            'fixed z-50 w-full border border-border/80 bg-popover text-popover-foreground',
            'shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_24px_60px_hsl(var(--foreground)/0.28)]',
            'animate-dialog-content-show',
            DIALOG_CONTENT_VARIANT_CLASS[variant],
            className
          )}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Dialog.test.ts
```

预期：PASS，3 个测试全绿

- [ ] **Step 6: 回归确认 center 行为没变**

```bash
# 在 web/ 目录下
npm run typecheck
```

预期：0 错误

手动抽查任意一个既有弹窗（例如设置页 → 技能 tab 里的任意弹窗，或侧边栏 Lovdex助手 → 新建会话弹窗），确认**仍然居中**、尺寸不变。

- [ ] **Step 7: 提交**

```bash
git add web/src/shared/view/ui/Dialog.tsx web/src/shared/view/ui/Dialog.test.ts
git commit -m "feat(ui): add optional sheet variant to DialogContent"
```

---

## Task 3b: sheet 需要独立的入场动画（计划缺陷修正）

**Files:**
- Modify: `web/tailwind.config.js`
- Modify: `web/src/shared/view/ui/Dialog.tsx`
- Test: `web/src/shared/view/ui/Dialog.test.ts`

**为什么有这个任务**：Task 3 实现时发现，`animate-dialog-content-show` 的 keyframes 写死了居中位移：

```js
'dialog-content-show': {
  from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
  to:   { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
},
```

而 Task 3 把 `animate-dialog-content-show` 留在了**变体之外的公共类**里。于是 `variant="sheet"` 会继承这个动画，被 keyframes 强行拉到屏幕正中间 —— sheet 完全失效。这是原计划的缺陷，Task 6 依赖它，必须先修。

修法：把动画类**移进变体查表**，sheet 用一套自己的、只做纵向位移的动画。

- [ ] **Step 1: 写失败的测试**

在 `web/src/shared/view/ui/Dialog.test.ts` 末尾追加：

```ts
test('center 与 sheet 各自绑定自己的入场动画', () => {
  assert.ok(
    DIALOG_CONTENT_VARIANT_CLASS.center.includes('animate-dialog-content-show'),
    'center 应使用居中动画',
  );
  assert.ok(
    DIALOG_CONTENT_VARIANT_CLASS.sheet.includes('animate-dialog-sheet-show'),
    'sheet 应使用底部滑入动画',
  );
});

test('sheet 不得沿用居中动画（其 keyframes 会强行注入 translate(-50%,-50%)）', () => {
  assert.ok(
    !DIALOG_CONTENT_VARIANT_CLASS.sheet.includes('animate-dialog-content-show'),
    'sheet 不能带 animate-dialog-content-show',
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Dialog.test.ts
```

预期：FAIL —— 变体串里还没有 `animate-*` 类

- [ ] **Step 3: 加 sheet 的 keyframes**

`web/tailwind.config.js` —— 在 `keyframes` 的 `'dialog-content-show'` 之后加：

```js
        'dialog-sheet-show': {
          from: { opacity: '0', transform: 'translateY(100%)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
```

在 `animation` 的 `'dialog-content-show'` 之后加：

```js
        'dialog-sheet-show': 'dialog-sheet-show 240ms cubic-bezier(0.2, 0, 0, 1)',
```

- [ ] **Step 4: 把动画类移进变体查表**

`web/src/shared/view/ui/Dialog.tsx` —— 变体常量改为：

```tsx
export const DIALOG_CONTENT_VARIANT_CLASS = {
  center: 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-lg rounded-2xl animate-dialog-content-show',
  sheet: 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl rounded-b-none animate-dialog-sheet-show',
} as const;
```

并把 `DialogContent` 的 `cn(...)` 里那一行 `'animate-dialog-content-show',` **删掉**（动画现在由变体提供）：

```tsx
          className={cn(
            'fixed z-50 w-full border border-border/80 bg-popover text-popover-foreground',
            'shadow-[0_3px_0_hsl(var(--foreground)/0.08),0_24px_60px_hsl(var(--foreground)/0.28)]',
            DIALOG_CONTENT_VARIANT_CLASS[variant],
            className
          )}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Dialog.test.ts
```

预期：PASS，5 个测试全绿

- [ ] **Step 6: 确认 center 行为未变 + typecheck**

```bash
# 在 web/ 目录下
npm run typecheck
```

预期：0 错误。并手动确认任意既有弹窗（如侧边栏 Lovdex助手 → 新建会话）仍然**居中且带缩放淡入**。

- [ ] **Step 7: 提交**

```bash
git add web/tailwind.config.js web/src/shared/view/ui/Dialog.tsx web/src/shared/view/ui/Dialog.test.ts
git commit -m "fix(ui): give the dialog sheet its own entrance animation"
```

---

## Task 4: `InboxDetail` —— 右栏详情（纯展示）

**Files:**
- Create: `web/src/components/inbox/InboxDetail.tsx`
- Test: `web/src/components/inbox/InboxDetail.test.tsx`

纯展示：不碰 store、不碰路由，跳转通过 `onNavigate(path)` 回调交给父组件。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/inbox/InboxDetail.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { InboxNotification } from '../../stores/inboxStore.pure';

import { InboxDetail } from './InboxDetail';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const mk = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1',
  severity: 'critical',
  title: '任务执行失败',
  body: 'line one\nline two',
  code: null,
  task_id: 't1',
  session_id: 's1',
  occurrence_count: 3,
  read_at: null,
  first_seen_at: '2026-09-21T09:00:00.000Z',
  last_seen_at: '2026-09-21T11:59:00.000Z',
  ...over,
});

const render = (item: InboxNotification | null) =>
  renderToStaticMarkup(
    <InboxDetail item={item} now={NOW} onMarkRead={() => {}} onNavigate={() => {}} />,
  );

test('未选中时显示空态', () => {
  const html = render(null);
  assert.ok(html.includes('从左侧选一条通知'), '应有空态文案');
});

test('正文保留换行（错误堆栈不被压成一行）', () => {
  const html = render(mk());
  assert.ok(html.includes('whitespace-pre-wrap'), '正文容器应保留换行');
  assert.ok(html.includes('line one'), '正文应渲染');
});

test('展示标题、来源标签与重复次数', () => {
  const html = render(mk());
  assert.ok(html.includes('任务执行失败'));
  assert.ok(html.includes('任务'), '来源标签应为「任务」');
  assert.ok(html.includes('×3'), '应展示重复次数');
});

test('按数据条件渲染操作按钮', () => {
  const html = render(mk());
  assert.ok(html.includes('打开会话'), '有 session_id 应出现打开会话');
  assert.ok(html.includes('查看任务'), '有 task_id 应出现查看任务');
  assert.ok(html.includes('标记已读'), '未读应出现标记已读');
});

test('skill_update 通知出现「去更新技能」，且不带任务/会话按钮', () => {
  const html = render(mk({ code: 'skill_update', task_id: null, session_id: null }));
  assert.ok(html.includes('去更新技能'));
  assert.ok(!html.includes('打开会话'));
  assert.ok(!html.includes('查看任务'));
});

test('已读通知不出现「标记已读」', () => {
  const html = render(mk({ read_at: '2026-09-21T11:00:00.000Z' }));
  assert.ok(!html.includes('标记已读'));
});

test('code 原样展示在元信息里（不做翻译）', () => {
  const html = render(mk({ code: 'disk_full' }));
  assert.ok(html.includes('disk_full'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/InboxDetail.test.tsx
```

预期：FAIL —— `Cannot find module './InboxDetail'`

- [ ] **Step 3: 写实现**

创建 `web/src/components/inbox/InboxDetail.tsx`：

```tsx
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';
import { formatAbsoluteTime, formatRelativeTime } from '../tasks/taskTimestamp';

import { inboxTargetPath, severityLabel, sourceLabel } from './inboxTarget';

type InboxDetailProps = {
  item: InboxNotification | null;
  now: Date;
  onMarkRead: (id: string) => void;
  onNavigate: (path: string) => void;
};

const SEVERITY_ICON: Record<InboxSeverity, React.ReactNode> = {
  critical: <AlertCircle className="h-4 w-4" />,
  warning: <AlertTriangle className="h-4 w-4" />,
  info: <Info className="h-4 w-4" />,
};

const SEVERITY_ICON_CLASS: Record<InboxSeverity, string> = {
  critical: 'bg-destructive/12 text-destructive',
  warning: 'bg-warning/12 text-warning',
  info: 'bg-muted text-muted-foreground',
};

/** 单条通知详情。桌面端作为右栏，移动端塞进底部 sheet —— 同一个组件两种容器。 */
export function InboxDetail({ item, now, onMarkRead, onNavigate }: InboxDetailProps) {
  if (!item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        从左侧选一条通知
      </div>
    );
  }

  const target = inboxTargetPath(item);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-start gap-2.5">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${SEVERITY_ICON_CLASS[item.severity]}`}
        >
          {SEVERITY_ICON[item.severity]}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{item.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-semibold">
              {severityLabel(item.severity)}
            </span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-semibold">
              {sourceLabel(item)}
            </span>
            {item.code ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{item.code}</span>
            ) : null}
            {item.occurrence_count > 1 ? <span>×{item.occurrence_count}</span> : null}
          </div>
        </div>
      </div>

      <p className="mt-3 text-2xs text-muted-foreground">
        首次 {formatAbsoluteTime(item.first_seen_at ?? '')}（{formatRelativeTime(item.first_seen_at ?? '', now)}）
        {item.last_seen_at && item.last_seen_at !== item.first_seen_at
          ? ` · 最近 ${formatAbsoluteTime(item.last_seen_at)}（${formatRelativeTime(item.last_seen_at, now)}）`
          : ''}
      </p>

      {item.body ? (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground">{item.body}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">（无详细内容）</p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {item.session_id ? (
          <Button size="sm" onClick={() => target && onNavigate(`/session/${item.session_id}`)}>
            打开会话
          </Button>
        ) : null}
        {item.task_id ? (
          <Button size="sm" variant="outline" onClick={() => target && onNavigate(`/task/${item.task_id}`)}>
            查看任务
          </Button>
        ) : null}
        {item.code === 'skill_update' ? (
          <Button size="sm" variant="outline" onClick={() => onNavigate('/settings?tab=skills')}>
            去更新技能
          </Button>
        ) : null}
        {!item.read_at ? (
          <Button size="sm" variant="ghost" onClick={() => onMarkRead(item.notification_id)}>
            标记已读
          </Button>
        ) : null}
      </div>
    </div>
  );
}
```

注意：文件顶部需要 `import * as React from 'react';`（`React.ReactNode` 类型用到）。若 lint 报 `React` 未使用，改成 `import type { ReactNode } from 'react';` 并把两处 `React.ReactNode` 换成 `ReactNode`。

- [ ] **Step 4: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/InboxDetail.test.tsx
```

预期：PASS，7 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/components/inbox/InboxDetail.tsx web/src/components/inbox/InboxDetail.test.tsx
git commit -m "feat(inbox): add inbox detail pane component"
```

---

## Task 5: `InboxList` —— 左栏列表（纯展示）

**Files:**
- Create: `web/src/components/inbox/InboxList.tsx`
- Test: `web/src/components/inbox/InboxList.test.tsx`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/inbox/InboxList.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { InboxNotification } from '../../stores/inboxStore.pure';

import { InboxList } from './InboxList';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const mk = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1',
  severity: 'critical',
  title: '任务执行失败',
  body: 'backend typecheck 新增 3 个错误',
  code: null,
  task_id: 't1',
  session_id: null,
  occurrence_count: 1,
  read_at: null,
  first_seen_at: '2026-09-21T11:58:00.000Z',
  last_seen_at: '2026-09-21T11:58:00.000Z',
  ...over,
});

const render = (items: InboxNotification[], selectedId: string | null = null) =>
  renderToStaticMarkup(
    <InboxList items={items} selectedId={selectedId} now={NOW} onSelect={() => {}} />,
  );

test('空列表显示空态', () => {
  assert.ok(render([]).includes('暂无通知'));
});

test('渲染标题与相对时间', () => {
  const html = render([mk()]);
  assert.ok(html.includes('任务执行失败'));
  assert.ok(html.includes('2 分钟前'), '应渲染相对时间');
});

test('未读行带未读圆点，已读行不带', () => {
  const unread = render([mk()]);
  const read = render([mk({ read_at: '2026-09-21T11:59:00.000Z' })]);
  assert.ok(unread.includes('data-unread="true"'), '未读行应标记 data-unread');
  assert.ok(read.includes('data-unread="false"'), '已读行应标记 data-unread=false');
});

test('选中行标记 data-selected', () => {
  assert.ok(render([mk()], 'n1').includes('data-selected="true"'));
  assert.ok(render([mk()]).includes('data-selected="false"'));
});

test('occurrence_count > 1 时展示 ×N', () => {
  assert.ok(render([mk({ occurrence_count: 3 })]).includes('×3'));
  assert.ok(!render([mk()]).includes('×1'), 'count 为 1 时不展示');
});

test('已读行整行降透明度', () => {
  assert.ok(render([mk({ read_at: '2026-09-21T11:59:00.000Z' })]).includes('opacity-55'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/InboxList.test.tsx
```

预期：FAIL —— `Cannot find module './InboxList'`

- [ ] **Step 3: 写实现**

创建 `web/src/components/inbox/InboxList.tsx`：

```tsx
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';
import { formatRelativeTime } from '../tasks/taskTimestamp';

type InboxListProps = {
  items: InboxNotification[];
  selectedId: string | null;
  now: Date;
  onSelect: (id: string) => void;
};

const SEVERITY_ICON: Record<InboxSeverity, React.ReactNode> = {
  critical: <AlertCircle className="h-3.5 w-3.5" />,
  warning: <AlertTriangle className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
};

const SEVERITY_ICON_CLASS: Record<InboxSeverity, string> = {
  critical: 'bg-destructive/12 text-destructive',
  warning: 'bg-warning/12 text-warning',
  info: 'bg-muted text-muted-foreground',
};

/** 左栏通知列表。纯展示，筛选/选中状态由 InboxPage 持有。 */
export function InboxList({ items, selectedId, now, onSelect }: InboxListProps) {
  if (items.length === 0) {
    return <div className="py-16 text-center text-sm text-muted-foreground">暂无通知</div>;
  }

  return (
    <ul className="space-y-1.5">
      {items.map((it) => {
        const selected = it.notification_id === selectedId;
        const unread = !it.read_at;
        return (
          <li key={it.notification_id}>
            <button
              type="button"
              data-selected={selected ? 'true' : 'false'}
              data-unread={unread ? 'true' : 'false'}
              onClick={() => onSelect(it.notification_id)}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors',
                'hover:bg-muted/60',
                selected && 'border-primary/30 bg-primary/10',
                !unread && 'opacity-55',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                  SEVERITY_ICON_CLASS[it.severity],
                )}
              >
                {SEVERITY_ICON[it.severity]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  {unread ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{it.title}</span>
                  {it.occurrence_count > 1 ? (
                    <span className="shrink-0 text-2xs text-muted-foreground">×{it.occurrence_count}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
                  <span>{formatRelativeTime(it.last_seen_at ?? it.first_seen_at ?? '', now)}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

同样需要 `import * as React from 'react';` 或 `import type { ReactNode } from 'react';`（见 Task 4 Step 3 的说明）。

- [ ] **Step 4: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/InboxList.test.tsx
```

预期：PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/components/inbox/InboxList.tsx web/src/components/inbox/InboxList.test.tsx
git commit -m "feat(inbox): add inbox list pane component"
```

---

## Task 6: `InboxPage` 组装成两栏 + 移动端 sheet

**Files:**
- Modify: `web/src/components/inbox/InboxPage.tsx`（整体重写）
- Modify: `web/src/components/inbox/index.ts`

`InboxPage` 持有全部状态（筛选、选中、sheet 开关），本身不可 SSR 测（依赖 `useWebSocket` provider 与 router）。靠 Task 2 Step 5 那种手动验收。

- [ ] **Step 1: 重写 InboxPage**

`web/src/components/inbox/InboxPage.tsx` 全文替换为：

```tsx
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck, Inbox as InboxIcon } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import MobileMenuButton from '../main-content/view/subcomponents/MobileMenuButton';
import { subscribeInbox, getInboxSnapshot, markReadLocal, markAllReadLocal } from '../../stores/inboxStore';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';

import { InboxDetail } from './InboxDetail';
import { InboxList } from './InboxList';
import { severityLabel } from './inboxTarget';

type FilterKey = 'all' | 'unread' | 'critical';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'critical', label: '严重' },
];

const SEVERITY_ORDER: InboxSeverity[] = ['critical', 'warning', 'info'];

export default function InboxPage() {
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);
  // 断点与 Tailwind 的 lg（1024px）对齐：>=lg 两栏，<lg 单列 + 全屏 sheet。
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 1024 });

  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // 这里**刻意不**自己拉取收件箱、也不自己订阅 WS：本组件现在只可能渲染在
  // AppContent 之内（见 App.tsx 的 /inbox 路由），而 AppContent 已经无条件做了
  // refreshInbox() + applyInboxEvent() 订阅。再来一套会让 /inbox 上每次
  // notification_updated / 重连都发两次全量 refetch，并让 created 事件进 reducer
  // 两遍。当前 inboxStore 的 created 按 id 去重、幂等所以没有可见危害，但那是
  // 巧合而非设计 —— 别把这份冗余加回来。

  // 相对时间每分钟重算一次，否则「2 分钟前」会一直停在挂载时的值。
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // 「全部」视图按严重度分组，严重在前；「未读」「严重」视图按时间倒序平铺。
  const visible = useMemo(() => {
    const items = snapshot.items;
    if (filter === 'unread') return items.filter((it) => !it.read_at);
    if (filter === 'critical') return items.filter((it) => it.severity === 'critical');
    return items;
  }, [snapshot.items, filter]);

  const grouped = useMemo(() => {
    if (filter !== 'all') return null;
    const by: Record<InboxSeverity, InboxNotification[]> = { critical: [], warning: [], info: [] };
    for (const it of visible) by[it.severity].push(it);
    return by;
  }, [visible, filter]);

  const unreadCount = useMemo(() => snapshot.items.filter((it) => !it.read_at).length, [snapshot.items]);
  const criticalCount = useMemo(
    () => snapshot.items.filter((it) => it.severity === 'critical' && !it.read_at).length,
    [snapshot.items],
  );

  // 选中项：默认第一条未读，没有未读则第一条；列表变化导致选中项消失时回落。
  useEffect(() => {
    if (selectedId && visible.some((it) => it.notification_id === selectedId)) return;
    const firstUnread = visible.find((it) => !it.read_at) ?? visible[0];
    setSelectedId(firstUnread ? firstUnread.notification_id : null);
  }, [visible, selectedId]);

  const selected = useMemo(
    () => visible.find((it) => it.notification_id === selectedId) ?? null,
    [visible, selectedId],
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (isMobile) setSheetOpen(true);
  };

  const filterLabel = (key: FilterKey) => {
    if (key === 'unread') return unreadCount > 0 ? `未读 ${unreadCount}` : '未读';
    if (key === 'critical') return criticalCount > 0 ? `严重 ${criticalCount}` : '严重';
    return '全部';
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col p-4">
      <div className="mb-4 flex items-center gap-2">
        {isMobile ? <MobileMenuButton onMenuClick={() => window.dispatchEvent(new CustomEvent('lovdex:open-sidebar'))} /> : null}
        <InboxIcon className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">收件箱</h1>
        {unreadCount > 0 ? (
          <span className="rounded-full bg-destructive px-2 py-0.5 text-2xs font-semibold text-destructive-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => markAllReadLocal()}>
          <CheckCheck className="mr-1 h-4 w-4" />全部已读
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={
              filter === f.key
                ? 'rounded-full bg-primary px-3 py-1 text-2xs font-semibold text-primary-foreground'
                : 'rounded-full border border-border px-3 py-1 text-2xs font-semibold text-muted-foreground hover:bg-muted'
            }
          >
            {filterLabel(f.key)}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-12">
        <div className="min-h-0 overflow-y-auto lg:col-span-5">
          {visible.length === 0 ? (
            // 空态必须在这里兜住：分组分支在 visible 为空时会渲染出零个 section，
            // 页面变成一片空白。
            <InboxList items={[]} selectedId={null} now={now} onSelect={handleSelect} />
          ) : grouped ? (
            SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((severity) => (
              <section key={severity} className="mb-4">
                <div className="mb-1.5 text-2xs font-semibold uppercase text-muted-foreground">
                  {severityLabel(severity)}
                </div>
                <InboxList
                  items={grouped[severity]}
                  selectedId={isMobile ? null : selectedId}
                  now={now}
                  onSelect={handleSelect}
                />
              </section>
            ))
          ) : (
            <InboxList
              items={visible}
              selectedId={isMobile ? null : selectedId}
              now={now}
              onSelect={handleSelect}
            />
          )}
        </div>

        {!isMobile ? (
          <div className="min-h-0 rounded-xl border border-border bg-card p-4 lg:col-span-7">
            <InboxDetail
              item={selected}
              now={now}
              onMarkRead={markReadLocal}
              onNavigate={(path) => navigate(path)}
            />
          </div>
        ) : null}
      </div>

      {isMobile ? (
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <DialogContent variant="sheet" className="p-4">
            <DialogTitle>{selected?.title ?? '通知详情'}</DialogTitle>
            <InboxDetail
              item={selected}
              now={now}
              onMarkRead={markReadLocal}
              onNavigate={(path) => { setSheetOpen(false); navigate(path); }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
```

**关于 `MobileMenuButton` 的接线**：`InboxPage` 拿不到 `AppContent` 的 `setSidebarOpen`。本计划采用的最小接法是派发一个自定义事件 `lovdex:open-sidebar`，由 `AppContent` 监听（下一步）。如果实现时发现 `AppContent` 已经有更直接的传参通道，优先用那个。

- [ ] **Step 2: AppContent 监听开侧边栏事件**

`web/src/components/app/AppContent.tsx` —— 在 `const isInboxRoute = ...` 附近加：

```tsx
  // 收件箱页在窄屏需要开侧边栏，但它是主内容区的子组件、拿不到 setSidebarOpen。
  useEffect(() => {
    const openSidebar = () => setSidebarOpen(true);
    window.addEventListener('lovdex:open-sidebar', openSidebar);
    return () => window.removeEventListener('lovdex:open-sidebar', openSidebar);
  }, [setSidebarOpen]);
```

- [ ] **Step 3: 更新导出**

`web/src/components/inbox/index.ts` 全文替换为：

```ts
export { default as InboxPage } from './InboxPage';
export { InboxList } from './InboxList';
export { InboxDetail } from './InboxDetail';
```

- [ ] **Step 4: typecheck + 既有测试不回归**

```bash
# 在 web/ 目录下
npm run typecheck
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/inbox/inboxTarget.test.ts src/components/inbox/InboxList.test.tsx src/components/inbox/InboxDetail.test.tsx
```

预期：typecheck 0 错误；三个测试文件全绿

- [ ] **Step 5: 手动验收（必做）**

打开 `http://<lan-ip>:5188/inbox`：

1. 宽屏（≥1024px）：左侧侧边栏 + 中间列表 + 右侧详情，三栏并排
2. 点左栏某条 → 右栏内容跟着换
3. 详情里多行正文**保留换行**（找一条 body 里带 `\n` 的通知；没有的话临时造一条）
4. 点「打开会话 / 查看任务」能跳走
5. 点「全部已读」→ 未读角标清零、已读行变淡
6. 窄屏（把窗口拖到 <1024px）：变单列列表，**顶部出现菜单按钮**，点它能拉出侧边栏抽屉
7. 窄屏点某条 → 从底部滑出全屏 sheet，内容与右栏一致

- [ ] **Step 6: 提交**

```bash
git add web/src/components/inbox/ web/src/components/app/AppContent.tsx
git commit -m "feat(inbox): two-pane inbox page with mobile detail sheet"
```

---

## Task 7: Toast 改版 —— 毛玻璃 + 入场/退场 + 悬停暂停

**Files:**
- Modify: `web/tailwind.config.js`
- Modify: `web/src/shared/view/ui/Toast.tsx`
- Test: `web/src/shared/view/ui/Toast.test.tsx`

- [ ] **Step 1: 加动画 keyframes**

`web/tailwind.config.js` —— 在 `keyframes` 对象里、`'dialog-content-show'` 之后加：

```js
        'toast-in': {
          from: { opacity: '0', transform: 'scale(0.94)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'toast-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.96)' },
        },
```

在 `animation` 对象里、`'dialog-content-show'` 之后加：

```js
        'toast-in': 'toast-in 260ms cubic-bezier(0.2, 0, 0, 1)',
        'toast-out': 'toast-out 180ms cubic-bezier(0.4, 0, 1, 1) forwards',
```

- [ ] **Step 2: 写失败的测试**

创建 `web/src/shared/view/ui/Toast.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SEVERITY_STYLE, ToastCard } from './Toast';

test('卡片本体不按严重度染色（整块染色是「太突兀」的主因）', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'critical', title: '失败', body: '详情' }} onDismiss={() => {}} />,
  );
  assert.ok(html.includes('bg-popover/80'), '卡片应为毛玻璃底');
  assert.ok(html.includes('backdrop-blur-xl'), '卡片应带毛玻璃模糊');
  assert.ok(html.includes('shadow-raised-md'), '应使用具名阴影档位');
  assert.ok(!html.includes('bg-destructive/10'), '卡片本体不应整块染色');
});

test('严重度只体现在图标块的配色上', () => {
  assert.ok(SEVERITY_STYLE.critical.iconClass.includes('bg-destructive/12'));
  assert.ok(SEVERITY_STYLE.warning.iconClass.includes('bg-warning/12'));
  assert.ok(SEVERITY_STYLE.info.iconClass.includes('bg-muted'));
});

test('渲染标题与正文', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'warning', title: '标题甲', body: '正文乙' }} onDismiss={() => {}} />,
  );
  assert.ok(html.includes('标题甲'));
  assert.ok(html.includes('正文乙'));
});

test('无 body 时不渲染正文节点', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'warning', title: '标题甲', body: null }} onDismiss={() => {}} />,
  );
  assert.ok(!html.includes('line-clamp-2'));
});

test('渲染关闭按钮', () => {
  const html = renderToStaticMarkup(
    <ToastCard item={{ id: 't1', severity: 'info', title: '标题甲' }} onDismiss={() => {}} />,
  );
  assert.ok(html.includes('aria-label="关闭"'));
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Toast.test.tsx
```

预期：FAIL —— `ToastCard` 未导出

- [ ] **Step 4: 重写 Toast.tsx**

`web/src/shared/view/ui/Toast.tsx` 全文替换为：

```tsx
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type ToastSeverity = 'critical' | 'warning' | 'info';

export type ToastItem = {
  id: string;
  severity: ToastSeverity;
  title: string;
  body?: string | null;
  onClick?: () => void;
};

/**
 * 严重度只落在图标块上，卡片本体一律毛玻璃底 —— 整块染色是「突兀」的主因。
 * 导出供测试断言，避免有人日后把染色加回卡片本体。
 */
export const SEVERITY_STYLE: Record<ToastSeverity, { icon: React.ReactNode; iconClass: string }> = {
  critical: {
    icon: <AlertCircle className="h-4 w-4" />,
    iconClass: 'bg-destructive/12 text-destructive',
  },
  warning: {
    icon: <AlertTriangle className="h-4 w-4" />,
    iconClass: 'bg-warning/12 text-warning',
  },
  info: {
    icon: <Info className="h-4 w-4" />,
    iconClass: 'bg-muted text-muted-foreground',
  },
};

export const AUTO_DISMISS_MS = 6000;

/** 单条 toast：入场淡入缩放，AUTO_DISMISS_MS 后播放退场动画再卸载。 */
export function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const [closing, setClosing] = useState(false);
  // 用 deadline 时间戳而不是剩余毫秒数：暂停/恢复反复切换不会累积漂移。
  const deadlineRef = useRef(0);
  const remainingRef = useRef(AUTO_DISMISS_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback((ms: number) => {
    clearTimer();
    remainingRef.current = ms;
    deadlineRef.current = Date.now() + ms;
    timerRef.current = setTimeout(() => setClosing(true), ms);
  }, [clearTimer]);

  useEffect(() => {
    schedule(AUTO_DISMISS_MS);
    return clearTimer;
  }, [schedule, clearTimer, item.id]);

  // 悬停暂停：记下剩余时间并清掉定时器；移出后按剩余时间续跑。
  const handleMouseEnter = useCallback(() => {
    clearTimer();
    remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
  }, [clearTimer]);

  const handleMouseLeave = useCallback(() => {
    if (closing) return;
    schedule(remainingRef.current);
  }, [closing, schedule]);

  const style = SEVERITY_STYLE[item.severity];

  return (
    <div
      className={cn(
        'pointer-events-auto w-80 rounded-2xl border border-border/70 bg-popover/80 p-3 shadow-raised-md backdrop-blur-xl',
        item.onClick && 'cursor-pointer',
        closing ? 'animate-toast-out' : 'animate-toast-in',
      )}
      onClick={item.onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      // 入场动画结束时不做事；只有退场动画结束才真正移除节点。
      onAnimationEnd={() => { if (closing) onDismiss(item.id); }}
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', style.iconClass)}>
          {style.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{item.title}</div>
          {item.body ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</div> : null}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); setClosing(true); }}
          aria-label="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** 容器：固定右上角。由调用方通过 push/remove 控制 items。 */
export function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex flex-col gap-2">
      {items.map((it) => <ToastCard key={it.id} item={it} onDismiss={onDismiss} />)}
    </div>,
    document.body,
  );
}

/** 便捷 hook：维护一个 toast 列表 + push/dismiss。 */
export function useToastStack() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((item: ToastItem) => setItems((prev) => [...prev, item]), []);
  const dismiss = useCallback((id: string) => setItems((prev) => prev.filter((it) => it.id !== id)), []);
  return { items, push, dismiss };
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/shared/view/ui/Toast.test.tsx
```

预期：PASS，5 个测试全绿

- [ ] **Step 6: 设计守卫 + typecheck**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/design/scaleGuard.test.ts src/design/tokenGuard.test.ts
npm run typecheck
```

预期：守卫 13 pass（不允许新增违规），typecheck 0 错误

- [ ] **Step 7: 提交**

```bash
git add web/tailwind.config.js web/src/shared/view/ui/Toast.tsx web/src/shared/view/ui/Toast.test.tsx
git commit -m "feat(ui): soften notification toast with frosted card and motion"
```

---

## Task 8: 汇总弹窗 —— 补回可见标题 + 分组

**Files:**
- Modify: `web/src/components/app/AppContent.tsx:341-354`

`AppContent` 依赖 WebSocket provider 与 router，无法 SSR 测；靠手动验收。

- [ ] **Step 1: 在收件箱页上不要弹汇总（代码审查发现）**

`web/src/components/app/AppContent.tsx` —— 现在的 announce effect **不区分路由**。硬加载 `/inbox` 时若存在未打扰的未读重要项、或断线重连的 refetch 命中，「你有未读通知」会直接糊在用户正盯着的收件箱列表上。

把这段：

```tsx
  useEffect(() => {
    const announce = () => {
      if (claimUnannouncedImportant().length > 0) setSummaryOpen(true);
    };
    announce();
    return subscribeInbox(announce);
  }, []);
```

改成：

```tsx
  useEffect(() => {
    const announce = () => {
      const important = claimUnannouncedImportant();
      // 已经在收件箱页时不弹汇总 —— 用户正盯着那个列表，糊一层弹窗纯属打扰。
      // 但**仍要 claim 掉**（上面这行的副作用），否则他离开收件箱时会把刚看过
      // 的内容又补弹一次。
      if (isInboxRoute) return;
      if (important.length > 0) setSummaryOpen(true);
    };
    announce();
    return subscribeInbox(announce);
  }, [isInboxRoute]);
```

- [ ] **Step 2: 计算候选集**

`web/src/components/app/AppContent.tsx` —— 在 `const inbox = useSyncExternalStore(...)` 之后加：

```tsx
  // 候选集：未读且非 info。`info` 永不进汇总弹窗，这是既有约定（见
  // docs/superpowers/specs/2026-09-20-inbox-notification-design.md §5），不要顺手改掉。
  const summaryItems = inbox.items
    .filter((it) => !it.read_at && it.severity !== 'info')
    .slice(0, 8);
  const summaryCritical = summaryItems.filter((it) => it.severity === 'critical');
  const summaryWarning = summaryItems.filter((it) => it.severity === 'warning');
```

- [ ] **Step 3: 替换 Dialog 内容**

把第 341-354 行的 `<Dialog open={summaryOpen} ...>...</Dialog>` 整体替换为：

```tsx
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="p-5">
          {/* DialogTitle 默认 sr-only（a11y 用），可见标题得自己渲染 —— 这是
              CommandResultModal 已经在用的模式。 */}
          <DialogTitle>你有未读通知</DialogTitle>
          <h2 className="text-lg font-semibold">你有未读通知</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">共 {summaryItems.length} 条需要你看一眼</p>

          <div className="mt-3 space-y-3">
            {[
              { key: 'critical', label: '严重', items: summaryCritical },
              { key: 'warning', label: '警告', items: summaryWarning },
            ]
              .filter((g) => g.items.length > 0)
              .map((group) => (
                <section key={group.key}>
                  <div className="mb-1 text-2xs font-semibold uppercase text-muted-foreground">
                    {group.label}
                  </div>
                  <ul className="space-y-1">
                    {group.items.map((it) => {
                      const target = inboxTargetPath(it);
                      return (
                        <li key={it.notification_id}>
                          <button
                            type="button"
                            disabled={!target}
                            onClick={() => {
                              if (!target) return;
                              setSummaryOpen(false);
                              markReadLocal(it.notification_id);
                              navigate(target);
                            }}
                            className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-muted disabled:cursor-default"
                          >
                            {it.title}
                            {it.occurrence_count > 1 ? (
                              <span className="ml-1.5 text-2xs text-muted-foreground">×{it.occurrence_count}</span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { markAllReadLocal(); setSummaryOpen(false); }}>
              全部已读
            </Button>
            <Button size="sm" onClick={() => { setSummaryOpen(false); navigate('/inbox'); }}>去收件箱</Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 4: 补 import**

`AppContent.tsx` 第 8 行的 store import 增加 `markReadLocal`、`markAllReadLocal`：

```tsx
import { refreshInbox, applyInboxEvent, claimUnannouncedImportant, subscribeInbox, getInboxSnapshot, markReadLocal, markAllReadLocal } from '../../stores/inboxStore';
```

新增一行：

```tsx
import { inboxTargetPath } from '../inbox/inboxTarget';
```

- [ ] **Step 5: typecheck**

```bash
# 在 web/ 目录下
npm run typecheck
```

预期：0 错误

- [ ] **Step 6: 手动验收（必做）**

制造一条未读 critical 通知（最简单的办法：从收件箱上报 skill 发一条，或直接改库里 `notifications` 表某行 `read_at = NULL`），刷新页面：

1. 弹窗**有可见标题**「你有未读通知」+ 副标题条数
2. 列表按「严重 / 警告」分组
3. 点某条 → 弹窗关闭并跳到对应任务/会话
4. 点「全部已读」→ 弹窗关闭、角标清零
5. **info 级别的通知不出现**在这个弹窗里

- [ ] **Step 7: 提交**

```bash
git add web/src/components/app/AppContent.tsx
git commit -m "fix(inbox): give the summary dialog a visible title and group by severity"
```

---

## Task 9: 侧边栏入口选中态

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx`
- Test: `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarInboxEntry from './SidebarInboxEntry';

const render = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <SidebarInboxEntry />
    </MemoryRouter>,
  );

test('停在 /inbox 时入口高亮', () => {
  assert.ok(render('/inbox').includes('data-active="true"'));
});

test('其他路由下不高亮', () => {
  assert.ok(render('/').includes('data-active="false"'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx
```

预期：FAIL —— 找不到 `data-active`

- [ ] **Step 3: 加选中态**

`web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx` —— 加 `useLocation` 并给 Button 加 `data-active`：

```tsx
import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { subscribeInbox, getUnreadCount } from '../../../../stores/inboxStore';

/**
 * 「收件箱」侧边栏整行入口，置于「定时任务」之后。点击跳 /inbox。
 * 未读数用红点角标显示（订阅模块级 inboxStore，跨路由存活）。
 */
export default function SidebarInboxEntry() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const unread = useSyncExternalStore(subscribeInbox, getUnreadCount, () => 0);
  const active = pathname === '/inbox';
  return (
    <div className="flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      <Button
        variant="ghost"
        data-active={active ? 'true' : 'false'}
        className={cn(
          'flex w-full justify-between p-2 h-auto font-normal hover:bg-muted',
          unread > 0 && 'bg-primary/5',
          active && 'bg-primary/10',
        )}
        onClick={() => navigate('/inbox')}
        title="收件箱"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Inbox className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">收件箱</span>
        </div>
        {unread > 0 ? (
          <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx
```

预期：PASS，2 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx
git commit -m "feat(sidebar): highlight the inbox entry while on /inbox"
```

---

## Task 10: 全量验收

**Files:** 无（只跑命令与手动检查）

- [ ] **Step 1: 跑本计划新增的全部测试**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/inbox/inboxTarget.test.ts \
  src/components/inbox/InboxList.test.tsx \
  src/components/inbox/InboxDetail.test.tsx \
  src/shared/view/ui/Toast.test.tsx \
  src/shared/view/ui/Dialog.test.ts \
  src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx
```

预期：全部 PASS

- [ ] **Step 2: 设计守卫 + 类型 + lint**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/design/scaleGuard.test.ts src/design/tokenGuard.test.ts
npm run typecheck
npm run lint
```

预期：守卫 13 pass（零新增违规）；typecheck **0 错误**（基线就是 0）；lint 与改动前相比**零新增**（先跑一次记下改动前的数量再对比）

- [ ] **Step 3: 既有测试不回归**

```bash
# 在 web/ 目录下
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/tasks/TaskInboxPanel.test.tsx src/stores/tests/inboxStore.test.ts src/stores/tests/inboxStoreCatchUp.test.ts
```

预期：全绿

- [ ] **Step 4: 端到端手动清单**

打开 `http://<lan-ip>:5188/inbox` 逐条确认：

1. 桌面端侧边栏在，且「收件箱」入口高亮
2. ≥1024px 两栏；<1024px 单列 + 菜单按钮 + 底部 sheet
3. 详情正文保留换行
4. 新通知到达时 toast 有缩放淡入；鼠标悬停不消失，移开约 6 秒后淡出
5. 汇总弹窗有可见标题且按严重度分组；info 不出现
6. 深色模式下以上各项同样正常（弹窗毛玻璃、卡片、列表对比度）

- [ ] **Step 5: 提交（若有验收期修补）**

```bash
git add -A web/
git commit -m "chore(inbox): address acceptance findings"
```

---

## 已知取舍

- **`lovdex:open-sidebar` 自定义事件**是绕过 prop drilling 的最小接法。若实现时发现 `AppContent` 已有现成的上下文可传 `setSidebarOpen`，优先改用那个。
- **汇总弹窗与 `ToastStack` 无法自动化测试**（`createPortal` + provider 依赖），只能手动验收。Task 8 Step 5 的清单必须真的走一遍。
- **相对时间在 Task 6 里每分钟重算**，避免「2 分钟前」停在挂载时刻。
