# Chat 页四项体验改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lovdex Chat 页实现：文件上传（分析文件/日志）、消息渐进式加载修复、Task→Chat 恢复上次会话、手机端助手会话自动收起侧边栏。

**Architecture:** 四个特性相互独立、分 Part 交付。后端只动 lovdex-backend 的 assets 模块（新增文件上传端点）；其余三处全在 lovdex-cli 前端。纯逻辑一律抽成可单测的函数（`node:test`），React 接线层尽量薄。

**Tech Stack:** Node.js `node:test` + `tsx`（测试）；React 18 + react-dropzone；Express + multer；SQLite（projects.db）。

**Spec:** `docs/superpowers/specs/2026-08-12-chat-improvements-design.md`

**测试命令（两个仓库都用 node:test，无 vitest）**
- lovdex-cli：`cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test <file>`
- lovdex-backend：`cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test <file>`
- 全量（改动完成后跑）：`cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/`；`cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/`
- typecheck：`cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`；`cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsc --noEmit -p server/tsconfig.json`

**交付顺序：** Part 1（渐进加载）→ Part 2（手机收侧边栏）→ Part 3（恢复会话）→ Part 4（文件上传）。

---

# Part 1 — Feature 2：消息渐进式加载修复

**问题**：`useSessionStore.refreshFromServer()` 不带 `limit` 拉全量并整体替换 `serverMessages`，且把 `slot.hasMore` 置 false → 切换/刷新长 session 时历史刷屏、滚动渐进失效。
**方案**：`refreshFromServer` 有界化（默认 `max(当前已加载,20)` 上限 200）+ 按 id 合并，保留已加载旧前缀。

### Task 1: sessionRefresh 纯函数

**Files:**
- Create: `lovdex-cli/src/stores/sessionRefresh.ts`
- Test: `lovdex-cli/src/stores/sessionRefresh.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lovdex-cli/src/stores/sessionRefresh.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeRefreshLimit, mergeRefreshedTail } from './sessionRefresh';
import type { NormalizedMessage } from './useSessionStore';

test('computeRefreshLimit defaults to max(current,20) capped at 200', () => {
  assert.equal(computeRefreshLimit(0), 20);
  assert.equal(computeRefreshLimit(20), 20);
  assert.equal(computeRefreshLimit(60), 60);
  assert.equal(computeRefreshLimit(500), 200); // capped
  assert.equal(computeRefreshLimit(50, { limit: 80 }), 80); // explicit opts wins
  assert.equal(computeRefreshLimit(50, { limit: 0 }), 1); // floor at 1
});

test('mergeRefreshedTail replaces when fetched covers existing', () => {
  const existing = [{ id: 'm1' }, { id: 'm2' }] as NormalizedMessage[];
  const fetched = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as NormalizedMessage[];
  assert.deepEqual(mergeRefreshedTail(existing, fetched), fetched);
});

test('mergeRefreshedTail keeps older prefix when fetched is a bounded tail', () => {
  const existing = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) as NormalizedMessage[];
  const fetched = ['d', 'e', 'f'].map((id) => ({ id })) as NormalizedMessage[];
  const merged = mergeRefreshedTail(existing, fetched);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('mergeRefreshedTail returns existing unchanged when fetched is empty', () => {
  const existing = [{ id: 'm1' }] as NormalizedMessage[];
  assert.equal(mergeRefreshedTail(existing, []), existing);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/sessionRefresh.test.ts`
Expected: FAIL with `Cannot find module './sessionRefresh'` (模块不存在)。

- [ ] **Step 3: Write minimal implementation**

```ts
// lovdex-cli/src/stores/sessionRefresh.ts
import type { NormalizedMessage } from './useSessionStore';

/** 有界刷新下限：至少覆盖初始加载页。 */
export const REFRESH_LIMIT_FLOOR = 20;
/** 有界刷新上限：防止拉全量刷屏。 */
export const MAX_REFRESH_LIMIT = 200;

/**
 * 计算 refreshFromServer 的 limit。
 * - 显式 opts.limit 优先（归一化到 ≥1）。
 * - 默认 = max(当前已加载条数, 下限)，封顶上限。
 */
export function computeRefreshLimit(currentLength: number, opts?: { limit?: number }): number {
  if (opts?.limit !== undefined) {
    return Math.max(1, Math.floor(opts.limit));
  }
  return Math.min(Math.max(currentLength, REFRESH_LIMIT_FLOOR), MAX_REFRESH_LIMIT);
}

/**
 * 合并刷新结果与已加载消息（两者都按时间正序）。
 * - fetched 为空 → 原样返回 existing。
 * - fetched 覆盖了 existing 全窗口（existing.length ≤ fetched.length）→ 直接替换。
 * - 否则（用户已加载更多、fetched 是更短的尾部页）→ 保留不在 fetched 里的旧前缀，fetched 覆盖尾部。
 */
export function mergeRefreshedTail(
  existing: NormalizedMessage[],
  fetched: NormalizedMessage[],
): NormalizedMessage[] {
  if (fetched.length === 0) return existing;
  if (existing.length <= fetched.length) return fetched;
  const fetchedIds = new Set(fetched.map((m) => m.id));
  const prefix = existing.filter((m) => !fetchedIds.has(m.id));
  return [...prefix, ...fetched];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/sessionRefresh.test.ts`
Expected: `# pass 4`, `# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli
git add src/stores/sessionRefresh.ts src/stores/sessionRefresh.test.ts
git commit -m "feat(chat): extract bounded-refresh pure helpers for progressive loading

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2: refreshFromServer 有界 + 合并

**Files:**
- Modify: `lovdex-cli/src/stores/useSessionStore.ts`（`refreshFromServer`，现 733-771 行；文件顶部 import 区）

- [ ] **Step 1: Write the failing test**

先给 store 的刷新行为写测试不可行（store 是 React hook、依赖 `authenticatedFetch`/`notify`）。改为用 Task 1 的纯函数保证核心逻辑，本任务只做接线。用 typecheck + 现有测试守护。

（说明：无新增测试文件。Step 2 改为 typecheck 基线。）

- [ ] **Step 2: Baseline typecheck（确认改动前干净）**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误（或仅有与本次改动无关的既有错误，记录下来）。

- [ ] **Step 3: 修改 import 区与 refreshFromServer**

在文件顶部 import 区（`useCallback` 之后）新增：

```ts
import { computeRefreshLimit, mergeRefreshedTail } from './sessionRefresh';
```

把 `refreshFromServer` 整体替换为：

```ts
  /**
   * Re-fetch a bounded tail page from the provider sessions endpoint and merge
   * it into the slot.
   *
   * Bounded (default limit = max(current loaded, 20), capped at 200) so a
   * session with a long transcript never floods the store or the UI on
   * `complete` / reconnect / external refresh. Older already-loaded messages
   * are preserved when the fetched page is shorter than the current window.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    opts: { limit?: number } = {},
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    const limit = computeRefreshLimit(slot.serverMessages.length, opts);

    const params = new URLSearchParams();
    params.append('limit', String(limit));
    params.append('offset', '0');

    try {
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const fetched: NormalizedMessage[] = data.messages || [];

      // A later-started fetch already applied: applying this stale transcript
      // would erase rows the user has already seen (and re-prune realtime
      // rows against an outdated snapshot).
      if (fetchTicket <= slot._appliedFetchSeq) {
        return;
      }
      slot._appliedFetchSeq = fetchTicket;

      slot.serverMessages = mergeRefreshedTail(slot.serverMessages, fetched);
      seedWorkflowStateFromMessages(fetched);
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      // offset 语义 = 「已从尾部消费的条数」（与 fetchFromServer/fetchMore 累积一致）。
      slot.offset = Math.min(slot.serverMessages.length, slot.total);
      slot.fetchedAt = Date.now();
      // Only drop realtime rows the server transcript now owns. A blind clear
      // here caused the chat pane to flash "Continue your conversation" after
      // `complete` while JSONL / provider_session_id indexing was still behind.
      slot.realtimeMessages = pruneRealtimeSupersededByServer(
        slot.serverMessages,
        slot.realtimeMessages,
      );
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify, seedWorkflowStateFromMessages]);
```

注意：`sessionRefresh.ts` 里 `computeRefreshLimit`/`mergeRefreshedTail` 引用 `NormalizedMessage` 类型——`useSessionStore.ts` 已导出该类型（`export interface NormalizedMessage`），无循环 import 问题。

- [ ] **Step 4: Typecheck + 现有测试**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json` 与 `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/stores/sessionRefresh.test.ts`
Expected: typecheck 无新增错误；sessionRefresh 测试 `# pass 4`。

- [ ] **Step 5: 全量前端测试回归**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/`
Expected: 全绿（或仅记录既有失败）。

- [ ] **Step 6: Commit**

```bash
cd lovdex-cli
git add src/stores/useSessionStore.ts src/stores/sessionRefresh.ts
git commit -m "fix(chat): bound refreshFromServer to a tail page and merge, keep progressive loading

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

# Part 2 — Feature 4：手机端助手会话自动收起侧边栏

**问题**：项目 session 点击会收侧边栏，助手 session 的 `openSession` 只 `navigate()`。
**方案**：`useProjectsState` 新增 `handleAssistantSessionSelect`（navigate + isMobile 收侧边栏），经 `sidebarSharedProps → Sidebar → SidebarContent → SidebarAssistant` 透传。

### Task 3: handleAssistantSessionSelect + 透传

**Files:**
- Modify: `lovdex-cli/src/hooks/useProjectsState.ts`（`handleSessionSelect` 附近新增；`sidebarSharedProps` 加字段；return 加字段）
- Modify: `lovdex-cli/src/components/sidebar/types/types.ts`（`SidebarProps` 加可选 `onAssistantSessionSelect`）
- Modify: `lovdex-cli/src/components/sidebar/view/Sidebar.tsx`（解构并透传）
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarContent.tsx`（props 类型 + 透传）
- Modify: `lovdex-cli/src/components/sidebar/view/subcomponents/SidebarAssistant.tsx`（新 prop `onOpenSession`）

- [ ] **Step 1: useProjectsState 新增 handler**

在 `handleSessionSelect`（现 856-881 行）之后新增：

```ts
  /**
   * Opens a Lovdex助手 (operator workspace) session from the sidebar. These
   * sessions navigate directly because they are not guaranteed to carry the
   * full ProjectSession shape; the URL-resolution effect selects them. On
   * mobile, collapse the sidebar like project-session clicks do.
   */
  const handleAssistantSessionSelect = useCallback(
    (targetSessionId: string) => {
      navigate(`/session/${targetSessionId}`);
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );
```

在 `sidebarSharedProps`（现 1036-1077 行）的对象里加字段：

```ts
      onAssistantSessionSelect: handleAssistantSessionSelect,
```

并加入依赖数组 `handleAssistantSessionSelect`。在 return（现 1079-1108 行）里加：

```ts
    handleAssistantSessionSelect,
```

- [ ] **Step 2: SidebarProps 类型**

`lovdex-cli/src/components/sidebar/types/types.ts` 的 `SidebarProps` 中，`onSessionSelect` 附近加：

```ts
  /** 打开 Lovdex助手 会话（移动端会顺带收起侧边栏）。 */
  onAssistantSessionSelect?: (sessionId: string) => void;
```

- [ ] **Step 3: Sidebar.tsx 解构并透传**

`Sidebar` 函数参数（现 39-59 行）里 `onSessionSelect` 后加：

```ts
  onAssistantSessionSelect,
```

`SidebarContent` 调用处（现 272 行起）加：

```ts
            onAssistantSessionSelect={onAssistantSessionSelect}
```

- [ ] **Step 4: SidebarContent 透传**

`SidebarContentProps`（现 41-76 行）加：

```ts
  onAssistantSessionSelect?: (sessionId: string) => void;
```

函数参数解构（现 78 行起）加 `onAssistantSessionSelect`，并在 `<SidebarAssistant activeSessionId={activeSessionId} />`（现 137 行）改为：

```tsx
      <SidebarAssistant
        activeSessionId={activeSessionId}
        onOpenSession={onAssistantSessionSelect}
      />
```

- [ ] **Step 5: SidebarAssistant 使用 onOpenSession**

`SidebarAssistantProps`（现 67-69 行）加：

```ts
  onOpenSession?: (sessionId: string) => void;
```

函数解构改为：

```ts
export default function SidebarAssistant({ activeSessionId = null, onOpenSession }: SidebarAssistantProps) {
```

`openSession`（现 74-76 行）改为：

```ts
  /** SPA 打开 Lovdex助手 会话；优先走外部回调（移动端收侧边栏），否则直接 navigate。 */
  const openSession = useCallback((sessionId: string) => {
    if (onOpenSession) {
      onOpenSession(sessionId);
      return;
    }
    navigate(`/session/${sessionId}`);
  }, [navigate, onOpenSession]);
```

- [ ] **Step 6: typecheck + 现有测试**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`
Expected: 无新增类型错误。

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli
git add src/hooks/useProjectsState.ts src/components/sidebar/types/types.ts src/components/sidebar/view/Sidebar.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx src/components/sidebar/view/subcomponents/SidebarAssistant.tsx
git commit -m "fix(sidebar): collapse mobile drawer when opening Lovdex assistant sessions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

# Part 3 — Feature 3：恢复上次打开的 session

**问题**：`/tasks` 点 chat 段 → `navigate('/')`，无持久化的 last-opened，`selectedSession=null` 空态。
**方案**：localStorage 存 `lovdex:last-opened-session`；`useProjectsState` 挂载且 URL 无 `sessionId` 时恢复；`handleNewSession` 清除。

### Task 4: lastOpenedSession 工具

**Files:**
- Create: `lovdex-cli/src/hooks/lastOpenedSession.ts`
- Test: `lovdex-cli/src/hooks/lastOpenedSession.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lovdex-cli/src/hooks/lastOpenedSession.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAST_OPENED_SESSION_KEY,
  readLastOpenedSessionId,
  writeLastOpenedSessionId,
  clearLastOpenedSessionId,
  findProjectSessionById,
} from './lastOpenedSession';
import type { Project } from '../types/app';

test('storage helpers round-trip through localStorage', () => {
  const store = new Map<string, string>();
  // node:test 环境没有浏览器 localStorage，注入一个假实现。
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };

  assert.equal(readLastOpenedSessionId(), null);
  writeLastOpenedSessionId('sess-1');
  assert.equal(store.get(LAST_OPENED_SESSION_KEY), 'sess-1');
  assert.equal(readLastOpenedSessionId(), 'sess-1');
  clearLastOpenedSessionId();
  assert.equal(readLastOpenedSessionId(), null);
});

test('findProjectSessionById returns the owning project and session', () => {
  const session = { id: 's1' };
  const project = {
    projectId: 'p1',
    sessions: [{ id: 's1' }, { id: 's2' }],
  } as unknown as Project;
  const match = findProjectSessionById([project], 's1');
  assert.equal(match?.project, project);
  assert.equal(match?.session.id, 's1');
});

test('findProjectSessionById returns null when missing', () => {
  const project = { projectId: 'p1', sessions: [{ id: 's1' }] } as unknown as Project;
  assert.equal(findProjectSessionById([project], 'nope'), null);
  assert.equal(findProjectSessionById([], 's1'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/hooks/lastOpenedSession.test.ts`
Expected: FAIL with `Cannot find module './lastOpenedSession'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// lovdex-cli/src/hooks/lastOpenedSession.ts
import type { Project, ProjectSession } from '../types/app';

export const LAST_OPENED_SESSION_KEY = 'lovdex:last-opened-session';

export function readLastOpenedSessionId(): string | null {
  try {
    return localStorage.getItem(LAST_OPENED_SESSION_KEY);
  } catch {
    return null;
  }
}

export function writeLastOpenedSessionId(sessionId: string): void {
  try {
    localStorage.setItem(LAST_OPENED_SESSION_KEY, sessionId);
  } catch {
    // localStorage unavailable — ignore
  }
}

export function clearLastOpenedSessionId(): void {
  try {
    localStorage.removeItem(LAST_OPENED_SESSION_KEY);
  } catch {
    // localStorage unavailable — ignore
  }
}

/** 在 projects 里按 session id 找归属项目与 session；找不到返回 null。 */
export function findProjectSessionById(
  projects: Project[],
  sessionId: string,
): { project: Project; session: ProjectSession } | null {
  for (const project of projects) {
    const match = project.sessions?.find((s) => s.id === sessionId);
    if (match) {
      return { project, session: match };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/hooks/lastOpenedSession.test.ts`
Expected: `# pass 3`, `# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli
git add src/hooks/lastOpenedSession.ts src/hooks/lastOpenedSession.test.ts
git commit -m "feat(chat): add last-opened-session localStorage helpers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 5: useProjectsState 接入

**Files:**
- Modify: `lovdex-cli/src/hooks/useProjectsState.ts`

- [ ] **Step 1: import 工具**

文件顶部 import 区加：

```ts
import {
  clearLastOpenedSessionId,
  findProjectSessionById,
  readLastOpenedSessionId,
  writeLastOpenedSessionId,
} from './lastOpenedSession';
```

- [ ] **Step 2: 写入 effect + 恢复 effect**

在 URL 解析 effect（现 789-841 行，`selectedSession?.id` 变化驱动的 effect）附近加两个 effect。

**写入**（放在 `handleSessionSelect` 之后的任意位置，hook 体内）：

```ts
  // 持久化「上次打开的 session」：任何入口（打开会话/侧边栏/resume/助手会话）选中具体 session 时记录。
  useEffect(() => {
    if (selectedSession?.id) {
      writeLastOpenedSessionId(selectedSession.id);
    }
  }, [selectedSession?.id]);
```

**恢复**（放在 URL 解析 effect 之后；`restoredOnceRef` 声明放 effect 前面）：

```ts
  // 挂载且 URL 无 sessionId（非「打开会话」）时，恢复上次打开的 session。
  // 每次 useProjectsState 挂载只恢复一次；AppContent 从 /tasks 等路由进入 / 会全新挂载。
  const restoredOnceRef = useRef(false);
  useEffect(() => {
    if (sessionId || projects.length === 0 || restoredOnceRef.current) {
      return;
    }
    const lastId = readLastOpenedSessionId();
    if (!lastId) {
      return;
    }
    const found = findProjectSessionById(projects, lastId);
    if (!found) {
      // 会话已删除 → 清掉无效 key
      clearLastOpenedSessionId();
      return;
    }
    restoredOnceRef.current = true;
    const normalizedSession = normalizeSessionProvider(found.session);
    setSelectedProject(found.project);
    setSelectedSession(normalizedSession);
  }, [sessionId, projects]);
```

- [ ] **Step 3: handleNewSession 清除**

`handleNewSession`（现 883-896 行）体里加：

```ts
      clearLastOpenedSessionId();
```

即：

```ts
  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      clearLastOpenedSessionId();
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );
```

注意 `restoredOnceRef` 需在 `return` 之前声明（hook 体内任意顶层位置均可，放在恢复 effect 前即可）。`useRef` 已在文件 import 区存在。

- [ ] **Step 4: typecheck + 测试**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`
Expected: 无新增类型错误。
Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/hooks/lastOpenedSession.test.ts`
Expected: `# pass 3`。

- [ ] **Step 5: 手动验证（可选但推荐）**

`cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx vite` 起前端 → 打开一个 session → 切到 Task 页 → 点顶部 chat 段 → 应回到该 session；点「新建会话」后再切到 Task→Chat → 应显示空 composer。

- [ ] **Step 6: Commit**

```bash
cd lovdex-cli
git add src/hooks/useProjectsState.ts src/hooks/lastOpenedSession.ts
git commit -m "feat(chat): restore last-opened session when entering chat from task page

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

# Part 4 — Feature 1：Chat 文件上传

**问题**：composer 只支持图片上传（`image/*`，5MB）。
**方案**：新增后端 `POST /api/assets/files?projectId=`（任意 MIME，50MB，存 `<项目>/.lovdex-tmp/`，含内部 `.gitignore`）；前端加附件按钮/拖拽，发送时把 `[附件: <绝对路径>]` 拼到用户消息开头。

### Task 6: 后端 file-assets service + 测试

**Files:**
- Create: `lovdex-backend/server/modules/assets/services/file-assets.service.ts`
- Test: `lovdex-backend/server/modules/assets/tests/file-assets.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lovdex-backend/server/modules/assets/tests/file-assets.service.test.ts
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROJECT_TMP_DIR,
  buildStoredFileRecords,
  ensureProjectTempDir,
} from '@/modules/assets/services/file-assets.service.js';

async function withTempProject(t: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lovdex-files-test-'));
  try {
    await t(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ensureProjectTempDir creates <project>/.lovdex-tmp with an ignore file', async () => {
  await withTempProject(async (dir) => {
    const tmpDir = await ensureProjectTempDir(dir);
    assert.equal(tmpDir, path.join(dir, PROJECT_TMP_DIR));
    assert.equal((await fs.stat(tmpDir)).isDirectory(), true);
    const gitignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\\*$/m); // 含 `*`
    assert.match(gitignore, /^!.gitignore$/m); // 且 !.gitignore
  });
});

test('ensureProjectTempDir is idempotent', async () => {
  await withTempProject(async (dir) => {
    await ensureProjectTempDir(dir);
    await ensureProjectTempDir(dir); // 不抛错
    assert.equal((await fs.stat(path.join(dir, PROJECT_TMP_DIR))).isDirectory(), true);
  });
});

test('buildStoredFileRecords maps multer files to absolute posix paths', async () => {
  await withTempProject(async (dir) => {
    const records = buildStoredFileRecords(dir, [
      { originalname: 'app.log', filename: '123-foo.log', size: 42, mimetype: 'text/plain' },
      { originalname: 'cfg.yaml', filename: '456-bar.yaml', size: 7, mimetype: 'application/x-yaml' },
    ]);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      name: 'app.log',
      path: path.join(dir, PROJECT_TMP_DIR, '123-foo.log').split(path.sep).join('/'),
      size: 42,
      mimeType: 'text/plain',
    });
    assert.equal(records[1].name, 'cfg.yaml');
    assert.equal(records[1].path, path.join(dir, PROJECT_TMP_DIR, '456-bar.yaml').split(path.sep).join('/'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/assets/tests/file-assets.service.test.ts`
Expected: FAIL with `Cannot find module '@/modules/assets/services/file-assets.service.js'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// lovdex-backend/server/modules/assets/services/file-assets.service.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { toPosixPath } from '@/shared/image-attachments.js';

/** 项目内临时上传目录名（位于 <projectPath>/ 下）。 */
export const PROJECT_TMP_DIR = '.lovdex-tmp';

/** 该目录里的 .gitignore 内容：屏蔽所有上传文件，但不屏蔽 .gitignore 自身。 */
const TMP_GITIGNORE = '*\n!.gitignore\n';

type UploadedFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type StoredFileRecord = {
  name: string;
  path: string;
  size: number;
  mimeType: string;
};

/**
 * 创建 <projectPath>/.lovdex-tmp 目录（含内部 .gitignore），返回该目录绝对路径。
 * 幂等：目录已存在时直接复用。
 */
export async function ensureProjectTempDir(projectPath: string): Promise<string> {
  const dir = path.join(projectPath, PROJECT_TMP_DIR);
  await fs.mkdir(dir, { recursive: true });

  const gitignorePath = path.join(dir, '.gitignore');
  try {
    await fs.writeFile(gitignorePath, TMP_GITIGNORE, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return dir;
}

/** 把 multer 落盘的文件映射为上传记录（path 为绝对 posix 路径）。 */
export function buildStoredFileRecords(projectPath: string, files: UploadedFile[]): StoredFileRecord[] {
  const tmpDir = path.join(projectPath, PROJECT_TMP_DIR);
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(tmpDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/** 项目删除时清理临时目录（尽力而为）。 */
export async function removeProjectTempDir(projectPath: string): Promise<void> {
  const dir = path.join(projectPath, PROJECT_TMP_DIR);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[file-assets] Failed to remove ${dir}:`, (error as Error).message);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/assets/tests/file-assets.service.test.ts`
Expected: `# pass 3`, `# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd lovdex-backend
git add server/modules/assets/services/file-assets.service.ts server/modules/assets/tests/file-assets.service.test.ts
git commit -m "feat(assets): add project temp-dir file upload service

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 7: 后端 /api/assets/files 路由 + 项目删除挂钩

**Files:**
- Modify: `lovdex-backend/server/modules/assets/assets.routes.ts`
- Modify: `lovdex-backend/server/modules/projects/services/project-delete.service.ts`

- [ ] **Step 1: assets.routes.ts 加 import**

顶部 import 区加：

```ts
import { projectsDb } from '@/modules/database/index.js';
import {
  buildStoredFileRecords,
  ensureProjectTempDir,
} from '@/modules/assets/services/file-assets.service.js';
```

- [ ] **Step 2: 新增 multer 实例 + /files 端点**

在文件末尾（`router.get('/images/:filename', ...)` 之后）追加：

```ts
/**
 * Chat 附件（分析文件/日志）：任意 MIME，≤50MB，最多 5 个。
 * 存到 <projectPath>/.lovdex-tmp/，绝对路径随响应返回；不提供 HTTP 回读，
 * 由代理 CLI 直接读磁盘。projectId 经查询串传入（multipart 里放字段会与
 * multer 的字段/文件处理顺序耦合，查询串更稳）。
 */
const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = (req as { projectTmpDir?: string }).projectTmpDir;
    if (dir) {
      cb(null, dir);
    } else {
      cb(new Error('projectTmpDir not resolved'));
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  },
});

const fileUpload = multer({
  storage: fileStorage,
  fileFilter: (req, file, cb) => cb(null, true),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 5,
  },
});

router.post('/files', async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    return res.status(400).json({ error: 'Missing projectId query parameter' });
  }

  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    return res.status(400).json({ error: 'Unknown projectId' });
  }

  try {
    (req as { projectTmpDir?: string }).projectTmpDir = await ensureProjectTempDir(projectPath);
  } catch (error) {
    console.error('[assets] Failed to prepare project temp dir:', error);
    return res.status(500).json({ error: 'Failed to prepare upload directory' });
  }

  fileUpload.array('files', 5)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    res.json({ files: buildStoredFileRecords(projectPath, files) });
  });
});
```

- [ ] **Step 3: project-delete 挂钩**

`project-delete.service.ts` 顶部 import 加：

```ts
import { removeProjectTempDir } from '@/modules/assets/services/file-assets.service.js';
```

`deleteOrArchiveProject` 的 force 分支里，在 `await deleteSessionJsonlFilesForProjectPath(row.project_path);` 后加：

```ts
  await removeProjectTempDir(row.project_path);
```

即：

```ts
  await deleteSessionJsonlFilesForProjectPath(row.project_path);
  await removeProjectTempDir(row.project_path);
  sessionsDb.deleteSessionsByProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
```

- [ ] **Step 4: typecheck + 服务测试回归**

Run: `cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsc --noEmit -p server/tsconfig.json`
Expected: 无新增类型错误。
Run: `cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/modules/assets/tests/file-assets.service.test.ts`
Expected: `# pass 3`。

- [ ] **Step 5: 手动冒烟（可选但推荐）**

后端 `TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx server/index.js` 起来后：

```bash
PROJECT_ID=$(sqlite3 <DB> "SELECT project_id FROM projects LIMIT 1")
echo "hello log line" > /tmp/hello.log
curl -s -H "Authorization: Bearer <token>" \
  -F "files=@/tmp/hello.log" \
  "http://localhost:<port>/api/assets/files?projectId=$PROJECT_ID"
```

Expected: 返回 `{ files: [{ name: 'hello.log', path: '.../.lovdex-tmp/...-hello.log', ... }] }`，且该目录内出现 `.gitignore`。

- [ ] **Step 6: Commit**

```bash
cd lovdex-backend
git add server/modules/assets/assets.routes.ts server/modules/assets/services/file-assets.service.ts server/modules/projects/services/project-delete.service.ts
git commit -m "feat(assets): add /api/assets/files upload to project temp dir, clean on delete

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 8: 前端 fileAttachments 纯函数 + 测试

**Files:**
- Create: `lovdex-cli/src/components/chat/utils/fileAttachments.ts`
- Test: `lovdex-cli/src/components/chat/utils/fileAttachments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lovdex-cli/src/components/chat/utils/fileAttachments.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE,
  buildAttachmentPrefix,
  validateFileUpload,
} from './fileAttachments';

test('validateFileUpload accepts any type within size limit', () => {
  assert.equal(validateFileUpload({ name: 'app.log', size: 1024, type: 'text/plain' }).ok, true);
  assert.equal(validateFileUpload({ name: 'cfg.yaml', size: 0, type: 'application/x-yaml' }).ok, true);
  assert.equal(validateFileUpload({ name: 'blob.bin', size: MAX_FILE_UPLOAD_SIZE, type: 'application/octet-stream' }).ok, true);
});

test('validateFileUpload rejects oversized files', () => {
  const result = validateFileUpload({ name: 'huge.log', size: MAX_FILE_UPLOAD_SIZE + 1, type: 'text/plain' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /50 MB/);
  }
});

test('buildAttachmentPrefix joins absolute paths as [附件: ...] lines', () => {
  const prefix = buildAttachmentPrefix([
    { path: '/a/1.log' },
    { path: '/b/2.yaml' },
  ]);
  assert.equal(prefix, '[附件: /a/1.log]\n[附件: /b/2.yaml]');
});

test('buildAttachmentPrefix returns empty for no files', () => {
  assert.equal(buildAttachmentPrefix([]), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/fileAttachments.test.ts`
Expected: FAIL with `Cannot find module './fileAttachments'`。

- [ ] **Step 3: Write minimal implementation**

```ts
// lovdex-cli/src/components/chat/utils/fileAttachments.ts
/** 单个上传文件大小上限（字节）：50MB。 */
export const MAX_FILE_UPLOAD_SIZE = 50 * 1024 * 1024;
/** 单次上传文件个数上限。 */
export const MAX_FILE_UPLOAD_COUNT = 5;

type UploadCandidate = {
  name: string;
  size?: number;
  type?: string;
};

/**
 * 校验一个待上传文件：任意类型，大小 ≤ 50MB。
 * 返回 `{ ok: true }` 或 `{ ok: false, error }`（错误文案复用图片上传的硬编码风格）。
 */
export function validateFileUpload(candidate: UploadCandidate): { ok: true } | { ok: false; error: string } {
  if (!candidate.size || candidate.size > MAX_FILE_UPLOAD_SIZE) {
    return { ok: false, error: 'File too large (max 50MB)' };
  }
  return { ok: true };
}

/** 把上传记录拼成首条消息前缀：`[附件: <path>]` 每文件一行。无文件返回空串。 */
export function buildAttachmentPrefix(files: Array<{ path: string }>): string {
  if (files.length === 0) return '';
  return files.map((f) => `[附件: ${f.path}]`).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/fileAttachments.test.ts`
Expected: `# pass 4`, `# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli
git add src/components/chat/utils/fileAttachments.ts src/components/chat/utils/fileAttachments.test.ts
git commit -m "feat(chat): add file-upload validation and attachment-prefix helpers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 9: useChatComposerState 附件状态与上传

**Files:**
- Modify: `lovdex-cli/src/components/chat/hooks/useChatComposerState.ts`

- [ ] **Step 1: import 工具**

顶部 import 区（`escapeRegExp` 之后）加：

```ts
import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE,
  buildAttachmentPrefix,
  validateFileUpload,
} from '../utils/fileAttachments';
```

- [ ] **Step 2: 新增 state 与 handler**

在 `attachedImages` state（现 228-230 行）后加：

```ts
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
```

在 `handleImageFiles`（现 549-581 行）后加：

```ts
  const handleFileFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      const result = validateFileUpload(file);
      if (!result.ok) {
        setFileErrors((previous) => {
          const next = new Map(previous);
          next.set(file.name || 'Unknown file', result.error);
          return next;
        });
        return false;
      }
      return true;
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_FILE_UPLOAD_COUNT));
    }
  }, []);
```

在 `handlePaste`（现 583-606 行）里，把仅处理图片的分流改为「图片走 handleImageFiles、其余走 handleFileFiles」：

```ts
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        const file = item.getAsFile();
        if (!file) return;
        if (item.type.startsWith('image/')) {
          handleImageFiles([file]);
        } else {
          handleFileFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));
        if (imageFiles.length > 0) handleImageFiles(imageFiles);
        if (otherFiles.length > 0) handleFileFiles(otherFiles);
      }
    },
    [handleFileFiles, handleImageFiles],
  );
```

- [ ] **Step 3: 拆分 dropzone（图片选择器 / 全类型拖拽+附件）**

把现有 `useDropzone`（现 608-617 行）替换为两个 dropzone：

```ts
  const handleDroppedFiles = useCallback(
    (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith('image/'));
      const otherFiles = files.filter((file) => !file.type.startsWith('image/'));
      if (imageFiles.length > 0) handleImageFiles(imageFiles);
      if (otherFiles.length > 0) handleFileFiles(otherFiles);
    },
    [handleFileFiles, handleImageFiles],
  );

  // 全类型 dropzone：负责拖拽遮罩 + 附件（回形针）选择器。
  // 注意：不设 maxSize —— 让超大文件落到 handleFileFiles 的 validateFileUpload，
  // 在 chip 上显示「File too large (max 50MB)」而不是被 dropzone 静默丢弃。
  const allFilesDropzone = useDropzone({
    maxFiles: MAX_FILE_UPLOAD_COUNT,
    onDrop: handleDroppedFiles,
    noClick: true,
    noKeyboard: true,
  });

  // 图片专用 dropzone：仅用于图片按钮的选择器（保持图片上传只收图片）。
  const imagePickerDropzone = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    },
    maxSize: 5 * 1024 * 1024,
    maxFiles: 5,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  const { getRootProps, getInputProps, isDragActive } = allFilesDropzone;
  const openFilePicker = allFilesDropzone.open;
  const openImagePicker = imagePickerDropzone.open;
```

- [ ] **Step 4: handleSubmit 上传文件 + 拼前缀**

在 handleSubmit 里 `const messageContent = currentInput;`（现 802 行）附近，把文件上传放在图片上传块之后、构造 `userMessage` 之前：

在图片上传块（`if (attachedImages.length > 0) { ... }`，现 805-834 行）之后加：

```ts
      let finalContent = messageContent;
      if (attachedFiles.length > 0) {
        const formData = new FormData();
        attachedFiles.forEach((file) => {
          formData.append('files', file);
        });

        try {
          const projectId = selectedProject?.projectId ?? '';
          const response = await authenticatedFetch(
            `/api/assets/files?projectId=${encodeURIComponent(projectId)}`,
            {
              method: 'POST',
              headers: {},
              body: formData,
            },
          );

          if (!response.ok) {
            throw new Error('Failed to upload files');
          }

          const result = await response.json();
          const uploadedFiles = Array.isArray(result.files) ? result.files : [];
          const prefix = buildAttachmentPrefix(uploadedFiles);
          finalContent = prefix ? `${prefix}\n\n${messageContent}` : messageContent;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }
```

然后 `const userMessage: ChatMessage = { ... }`（现 885-890 行）的 `content` 改为 `finalContent`，`chat.send`（现 908-916 行）的 `content: finalContent`。

提交成功后的清理（现 921-923 行 `setAttachedImages([])` 附近）加：

```ts
      setAttachedFiles([]);
      setFileErrors(new Map());
```

- [ ] **Step 5: 更新返回对象**

`return` 对象（现 1260-1317 行）里，`attachedImages` 相关项附近加：

```ts
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    openFilePicker,
```

- [ ] **Step 6: typecheck + 纯函数测试**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`
Expected: 无新增类型错误。
Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/fileAttachments.test.ts`
Expected: `# pass 4`。

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli
git add src/components/chat/hooks/useChatComposerState.ts src/components/chat/utils/fileAttachments.ts
git commit -m "feat(chat): upload files and prepend [附件: path] to first message

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 10: ChatComposer 附件 UI + ChatInterface 接线

**Files:**
- Create: `lovdex-cli/src/components/chat/view/subcomponents/FileAttachment.tsx`
- Modify: `lovdex-cli/src/components/chat/view/subcomponents/ChatComposer.tsx`
- Modify: `lovdex-cli/src/components/chat/view/ChatInterface.tsx`

- [ ] **Step 1: 新建 FileAttachment chip**

```tsx
// lovdex-cli/src/components/chat/view/subcomponents/FileAttachment.tsx
import { FileIcon } from 'lucide-react';

interface FileAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

const formatSize = (bytes: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const FileAttachment = ({ file, onRemove, uploadProgress, error }: FileAttachmentProps) => (
  <div className="group relative flex h-20 w-24 flex-col items-center justify-center rounded-xl border border-border/50 bg-card shadow-sm">
    <FileIcon className="h-6 w-6 text-primary" />
    <span className="mt-1 max-w-full truncate px-1 text-[11px] text-muted-foreground" title={file.name}>
      {file.name}
    </span>
    <span className="text-[10px] text-muted-foreground/70">{formatSize(file.size)}</span>
    {uploadProgress !== undefined && uploadProgress < 100 && (
      <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
        <div className="text-xs text-white">{uploadProgress}%</div>
      </div>
    )}
    {error && (
      <div
        className="absolute inset-0 flex items-center justify-center rounded-xl bg-red-500/60 p-1 text-center text-[10px] leading-tight text-white"
        title={error}
      >
        {error}
      </div>
    )}
    <button
      type="button"
      onClick={onRemove}
      className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
      aria-label={`Remove ${file.name}`}
    >
      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
);

export default FileAttachment;
```

- [ ] **Step 2: ChatComposer import + props**

`ChatComposer.tsx` 顶部 lucide import（现 14 行）加 `Paperclip`：

```ts
import { ImageIcon, MessageSquareIcon, XIcon, Loader2, ChevronDown, Check, ArrowUpIcon, Cpu, Paperclip } from 'lucide-react';
```

import FileAttachment：

```ts
import FileAttachment from './FileAttachment';
```

`ChatComposerProps` 里 `imageErrors` 附近加：

```ts
  attachedFiles: File[];
  onRemoveFile: (index: number) => void;
  fileErrors: Map<string, string>;
  openFilePicker: () => void;
```

函数解构里对应加：

```ts
  attachedFiles,
  onRemoveFile,
  fileErrors,
  openFilePicker,
```

- [ ] **Step 3: ChatComposer 渲染附件 chips 与按钮**

附件 chips：在 `attachedImages.length > 0` 的 `PromptInputHeader` 块（现 385-401 行）之后加：

```tsx
          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <FileAttachment
                      key={`${file.name}-${index}`}
                      file={file}
                      onRemove={() => onRemoveFile(index)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}
```

拖拽遮罩文案（现 380 行）`Drop images here` 改为 `Drop files here`。

附件按钮：在图片按钮（现 430-435 行）后面加：

```tsx
            <PromptInputButton
              tooltip={{ content: t('input.attachFiles') }}
              onClick={openFilePicker}
            >
              <Paperclip className="h-4 w-4" />
            </PromptInputButton>
```

- [ ] **Step 4: ChatInterface 接线**

`useChatComposerState` 解构（现 180-187 行）加：

```ts
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    openFilePicker,
```

`<ChatComposer` 传参（现 522-529 行附近）加：

```tsx
          attachedFiles={attachedFiles}
          onRemoveFile={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          openFilePicker={openFilePicker}
```

- [ ] **Step 5: typecheck + 纯函数测试**

Run: `cd lovdex-cli && npx tsc --noEmit -p tsconfig.json`
Expected: 无新增类型错误。
Run: `cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/fileAttachments.test.ts`
Expected: `# pass 4`。

- [ ] **Step 6: 手动冒烟（可选但推荐）**

起前端 + 后端：拖一个 `.log` 进输入框 → 出现文件 chip → 输入「分析这个日志」发送 → 首条用户消息显示 `[附件: /abs/path/xxx.log]`；代理会话里能看到该文件。

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli
git add src/components/chat/view/subcomponents/FileAttachment.tsx src/components/chat/view/subcomponents/ChatComposer.tsx src/components/chat/view/ChatInterface.tsx src/i18n/locales/en/chat.json
git commit -m "feat(chat): file attachment chips and picker in composer

Co-Authored-By: Claude <noreply@anthropic.com>"
```

（注：`input.attachFiles` 键已在 `chat.json` 存在，无需新增；无 zh locale。）

---

# Final Verification

- [ ] 前端全量测试：`cd lovdex-cli && env -u TSX_TSCONFIG_PATH npx tsx --test src/` → 全绿
- [ ] 前端 typecheck：`cd lovdex-cli && npx tsc --noEmit -p tsconfig.json` → 无新增错误
- [ ] 后端全量测试：`cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsx --test server/` → 全绿
- [ ] 后端 typecheck：`cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npx tsc --noEmit -p server/tsconfig.json` → 无新增错误
- [ ] 两个仓库各自 `git status` 干净、提交完整
