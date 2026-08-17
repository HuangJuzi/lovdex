# 任务详情页「执行结果」区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任务详情页加一个只读「执行结果」卡片，渲染关联会话最后一条 assistant 文本结论，免去点进会话查看。

**Architecture:** Phase 1 纯前端只读。新增纯函数 `pickLastAssistantText` 从消息列表取最后一条 assistant 文本；新增展示组件 `TaskResultPanel`（受控 props）；在 `TaskDetail` 里通过现成 `api.unifiedSessionMessages` 拉取关联会话消息，订阅 `task_upserted` WS 事件在状态进入 `in_progress`/`in_review`/`done` 时刷新。不改后端、不改表结构。

**Tech Stack:** React + TypeScript, Vite, Tailwind。测试：`npx tsx --test <file>`（`node:test` + `node:assert/strict`；组件用 `react-dom/server` `renderToStaticMarkup` 冒烟）。无 `test` script。复用 `MarkdownContent`（`src/components/chat/tools/components/ContentRenderers/MarkdownContent.tsx`）渲染 markdown。

**Spec:** `docs/task-result-detail-design.md`

---

## File Structure

| 文件 | 职责 |
|---|---|
| `lovdex-cli/src/components/tasks/taskResult.ts`（新建） | 纯函数 `pickLastAssistantText(messages)` + 类型 `AssistantTextMessage` / `TaskResultState` |
| `lovdex-cli/src/components/tasks/taskResult.test.ts`（新建） | 纯函数单测 |
| `lovdex-cli/src/components/tasks/TaskResultPanel.tsx`（新建） | 受控展示组件：根据 state 渲染 idle/loading/empty/error/ready(markdown) |
| `lovdex-cli/src/components/tasks/TaskResultPanel.test.tsx`（新建） | 展示组件冒烟测试（非 ready 状态；ready 走 markdown 由 typecheck+手动验证） |
| `lovdex-cli/src/components/tasks/TaskDetail.tsx`（修改） | 接线：拉取、WS 订阅刷新、刷新按钮、卡片插入网格下方 |
| `lovdex-cli/src/components/tasks/index.ts`（修改） | 导出 `TaskResultPanel`（保持现有出口风格） |

---

## Task 1: 纯函数 `pickLastAssistantText`

**Files:**
- Create: `lovdex-cli/src/components/tasks/taskResult.ts`
- Test: `lovdex-cli/src/components/tasks/taskResult.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lovdex-cli/src/components/tasks/taskResult.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLastAssistantText } from './taskResult';

test('returns null for an empty message list', () => {
  assert.equal(pickLastAssistantText([]), null);
});

test('returns the content of the last assistant text message', () => {
  const messages = [
    { kind: 'text', role: 'user', content: 'do the thing' },
    { kind: 'text', role: 'assistant', content: 'done' },
  ];
  assert.equal(pickLastAssistantText(messages), 'done');
});

test('picks the LAST assistant text when several exist', () => {
  const messages = [
    { kind: 'text', role: 'assistant', content: 'first attempt' },
    { kind: 'text', role: 'assistant', content: 'final conclusion' },
  ];
  assert.equal(pickLastAssistantText(messages), 'final conclusion');
});

test('skips user text messages', () => {
  const messages = [{ kind: 'text', role: 'user', content: 'only user' }];
  assert.equal(pickLastAssistantText(messages), null);
});

test('skips non-text kinds (tool_use, thinking, etc.)', () => {
  const messages = [
    { kind: 'tool_use', role: 'assistant', content: 'ran a tool' },
    { kind: 'thinking', role: 'assistant', content: 'pondering' },
  ];
  assert.equal(pickLastAssistantText(messages), null);
});

test('skips assistant text with empty or whitespace-only content', () => {
  const messages = [
    { kind: 'text', role: 'assistant', content: '   ' },
    { kind: 'text', role: 'assistant', content: '' },
  ];
  assert.equal(pickLastAssistantText(messages), null);
});

test('trims surrounding whitespace from the returned content', () => {
  const messages = [{ kind: 'text', role: 'assistant', content: '  hello  ' }];
  assert.equal(pickLastAssistantText(messages), 'hello');
});

test('returns null when the only assistant text is blank but a later non-text exists', () => {
  const messages = [
    { kind: 'text', role: 'assistant', content: '' },
    { kind: 'tool_result', role: 'assistant', content: 'tool output' },
  ];
  assert.equal(pickLastAssistantText(messages), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/taskResult.test.ts`
Expected: FAIL — `Cannot find module './taskResult'` (or similar resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `lovdex-cli/src/components/tasks/taskResult.ts`:

```ts
// Minimal message shape consumed by pickLastAssistantText. Kept structural so the
// pure function does not need to import the heavier NormalizedMessage type (which
// pulls in workflow/provider types). The real fetch payload satisfies this shape.
export interface AssistantTextMessage {
  kind: string;
  role?: string;
  content?: string;
}

export type TaskResultState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/**
 * Returns the trimmed content of the LAST assistant `text` message in the list,
 * or null if there is none with non-blank content. Used by the task detail page
 * to surface the agent's conclusion without opening the conversation.
 */
export function pickLastAssistantText(messages: readonly AssistantTextMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind !== 'text' || m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (text) return text;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/taskResult.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd lovdex-cli
git add src/components/tasks/taskResult.ts src/components/tasks/taskResult.test.ts
git commit -m "feat(tasks): add pickLastAssistantText pure helper for task result"
```

---

## Task 2: 展示组件 `TaskResultPanel`

**Files:**
- Create: `lovdex-cli/src/components/tasks/TaskResultPanel.tsx`
- Test: `lovdex-cli/src/components/tasks/TaskResultPanel.test.tsx`
- Modify: `lovdex-cli/src/components/tasks/index.ts`

- [ ] **Step 1: Write the failing test**

Create `lovdex-cli/src/components/tasks/TaskResultPanel.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskResultPanel } from './TaskResultPanel';

// MarkdownContent (used by the 'ready' state) pulls ThemeContext/i18n providers
// and cannot be SSR'd in isolation, so the ready state is verified by typecheck
// + manual run. These tests cover the non-markdown branches.

test('idle state renders the "not started" hint and no refresh button', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'idle', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /尚未开始执行/);
  assert.doesNotMatch(html, /刷新/);
});

test('loading state renders the loading hint', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'loading', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /加载中/);
});

test('empty state renders the "no conclusion yet" hint and a refresh button', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'empty', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /agent 还没产出结论/);
  assert.match(html, /刷新/);
});

test('error state renders the error hint and a retry button', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'error', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /加载结果失败/);
  assert.match(html, /重试/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/TaskResultPanel.test.tsx`
Expected: FAIL — `Cannot find module './TaskResultPanel'`.

- [ ] **Step 3: Write minimal implementation**

Create `lovdex-cli/src/components/tasks/TaskResultPanel.tsx`:

```tsx
import { MarkdownContent } from '../chat/tools/components/ContentRenderers/MarkdownContent';
import type { TaskResultState } from './taskResult';

interface TaskResultPanelProps {
  state: TaskResultState;
  content: string;
  onRefresh: () => void;
}

/**
 * Read-only "执行结果" card for the task detail page. The parent owns the
 * fetch state machine and passes it down; this component only renders.
 */
export function TaskResultPanel({ state, content, onRefresh }: TaskResultPanelProps) {
  const showRefresh = state === 'ready' || state === 'empty';
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs uppercase tracking-wide text-muted-foreground">执行结果</h4>
        {showRefresh && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
          >
            刷新
          </button>
        )}
      </div>
      {state === 'idle' && (
        <div className="text-sm text-muted-foreground">尚未开始执行</div>
      )}
      {state === 'loading' && (
        <div className="text-sm text-muted-foreground">加载中…</div>
      )}
      {state === 'empty' && (
        <div className="text-sm text-muted-foreground">agent 还没产出结论</div>
      )}
      {state === 'error' && (
        <div className="flex items-center gap-3">
          <div className="text-sm text-red-500">加载结果失败</div>
          <button
            className="rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500 hover:bg-red-500/20"
            onClick={onRefresh}
          >
            重试
          </button>
        </div>
      )}
      {state === 'ready' && content && <MarkdownContent content={content} />}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/TaskResultPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the barrel**

Modify `lovdex-cli/src/components/tasks/index.ts` — add the export. Read the file first; it currently exports `TaskBoard`, `TaskCard`, `TaskDetailPage` (and possibly `ViewSwitcher`). Append:

```ts
export { TaskResultPanel } from './TaskResultPanel';
```

- [ ] **Step 6: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli
git add src/components/tasks/TaskResultPanel.tsx src/components/tasks/TaskResultPanel.test.tsx src/components/tasks/index.ts
git commit -m "feat(tasks): add TaskResultPanel presentational component"
```

---

## Task 3: 在 `TaskDetail` 接线（拉取 + WS 刷新 + 卡片）

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: Add imports and state**

In `lovdex-cli/src/components/tasks/TaskDetail.tsx`:

Change line 15 from `const { sendMessage } = useWebSocket();` to:

```ts
  const { sendMessage, subscribe } = useWebSocket();
```

Add to the existing type import on line 6 (`import type { Task, TaskStatus } from '../../types/app';`):

```ts
import type { Task, TaskStatus, TaskUpsertedEvent } from '../../types/app';
```

Add new imports after the existing `taskExecution` import (line 8):

```ts
import { TaskResultPanel } from './TaskResultPanel';
import { pickLastAssistantText } from './taskResult';
import type { TaskResultState } from './taskResult';
```

After the existing state declarations (after line 21 `const savingRef = useRef(false);`), add:

```ts
  const [resultState, setResultState] = useState<TaskResultState>('idle');
  const [resultContent, setResultContent] = useState('');
  const resultSeq = useRef(0);
```

- [ ] **Step 2: Add the `loadResult` callback**

After the existing `load` callback (after line 44, the closing `}, [taskId]);` of `load`), add:

```ts
  const loadResult = useCallback(async (sessionId: string) => {
    const seq = ++resultSeq.current;
    setResultState('loading');
    try {
      const res = await api.unifiedSessionMessages(sessionId, 'claude', {});
      if (seq !== resultSeq.current) return;
      if (!res.ok) {
        setResultState('error');
        return;
      }
      const body = (await res.json()) as { data?: { messages?: unknown[] } } | { messages?: unknown[] };
      const messages = Array.isArray((body as { data?: { messages?: unknown[] } })?.data?.messages)
        ? (body as { data: { messages: unknown[] } }).data.messages
        : Array.isArray((body as { messages?: unknown[] }).messages)
          ? (body as { messages: unknown[] }).messages
          : [];
      const text = pickLastAssistantText(messages as { kind: string; role?: string; content?: string }[]);
      if (text) {
        setResultContent(text);
        setResultState('ready');
      } else {
        setResultContent('');
        setResultState('empty');
      }
    } catch (err) {
      console.error('load task result failed', err);
      if (seq === resultSeq.current) setResultState('error');
    }
  }, []);
```

- [ ] **Step 3: Add effects for initial load and WS refresh**

After the existing `useEffect(() => { void load(); }, [load]);` (line 46-48), add:

```ts
  // Fetch the result whenever the linked session changes.
  useEffect(() => {
    if (!task?.session_id) {
      setResultState('idle');
      setResultContent('');
      return;
    }
    void loadResult(task.session_id);
  }, [task?.session_id, loadResult]);

  // Live-refresh the result when the engine advances this task's session
  // (running → in_progress, completed → in_review). We deliberately do NOT
  // setTask here, to avoid clobbering in-flight title/description edits.
  useEffect(() => {
    if (!subscribe || !taskId) return;
    return subscribe((event) => {
      if (event.kind !== 'task_upserted') return;
      const upserted = event as unknown as TaskUpsertedEvent;
      if (!upserted.task || upserted.task.task_id !== taskId) return;
      const sid = upserted.task.session_id;
      if (!sid) return;
      if (upserted.task.status === 'in_progress' || upserted.task.status === 'in_review' || upserted.task.status === 'done') {
        void loadResult(sid);
      }
    });
  }, [subscribe, taskId, loadResult]);
```

- [ ] **Step 4: Insert the panel into the layout**

The grid closes at the `</div>` on line 280 (the `mt-6 grid grid-cols-1 ...` block). Immediately after that closing `</div>` (and before the `</div>` that closes `mx-auto max-w-3xl` on line 281), insert:

```tsx
          <TaskResultPanel
            state={resultState}
            content={resultContent}
            onRefresh={() => {
              if (task?.session_id) void loadResult(task.session_id);
            }}
          />
```

- [ ] **Step 5: Typecheck**

Run: `cd lovdex-cli && npm run typecheck`
Expected: PASS. If `subscribe` is reported unused by lint later, it is used in the effect — confirm no `@typescript-eslint/no-unused-vars` error.

- [ ] **Step 6: Lint**

Run: `cd lovdex-cli && npm run lint`
Expected: PASS (no new errors). Fix any boundary/unused-import findings inline.

- [ ] **Step 7: Commit**

```bash
cd lovdex-cli
git add src/components/tasks/TaskDetail.tsx
git commit -m "feat(tasks): show agent conclusion on task detail page"
```

---

## Task 4: 手动验证 + 收尾

**Files:** none

- [ ] **Step 1: Run the app**

Run: `cd lovdex-cli && npm run dev` (and the backend per its README). Open a task that has a linked, completed session.

- [ ] **Step 2: Verify acceptance criteria**

Confirm against `docs/task-result-detail-design.md` §6:
- 任务有 session_id 且会话有 assistant 文本 → 详情页底部「执行结果」卡片显示结论（markdown 渲染）。
- 无 session_id（未开始）→ 显示「尚未开始执行」，不发请求（Network 面板确认）。
- 有 session_id 但无 assistant 文本 → 显示「agent 还没产出结论」。
- 从看板点开始执行，会话跑完进入评审中 → 详情页结论自动刷新（WS 触发，无需手动刷新）。
- 「刷新」按钮可手动重拉。
- 断网/会话已删 → 显示「加载结果失败」+ 重试，详情页其余部分不崩。

- [ ] **Step 3: Final full test run**

Run: `cd lovdex-cli && npx tsx --test src/components/tasks/taskResult.test.ts src/components/tasks/TaskResultPanel.test.tsx`
Expected: PASS (12 tests).

- [ ] **Step 4: Commit any verification fixes (if any)**

Only if Step 2 surfaced bugs. Otherwise skip.

```bash
cd lovdex-cli
git add -A
git commit -m "fix(tasks): result panel verification fixes"
```

---

## Self-Review Notes

- **Spec coverage**: §2.2 数据来源 → Task 3 `loadResult` + Task 1 picker. §2.3 触发时机 → Task 3 两个 effect + 刷新按钮. §2.4 布局 → Task 3 Step 4 全宽卡片插网格下方. §2.4 空态 → Task 2 各分支. §4 不做 → 未引入后端/表/编辑改动，符合. §6 验收 → Task 4.
- **Type consistency**: `TaskResultState` 定义于 `taskResult.ts`，`TaskResultPanel` 与 `TaskDetail` 均从此导入；`pickLastAssistantText` 签名 `(readonly AssistantTextMessage[]) => string | null`，调用处用结构兼容的 `{kind,role?,content?}[]` 转入。
- **已知限制（已记录）**：`TaskResultPanel` 的 `ready` 状态走 `MarkdownContent`，因依赖 ThemeContext/i18n 无法在 `renderToStaticMarkup` 冒烟，由 typecheck + Task 4 手动验证覆盖。纯函数 `pickLastAssistantText` 已完整单测。
