# 会话级自动审批开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让交互会话能把自动审批关掉——关掉后该会话后续手动发送的消息恢复「问人」，而任务的定时执行逐字节不变。

**Architecture:** 自动审批的真值在任务行 `tasks.auto_approve`，服务端在每次 `chat.send` 反查（`chat-websocket.service.ts:266`）。本计划给这条反查加一层**纯降级**：客户端只能传字面量 `false` 把自己的这次发送降回「问人」，传 `true` 一律被忽略，防自我授权性质不变。前端在 composer 工具栏加一个独立开关（**不进 `permissionMode` 循环**），状态是「任务开关 + 会话级 override」，override 存 localStorage。

**Tech Stack:** TypeScript、React 18、node:test（后端 + 前端均为 `npx tsx --test`，前端无 DOM 环境，渲染测试用 `renderToStaticMarkup`）、Express + WebSocket 后端。

**Spec:** `docs/superpowers/specs/2026-09-23-session-auto-approve-toggle-design.md`

---

## 环境前置（每个 shell 都要做）

`TSX_TSCONFIG_PATH=server/tsconfig.json` 在本机被**全局导出**，会让从 `web/` 目录跑的 `npx tsx` 去 `web/server/tsconfig.json` 找配置并崩溃（`Error: Cannot resolve tsconfig at path: .../web/server/tsconfig.json`）。所以前端测试命令**必须**用 `env -u TSX_TSCONFIG_PATH` 前缀。后端命令则显式传 `--tsconfig`。

```bash
# 后端（在 backend/ 下）
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test <测试文件>

# 前端（在 web/ 下）
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test <测试文件>
```

**基线不干净**：`npm run typecheck` 有 pre-existing 错误、`npm run lint` 44 errors。验收标准是**零新增**，不是全绿。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `backend/server/modules/permissions/auto-approve-policy.ts` | 自动审批策略（纯函数，provider 中立） | 加 `applyClientAutoApproveOverride` |
| `backend/server/modules/permissions/tests/auto-approve-policy.test.ts` | 上述纯函数的表驱动测试 | 加 3 个 test |
| `backend/server/modules/websocket/services/chat-websocket.service.ts` | `chat.send` 装配 `runtimeOptions` | 接线 + 改注释 |
| `web/src/components/chat/hooks/useSessionAutoApprove.ts` | 会话级 override 的读写 + hook | **新建** |
| `web/src/components/chat/hooks/useSessionAutoApprove.test.ts` | 上述纯函数的测试 | **新建** |
| `web/src/components/chat/view/subcomponents/AutoApproveToggle.tsx` | 开关按钮（独立组件，便于渲染测试） | **新建** |
| `web/src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx` | 按钮渲染测试 | **新建** |
| `web/src/components/chat/types/types.ts` | `ChatInterfaceProps` | 加 `linkedTaskAutoApprove` |
| `web/src/components/main-content/view/MainContent.tsx` | 把 linked task 的开关传下去 | 加一行 prop |
| `web/src/components/chat/view/ChatInterface.tsx` | 调 hook、注入 options、挂按钮 | 改 3 处 |
| `web/src/components/chat/hooks/useChatComposerState.ts` | `buildSendOptions` | 注入 `autoApprove: false` |
| `web/src/components/chat/view/subcomponents/ChatComposer.tsx` | composer 工具栏 | 挂 `AutoApproveToggle` |

---

## Task 1: 后端纯函数 `applyClientAutoApproveOverride`

**Files:**
- Modify: `backend/server/modules/permissions/auto-approve-policy.ts`（文件末尾，`resolveTaskAutoApprove` 之后，当前 278 行）
- Test: `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`（文件末尾）

- [ ] **Step 1: 写失败的测试**

把 `auto-approve-policy.test.ts` 顶部的 import 改成：

```ts
import {
  applyClientAutoApproveOverride,
  decideAutoApproval,
  resolveTaskAutoApprove,
  TOOLS_REQUIRING_INTERACTION,
} from '@/modules/permissions/auto-approve-policy.js';
```

在文件**末尾**追加：

```ts
// --- 客户端降级（会话级开关）---

test('a client may downgrade auto-approval for its own send', () => {
  assert.equal(applyClientAutoApproveOverride(true, false), false);
});

test('a client may NOT upgrade auto-approval, whatever it sends', () => {
  for (const value of [true, 1, 0, 'false', '', null, undefined, {}, []]) {
    assert.equal(
      applyClientAutoApproveOverride(false, value),
      false,
      `client value ${JSON.stringify(value)} must not turn auto-approval on`,
    );
  }
});

test('only the literal false downgrades; every other value keeps the task value', () => {
  for (const value of [true, 1, 0, 'false', '', null, undefined, {}, []]) {
    assert.equal(
      applyClientAutoApproveOverride(true, value),
      true,
      `client value ${JSON.stringify(value)} must leave the task value alone`,
    );
  }
});
```

注意 `0` 与 `'false'` 在第二个断言里是**刻意**的：它们不是字面量 `false`，所以既不降级也不升级。这是规格里写死的语义，不要"顺手"放宽成 falsy 判断。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: FAIL —— `applyClientAutoApproveOverride is not a function`（或 TS 报该导出不存在）。

- [ ] **Step 3: 写最小实现**

在 `auto-approve-policy.ts` 末尾（`resolveTaskAutoApprove` 之后）追加：

```ts
/**
 * The client may only ever turn auto-approval OFF for its own send.
 *
 * `chat.send` options come from the browser, so honouring a client-supplied
 * `true` would let any client grant itself unattended permissions — exactly what
 * `resolveTaskAutoApprove` exists to prevent. Only the literal `false`
 * downgrades; `true`, `0`, `'false'` and a missing field all leave the task's
 * value alone, so a malformed client cannot accidentally disable the feature for
 * a task that has it on.
 */
export function applyClientAutoApproveOverride(taskFlag: boolean, clientRequest: unknown): boolean {
  return taskFlag && clientRequest !== false;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
```

Expected: PASS，`# pass 24`（原 21 + 新 3），`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/permissions/auto-approve-policy.ts backend/server/modules/permissions/tests/auto-approve-policy.test.ts
git commit -m "feat(auto-approve): let a client downgrade its own send, never upgrade"
```

---

## Task 2: 后端接线 `chat.send`

**Files:**
- Modify: `backend/server/modules/websocket/services/chat-websocket.service.ts:19`（import）与 `:262-266`（`runtimeOptions`）

**为什么这个任务没有单测：** `handleChatSend` 没有导出、也没有测试宿主——它需要 DB 行、WebSocket 与 provider spawn。本仓库对这个函数的既有做法就是把可判定的部分抽成纯函数再测（见 `filterImagesToUploadStore` / `chat-image-filter.test.ts`），Task 1 抽出的 `applyClientAutoApproveOverride` 正是那一层。本任务的验收是 typecheck + lint + Task 8 的手工 E2E。**不要**为了测试去导出 `handleChatSend` 或起一个 DB 测试宿主。

- [ ] **Step 1: 改 import（第 19 行）**

```ts
// 改前
import { resolveTaskAutoApprove } from '@/modules/permissions/auto-approve-policy.js';
// 改后
import {
  applyClientAutoApproveOverride,
  resolveTaskAutoApprove,
} from '@/modules/permissions/auto-approve-policy.js';
```

- [ ] **Step 2: 改 `runtimeOptions` 的 `autoApprove`（当前 262-266 行）**

```ts
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Placed after the ...clientOptions spread so a client-supplied
    // `autoApprove` cannot upgrade: the only client value that is honoured is a
    // literal `false`, which downgrades this send back to asking the human.
    // Everything else (including `true`) leaves the task's value alone.
    autoApprove: applyClientAutoApproveOverride(
      resolveTaskAutoApprove(sessionId, getTaskAutoApprove),
      clientOptions.autoApprove,
    ),
```

原注释写的是「a client-supplied autoApprove is discarded」——**必须**一起改掉，否则注释与代码矛盾，下一个人会把降级路径当成漏洞。

- [ ] **Step 3: typecheck 与 lint（零新增）**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm run typecheck 2>&1 | tail -20
npm run lint 2>&1 | tail -20
```

Expected: 与改动前的输出**逐条一致**（pre-existing 错误数不变）。先在改动前跑一次存下输出以便对比。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/websocket/services/chat-websocket.service.ts
git commit -m "feat(auto-approve): honour a client downgrade in chat.send"
```

---

## Task 3: 前端 `useSessionAutoApprove`（纯函数 + hook）

**Files:**
- Create: `web/src/components/chat/hooks/useSessionAutoApprove.ts`
- Test: `web/src/components/chat/hooks/useSessionAutoApprove.test.ts`

- [ ] **Step 1: 写失败的测试**

新建 `web/src/components/chat/hooks/useSessionAutoApprove.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoApproveOverrideKey,
  readAutoApproveOverride,
  resolveEffectiveAutoApprove,
  writeAutoApproveOverride,
  type AutoApproveStorage,
} from './useSessionAutoApprove';

function fakeStorage(
  seed: Record<string, string> = {},
): AutoApproveStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

test('effective auto-approval is the task flag minus the session override', () => {
  assert.equal(resolveEffectiveAutoApprove(true, false), true);
  assert.equal(resolveEffectiveAutoApprove(true, true), false);
  assert.equal(resolveEffectiveAutoApprove(false, false), false);
  assert.equal(resolveEffectiveAutoApprove(false, true), false);
});

test('the override round-trips through storage, keyed by session', () => {
  const storage = fakeStorage();
  writeAutoApproveOverride('s1', true, storage);
  assert.equal(storage.data[autoApproveOverrideKey('s1')], '1');
  assert.equal(readAutoApproveOverride('s1', storage), true);
  // 另一个会话不受影响 —— 键必须是 per-session 的。
  assert.equal(readAutoApproveOverride('s2', storage), false);

  writeAutoApproveOverride('s1', false, storage);
  assert.equal(readAutoApproveOverride('s1', storage), false);
});

test('a missing or malformed stored value reads as "not overridden"', () => {
  const storage = fakeStorage({ [autoApproveOverrideKey('s1')]: 'garbage' });
  assert.equal(readAutoApproveOverride('s1', storage), false);
  assert.equal(readAutoApproveOverride('s2', storage), false);
});

test('a null session id neither reads nor writes', () => {
  const storage = fakeStorage();
  assert.equal(readAutoApproveOverride(null, storage), false);
  assert.equal(readAutoApproveOverride(undefined, storage), false);
  assert.equal(readAutoApproveOverride('', storage), false);
  writeAutoApproveOverride(null, true, storage);
  assert.deepEqual(storage.data, {});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/hooks/useSessionAutoApprove.test.ts
```

Expected: FAIL —— 模块不存在（`Cannot find module './useSessionAutoApprove'`）。

- [ ] **Step 3: 写实现**

新建 `web/src/components/chat/hooks/useSessionAutoApprove.ts`：

```ts
import { useCallback, useEffect, useState } from 'react';

import { safeLocalStorage } from '../utils/chatStorage';

/** The slice of the Storage API this hook needs; injected so tests can pass a fake. */
export interface AutoApproveStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Session-scoped "the user turned auto-approval off here" flag.
 *
 * Keyed by session and persisted, mirroring the existing
 * `permissionMode-${sessionId}` key in useChatProviderState. Persisting matters:
 * a reload that silently restored auto-approval would be invisible — tool calls
 * stop being shown — and the user would only find out when something they wanted
 * to approve was auto-denied.
 *
 * This is a pure frontend preference and never reaches the unattended paths:
 * scheduled / assistant / headless runs go through `startTaskRun` and read the
 * task row directly, never through `chat.send`.
 */
export function autoApproveOverrideKey(sessionId: string): string {
  return `autoApproveOff-${sessionId}`;
}

/** The task flag minus the session override. Pure; four quadrants in the test. */
export function resolveEffectiveAutoApprove(taskFlag: boolean, override: boolean): boolean {
  return taskFlag && !override;
}

export function readAutoApproveOverride(
  sessionId: string | null | undefined,
  storage: AutoApproveStorage = safeLocalStorage,
): boolean {
  if (!sessionId) return false;
  return storage.getItem(autoApproveOverrideKey(sessionId)) === '1';
}

export function writeAutoApproveOverride(
  sessionId: string | null | undefined,
  override: boolean,
  storage: AutoApproveStorage = safeLocalStorage,
): void {
  if (!sessionId) return;
  storage.setItem(autoApproveOverrideKey(sessionId), override ? '1' : '0');
}

export interface UseSessionAutoApproveArgs {
  sessionId: string | null | undefined;
  /** The linked task's `auto_approve === 1`; `undefined` means "no linked task". */
  taskFlag: boolean | undefined;
}

export interface UseSessionAutoApproveResult {
  /** Whether to render the toggle at all — only when the task has it on. */
  show: boolean;
  /** The state the button renders. */
  enabled: boolean;
  toggle: () => void;
  /**
   * `false` only when this send must be downgraded. Typed `false | undefined`
   * (not `boolean`) so a caller cannot accidentally send `true` — the backend
   * would ignore it, but the type makes the mistake unrepresentable here.
   */
  clientAutoApprove: false | undefined;
}

export function useSessionAutoApprove({
  sessionId,
  taskFlag,
}: UseSessionAutoApproveArgs): UseSessionAutoApproveResult {
  const [override, setOverride] = useState(() => readAutoApproveOverride(sessionId));

  // Re-read when the user switches sessions; a stale override from the previous
  // session must not leak into this one.
  useEffect(() => {
    setOverride(readAutoApproveOverride(sessionId));
  }, [sessionId]);

  const toggle = useCallback(() => {
    setOverride((previous) => {
      const next = !previous;
      writeAutoApproveOverride(sessionId, next);
      return next;
    });
  }, [sessionId]);

  const show = taskFlag === true;
  return {
    show,
    enabled: resolveEffectiveAutoApprove(show, override),
    toggle,
    clientAutoApprove: override ? false : undefined,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/hooks/useSessionAutoApprove.test.ts
```

Expected: PASS，`# pass 4`，`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/hooks/useSessionAutoApprove.ts web/src/components/chat/hooks/useSessionAutoApprove.test.ts
git commit -m "feat(auto-approve): session-scoped override hook"
```

---

## Task 4: `AutoApproveToggle` 按钮组件

**Files:**
- Create: `web/src/components/chat/view/subcomponents/AutoApproveToggle.tsx`
- Test: `web/src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx`

做成独立小组件而不是内联进 `ChatComposer`：`ChatComposer` 有 60+ 个 prop，整棵渲染的测试成本远高于一个两 prop 的叶子组件（`AutoApproveNotice.tsx` 是同一个套路）。

- [ ] **Step 1: 写失败的测试**

新建 `web/src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveToggle } from './AutoApproveToggle';

const noop = () => {};

test('renders the on state as pressed', () => {
  const html = renderToStaticMarkup(<AutoApproveToggle enabled onToggle={noop} />);
  assert.match(html, /自动审批/);
  assert.match(html, /aria-pressed="true"/);
});

test('renders the overridden (off) state as not pressed, with the same label', () => {
  const html = renderToStaticMarkup(<AutoApproveToggle enabled={false} onToggle={noop} />);
  // 标签不随状态变：按钮一直在，只有外观变 —— 否则关掉后无从再打开。
  assert.match(html, /自动审批/);
  assert.match(html, /aria-pressed="false"/);
});

test('the tooltip states the blast radius', () => {
  const html = renderToStaticMarkup(<AutoApproveToggle enabled onToggle={noop} />);
  // 只说开关名会让人以为改的是任务；作用范围必须写在 title 里。
  assert.match(html, /定时执行/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx
```

Expected: FAIL —— `Cannot find module './AutoApproveToggle'`。

- [ ] **Step 3: 写实现**

新建 `web/src/components/chat/view/subcomponents/AutoApproveToggle.tsx`：

```tsx
/**
 * The composer's session-scoped auto-approval switch.
 *
 * Only rendered when the linked task has `auto_approve = 1` — the chat window may
 * turn unattended approval OFF (and back on), but may never GRANT it to a task
 * that does not already have it. Granting lives on the task page.
 *
 * Colour is deliberately the warning band (same as `bypassPermissions`): this
 * state means tool calls are being answered without you, so it should not look
 * like an ordinary toggle. The label does not change with state — if it vanished
 * when off there would be no way to turn it back on from here.
 *
 * The double span follows ChatComposer's permission-mode button (`sm:hidden` /
 * `sm:inline` are both display utilities at equal specificity, so merging them
 * onto one element would be resolved by CSS source order, not by breakpoint).
 */
export function AutoApproveToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const title = enabled
    ? '自动审批已开启：本会话手动发送的消息不再询问权限。仅影响你在此会话手动发送的消息；该任务的定时执行不受影响。'
    : '自动审批已关闭：本会话手动发送的消息会恢复权限询问。该任务的定时执行仍会自动批准。';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      title={title}
      aria-label={title}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-all duration-200 sm:px-2.5 ${
        enabled
          ? 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
          : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
      }`}
    >
      <span className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${enabled ? 'bg-warning' : 'bg-muted-foreground'}`} />
      <span className="whitespace-nowrap sm:hidden">自动审批</span>
      <span className="hidden whitespace-nowrap sm:inline">自动审批</span>
    </button>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx
```

Expected: PASS，`# pass 3`，`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/AutoApproveToggle.tsx web/src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx
git commit -m "feat(auto-approve): the composer toggle button"
```

---

## Task 5: 数据透传与 options 注入

**Files:**
- Modify: `web/src/components/chat/types/types.ts:147` 一带（`ChatInterfaceProps`）
- Modify: `web/src/components/main-content/view/MainContent.tsx:188` 一带
- Modify: `web/src/components/chat/view/ChatInterface.tsx:44`（解构）、`:236` 一带（调 `useChatComposerState`）
- Modify: `web/src/components/chat/hooks/useChatComposerState.ts:43-70`（args）、`:706-729`（`buildSendOptions` 返回 + deps）

沿用既有 `linkedTaskModel` 的三段式管道，不新造机制。

- [ ] **Step 1: 给 `ChatInterfaceProps` 加 prop**

`web/src/components/chat/types/types.ts`，紧挨 `linkedTaskModel`（:147）之后：

```ts
  /** The linked task's `auto_approve === 1`. `undefined` when there is no linked
   *  task (or it has not resolved yet) — the composer then renders no
   *  auto-approval toggle at all. */
  linkedTaskAutoApprove?: boolean;
```

- [ ] **Step 2: 在 `MainContent.tsx` 传值**

`web/src/components/main-content/view/MainContent.tsx:188`，紧挨 `linkedTaskModel`：

```tsx
                  linkedTaskModel={linkedTask ? (linkedTask.executor_model ?? null) : undefined}
                  linkedTaskAutoApprove={linkedTask ? linkedTask.auto_approve === 1 : undefined}
```

- [ ] **Step 3: 在 `ChatInterface.tsx` 解构并调 hook**

解构处（`:44` 一带，`linkedTaskModel` 之后）加：

```ts
  linkedTaskAutoApprove,
```

顶部 import 区加：

```ts
import { useSessionAutoApprove } from '../hooks/useSessionAutoApprove';
```

在 `useChatComposerState({...})` 调用（`:236` 一带）**之前**加：

```ts
  const { show: showAutoApprove, enabled: autoApproveEnabled, toggle: toggleAutoApprove, clientAutoApprove } =
    useSessionAutoApprove({ sessionId: currentSessionId, taskFlag: linkedTaskAutoApprove });
```

在 `useChatComposerState({...})` 的参数对象里加一行（挨着 `permissionMode`）：

```ts
    clientAutoApprove,
```

- [ ] **Step 4: 在 `useChatComposerState` 里注入 options**

`web/src/components/chat/hooks/useChatComposerState.ts` 的 `UseChatComposerStateArgs`（`:43-70`）里，挨着 `permissionMode` 加：

```ts
  /**
   * `false` when the user turned auto-approval off for this session; `undefined`
   * to leave the server's task-derived value alone. Never `true` — the backend
   * ignores an upgrade, so the type does not allow one to be sent.
   */
  clientAutoApprove?: false | undefined;
```

在 hook 的解构参数列表（`:200` 一带，`permissionMode` 之后）加：

```ts
  clientAutoApprove,
```

`buildSendOptions` 的返回对象（`:706-720`）里加：

```ts
      // Only ever a downgrade. The backend re-derives auto-approval from the
      // task row and honours this key only when it is literally `false`.
      ...(clientAutoApprove === false ? { autoApprove: false } : {}),
```

`buildSendOptions` 的依赖数组（`:721-730`）里加：

```ts
    clientAutoApprove,
```

- [ ] **Step 5: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -20
```

Expected: 与改动前逐条一致（零新增）。`QueuedSendOptions` 是 `Record<string, unknown>`，所以注入新键不需要改类型。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/types/types.ts web/src/components/main-content/view/MainContent.tsx web/src/components/chat/view/ChatInterface.tsx web/src/components/chat/hooks/useChatComposerState.ts
git commit -m "feat(auto-approve): thread the session override into chat.send options"
```

---

## Task 6: 在 composer 工具栏挂上按钮

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/ChatComposer.tsx:55-104`（props）、`:516` 之后（渲染）、import 区

- [ ] **Step 1: 加 props 与 import**

import 区加：

```ts
import { AutoApproveToggle } from './AutoApproveToggle';
```

`ChatComposerProps` 里，紧挨 `onModeSwitch`（`:66`）加：

```ts
  /** Whether to render the auto-approval toggle (only for a task that has it on). */
  showAutoApprove?: boolean;
  /** The toggle's rendered state: the task flag minus the session override. */
  autoApproveEnabled?: boolean;
  onToggleAutoApprove?: () => void;
```

在组件解构参数里（`:132` 一带，`permissionMode` 之后）加：

```ts
  showAutoApprove,
  autoApproveEnabled,
  onToggleAutoApprove,
```

- [ ] **Step 2: 渲染**

`ChatComposer.tsx` 的权限模式按钮整块在 `:516` 结束（`</button>`），模型按钮从 `:518` 开始。**在这两者之间**插入：

```tsx
            {showAutoApprove && (
              <AutoApproveToggle
                enabled={Boolean(autoApproveEnabled)}
                onToggle={onToggleAutoApprove ?? (() => {})}
              />
            )}
```

- [ ] **Step 3: 从 `ChatInterface.tsx` 传下去**

在 `<ChatComposer ... />` 的 prop 列表（`:525` 一带，`onModeSwitch` 之后）加：

```tsx
          showAutoApprove={showAutoApprove}
          autoApproveEnabled={autoApproveEnabled}
          onToggleAutoApprove={toggleAutoApprove}
```

- [ ] **Step 4: typecheck 与 lint**

```bash
cd /mnt/b/workdir/github/lovdex/web
npm run typecheck 2>&1 | tail -20
npm run lint 2>&1 | tail -20
```

Expected: 零新增。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/ChatComposer.tsx web/src/components/chat/view/ChatInterface.tsx
git commit -m "feat(auto-approve): show the toggle in the composer"
```

---

## Task 7: 回归跑一遍受影响的测试

**Files:** 无改动，纯验证。

- [ ] **Step 1: 后端**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/headless-task-run.test.ts
npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-image-filter.test.ts
```

Expected: 全 PASS。

- [ ] **Step 2: 前端**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/hooks/useSessionAutoApprove.test.ts
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/AutoApproveToggle.test.tsx
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/permissionModeLabels.test.ts
env -u TSX_TSCONFIG_PATH npx tsx --test src/hooks/useLinkedTask.test.ts
```

Expected: 全 PASS。

---

## Task 8: 端到端手工验证

**Files:** 无改动。

> ⚠️ **需要用户明确许可**：后端改动要生效必须重启后端进程。本项目规定**每一次**重启都要单独取得用户许可，一次授权不等于长期授权。不要自行重启。如果用户说自己已经重启，直接往下走。

- [ ] **Step 1: 确认服务在跑**

```bash
ss -ltnp 2>/dev/null | grep -E ':(3188|5188)'
```

Expected: `:3188`（后端）与 `:5188`（vite dev）都在监听。缺哪个就告诉用户，不要自行拉起。

- [ ] **Step 2: 造一个开着自动审批的任务会话**

在浏览器（用 IP，不用 localhost，见项目约定）打开一个任务，在任务详情里把「自动审批」打开（`TaskDetail.tsx:753` 的开关），然后点任务板「执行」按钮跑一次。

- [ ] **Step 3: 验证关闭生效**

在跑完的会话里：

1. composer 工具栏应出现一个 **warning 色**的「自动审批」按钮。
2. 点一下 → 按钮变灰。
3. 发一条会触发工具调用的消息（例如「读一下 README 第一行」）。
4. Expected: 出现权限确认弹窗（`PermissionRequestsBanner`），而**不是** `AutoApproveNotice` 的「已自动放行 …」。
5. 刷新页面 → 按钮**仍是灰的**（override 已持久化）。
6. 再点一下 → 按钮变回 warning 色，再发一条 → 恢复静默放行。

- [ ] **Step 4: 验证定时执行不受影响**

回到任务详情，确认任务的「自动审批」**仍然是开启**（前端 override 没有写回任务）。再点一次「执行」跑一次，Expected: 全程无权限弹窗。

- [ ] **Step 5: 记录结果**

把观察到的现象记进 `docs/superpowers/plans/2026-09-23-session-auto-approve-toggle.md` 的末尾（或直接向用户汇报）。若第 3 步的弹窗没出现，**不要**标记完成——先按 systematic-debugging 定位。

---

## 完成标准

- [ ] 后端 `applyClientAutoApproveOverride` 的三个 test 通过，且 `true` / `0` / `'false'` 均**不能**升级。
- [ ] `chat.send` 的注释不再写「client-supplied autoApprove is discarded」。
- [ ] composer 里只在任务开着自动审批时出现按钮；关掉后恢复弹窗且刷新不丢。
- [ ] 任务的 `auto_approve` 字段在关掉开关后**没有被写回**。
- [ ] 定时执行路径逐字节不变。
- [ ] backend / web 的 typecheck 与 lint **零新增**。
