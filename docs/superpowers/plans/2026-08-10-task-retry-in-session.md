# 任务「重试」改为在现有会话内续跑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务详情页/看板的「重试」按钮不再新建会话，而是向任务已关联的 session 发 `chat.send`（内容「上次执行中断/出错了，请重试继续完成」），让 agent 带上下文续跑。

**Architecture:** 纯前端改动。`taskExecution.ts` 把 `buildTaskChatSend` 参数化（第三个参数 `content`，缺省仍为任务提示词），新增 `TASK_RETRY_MESSAGE` 常量；`TaskDetail.tsx` 新增 `retryTask()`（有 session → 发重试消息，否则回退 `startExecution()`）；`TaskBoard.tsx` 的 `onStart` 加 `failed && session_id` 分支走重试消息。后端 `chat.send` 对已有 `provider_session_id` 的会话已走 `resume: true`，零后端改动。

**Tech Stack:** React + Vite + TS（前端），node:test + tsx（测试）。

---

## 文件总览（仅前端 `lovdex-cli/`）

| 文件 | 改动 |
|---|---|
| `src/components/tasks/taskExecution.ts` | 导出 `TASK_RETRY_MESSAGE`；`buildTaskChatSend(sessionId, task, content?)` |
| `src/components/tasks/taskExecution.test.ts` | 加 `buildTaskChatSend` content 参数化 + `TASK_RETRY_MESSAGE` 用例 |
| `src/components/tasks/TaskDetail.tsx` | 新增 `retryTask()`；重试按钮改调它 |
| `src/components/tasks/TaskBoard.tsx` | 新增 `runTask()` 分支；卡片 `onStart` 改调它 |

**注意**：两个仓库的 `main` 上都有无关的未提交改动（cli：`src/components/chat/hooks/*.ts`、`src/stores/useSessionStore.ts`）。提交时只 `git add` 本计划涉及的文件，绝不动那些未提交文件。

---

## Task 1: `taskExecution.ts` 参数化 + `TASK_RETRY_MESSAGE`（TDD）

**Files:**
- Modify: `lovdex-cli/src/components/tasks/taskExecution.ts`
- Test: `lovdex-cli/src/components/tasks/taskExecution.test.ts`

- [ ] **Step 1: 写失败测试**

把 `lovdex-cli/src/components/tasks/taskExecution.test.ts` 整体替换为：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';
import { TASK_RETRY_MESSAGE, buildTaskChatSend, taskPromptOf } from './taskExecution';

// A minimal Task fixture — only fields buildTaskChatSend reads matter
// (executor_provider, executor_model, title, description).
const task = {
  task_id: 't1',
  project_path: '/p',
  title: '修登录',
  description: '把登录页 500 报错修好',
  status: 'in_progress',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: 's1',
  started_at: null,
  completed_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as Task;

test('taskPromptOf sends the description (the execution content) when present', () => {
  assert.equal(taskPromptOf({ title: '修登录', description: '把登录页 500 报错修好' }), '把登录页 500 报错修好');
});

test('taskPromptOf falls back to the title for older tasks with no description', () => {
  assert.equal(taskPromptOf({ title: '修登录', description: null }), '修登录');
  assert.equal(taskPromptOf({ title: '修登录', description: '' }), '修登录');
  assert.equal(taskPromptOf({ title: '修登录', description: '   ' }), '修登录');
});

test('taskPromptOf trims the description', () => {
  assert.equal(taskPromptOf({ title: 't', description: '  do the thing  ' }), 'do the thing');
});

test('buildTaskChatSend defaults content to the task prompt', () => {
  const frame = buildTaskChatSend('s1', task);
  assert.equal(frame.type, 'chat.send');
  assert.equal(frame.sessionId, 's1');
  assert.equal(frame.content, '把登录页 500 报错修好');
});

test('buildTaskChatSend sends TASK_RETRY_MESSAGE when provided as content', () => {
  const frame = buildTaskChatSend('s1', task, TASK_RETRY_MESSAGE);
  assert.equal(frame.sessionId, 's1');
  assert.equal(frame.content, '上次执行中断/出错了，请重试继续完成');
  assert.equal(frame.options.sessionSummary, task.title);
});

test('buildTaskChatSend passes through an arbitrary custom content', () => {
  const frame = buildTaskChatSend('s1', task, '继续完成');
  assert.equal(frame.content, '继续完成');
});

test('TASK_RETRY_MESSAGE is non-empty and mentions retrying', () => {
  assert.ok(TASK_RETRY_MESSAGE.length > 0);
  assert.match(TASK_RETRY_MESSAGE, /重试/);
});
```

- [ ] **Step 2: 运行测试，确认失败（red）**

Run（在 `lovdex-cli/`）：
```bash
npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskExecution.test.ts 2>&1 | tail -8
```
Expected：`buildTaskChatSend` 相关用例失败（`TASK_RETRY_MESSAGE` 未导出 / `buildTaskChatSend` 不接第三个参数 / content 不是重试文案）；`taskPromptOf` 3 个用例仍过。

- [ ] **Step 3: 实现 `taskExecution.ts`**

把 `lovdex-cli/src/components/tasks/taskExecution.ts` 中 `buildTaskChatSend` 的注释与函数体替换为：

```ts
/**
 * The message sent into an existing session when the user hits "重试" on a
 * failed task. Deliberately does NOT re-send the task prompt — the session
 * transcript already carries it and the prior attempt; the agent resumes with
 * that context. Wording covers both "interrupted without an error in the
 * transcript" (crash/kill/restart) and "errored with the error recorded".
 */
export const TASK_RETRY_MESSAGE = '上次执行中断/出错了，请重试继续完成';

/**
 * Build the `chat.send` frame that runs a task on its linked session. Sent over
 * the board/detail's existing socket so execution begins in place — the run
 * streams and persists server-side exactly like an interactive chat, and can be
 * watched later by opening the session. Permission mode is the default (ask):
 * any prompt surfaces as the board's "等你批准" marker until the user opens the
 * session to decide.
 *
 * `content` defaults to the task's execution prompt (`taskPromptOf`). Retry
 * passes `TASK_RETRY_MESSAGE` instead so the agent continues the existing
 * conversation rather than restarting from scratch.
 */
export function buildTaskChatSend(sessionId: string, task: Task, content?: string): TaskChatSend {
  const toolsSettings = readToolsSettings(task.executor_provider);
  return {
    type: 'chat.send',
    sessionId,
    content: content ?? taskPromptOf(task),
    options: {
      model: task.executor_model || undefined,
      permissionMode: 'default',
      toolsSettings,
      skipPermissions: toolsSettings.skipPermissions ?? false,
      sessionSummary: task.title,
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过（green）**

Run（在 `lovdex-cli/`）：
```bash
npx tsx --tsconfig tsconfig.json --test src/components/tasks/taskExecution.test.ts 2>&1 | tail -8
```
Expected：`# pass 7`，`# fail 0`。

- [ ] **Step 5: typecheck + lint**

Run（在 `lovdex-cli/`）：
```bash
npm run typecheck && npx eslint src/components/tasks/taskExecution.ts src/components/tasks/taskExecution.test.ts
```
Expected：两者无输出，exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/components/tasks/taskExecution.ts src/components/tasks/taskExecution.test.ts
git commit -m "feat(tasks): retry a failed task inside its existing session

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: TaskDetail 重试按钮续跑

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: 更新 import**

把第 8 行 `import { buildTaskChatSend } from './taskExecution';` 改为：

```ts
import { buildTaskChatSend, TASK_RETRY_MESSAGE } from './taskExecution';
```

- [ ] **Step 2: 新增 `retryTask()`**

在 `startExecution` 函数定义（以 `async function startExecution() {` 开头、以 `  }` 结束，位于文件约 226-253 行）之后加：

```ts
  /**
   * Retry a failed task in its existing session: send the retry message over
   * the socket so the agent resumes with the full conversation context, instead
   * of `startExecution` which would create a brand-new session and orphan the
   * old one. Defensive fallback to `startExecution` if the task somehow has no
   * session (the retry button only renders when `session_id` is set).
   */
  function retryTask() {
    if (!task) return;
    if (task.session_id) {
      sendMessage(buildTaskChatSend(task.session_id, task, TASK_RETRY_MESSAGE));
      return;
    }
    void startExecution();
  }
```

- [ ] **Step 3: 重试按钮改调 `retryTask()`**

把执行区的「↻ 重试」按钮（`task.failed && task.session_id` 分支内，位于文件约 456 行）的：

```tsx
                    onClick={() => void startExecution()}
```

改为：

```tsx
                    onClick={() => retryTask()}
```

「开始执行」按钮（无 session 分支，约 488 行）的 `onClick={() => void startExecution()}` **保持不动**。

- [ ] **Step 4: typecheck + lint**

Run（在 `lovdex-cli/`）：
```bash
npm run typecheck && npx eslint src/components/tasks/TaskDetail.tsx
```
Expected：两者无输出（若有既有 `react-hooks/exhaustive-deps` warning，warning 可接受，exit 0）。

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/TaskDetail.tsx
git commit -m "feat(tasks): retry a failed task inside its existing session

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: TaskBoard 卡片重试续跑

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 更新 import**

把第 29 行 `import { buildTaskChatSend } from './taskExecution';` 改为：

```ts
import { buildTaskChatSend, TASK_RETRY_MESSAGE } from './taskExecution';
```

- [ ] **Step 2: 新增 `runTask()` 分支**

在 `startExecution` 函数定义（以 `async function startExecution(task: Task) {` 开头、以 `  }` 结束，位于文件约 174-197 行）之后加：

```ts
  /**
   * Card "开始执行" / "重试" entry. A failed task with a linked session retries
   * in-place: send the retry message so the agent resumes with the existing
   * conversation context, instead of `startExecution` which would create a new
   * session and orphan the old one. Fresh runs (no session) keep the old path.
   */
  function runTask(task: Task) {
    if (task.failed && task.session_id) {
      sendMessage(buildTaskChatSend(task.session_id, task, TASK_RETRY_MESSAGE));
      return;
    }
    void startExecution(task);
  }
```

- [ ] **Step 3: 卡片 `onStart` 改调 `runTask`**

把第 330 行 `onStart={() => startExecution(task)}` 改为：

```tsx
                    onStart={() => runTask(task)}
```

- [ ] **Step 4: typecheck + lint**

Run（在 `lovdex-cli/`）：
```bash
npm run typecheck && npx eslint src/components/tasks/TaskBoard.tsx
```
Expected：两者无输出，exit 0。

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): retry a failed task inside its existing session

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 端到端手工验证

**Files:** 无（验证只读）

- [ ] **Step 1: 重启前端**

后端无改动，只需确认 vite 已热更新前端改动；若不确定可 `systemctl --user restart lovdex` 后 `sleep 3`、`systemctl --user status lovdex --no-pager | head -4`，确认 `Active: active (running)`。

- [ ] **Step 2: 制造 failed 任务**

打开 `http://localhost:5187` → 任务面板 → 新建一个 backlog 任务（选一个真实项目）→ 点「开始执行」，等它跑起来。要看到「重试」按钮需任务处于 `failed` 状态：中断后端进程、或让任务自然失败。

- [ ] **Step 3: 点重试，验证续跑**

在 TaskDetail 点「↻ 重试」：确认**没有**新建会话（侧栏会话数不变），且该会话 transcript 里出现一条「上次执行中断/出错了，请重试继续完成」用户消息，agent 继续产出。failed 徽章清除、任务回到进行中。

- [ ] **Step 4: 看板卡片重试**

回到任务面板，对同一 failed 任务点卡片上的「↻ 重试」：同样续跑，无新会话。

- [ ] **Step 5: 回归**

确认无 session 任务的「开始执行」仍走新建会话路径；改项目、改状态、删除任务等不受影响。

---

## Self-Review 记录

- **Spec 覆盖**：§2.1 消息内容 → Task 1；§2.2 交互（详情页+看板）→ Task 2/3；§3.1 文件清单 → 全部；§3.2 数据流 → 无需后端改动（Task 1-3 前端即可）；§3.3 错误处理（无 session 回退）→ Task 2 `retryTask` 防御分支 + Task 3 `runTask`；§5 测试 → Task 1 单元测试 + Task 4 E2E。无缺口。
- **占位符扫描**：无 TBD/TODO；每步含完整代码与命令。
- **类型一致性**：`TASK_RETRY_MESSAGE` 在 taskExecution.ts 导出、test import、TaskDetail/TaskBoard import 三处一致；`buildTaskChatSend(sessionId, task, content?)` 签名在 test 与两处调用一致；`runTask(task)` / `retryTask()` 命名一致。
