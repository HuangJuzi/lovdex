# 收件箱未读角标实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让左侧导航的收件箱在有任何未读（含 `info`）时显示数字角标，并按未读里的最高严重度着色。

**Architecture:** `countUnread` 去掉 `severity !== 'info'` 这个全仓唯一的例外，与后端 `/api/notifications/unread-count`、`/inbox` 页头、列表红点四处口径统一；新增纯函数 `selectUnreadTone` 派生「未读里的最高严重度」供角标选色；`SidebarInboxEntry` 用两个返回原始值的 `useSyncExternalStore` 订阅（number / string|null），避免返回新对象导致的无限重渲染。`info` 仍然不弹 toast、不进补推汇总弹窗，只改「会计数 + 有着色」。

**Tech Stack:** React 18 + Vite（web，node:test + `renderToStaticMarkup` 静态渲染测试，无 DOM）；Node.js + TypeScript（backend，只改提示词/注释文案，`npx tsx --test` 跑 node:test）。

**Spec:** `docs/superpowers/specs/2026-09-28-inbox-unread-badge-design.md`

**仓库约定：**
- commit message 英文、**不加** Co-Authored-By 署名行。
- `git add` **只加本计划明确列出的文件**，绝不 `git add -A`。
- web 命令一律 `cd /mnt/b/workdir/github/lovdex/web`，测试**必须**带 `env -u TSX_TSCONFIG_PATH`（该变量在开发机 shell 里全局导出、指向 backend 的 tsconfig，会劫持 web 的 tsx；仓库内没有任何文件设置它）。
- backend 命令一律 `cd /mnt/b/workdir/github/lovdex/backend`，测试带 `--tsconfig server/tsconfig.json`。

**基线（改动前实测，用于判断「零新增」）：**

| 检查 | 基线 |
|---|---|
| web `inboxStore.test.ts`（9）/ `inboxStoreCatchUp.test.ts`（5）/ `SidebarInboxEntry.test.tsx`（3） | 17 tests / 17 pass / 0 fail |
| backend `notifications.db.test.ts` | 7 tests / 7 pass / 0 fail |
| backend `operator-prompt-tools.test.ts` | 4 tests / 4 pass / 0 fail |
| backend `npx tsc --noEmit -p server/tsconfig.json` | **14 个既有错误**（`config/tests`、`operators/tests` ×2、`tasks/tests` ×2，与本次改动文件无关） |
| web `npx tsc --noEmit -p tsconfig.json` | 0 错误 |

**另一个实测结论（决定了 Task 3 的写法）：** 本仓库的前端渲染测试用 `renderToStaticMarkup`，它走 `useSyncExternalStore` 的 **`getServerSnapshot`**（第三个参数）。实测 `useSyncExternalStore(sub, () => value, () => 42)` 在 `renderToStaticMarkup` 下渲染出 `42`，而不是模块里的 `value`。因此**往模块级 store 灌数据再静态渲染是看不到的** —— Task 3 为此给组件加了一层可注入快照的纯展示包装。

**已预跑验证：** Task 1 的 `selectUnreadTone` 六种输入、Task 3 的 8 条用例（含三条高亮 + 五条角标）都已在临时副本上真跑通过（8/8 pass），随后临时实现已 `git checkout` 还原、临时文件已删除。计划里的代码可直接照抄。

**当前工作区不干净（与本计划无关）：** 有另一个并发会话正在改 `backend/server/modules/providers/services/sessions.service.ts` 与 `backend/server/modules/tasks/services/tasks.service.ts`（任务/会话级联删除顺序）。执行本计划时 `git add` **只加自己列出的文件**，不要 `git add -A`，也不要把那两个文件带进任何提交。

---

### Task 1: 纯函数层 —— 计数含 info + 派生角标色调

**Files:**
- Modify: `web/src/stores/inboxStore.pure.ts:26-29`（`countUnread`）、文件末尾（新增 `selectUnreadTone`）
- Test: `web/src/stores/tests/inboxStore.test.ts`（改一条断言 + 追加新用例）

- [ ] **Step 1: 改掉旧断言，写失败测试**

`web/src/stores/tests/inboxStore.test.ts:16-19` 现在是**反向**断言，必须替换（否则实现后它必红）：

```ts
test('countUnread 排除 info（spec §5）', () => {
  const rows = [n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })];
  assert.equal(countUnread(rows), 1);
});
```

替换为：

```ts
test('countUnread 计入 info（2026-09-28 口径对齐，与后端 unread-count 一致）', () => {
  const rows = [n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })];
  assert.equal(countUnread(rows), 2);
});
```

在文件末尾（第 67 行 `});` 之后）追加 `selectUnreadTone` 的用例，并把 import 补上：

```ts
import { inboxReducer, countUnread, selectUnreadTone, selectUnannouncedImportant, type InboxState, type InboxNotification } from '../inboxStore.pure.js';
```

```ts
test('selectUnreadTone：无未读时返回 null', () => {
  assert.equal(selectUnreadTone([]), null);
  assert.equal(selectUnreadTone([n({ read_at: 'now' })]), null);
});

test('selectUnreadTone：未读里的最高严重度决定色调', () => {
  assert.equal(selectUnreadTone([n({ severity: 'info' })]), 'info');
  assert.equal(
    selectUnreadTone([n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })]),
    'warning',
  );
  assert.equal(
    selectUnreadTone([
      n({ notification_id: 'a', severity: 'info' }),
      n({ notification_id: 'b', severity: 'warning' }),
      n({ notification_id: 'c', severity: 'critical' }),
    ]),
    'critical',
  );
});

test('selectUnreadTone：已读的严重项不抬升色调', () => {
  const rows = [
    n({ notification_id: 'a', severity: 'info' }),
    n({ notification_id: 'b', severity: 'critical', read_at: 'now' }),
  ];
  assert.equal(selectUnreadTone(rows), 'info');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/tests/inboxStore.test.ts
```
Expected: FAIL —— `countUnread 计入 info` 得到 1（期望 2）；`selectUnreadTone` 相关用例报 `is not a function`（TS 编译期即报 `has no exported member 'selectUnreadTone'`）。共计 4 条失败。

- [ ] **Step 3: 实现**

`countUnread` 去掉 `severity` 过滤（`web/src/stores/inboxStore.pure.ts:26-29`）：

```ts
/** 未读总数 —— 与后端 unread-count、/inbox 页头、列表红点同一口径（含 info）。 */
export function countUnread(items: readonly InboxNotification[]): number {
  return items.filter((it) => !it.read_at).length;
}
```

在同一文件末尾追加（放在 `countUnread` 之后、`selectUnannouncedImportant` 之前即可，位置不影响语义）：

```ts
/**
 * 未读里的最高严重度，决定侧栏角标配色；无未读时为 null。
 * 刻意复用 InboxSeverity 而不是另立别名 —— 一份类型，分级变化时编译期会带上角标。
 */
export function selectUnreadTone(items: readonly InboxNotification[]): InboxSeverity | null {
  let tone: InboxSeverity | null = null;
  for (const it of items) {
    if (it.read_at) continue;
    if (it.severity === 'critical') return 'critical';
    if (it.severity === 'warning') tone = 'warning';
    else if (tone === null) tone = 'info';
  }
  return tone;
}
```

**不要动** `selectUnannouncedImportant`（`:38-45`）——它继续排除 info，补推汇总弹窗的候选集不变。这是本设计刻意的边界。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/tests/inboxStore.test.ts
```
Expected: PASS，12 tests / 12 pass / 0 fail（基线 9，改 1 不增减、新增 3）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/stores/inboxStore.pure.ts web/src/stores/tests/inboxStore.test.ts && git commit -m "feat(inbox): count info toward unread and derive the badge tone"
```

---

### Task 2: store 层 —— 暴露 `getUnreadTone`

**Files:**
- Modify: `web/src/stores/inboxStore.ts:9-15`（import）、`:38-40` 附近（新增 getter）
- Test: `web/src/stores/tests/inboxStoreCatchUp.test.ts`（追加一条）

- [ ] **Step 1: 写失败测试**

在 `web/src/stores/tests/inboxStoreCatchUp.test.ts` 末尾追加。该文件已 import `applyInboxEvent` 与 `getInboxSnapshot`，需把 `getUnreadTone` 补进那条 import：

```ts
import {
  applyInboxEvent,
  claimUnannouncedImportant,
  refreshInbox,
  getInboxSnapshot,
  getUnreadTone,
} from '../inboxStore.js';
```

```ts
test('getUnreadTone 跟随 store 快照：有未读 info 即返回 info', () => {
  applyInboxEvent({ kind: 'notification_created', payload: n({ notification_id: 'tone-1', severity: 'info' }) });
  assert.equal(getUnreadTone(), 'info');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/tests/inboxStoreCatchUp.test.ts
```
Expected: FAIL —— `getUnreadTone is not a function`（同时 TS 报 `has no exported member 'getUnreadTone'`）。

- [ ] **Step 3: 实现**

`web/src/stores/inboxStore.ts` 的 import 补上 `selectUnreadTone`：

```ts
import {
  inboxReducer,
  countUnread,
  selectUnreadTone,
  selectUnannouncedImportant,
  type InboxState,
  type InboxNotification,
  type InboxSeverity,
} from './inboxStore.pure';
```

在 `getUnreadCount`（`:38-40`）之后加薄包装：

```ts
/** 角标色调：未读里的最高严重度；无未读时 null。与 getUnreadCount 同源同快照。 */
export function getUnreadTone(): InboxSeverity | null {
  return selectUnreadTone(state.items);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/tests/inboxStoreCatchUp.test.ts
```
Expected: PASS，6 tests / 6 pass / 0 fail。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/stores/inboxStore.ts web/src/stores/tests/inboxStoreCatchUp.test.ts && git commit -m "feat(inbox): expose the unread badge tone from the store"
```

---

### Task 3: 角标按色调渲染

**Files:**
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx:1-44`（整个组件 + 新增一个可注入快照的小包装组件）
- Test: `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx`（追加四条）

**⚠️ 实测约束（务必先读）：本仓库的渲染测试用 `renderToStaticMarkup`，它走的是 `useSyncExternalStore` 的 `getServerSnapshot`（第三个参数）。**

我实测确认过：`renderToStaticMarkup(<Reading />)` 里 `useSyncExternalStore(sub, () => value, () => 42)` 渲染出的是 **42**，不是模块里的 `value`。现有测试里的 `() => 0` / `() => null` 就是 server 快照。

所以：**直接 `renderToStaticMarkup(<SidebarInboxEntry />)` 永远看不到任何未读** —— 也不能靠往模块级 store 里灌数据来测。再做一层：给组件加一个**只供测试注入快照的同文件包装组件** `InboxEntryView`，真实导出的 `SidebarInboxEntry` 保持无 props、内部使用 store 的真实快照。

- [ ] **Step 1: 写失败测试**

`SidebarInboxEntry.test.tsx` 整体替换为：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import type { InboxNotification } from '../../../../stores/inboxStore.pure';

import { InboxEntryView } from './SidebarInboxEntry';

const n = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1', severity: 'info', title: 'A', read_at: null,
  occurrence_count: 1, ...over,
});

// 显式注入快照：renderToStaticMarkup 走的是 useSyncExternalStore 的
// getServerSnapshot，读不到模块级 store 的真实状态（见组件内的注释）。
const render = (
  path: string,
  items: InboxNotification[] = [],
) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <InboxEntryView unread={unreadOf(items)} tone={toneOf(items)} />
    </MemoryRouter>,
  );

/** 与 store 同口径的本地复刻，只用于构造测试输入。 */
const unreadOf = (items: InboxNotification[]) => items.filter((it) => !it.read_at).length;
const toneOf = (items: InboxNotification[]): 'critical' | 'warning' | 'info' | null => {
  const un = items.filter((it) => !it.read_at);
  if (un.some((it) => it.severity === 'critical')) return 'critical';
  if (un.some((it) => it.severity === 'warning')) return 'warning';
  return un.length > 0 ? 'info' : null;
};

test('停在 /inbox 时入口高亮', () => {
  assert.ok(render('/inbox').includes('data-active="true"'));
});

test('其他路由下不高亮', () => {
  assert.ok(render('/').includes('data-active="false"'));
});

test('尾斜杠 /inbox/ 也高亮', () => {
  assert.ok(render('/inbox/').includes('data-active="true"'));
});

/** 取出角标那个 span 的 class 属性；没有角标时返回 null。 */
function badgeClass(html: string): string | null {
  const m = /<span data-tone="([^"]+)" class="([^"]*)"/.exec(html);
  return m ? m[2] : null;
}

test('未读全是 info 时也渲染数字角标，且用中性灰', () => {
  const html = render('/', [n({ severity: 'info' })]);
  assert.ok(html.includes('>1<'), '应渲染未读数 1');
  assert.match(badgeClass(html) ?? '', /\bbg-muted\b/, 'info 色调应中性灰');
  assert.doesNotMatch(badgeClass(html) ?? '', /bg-destructive/, 'info 不应是红底');
  assert.doesNotMatch(badgeClass(html) ?? '', /bg-warning/, 'info 不应是琥珀底');
});

test('未读含 warning 时角标用琥珀色', () => {
  const html = render('/', [n({ severity: 'warning' })]);
  assert.equal(badgeClass(html) !== null && /bg-warning/.test(badgeClass(html)!), true);
  assert.doesNotMatch(badgeClass(html) ?? '', /bg-destructive/, '没有 critical 时不应是红底');
});

test('未读含 critical 时角标用红色，红色优先于其它未读', () => {
  const html = render('/', [
    n({ notification_id: 'i1', severity: 'info' }),
    n({ notification_id: 'c1', severity: 'critical' }),
  ]);
  assert.ok(html.includes('>2<'), '应数到 2 条未读');
  assert.match(html, /data-tone="critical"/);
  assert.match(badgeClass(html) ?? '', /\bbg-destructive\b/);
});

test('没有未读时不渲染角标', () => {
  const html = render('/', []);
  assert.equal(badgeClass(html), null, '未读为 0 时不应有角标');
  assert.ok(!html.includes('>99<'));
});

test('超过 99 显示 99+', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    n({ notification_id: `m${i}`, severity: 'warning' }),
  );
  assert.ok(render('/', many).includes('99+'));
});
```

**为什么用 `badgeClass()` 提取而不是 `html.includes('bg-muted')`**：外层 `Button` 的 className 里有 `hover:bg-muted`，所以整段 HTML 里 `includes('bg-muted')` **恒为真** —— 只查它会让「info 应中性灰」因为错误的理由通过。用正则把角标那个 `<span data-tone=… class=…>` 的 class 单独抠出来再断言，既不受外层影响，也不依赖 `cn()` 的类名输出顺序。`data-tone` 同时让「有没有角标」有唯一判据（`badgeClass() === null`）。

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx
```
Expected: FAIL —— TS 编译期报 `InboxEntryView` 无导出；即便忽略类型，四条角标用例也会因为当前组件不渲染任何未读而失败。三条高亮用例应当仍通过。

- [ ] **Step 3: 实现**

`SidebarInboxEntry.tsx` 整体替换为：
import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { subscribeInbox, getUnreadCount, getUnreadTone } from '../../../../stores/inboxStore';
import type { InboxSeverity } from '../../../../stores/inboxStore.pure';
import { isInboxPath } from '../../../app/inboxRouteMatch';

/** 角标配色：按未读里的最高严重度。info 与收件箱列表的 info 图标色块同款 token。 */
const TONE_CLASS: Record<InboxSeverity, string> = {
  critical: 'bg-destructive text-destructive-foreground',
  warning: 'bg-warning text-warning-foreground',
  info: 'border border-border bg-muted text-muted-foreground',
};

type InboxEntryViewProps = {
  unread: number;
  tone: InboxSeverity | null;
};

/**
 * 「收件箱」侧边栏整行入口，置于「定时任务」之后。点击跳 /inbox。
 * 未读数用数字角标显示，配色按未读里的最高严重度：critical 红、warning 琥珀、
 * info 中性灰。
 *
 * `InboxEntryView` 只承接纯展示、参数即快照，因此可以在 `renderToStaticMarkup`
 * 下被直接测到 —— 那个渲染路径走的是 `useSyncExternalStore` 的 getServerSnapshot
 * （本组件里是 `() => 0` / `() => null`），读不到模块级 store 的真实状态。
 * 真实入口 `SidebarInboxEntry` 保持无 props，只负责把 store 快照接上。
 */
export function InboxEntryView({ unread, tone }: InboxEntryViewProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = isInboxPath(pathname);
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
        {unread > 0 && tone ? (
          <span
            data-tone={tone}
            className={cn(
              'ml-2 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold',
              TONE_CLASS[tone],
            )}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
    </div>
  );
}

export default function SidebarInboxEntry() {
  // 两个订阅各自返回原始值（number / string|null），不用一个返回 {unread, tone}
  // 新对象的订阅 —— 后者每次 getSnapshot 都是新引用，会触发无限重渲染。
  const unread = useSyncExternalStore(subscribeInbox, getUnreadCount, () => 0);
  const tone = useSyncExternalStore(subscribeInbox, getUnreadTone, () => null);
  return <InboxEntryView unread={unread} tone={tone} />;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx
```
Expected: PASS，8 tests / 8 pass / 0 fail。

- [ ] **Step 5: 确认调用方没受影响**

`SidebarContent.tsx:343` 用的是 `<SidebarInboxEntry />`（默认导出、无 props），签名未变，无需改动。用 grep 确认只有这一处引用：

```bash
cd /mnt/b/workdir/github/lovdex && grep -rn "SidebarInboxEntry" web/src --include=*.tsx --include=*.ts | grep -v "\.test\."
```
Expected: 只有 `SidebarContent.tsx` 的 import 与使用各一行。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx && git commit -m "feat(sidebar): color the inbox badge by the highest unread severity"
```

---

### Task 4: 同步「info 不再是不计角标的二等公民」的文案

**Files:**
- Modify: `backend/server/claude-sdk.js:62`（`OPERATOR_INBOX_PROMPT` 第 2 段）
- Modify: `backend/server/modules/operators/operator.tools.ts:773`（`send_notification.description`）
- Modify: `backend/server/index.js:2245`（启动期 skill 更新通知的注释）
- Modify: `docs/superpowers/specs/2026-09-20-inbox-notification-design.md` §5 表

行为改了而描述不改会静默漂移：助手会因为「info 不算角标」这句话而建议用户「用 info 就不会被角标烦到」，而实际上会。这四处必须一起改。

- [ ] **Step 1: 改 `OPERATOR_INBOX_PROMPT`**

`backend/server/claude-sdk.js:62` 当前是：

```js
  '当用户要你「通知他」「发消息到收件箱」「发个测试通知」「把结果放到收件箱」时，**直接调用 send_notification 工具**（severity/title/body/code），不要只输出 lovdex-alert 代码块——你是助手，走工具这条路。severity 取 critical/warning/info：critical 和 warning 会弹窗并计未读角标，info 只进收件箱。code 用稳定标识以便同类合并。',
```

改为（末句替换）：

```js
  '当用户要你「通知他」「发消息到收件箱」「发个测试通知」「把结果放到收件箱」时，**直接调用 send_notification 工具**（severity/title/body/code），不要只输出 lovdex-alert 代码块——你是助手，走工具这条路。severity 取 critical/warning/info：三种 severity 都会进收件箱并计入侧栏未读角标（critical 红、warning 琥珀、info 中性灰）；只有 critical 和 warning 会弹窗，info 不弹。code 用稳定标识以便同类合并。',
```

- [ ] **Step 2: 改 `send_notification` 工具描述**

`backend/server/modules/operators/operator.tools.ts:773` 的描述里，把这一段：

```
severity: critical|warning|info (info lands in the inbox only — no toast, no badge).
```

改为：

```
severity: critical|warning|info (all three land in the inbox and count toward the sidebar badge — critical red, warning amber, info neutral grey; only critical/warning toast).
```

文件同一行的其余文字不动。

- [ ] **Step 3: 改启动期注释**

`backend/server/index.js:2244-2245` 当前是：

```js
        // 启动时比对内置 vs 已安装版本，落后就发一条 info 通知（进收件箱、
        // 不弹窗不计角标）。失败绝不阻塞启动。
```

改为：

```js
        // 启动时比对内置 vs 已安装版本，落后就发一条 info 通知（进收件箱、
        // 计角标、不弹窗）。失败绝不阻塞启动。
```

- [ ] **Step 4: 改 2026-09-20 spec 的 §5 表**

`docs/superpowers/specs/2026-09-20-inbox-notification-design.md` 的 `## 5. severity 语义` 表格中，`info` 行的「侧边栏角标」一列由 `不计入` 改为 `计入（中性灰）`：

```markdown
| `info` | 是（静默区） | 否 | 计入（中性灰） | 否 |
```

并在该表格下方紧接一行修订说明（与文件里既有的 `**2026-09-21 修正（断线补推）**` 同一风格）：

```markdown
**2026-09-28 修正（口径对齐）**：`info` 原本不计入侧边栏角标，但它**只在这一处**被排除 —— 后端 `/api/notifications/unread-count`、`/inbox` 页头角标、收件箱列表的未读红点全都把 info 算作未读，于是出现「侧栏 0、页面里 3 个红点」的自相矛盾。现改为角标统计全部未读，并按未读里的最高严重度着色（critical 红 / warning 琥珀 / info 中性灰）；info 仍然不弹 toast、不进补推汇总弹窗。详见 `docs/superpowers/specs/2026-09-28-inbox-unread-badge-design.md`。
```

- [ ] **Step 5: 跑受影响的守卫测试**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-prompt-tools.test.ts server/modules/notifications/tests/notifications.db.test.ts
```
Expected: PASS，11 tests / 11 pass / 0 fail（4 + 7）。

`operator-prompt-tools.test.ts` 只断言 `OPERATOR_INBOX_PROMPT` 这个**标识符**被插值、以及清理段里的锚点词，不断言收件箱段的具体句子，所以这处文案改动不会让它变红。若它红了，说明改动碰到了不该碰的段落，回退重看。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex && git add backend/server/claude-sdk.js backend/server/modules/operators/operator.tools.ts backend/server/index.js docs/superpowers/specs/2026-09-20-inbox-notification-design.md && git commit -m "docs(inbox): stop describing info as excluded from the badge"
```

---

### Task 5: 全量回归与端到端验收

**Files:**
- 无代码改动（只跑验证）

- [ ] **Step 1: 前端类型检查零新增**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsc --noEmit -p tsconfig.json
```
Expected: 无输出，exit 0（基线就是 0 错误）。

- [ ] **Step 2: 前端相关测试全绿**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/tests/inboxStore.test.ts src/stores/tests/inboxStoreCatchUp.test.ts src/components/sidebar/view/subcomponents/SidebarInboxEntry.test.tsx src/components/inbox/InboxList.test.tsx src/components/inbox/InboxDetail.test.tsx src/components/inbox/inboxTarget.test.ts
```
Expected: 全部 pass / 0 fail，逐文件为 `inboxStore.test.ts` 12、`inboxStoreCatchUp.test.ts` 6、`SidebarInboxEntry.test.tsx` 8、`InboxList.test.tsx` 6、`InboxDetail.test.tsx` 7、`inboxTarget.test.ts` 7（合计 46）。特别确认 `InboxList.test.tsx`、`InboxDetail.test.tsx` 未回归 —— 它们渲染的是列表与详情，不消费 `countUnread`，本应完全不受影响（基线用例数已实测：6 / 7 / 7）。

- [ ] **Step 3: 前端设计守卫**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/web && env -u TSX_TSCONFIG_PATH npx tsx --test src/design/tokenGuard.test.ts src/design/scaleGuard.test.ts
```
Expected: pass / 0 fail。新增的 `bg-muted` / `text-muted-foreground` / `border-border` / `bg-warning` / `bg-destructive` 全是语义 token，无需任何豁免；若这条红了说明写了 `bg-gray-*` 之类的裸调色板类。

- [ ] **Step 4: 后端类型检查零新增**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && env -u TSX_TSCONFIG_PATH npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"
```
Expected: `14`（与基线一致）。本次后端只改字符串与注释，不应有任何变化。

- [ ] **Step 5: E2E —— 真实浏览器验证（关键步骤，不要用截图判定）**

环境已确认可用：`/tmp/node_modules/puppeteer-core` + `~/.cache/puppeteer` 里的 chromium、vite :5188（代理到后端 :3188）、登录 `zhiju.huang@sophgo.com` / `888888`。库里当前有 **3 条未读 info**、0 条未读 warning/critical。

写一个脚本放到 **`/tmp`**（**不要**放进仓库；`/tmp` 会被中途清空，同一脚本所需的 node_modules 也别跨 Bash 调用依赖）。脚本要点：

0. **稳定选择器**：入口按钮自带 `title="收件箱"`，用 `document.querySelector('button[title="收件箱"]')` 定位；角标是它的最后一个子 `<span>`（无未读时该子节点不存在）。
1. `puppeteer.launch`（`executablePath` 指向缓存 chromium），打开 `http://127.0.0.1:5188/`，走登录流程（填 email / code → 提交），等侧栏出现。
2. 读取角标：文本 `textContent` + `getComputedStyle(el).backgroundColor`。期望文本 `3`，背景等于 `--muted` 解析出的 `rgb(...)`（**不是** `--destructive` 的红）。三个 token 的 `rgb` 值都在页面内从 `:root` 现读，**不要硬编码色值**。
3. 走 UI 打开 `/inbox` → 点「全部已读」→ 回 `/`，确认角标元素不存在。
4. **注入 critical 验证红色**。`POST /api/notifications` 不存在（只有 `/read-all`、`/:id/read`），直接对库 INSERT 又不会触发 WS 广播 —— 但 `AppContent` 挂载时会 `refreshInbox()` 做全量拉取，所以「直接落库 + 刷新页面」是可靠路径：

   ```bash
   cd /mnt/b/workdir/github/lovdex/backend && node -e '
   const D=require("better-sqlite3");
   const db=new D(process.env.HOME+"/.lovdex/data/new-auth.db");
   db.prepare(`INSERT INTO notifications
     (notification_id, severity, title, dedupe_key, occurrence_count)
     VALUES (?,?,?,?,1)`).run("e2e-badge-critical-1","critical","E2E 角标红色验证","e2e-badge:critical");
   '
   ```
   然后 `page.reload()`，等首挂 refetch 落地（轮询角标文本，最多 10s）。上一步已把 3 条 info 全部标为已读，所以期望文本 `1`，背景等于 `--destructive` 的 `rgb`。

   **注意**：reload 后 `claimUnannouncedImportant()` 会对这条未读 critical 弹出汇总弹窗。它会盖住画面但**不影响** DOM 读取与 computed style，别被它干扰判定。读完后关掉弹窗。
5. **清理**：删除注入行，避免污染用户收件箱。

   ```bash
   cd /mnt/b/workdir/github/lovdex/backend && node -e '
   const D=require("better-sqlite3");
   const db=new D(process.env.HOME+"/.lovdex/data/new-auth.db");
   console.log(db.prepare("DELETE FROM notifications WHERE notification_id=?").run("e2e-badge-critical-1").changes);
   '
   ```
   期望输出 `1`。

6. 全部判定一律用 `textContent` + `getComputedStyle`，**不要**整页截图（整页截图的图像描述会编造内容）。

这六步全部可脚本化，**不需要**人工配合，也不需要在助手会话里发测试通知。

- [ ] **Step 6: 无提交**

本任务只跑验证，不产生提交。若 Step 1–4 有任何红，回到对应 Task 修，不要在这里就地改代码。

---

## 自查记录

**Spec 覆盖：**

| Spec 章节 | 落点 |
|---|---|
| 派生逻辑（`countUnread` 含 info、`selectUnreadTone`） | Task 1 |
| 订阅方式（两个原始值订阅） | Task 3 |
| 角标渲染（三档色调表） | Task 3 |
| 文案与文档同步（4 处 + 不 bump skill 版本） | Task 4 |
| 测试（反转断言、`selectUnreadTone` 用例、入口组件用例、后端无新测试） | Task 1 / 2 / 3 / 4-Step5 |
| 验收（灰 3 → 已读消失 → 注入 critical 变红） | Task 5-Step5 |
| 非目标（独立页/折叠态不加角标） | 无任务 —— 刻意不做 |

**类型一致性：** `selectUnreadTone` 在 `inboxStore.pure.ts` 定义（Task 1）、`inboxStore.ts` 包装为 `getUnreadTone`（Task 2）、`SidebarInboxEntry` 消费（Task 3），三处签名一致：`(items: readonly InboxNotification[]) => InboxSeverity | null` 与 `() => InboxSeverity | null`。`InboxSeverity` 从 `inboxStore.pure` 导出（该文件已在首行定义并 `export type`），Task 2 的 import 与 Task 3 的 import 路径都是 `'../../../../stores/inboxStore.pure'`（相对深度按各自文件层级算：`SidebarInboxEntry.tsx` 在 `components/sidebar/view/subcomponents/`，四层到 `src/`，与它现有的 `subscribeInbox` import 同深度）。

**已知风险：** Task 3-Step4 的用例间串扰（模块级单例 store + `node:test` 并发）已在计划里写明处理方式，并给了兜底，不依赖「碰巧不串」。
