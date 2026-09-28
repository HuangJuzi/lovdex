# 任务页缩略面板与内联待办 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击任务卡片不再跳到全页详情，改为就地展开右侧缩略面板；面板内可直接快速回复、就地回答权限提示；电脑端默认表格视图。

**Architecture:** 面板是任务页内的一个受控容器（桌面右栏 / 窄屏 sheet），不引入路由。待办不通过 `PermissionContext`（那个 Provider 只存在于 `ChatInterface` 子树内，任务页取不到），而是用一个**会话作用域的 socket 订阅钩子**：任务页借助顶层已有的 `WebSocketProvider` 自己发 `chat.subscribe`，从 `chat_subscribed` ack 与 `permission_request` 帧收待办，答复直接发 `chat.permission-response`。排序、倒计时、可回复性等判断抽成纯函数模块，因为本仓库前端**没有 jsdom**，只能测纯逻辑。

**Tech Stack:** React 18 + TypeScript + Tailwind + react-router-dom；测试用 Node 内置 `node:test` + `assert/strict`，组件断言用 `react-dom/server` 的 `renderToStaticMarkup`，命令 `npx tsx --test <file>`（web 无 vitest/jsdom，**不能做 DOM 交互测试**）。

**上游 spec:** `docs/superpowers/specs/2026-09-28-task-summary-panel-design.md`
**可交互预览:** `docs/preview/tasks-final.html`

---

## 环境准备（每个任务开始前）

```bash
cd /mnt/b/workdir/github/lovdex/web
unset TSX_TSCONFIG_PATH          # 全局导出的这个变量会破坏 web 侧的 tsx 运行
npx tsx --test src/components/tasks/<file>.test.ts
npx tsc --noEmit -p tsconfig.json # 基线：已知有 pre-existing 错误，只要求「零新增」
```

**基线说明：** `tsc` 与 `lint` 在本仓库**不是干净的**（历史遗留错误）。验收口径一律是**零新增**，不是全绿。执行每个任务时先记下当前错误数，任务后比对。

---

## 文件结构

**新建（纯函数模块 —— 全部可测，这是本计划的测试重心）**

| 文件 | 职责 |
|---|---|
| `web/src/components/tasks/panelPermission.ts` | 待办排序（超时优先）、超时时刻推算、可回复性判定、剩余秒数格式化 |
| `web/src/components/tasks/panelReply.ts` | 回复区状态派生（可用 / 排队 / 禁用 / 无会话）与文案 |

**新建（React）**

| 文件 | 职责 |
|---|---|
| `web/src/components/tasks/useSessionPendingRequests.ts` | 会话作用域的 socket 订阅钩子：`chat.subscribe` → 收 `pendingPermissions` / `permission_request` / `permission_cancelled`，暴露 `respond()` |
| `web/src/components/tasks/TaskSummaryPanel.tsx` | 面板容器：头部 / chip / 待办区 / 完成度 / 结果 / 属性 / 回复区 / 底部动作 |
| `web/src/components/tasks/PendingPromptCard.tsx` | 单条待办：按 `toolName` 分派（AskUserQuestion 选项 / 计划 / 通用授权）+ 倒计时 |
| `web/src/components/tasks/TaskPanelReplyBox.tsx` | 面板内回复区：常用语 chip + 输入框 + 发送 |

**修改**

| 文件 | 改动 |
|---|---|
| `web/src/components/tasks/TaskBoard.tsx` | `taskViewMode` 默认 `'table'`；持有所展开任务 id；右栏容器 + `.closed`；工具栏开关 |
| `web/src/components/tasks/TaskCard.tsx` | :54 的 `navigate()` 改为 `onOpenPanel` 回调 |
| `web/src/components/tasks/TaskDetail.tsx` | 等待横幅的引导语改为指向任务面板（Task 11） |

**刻意不做（YAGNI）**

- 不改后端（无新表、无新接口、无新帧）。
- 不新建测试框架（继续用 `node:test`）。
- 不复用 `useChatProviderState` / `useChatComposerState`（700 行、依赖会话与项目，牵一串），改用独立的轻量订阅钩子。
- 不重构 `PermissionRequestsBanner` 现有的 props 驱动结构。
- **不改 `TaskTableView.tsx`**：它的 `onOpenTask` 语义本就是「打开这条任务」，由调用方决定是导航还是展开面板。把「跳转 vs 展开」的选择留在 `TaskBoard.tsx` 一处，组件不必知道这个区别（Task 9 有说明）。

---

## Task 1: 待办排序与超时推算（纯函数）

**Files:**
- Create: `web/src/components/tasks/panelPermission.ts`
- Test: `web/src/components/tasks/panelPermission.test.ts`

**背景：** 两类提示的超时行为完全不同 —— `AskUserQuestion` / `ExitPlanMode` 是 `timeoutMs: 0`（永远等，见 `backend/server/claude-sdk.js:152`），其余工具默认 60000ms 后**自动拒绝**（`backend/server/config.ts:47`）。所以「会超时的排前面」，且倒计时只给会超时的。

**两处实现约束（写代码前先看）：**

1. 判据必须复用 `web/src/components/chat/utils/autoApproveDeny.ts` 的 `AUTO_APPROVE_INTERACTION_TOOLS`，**不要在本模块再抄一份工具名字面量**。那份声明自己是全前端唯一副本（「其余前端文件一律从这里 import，不要再写第二份字面量」），并且 `autoApproveDeny.test.ts` 有一条对账测试读后端 `auto-approve-policy.ts` 源码比对两边。第三个副本对那条守卫不可见 —— 后端将来加第三个交互型工具时这里会静默漂开。该文件自身零 import，不会形成循环依赖。
2. 工具名册里**不要**放 `'exit_plan_mode'`。这个拼写匹配不到任何真实工具（SDK 里叫 `ExitPlanMode`，见 `backend/server/claude-sdk.js:322-324`），后端 `TOOLS_REQUIRING_INTERACTION` 里也没有它，所以 `requiresInteraction` 为假 → `timeoutMs: undefined` → 60 秒后照常自动拒绝。把它当成交互类，等于向用户承诺一个不会发生的无限等待，方向是危险的。
3. 「永不超时」是 **claude provider** 的说法，不是全后端普遍事实：qoder 没有这条分支，`backend/server/qoder-runner.js:190` 对每一个审批都套 `QODER_APPROVAL_TIMEOUT_MS`。注释里要写清这一点。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/panelPermission.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PendingPermissionRequest } from '../chat/types/types';

import {
  NEVER_TIMES_OUT,
  isInteractiveTool,
  sortPendingRequests,
  timeoutAt,
  remainingSeconds,
  formatCountdown,
} from './panelPermission';

const req = (
  requestId: string,
  toolName: string,
  receivedAtMs: number,
): PendingPermissionRequest => ({
  requestId,
  toolName,
  receivedAt: new Date(receivedAtMs),
});

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

test('交互类工具永不超时', () => {
  assert.equal(isInteractiveTool('AskUserQuestion'), true);
  assert.equal(isInteractiveTool('ExitPlanMode'), true);
  // 'exit_plan_mode' 匹配不到任何真实工具（SDK 里叫 ExitPlanMode），后端照样给它
  // 正常超时 —— 当成交互类会承诺一个不会发生的无限等待。
  assert.equal(isInteractiveTool('exit_plan_mode'), false);
  assert.equal(isInteractiveTool('Bash'), false);
});

test('timeoutAt：交互类返回 NEVER_TIMES_OUT，普通工具是 receivedAt + 超时', () => {
  const ask = req('a', 'AskUserQuestion', NOW);
  const bash = req('b', 'Bash', NOW);

  assert.equal(timeoutAt(ask, TIMEOUT), NEVER_TIMES_OUT);
  assert.equal(timeoutAt(bash, TIMEOUT), NOW + TIMEOUT);
});

test('没有 receivedAt 时视为永不超时（宁可让它排在后面，也不要误报倒计时）', () => {
  const noStamp: PendingPermissionRequest = { requestId: 'c', toolName: 'Bash' };
  assert.equal(timeoutAt(noStamp, TIMEOUT), NEVER_TIMES_OUT);
});

test('无效日期（Invalid Date）也归为永不超时', () => {
  const bad: PendingPermissionRequest = {
    requestId: 'd',
    toolName: 'Bash',
    receivedAt: new Date(NaN),
  };
  assert.equal(timeoutAt(bad, TIMEOUT), NEVER_TIMES_OUT);
});

test('排序：会超时的排前面，且按超时时刻升序', () => {
  const list = [
    req('never', 'AskUserQuestion', NOW),
    req('late', 'Bash', NOW - 10_000),
    req('soon', 'Bash', NOW - 50_000),
  ];

  const sorted = sortPendingRequests(list, TIMEOUT);
  assert.deepEqual(sorted.map((r) => r.requestId), ['soon', 'late', 'never']);
});

test('排序是纯函数：不改动入参数组', () => {
  const list = [req('never', 'AskUserQuestion', NOW), req('soon', 'Bash', NOW)];
  const before = list.map((r) => r.requestId);
  sortPendingRequests(list, TIMEOUT);
  assert.deepEqual(list.map((r) => r.requestId), before);
});

test('两个永不超时的请求保持输入顺序（Infinity - Infinity 的比较结果按规范视为相等）', () => {
  const list = [req('first', 'AskUserQuestion', NOW), req('second', 'ExitPlanMode', NOW)];
  assert.deepEqual(sortPendingRequests(list, TIMEOUT).map((r) => r.requestId), ['first', 'second']);
});

test('remainingSeconds：向上取整，已过期夹到 0', () => {
  const bash = req('b', 'Bash', NOW);
  assert.equal(remainingSeconds(bash, NOW, TIMEOUT), 60);
  assert.equal(remainingSeconds(bash, NOW + 1_500, TIMEOUT), 59);
  assert.equal(remainingSeconds(bash, NOW + 120_000, TIMEOUT), 0);
});

test('remainingSeconds：永不超时返回 null', () => {
  const ask = req('a', 'AskUserQuestion', NOW);
  assert.equal(remainingSeconds(ask, NOW, TIMEOUT), null);
});

test('formatCountdown：25 秒以上保留「N 秒后自动拒绝」，不足 25 秒改紧迫文案', () => {
  assert.equal(formatCountdown(60), '60 秒后自动拒绝');
  assert.equal(formatCountdown(25), '25 秒后自动拒绝');
  assert.equal(formatCountdown(24), '即将自动拒绝（24 秒）');
  assert.equal(formatCountdown(0), '即将自动拒绝（0 秒）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/panelPermission.test.ts`
Expected: FAIL —— `Cannot find module './panelPermission'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/panelPermission.ts`：

```ts
import { AUTO_APPROVE_INTERACTION_TOOLS } from '../chat/utils/autoApproveDeny';
import type { PendingPermissionRequest } from '../chat/types/types';

/**
 * 交互类工具的审批在 **claude provider** 下没有超时 —— `claude-sdk.js` 给它们的
 * `timeoutMs` 传 0，语义是「无限等待」（见该文件注释
 * ``timeoutMs 0 = wait indefinitely (interactive tools)``）。其余工具到点会被
 * **自动拒绝**，所以它们才是需要抢时间的那一类。
 *
 * 「永不超时」是 claude provider 的说法，不是全后端的普遍事实：qoder 没有这条
 * 分支，`qoder-runner.js` 对**每一个**审批都套 `QODER_APPROVAL_TIMEOUT_MS`，
 * 交互类工具在那边同样会到点被拒。本模块只驱动 claude 通道的倒计时展示。
 */
/** 哨兵：用 NaN 会被 Math.max / 比较运算悄悄吞掉，用 Infinity 排序自然沉到最后。 */
export const NEVER_TIMES_OUT = Number.POSITIVE_INFINITY;

/**
 * 判据直接复用 `autoApproveDeny.ts` 的 `AUTO_APPROVE_INTERACTION_TOOLS`，
 * 不在这里另抄一份字面量：那份是全前端唯一副本，且与后端
 * `TOOLS_REQUIRING_INTERACTION` 之间有一条对账测试钉着。抄第二份就绕过了那条
 * 守卫 —— 后端将来加第三个交互型工具时，这里会**静默**漂开。
 *
 * 注意别凭「名字看着像」往回加 `exit_plan_mode`：那个拼写匹配不到任何真实工具
 * （SDK 里叫 `ExitPlanMode`，见 `claude-sdk.js` 的相关注释），后端照样给它正常
 * 超时。把它当成交互类，等于向用户承诺一个根本不会发生的无限等待。
 */
export function isInteractiveTool(toolName: string): boolean {
  return AUTO_APPROVE_INTERACTION_TOOLS.has(toolName);
}

/**
 * 该请求会被自动拒绝的时刻（epoch ms）。永不超时返回 `NEVER_TIMES_OUT`。
 *
 * 缺 `receivedAt` 时按永不超时处理：倒计时是「再不管就要失败」的告警，
 * 宁可不报，也不要因为拿不到时间戳就编一个出来。
 */
export function timeoutAt(request: PendingPermissionRequest, timeoutMs: number): number {
  if (isInteractiveTool(request.toolName)) {
    return NEVER_TIMES_OUT;
  }
  const receivedAtMs = request.receivedAt instanceof Date ? request.receivedAt.getTime() : NaN;
  if (!Number.isFinite(receivedAtMs)) {
    return NEVER_TIMES_OUT;
  }
  return receivedAtMs + timeoutMs;
}

/**
 * 会超时的排前面（超时时刻升序），永不超时的排最后。
 * 返回新数组 —— 调用方可能持有原数组（React state），不能就地排序。
 */
export function sortPendingRequests(
  requests: readonly PendingPermissionRequest[],
  timeoutMs: number,
): PendingPermissionRequest[] {
  return [...requests].sort((a, b) => timeoutAt(a, timeoutMs) - timeoutAt(b, timeoutMs));
}

/** 剩余秒数（向上取整，下限 0）；永不超时返回 null。 */
export function remainingSeconds(
  request: PendingPermissionRequest,
  nowMs: number,
  timeoutMs: number,
): number | null {
  const at = timeoutAt(request, timeoutMs);
  if (at === NEVER_TIMES_OUT) {
    return null;
  }
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/**
 * 倒计时文案。最后 25 秒换成紧迫措辞 —— 单看数字递减不一定会让人意识到
 * 「到点会被自动拒绝、这次执行就没了」，而这不是能反悔的事。
 */
export function formatCountdown(seconds: number): string {
  return seconds > 24 ? `${seconds} 秒后自动拒绝` : `即将自动拒绝（${seconds} 秒）`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/panelPermission.test.ts`
Expected: PASS —— `# pass 10`、`# fail 0`

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 错误数与任务开始前**相同**（零新增）

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/panelPermission.ts web/src/components/tasks/panelPermission.test.ts
git commit -m "feat(tasks): rank pending approvals by when they will auto-deny"
```

---

## Task 2: 回复区状态派生（纯函数）

**Files:**
- Create: `web/src/components/tasks/panelReply.ts`
- Test: `web/src/components/tasks/panelReply.test.ts`

**背景：** 回复区有四种形态，判据来自任务与运行状态，全是可测的纯逻辑：
（a）会话不可用 —— 没有 `session_id`，或 `session_id` 指向已被硬删的 sessions 行（后端置 `session_deleted`）→ 禁用；（b）会话正在跑 → 可输入但排队（后端 `RUN_IN_PROGRESS` 无服务端队列）；（c）有未答复的待办 → 只影响文案，不影响可发性；（d）正常 → 可直接发。

（a）的两个来源在回复框这边不做区分：判据复用 `taskActions.ts` 的 `hasOpenableSession`。别在这里另抄 `!task.session_id && !task.session_deleted` —— 那份是全前端唯一副本，抄第二份就绕过了它，将来多出一种「会话不可用」的形态时会**静默**放行，用户敲完再发才发现发不出去。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/panelReply.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import { replyState } from './panelReply';

const task = (over: Partial<Task>): Task => ({
  task_id: 't1',
  title: '任务',
  description: '',
  status: 'in_progress',
  priority: 'P2',
  project_id: 'p1',
  session_id: 's1',
  ...over,
} as Task);

test('无 session_id：禁用，不能排队也不能发', () => {
  const s = replyState({ task: task({ session_id: null }), isProcessing: false, hasPendingPrompt: false });
  assert.equal(s.mode, 'no-session');
  assert.equal(s.canType, false);
  assert.equal(s.willQueue, false);
});

test('session_id 还在但会话被清理：同样禁用，且文案与无 session_id 一致', () => {
  // 后端在 session_id 仍指向一条已被硬删的 sessions 行时置 session_deleted
  // （operator 工作区启动清理会这么做）。只判 !session_id 会放行这种任务，
  // 用户敲完再发才发现会话没了 —— 正是本模块要避免的那件事。
  const deleted = replyState({
    task: task({ session_id: 's1', session_deleted: true }),
    isProcessing: false,
    hasPendingPrompt: false,
  });
  const absent = replyState({ task: task({ session_id: null }), isProcessing: false, hasPendingPrompt: false });

  assert.equal(deleted.mode, 'no-session');
  assert.equal(deleted.canType, false);
  assert.equal(deleted.willQueue, false);
  // 从用户视角两者都是「会话没了」，读到的说明不该有差别。
  assert.equal(deleted.hint, absent.hint);
});

test('会话被清理即使显示为运行中也不放行（先判会话，再判运行）', () => {
  const s = replyState({
    task: task({ session_id: 's1', session_deleted: true }),
    isProcessing: true,
    hasPendingPrompt: false,
  });
  assert.equal(s.mode, 'no-session');
  assert.equal(s.canType, false);
  assert.equal(s.willQueue, false);
});

test('会话正在跑：可输入，但发送会排队', () => {
  const s = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: false });
  assert.equal(s.mode, 'queued');
  assert.equal(s.canType, true);
  assert.equal(s.willQueue, true);
});

test('跑着且有未答复的待办：仍可输入（待办是选择、回复是补充说明，两者不互斥）', () => {
  const s = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: true });
  assert.equal(s.mode, 'queued');
  assert.equal(s.canType, true);
});

test('空闲无待办：直接可发', () => {
  const s = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: false });
  assert.equal(s.mode, 'ready');
  assert.equal(s.canType, true);
  assert.equal(s.willQueue, false);
});

test('空闲但有待办：可发（回复会以 chat.send 走，与答复帧不冲突）', () => {
  const s = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: true });
  assert.equal(s.mode, 'ready');
  assert.equal(s.canType, true);
});

test('每种形态都给出非空提示文案', () => {
  const cases = [
    { task: task({ session_id: null }), isProcessing: false, hasPendingPrompt: false },
    { task: task({}), isProcessing: true, hasPendingPrompt: false },
    { task: task({}), isProcessing: false, hasPendingPrompt: false },
  ];
  for (const c of cases) {
    const s = replyState(c);
    assert.equal(typeof s.hint, 'string');
    assert.ok(s.hint.length > 0, `mode=${s.mode} 的 hint 不能为空`);
  }
});

// hasPendingPrompt 唯一可观察的出口就是 hint：不钉住两个分支的差异，
// 一个「忽略 hasPendingPrompt」的实现照样能全绿。
test('排队中：有/无待办给出不同文案，且在跑的文案要点出「回答」', () => {
  const withPrompt = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: true });
  const without = replyState({ task: task({}), isProcessing: true, hasPendingPrompt: false });

  assert.notEqual(withPrompt.hint, without.hint);
  assert.match(withPrompt.hint, /回答/);
  assert.match(without.hint, /排队/);
});

test('空闲：有/无待办给出不同文案', () => {
  const withPrompt = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: true });
  const without = replyState({ task: task({}), isProcessing: false, hasPendingPrompt: false });

  assert.notEqual(withPrompt.hint, without.hint);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/panelReply.test.ts`
Expected: FAIL —— `Cannot find module './panelReply'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/panelReply.ts`：

```ts
/**
 * 回复区形态的派生。纯函数，无 React 依赖。
 *
 * 待办与回复不是互斥的：待办是「从中选一个」，回复是「补充一句话」。所以
 * `hasPendingPrompt` 只影响排版与文案（待办区显示在回复区上方），不改变可输入性。
 *
 * 真正决定可发性的只有两件事 —— 会话是否还能用，以及会话是否正在跑。会话在跑时
 * 后端会以 `RUN_IN_PROGRESS` 拒掉 `chat.send`
 * （见 `backend/server/modules/websocket/services/chat-websocket.service.ts`），
 * 服务端**没有**队列；前端只能替它排队（`queued_message_<sessionId>`，由
 * `useQueuedMessageAutoSend.ts` 冲刷）。所以要**提前**说清楚：发送不等于送达。
 *
 * 「会话不能用」有两种来源，回复框这边不做区分：一是压根没有 `session_id`
 * （清理任务时顺手删了会话），二是 `session_id` 还在、却指向一条已被硬删的
 * sessions 行（后端据此置 `session_deleted`，见 tasks.service.ts 的 decorate）。
 * 对用户而言两者都是「会话没了」，能做的事也只有一件 —— 不让敲。判据直接用
 * `hasOpenableSession`，不在这里另抄一份 `!session_id && !session_deleted`：
 * 那份是全前端唯一副本，抄第二份就绕过了它 —— 将来多出一种「会话不可用」的
 * 形态时，这里会**静默**放行，用户敲完再发才发现发不出去。
 */

import type { Task } from '../../types/app';

import { hasOpenableSession } from './taskActions';

export type ReplyMode = 'no-session' | 'queued' | 'ready';

export interface ReplyState {
  mode: ReplyMode;
  /** 输入框是否可编辑。 */
  canType: boolean;
  /** 发送后是否只是排队（要等这一轮跑完才真正发出去）。 */
  willQueue: boolean;
  /** 输入区下方的说明文案。 */
  hint: string;
}

export interface ReplyStateInput {
  task: Task;
  /** 该会话当前是否有正在执行的 run。 */
  isProcessing: boolean;
  /** 是否有未答复的待办。 */
  hasPendingPrompt: boolean;
}

export function replyState({ task, isProcessing, hasPendingPrompt }: ReplyStateInput): ReplyState {
  if (!hasOpenableSession(task)) {
    return {
      mode: 'no-session',
      canType: false,
      willQueue: false,
      hint: '这个会话已被清理，无法再回复',
    };
  }

  if (isProcessing) {
    return {
      mode: 'queued',
      canType: true,
      willQueue: true,
      hint: hasPendingPrompt
        ? '正在等待你回答上面的问题 · 消息将排队发送'
        : '执行中 · 消息将排队发送，等这一轮结束',
    };
  }

  return {
    mode: 'ready',
    canType: true,
    willQueue: false,
    hint: hasPendingPrompt ? '也可以直接用一句话回复' : 'Enter 发送 · Shift+Enter 换行',
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/panelReply.test.ts`
Expected: PASS —— `# pass 10`、`# fail 0`

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/panelReply.ts web/src/components/tasks/panelReply.test.ts
git commit -m "feat(tasks): derive the summary panel reply state from session and run status"
```

---

## Task 3: 会话作用域的待办订阅钩子

**Files:**
- Create: `web/src/components/tasks/useSessionPendingRequests.ts`（钩子，薄壳）
- Create: `web/src/components/tasks/pendingRequestEvents.ts`（纯 reducer，全部判断逻辑）
- Test: `web/src/components/tasks/pendingRequestEvents.test.ts`
- Test: 无（钩子本体；React hook，本仓库无 jsdom 无法测 —— 见下面「为什么拆成两半」）

**背景（本计划最关键的一步）：** 任务页**不能**用 `PermissionContext` —— 它的唯一 Provider 在 `web/src/components/chat/view/ChatInterface.tsx:452`，而 `/tasks` 是独立路由，树上没有它，`usePermission()` 只会返回 `null`。

任务页有 `WebSocketProvider`（挂在 `App.tsx:126`，所有路由之上）。所以钩子自己走订阅：

1. 挂载 / `sessionId` 变化时发 `chat.subscribe`（`sessions: [{ sessionId, lastSeq: 0 }]`）。
2. 后端 `handleChatSubscribe`（`backend/server/modules/websocket/services/chat-websocket.service.ts:347`）回 `chat_subscribed`，带 `pendingPermissions` 与 `lastSeq`；运行中时还会 `attachConnection`，后续 `permission_request` / `permission_cancelled` 实时到达。
3. 答复发 `chat.permission-response`，帧格式与 `handlePermissionDecision`（`web/src/components/chat/hooks/useChatComposerState.ts:1329`）完全一致。

**为什么拆成两半（对原计划的偏离，已由控制方要求）：** 原计划写「无测试，React hook 测不到」。钩子确实测不到，但判断逻辑可以 —— 抽成纯函数后就能在 `node:test`（无 jsdom）下测。仓库里已有同款分工（见 `docs/superpowers/plans/2026-08-05-workflow-adaptation.md`：「把聚合逻辑抽成纯函数 `applyWorkflowEvent(state, event) → state`，便于在 `node:test`(无 jsdom)下测」），`panelPermission.ts` / `panelReply.ts` 也是这么分的。

**两个必须知道的后端事实（都已在代码里核实）：**

1. **`lastSeq: 0` 拦不住重放。** `handleChatSubscribe` 在运行中时先 `attachConnection` 再 `replayEvents`，起点由 `readReplayStart` 算：`Math.max(clientLastSeq, priorSeq)`，而 `priorSeq` 在**该 socket 首次订阅这个 run** 时是 `-1` —— 于是 `startSeq = max(0, -1) = 0`，**整段缓冲区都会被重放**，客户端发什么 `lastSeq` 都一样。
   为什么这是 bug 而不只是浪费：答复一条审批**不会**发 `permission_cancelled`（`claude-sdk.js` 的 resolve 路径只 `pendingToolApprovals.delete(requestId)`；`permission_cancelled` 只走 timeout/abort 的 `onCancel`），所以已答的 `permission_request` 仍在缓冲区里，重放会把它当新待办加回来 —— 还带着新打的 `receivedAt`，连倒计时都是全新的。点它毫无反应（`resolveToolApproval` 对未知 requestId 静默忽略）。
   对策：**ack 的 `lastSeq` 是快照的权威水线**。`chat_subscribed.pendingPermissions` 覆盖了 `<= lastSeq` 的一切，所以此后任何 `seq <= lastSeq` 的增量帧必然是重放，丢弃。落在 `snapshotSeq` 字段上。
2. **空闲时订阅、之后才起跑的 run，本 socket 收不到审批帧。** `attachConnection` 只在 `handleChatSubscribe` 里调用（那时还没 run），`startRun` 只把发起方那条连接放进 writer 的 socket 集合。对策：监听广播的 `session_status` 帧（`broadcastSessionStatus` → `connectedClients.forEach`，所有已连客户端都收得到），在它**迁移进 `running`** 时补发一次 `chat.subscribe` —— 此刻订阅会命中 `isProcessing: true` 从而 attach。必须只在状态**变化**时补，否则与补订阅引发的 ack 互相触发。

- [ ] **Step 1: 先写纯函数的失败测试，再写 reducer**

创建 `web/src/components/tasks/pendingRequestEvents.test.ts`（测试先跑成 `ERR_MODULE_NOT_FOUND`，再写实现）：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PendingPermissionRequest } from '../chat/types/types';

import {
  EMPTY_PENDING_STATE,
  applyPendingEvent,
  type PendingRequestsEvent,
  type PendingRequestsState,
} from './pendingRequestEvents';

const SID = 'sess-1';
const NOW = new Date('2026-01-02T03:04:05.000Z');
const opts = { now: NOW };

const req = (requestId: string, toolName = 'Bash'): PendingPermissionRequest => ({
  requestId,
  toolName,
  receivedAt: NOW,
});

const stateWith = (
  pendingRequests: PendingPermissionRequest[],
  isProcessing = true,
  snapshotSeq = -1,
): PendingRequestsState => ({ pendingRequests, isProcessing, snapshotSeq });

const ack = (lastSeq: number, pendingPermissions: unknown = []): PendingRequestsEvent => ({
  kind: 'chat_subscribed',
  sessionId: SID,
  isProcessing: true,
  lastSeq,
  pendingPermissions,
});

test('未选中会话（sessionId 为 null）时任何帧都原样返回', () => {
  const events: PendingRequestsEvent[] = [
    { kind: 'chat_subscribed', sessionId: SID, isProcessing: true, pendingPermissions: [req('a')] },
    { kind: 'permission_request', sessionId: SID, requestId: 'a', toolName: 'Bash' },
    { kind: 'permission_cancelled', sessionId: SID, requestId: 'a' },
    { kind: 'complete', sessionId: SID },
    { kind: 'other' },
  ];

  for (const event of events) {
    assert.equal(applyPendingEvent(EMPTY_PENDING_STATE, event, null, opts), EMPTY_PENDING_STATE, event.kind);
  }
});

test('sessionId 为空串同样不跟踪', () => {
  const event: PendingRequestsEvent = { kind: 'complete', sessionId: '' };
  assert.equal(applyPendingEvent(stateWith([req('a')]), event, '', opts).pendingRequests.length, 1);
});

test('chat_subscribed：别的会话的 ack 不改变状态', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: 'other',
    isProcessing: false,
    pendingPermissions: [],
  };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('chat_subscribed：本会话的 ack 整体替换待办并带上 isProcessing', () => {
  const state = stateWith([req('stale')], false);
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [req('a'), req('b')],
  };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(next.isProcessing, true);
});

test('chat_subscribed：pendingPermissions 不是数组时清空（不残留上个会话的条目）', () => {
  const state = stateWith([req('stale')]);

  for (const bogus of [undefined, null, 'nope', { 0: req('x') }]) {
    const next = applyPendingEvent(
      state,
      { kind: 'chat_subscribed', sessionId: SID, isProcessing: true, pendingPermissions: bogus },
      SID,
      opts,
    );
    assert.deepEqual(next.pendingRequests, [], String(bogus));
  }
});

test('chat_subscribed：ISO 字符串的 receivedAt 转成 Date —— 丢了它倒计时就静默失效', () => {
  const iso = '2025-12-31T23:59:00.000Z';
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [{ requestId: 'a', toolName: 'Bash', receivedAt: iso }],
  };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.ok(entry.receivedAt instanceof Date, 'receivedAt 必须是 Date，不能是线上传来的字符串');
  assert.equal(entry.receivedAt?.getTime(), new Date(iso).getTime());
});

test('chat_subscribed：缺 receivedAt 的条目用注入的 now 打点', () => {
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [{ requestId: 'a', toolName: 'Bash' }],
  };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.equal(entry.receivedAt?.getTime(), NOW.getTime());
});

test('chat_subscribed：snapshot 条目原样带出（input/context/sessionId 都是喂给面板的）', () => {
  // 后端构造快照时已经把 sessionId 重映射成应用会话 id（registry 的出站覆写 +
  // handleChatSubscribe 的 .map），所以这里的 sessionId 是**穿过**来的，不是本
  // 函数补的 —— 本函数只补 receivedAt。
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [
      { requestId: 'a', toolName: 'Bash', sessionId: SID, input: { cmd: 'ls' }, context: { cwd: '/tmp' } },
    ],
  };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.equal(entry.sessionId, SID);
  assert.deepEqual(entry.input, { cmd: 'ls' });
  assert.deepEqual(entry.context, { cwd: '/tmp' });
});

test('permission_request：别的会话的请求不进来', () => {
  const state = stateWith([], true);
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: 'other',
    requestId: 'a',
    toolName: 'Bash',
  };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('permission_request：本会话的请求追加到队尾并置 isProcessing', () => {
  const state = stateWith([req('a')], false);
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'b',
    toolName: 'Write',
    input: { file_path: '/tmp/x' },
    context: { cwd: '/tmp' },
  };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(next.isProcessing, true);

  const added = next.pendingRequests[1];
  assert.equal(added.toolName, 'Write');
  assert.equal(added.sessionId, SID);
  assert.equal(added.receivedAt?.getTime(), NOW.getTime());
  assert.deepEqual(added.input, { file_path: '/tmp/x' });
});

test('permission_request：toolName 缺失时落到 UnknownTool', () => {
  const event: PendingRequestsEvent = { kind: 'permission_request', sessionId: SID, requestId: 'a' };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.equal(entry.toolName, 'UnknownTool');
});

test('permission_request：没有 requestId 的直接丢弃（答不了）', () => {
  const state = stateWith([req('a')]);
  for (const requestId of [undefined, '']) {
    const event: PendingRequestsEvent = { kind: 'permission_request', sessionId: SID, requestId, toolName: 'Bash' };
    assert.equal(applyPendingEvent(state, event, SID, opts), state, String(requestId));
  }
});

test('permission_request：已在队列里的 requestId 不重复追加', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = { kind: 'permission_request', sessionId: SID, requestId: 'a', toolName: 'Bash' };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.equal(next.pendingRequests.length, 1);
  assert.equal(next.pendingRequests.filter((r) => r.requestId === 'a').length, 1);
});

test('permission_cancelled：按 requestId 过滤掉，其余保持顺序', () => {
  const state = stateWith([req('a'), req('b'), req('c')]);
  const event: PendingRequestsEvent = { kind: 'permission_cancelled', sessionId: SID, requestId: 'b' };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['a', 'c']);
});

test('permission_cancelled：没有这个 id 时返回同一个引用（不白造新数组）', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = { kind: 'permission_cancelled', sessionId: SID, requestId: 'nope' };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('permission_cancelled：别的会话的取消不影响本会话', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = { kind: 'permission_cancelled', sessionId: 'other', requestId: 'a' };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('complete：本会话结束时清空待办并落下 isProcessing（丢帧时的兜底）', () => {
  const state = stateWith([req('a'), req('b')], true);
  const event: PendingRequestsEvent = { kind: 'complete', sessionId: SID };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests, []);
  assert.equal(next.isProcessing, false);
});

test('complete：水线一起归零 —— 下一轮 run 的 seq 从 1 重数，旧水线会静默吞掉它的实时帧', () => {
  const finished = applyPendingEvent(
    applyPendingEvent(EMPTY_PENDING_STATE, ack(9), SID, opts),
    { kind: 'complete', sessionId: SID },
    SID,
    opts,
  );
  assert.equal(finished.snapshotSeq, -1);

  // 下一轮的第一个审批帧 seq=1。若水线还停在 9，这一帧会被当成重放丢掉。
  const nextRunFrame: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'round-2',
    toolName: 'Bash',
    seq: 1,
  };
  assert.deepEqual(
    applyPendingEvent(finished, nextRunFrame, SID, opts).pendingRequests.map((r) => r.requestId),
    ['round-2'],
  );
});

test('complete：别的会话结束不改变本会话状态', () => {
  const state = stateWith([req('a')], true);
  const event: PendingRequestsEvent = { kind: 'complete', sessionId: 'other' };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('other：不认识的帧原样返回同一个引用', () => {
  const state = stateWith([req('a')]);
  assert.equal(applyPendingEvent(state, { kind: 'other' }, SID, opts), state);
});

/*
 * 重放水线：`chat.subscribe` 的 ack 之后，后端还会把 run 缓冲区里的整段事件重放
 * 给这个 socket（`readReplayStart` 对**首次**订阅返回 0，与客户端发的 lastSeq 无关）。
 * 答复一条审批**不会**发 `permission_cancelled`，所以已经答过的 `permission_request`
 * 仍躺在缓冲区里，重放会把它当成一条新待办加回来 —— 而且带着新打的 receivedAt，
 * 连倒计时都是全新的。点它毫无反应（后端对未知 requestId 静默忽略）。
 */

test('chat_subscribed：ack 把 lastSeq 记成快照水线', () => {
  const next = applyPendingEvent(EMPTY_PENDING_STATE, ack(7), SID, opts);
  assert.equal(next.snapshotSeq, 7);
});

test('chat_subscribed：lastSeq 不是数字时水线落到 -1（宁可不拦，也不要误拦实时帧）', () => {
  for (const bogus of [undefined, null, '7', Number.NaN]) {
    const event = { kind: 'chat_subscribed', sessionId: SID, isProcessing: true, lastSeq: bogus } as PendingRequestsEvent;
    assert.equal(applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).snapshotSeq, -1, String(bogus));
  }
});

test('permission_request：seq 落在快照水线以内的（重放）丢弃，不复活已答的待办', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const replayed: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'answered',
    toolName: 'Bash',
    seq: 5,
  };

  assert.equal(applyPendingEvent(state, replayed, SID, opts), state);
  assert.equal(
    applyPendingEvent(state, { ...replayed, seq: 2 }, SID, opts),
    state,
    '水线以下的更早帧同样丢弃',
  );
});

test('permission_request：seq 高于快照水线的（真·实时帧）正常追加', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const live: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'live',
    toolName: 'Bash',
    seq: 6,
  };

  const next = applyPendingEvent(state, live, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['live']);
  assert.equal(next.isProcessing, true);
  assert.equal(next.snapshotSeq, 5, '水线不因增量帧前进');
});

test('permission_request：没有 seq 的帧照常处理（别把不盖 seq 的 provider 静默吞掉）', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'no-seq',
    toolName: 'Bash',
  };

  assert.deepEqual(
    applyPendingEvent(state, event, SID, opts).pendingRequests.map((r) => r.requestId),
    ['no-seq'],
  );
});

test('permission_cancelled：seq 落在快照水线以内的（重放）丢弃', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const withPending = { ...state, pendingRequests: [req('a')] };
  const replayed: PendingRequestsEvent = {
    kind: 'permission_cancelled',
    sessionId: SID,
    requestId: 'a',
    seq: 5,
  };

  assert.equal(applyPendingEvent(withPending, replayed, SID, opts), withPending);
  assert.deepEqual(
    applyPendingEvent(withPending, { ...replayed, seq: 6 }, SID, opts).pendingRequests.map((r) => r.requestId),
    [],
  );
});

test('水线是会话级的：没收到 ack 之前（-1）不拦任何帧', () => {
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'a',
    toolName: 'Bash',
    seq: 1,
  };

  assert.deepEqual(
    applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests.map((r) => r.requestId),
    ['a'],
  );
});

test('纯函数：任何一条分支都不改动入参的 state 与其中的数组/对象', () => {
  const list = [req('a'), req('b')];
  const state = stateWith(list, true, 3);
  const snapshot = JSON.stringify(list.map((r) => ({ id: r.requestId, at: r.receivedAt?.toISOString() })));

  applyPendingEvent(state, { kind: 'permission_cancelled', sessionId: SID, requestId: 'a' }, SID, opts);
  applyPendingEvent(state, { kind: 'permission_request', sessionId: SID, requestId: 'c' }, SID, opts);
  applyPendingEvent(state, { kind: 'permission_request', sessionId: SID, requestId: 'd', seq: 1 }, SID, opts);
  applyPendingEvent(state, { kind: 'complete', sessionId: SID }, SID, opts);
  applyPendingEvent(state, ack(9, [req('z')]), SID, opts);

  assert.deepEqual(state.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(state.isProcessing, true);
  assert.equal(state.snapshotSeq, 3);
  assert.equal(
    JSON.stringify(list.map((r) => ({ id: r.requestId, at: r.receivedAt?.toISOString() }))),
    snapshot,
  );
});
```

创建 `web/src/components/tasks/pendingRequestEvents.ts`：

```ts
/**
 * 把一个 socket 帧折算进「本会话待办审批」状态的**纯函数**。
 *
 * 为什么独立成文件：这个仓库的前端测试是 `node:test` **无 jsdom**，钩子本体
 * 测不到。把折叠逻辑挤出来，语义（去重、跨会话过滤、重放水线、丢帧兜底）才
 * 测得到 —— 与 `panelPermission.ts` / `panelReply.ts` 同一分工。
 *
 * 线上契约（都在后端，别凭记忆改）：
 *  - 每个出站帧的 `sessionId` 都是**应用会话 id**：registry 构造出站事件时统一
 *    覆写 `sessionId: run.appSessionId`（`chat-run-registry.service.ts` 的
 *    `decorateAndRecordEvent`，经 `ChatSessionWriter` 发出），所以直接用任务/
 *    会话的 `session_id` 比就是对的。
 *  - `chat_subscribed`（`handleChatSubscribe`）带 `isProcessing`、`lastSeq` 与
 *    `pendingPermissions` 全量快照；`permission_request` / `permission_cancelled`
 *    是运行中的增量帧。
 *  - **ack 之后还会跟着整段重放，`lastSeq: 0` 拦不住它**：`handleChatSubscribe`
 *    在运行中时先 `attachConnection` 再 `replayEvents`，起点由 `readReplayStart`
 *    算，对**首次**订阅返回 `Math.max(clientLastSeq, -1)` —— 客户端发什么
 *    `lastSeq` 都没用。这是 `snapshotSeq` 水线存在的唯一理由。
 */

import type { PendingPermissionRequest } from '../chat/types/types';

export interface PendingRequestsState {
  pendingRequests: PendingPermissionRequest[];
  isProcessing: boolean;
  /**
   * 最近一次 `chat_subscribed` 的 `lastSeq`，即快照的**权威水线**：
   * `seq <= snapshotSeq` 的增量帧必然来自 ack 之后的重放，不是新状态。
   */
  snapshotSeq: number;
}

export type PendingRequestsEvent =
  | { kind: 'chat_subscribed'; sessionId?: string; isProcessing?: boolean; lastSeq?: number; pendingPermissions?: unknown }
  | { kind: 'permission_request'; sessionId?: string; requestId?: string; toolName?: string; input?: unknown; context?: unknown; seq?: number }
  | { kind: 'permission_cancelled'; sessionId?: string; requestId?: string; seq?: number }
  | { kind: 'complete'; sessionId?: string }
  | { kind: 'other' };

export const EMPTY_PENDING_STATE: PendingRequestsState = {
  pendingRequests: [],
  isProcessing: false,
  // 不是 0：`run.lastSeq` 从 0 起递增，**实时**帧的 seq 从 1 开始，用 0 会把
  // 首订阅（还没拿到 ack）之后的头几帧真事件当成重放丢掉。水线只该拦已知范围，
  // 未知时宁可不拦。
  snapshotSeq: -1,
};

export interface ApplyPendingEventOptions {
  /** 可注入的「现在」，缺省取真实时间；测试用它钉住打的点。 */
  now?: Date;
}

/**
 * 这一帧是不是 ack 之前就已经发生过、被 `replayEvents` 重放回来的旧事件？
 *
 * 不拦的后果不是「多显示一条」那么轻：答复一条审批**不会**发
 * `permission_cancelled`（`claude-sdk.js` 的 resolve 路径只
 * `pendingToolApprovals.delete(requestId)`，`permission_cancelled` 只走
 * timeout/abort 的 `onCancel`），所以已答的 `permission_request` 仍躺在 run
 * 的事件缓冲区里，重放会把它当成一条新待办加回来 —— 还带着新打的 `receivedAt`，
 * 于是倒计时也是全新的。点它则毫无反应：`resolveToolApproval` 对未知 requestId
 * 静默忽略。
 *
 * 这道判断看着像可以「简化」掉的冗余检查，别删：没有它，面板在每次刷新/重订阅后
 * 都会长出一条点了没反应的幽灵待办。
 *
 * 没有 `seq` 的帧一律放行：不是所有 provider 都盖 seq，把「没盖」当成「旧」会
 * 静默吞掉实时帧 —— 那是比幽灵按钮更糟的故障。
 */
function isReplayed(event: { seq?: number }, state: PendingRequestsState): boolean {
  return typeof event.seq === 'number' && event.seq <= state.snapshotSeq;
}

/**
 * `chat_subscribed` 快照里的条目已经带了 `receivedAt`，但它**不是 Date**：
 * 帧经由 `JSON.stringify` 出去，Date 会序列化成 ISO 字符串。不在这里转回来，
 * 倒计时（`panelPermission.timeoutAt` 只认 `instanceof Date`）会静默失效 ——
 * 刷新页面后所有待办都变成「永不超时」。
 *
 * 缺时间戳时才打 `now`：调用方注入的时钟优先，否则每次刷新都会把快照里已有
 * 的真实等待时长冲掉，倒计时从头开始。
 */
function stampReceivedAt(item: PendingPermissionRequest, now: Date): PendingPermissionRequest {
  if (item.receivedAt === undefined || item.receivedAt === null) {
    return { ...item, receivedAt: now };
  }
  return { ...item, receivedAt: new Date(item.receivedAt as unknown as string | number | Date) };
}

/** `lastSeq` 只有是有限数时才可信；缺失/脏值一律当 -1（= 不拦）。 */
function readSnapshotSeq(lastSeq: unknown): number {
  return typeof lastSeq === 'number' && Number.isFinite(lastSeq) ? lastSeq : -1;
}

export function applyPendingEvent(
  state: PendingRequestsState,
  event: PendingRequestsEvent,
  sessionId: string | null,
  options: ApplyPendingEventOptions = {},
): PendingRequestsState {
  // 没选中会话就没什么可跟踪的 —— 所有帧一律原样返回同一引用。
  if (!sessionId) {
    return state;
  }

  const now = options.now ?? new Date();

  switch (event.kind) {
    case 'chat_subscribed': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      // 快照是权威的：整体替换，且非数组时归零 —— 留着上个会话的条目会让面板
      // 显示一个答不了的按钮。
      const items = Array.isArray(event.pendingPermissions)
        ? (event.pendingPermissions as PendingPermissionRequest[]).map((item) => stampReceivedAt(item, now))
        : [];
      return {
        pendingRequests: items,
        isProcessing: Boolean(event.isProcessing),
        snapshotSeq: readSnapshotSeq(event.lastSeq),
      };
    }

    case 'permission_request': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      if (isReplayed(event, state)) {
        return state;
      }
      // 没有 requestId 就答不了，收下只会变成一个永远无法回应的按钮。
      if (!event.requestId) {
        return state;
      }
      // 同一 requestId 重复到达（重放或重订阅）不追加第二条。
      if (state.pendingRequests.some((request) => request.requestId === event.requestId)) {
        return state;
      }
      const request: PendingPermissionRequest = {
        requestId: event.requestId,
        toolName: event.toolName || 'UnknownTool',
        input: event.input,
        context: event.context,
        sessionId,
        receivedAt: now,
      };
      return {
        pendingRequests: [...state.pendingRequests, request],
        isProcessing: true,
        snapshotSeq: state.snapshotSeq,
      };
    }

    case 'permission_cancelled': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      if (isReplayed(event, state)) {
        return state;
      }
      if (!state.pendingRequests.some((request) => request.requestId === event.requestId)) {
        return state;
      }
      return {
        pendingRequests: state.pendingRequests.filter((request) => request.requestId !== event.requestId),
        isProcessing: state.isProcessing,
        snapshotSeq: state.snapshotSeq,
      };
    }

    case 'complete': {
      if (event.sessionId !== sessionId) {
        return state;
      }
      // 本轮结束了，等待也就结束了。后端在正常路径上还会发 `permission_cancelled`，
      // 这里是丢帧时的兜底：否则面板会永远挂着一个答不了的回执按钮。
      //
      // 水线同时归零：run 结束意味着下一轮的 seq 从 1 重新数（`readReplayStart`
      // 也只在同一个 run 内比较）。不清掉的话，若下一轮开始时漏掉了重新订阅
      // （重连抖动、transition 判定失效），新 run 的实时帧会全部落在旧水线以下被
      // 静默丢掉 —— 那是「任务在等审批，面板却什么都不显示」。水线宁可失效放行，
      // 也不要误杀；何况此时待办本就被清空，没有可复活的幽灵。
      return {
        pendingRequests: [],
        isProcessing: false,
        snapshotSeq: -1,
      };
    }

    case 'other':
    default:
      return state;
  }
}
```

- [ ] **Step 2: 再写钩子（薄壳：只做帧映射、订阅、乐观移除）**

创建 `web/src/components/tasks/useSessionPendingRequests.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket, type ServerEvent } from '../../contexts/WebSocketContext';
import type { PendingPermissionRequest } from '../chat/types/types';

import {
  EMPTY_PENDING_STATE,
  applyPendingEvent,
  type PendingRequestsEvent,
  type PendingRequestsState,
} from './pendingRequestEvents';

export interface PendingDecision {
  allow?: boolean;
  message?: string;
  rememberEntry?: string | null;
  updatedInput?: unknown;
}

export interface UseSessionPendingRequestsResult {
  pendingRequests: PendingPermissionRequest[];
  isProcessing: boolean;
  respond: (requestId: string, decision: PendingDecision) => void;
}

/**
 * 把一帧 `ServerEvent` 折成 reducer 认识的 `PendingRequestsEvent`。
 *
 * 不认识的 kind 一律落到 `'other'` —— reducer 会原样返回同一引用，不触发渲染。
 * 这正是「网关将来加帧类型时，本钩子不会瞎认」的边界。
 */
function toPendingEvent(event: ServerEvent): PendingRequestsEvent {
  switch (event.kind) {
    case 'chat_subscribed':
      return {
        kind: 'chat_subscribed',
        sessionId: event.sessionId,
        isProcessing: event.isProcessing as boolean | undefined,
        lastSeq: event.lastSeq as number | undefined,
        pendingPermissions: event.pendingPermissions,
      };
    case 'permission_request':
      return {
        kind: 'permission_request',
        sessionId: event.sessionId,
        requestId: event.requestId as string | undefined,
        toolName: event.toolName as string | undefined,
        input: event.input,
        context: event.context,
        seq: event.seq,
      };
    case 'permission_cancelled':
      return {
        kind: 'permission_cancelled',
        sessionId: event.sessionId,
        requestId: event.requestId as string | undefined,
        seq: event.seq,
      };
    case 'complete':
      return { kind: 'complete', sessionId: event.sessionId };
    default:
      return { kind: 'other' };
  }
}

/**
 * 订阅**一个会话**的待办工具审批。
 *
 * 与聊天页的区别：那边是自己发起对话、只关心正被查看的会话；这里是一块
 * 「任务详情」面板，挂在后台运行的任务会话上。两者用同一个共享 socket，
 * 各自 `chat.subscribe`，所以可以并存。
 *
 * `lastSeq: 0` 不是「不回放」的开关 —— 后端对首次订阅照样把整个 run 缓冲区
 * 重放回来（`readReplayStart` 返回 `Math.max(clientLastSeq, -1)`）。真正挡住
 * 重放里那些已答待办的是 `snapshotSeq` 水线，见 `pendingRequestEvents.ts`。
 * 这里给 0 只是声明「我不要历史」；反正本面板一个字的历史都不渲染。
 */
export function useSessionPendingRequests(
  sessionId: string | null | undefined,
): UseSessionPendingRequestsResult {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const [state, setState] = useState<PendingRequestsState>(EMPTY_PENDING_STATE);

  /**
   * socket 回调是异步的，闭包里的 `sessionId` 会过期 —— 切了会话之后旧的监听器
   * 还会拿老 id 去比。ref 每次渲染都重指，监听器读 ref 拿到的永远是最新的那个。
   */
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  sessionIdRef.current = sessionId ?? null;

  /**
   * 「上次为哪个会话的哪次 run 补过订阅」。见 `session_status` 分支的注释：
   * 只在**状态发生变化**时补订阅，否则会和补订阅引发的 `chat_subscribed` 互相
   * 触发成死循环。
   */
  const lastStatusRef = useRef<{ sessionId: string; state: string } | null>(null);

  // 切会话立刻抹掉上一个会话的待办：否则新面板会挂着一个属于别人的按钮。
  useEffect(() => {
    setState(EMPTY_PENDING_STATE);
    lastStatusRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    return subscribe((event: ServerEvent) => {
      // 会话在**空闲时**被订阅、之后才起跑：`attachConnection` 只发生在
      // `handleChatSubscribe` 里（那时还没 run），而 `startRun` 只把发起方那条
      // 连接放进 writer 的 socket 集合。于是本 socket 收不到任何
      // `permission_request`，面板永远是空的，直到下次重连。
      //
      // `session_status` 是广播给**所有**已连接客户端的（registry 的
      // `broadcastSessionStatus` → `connectedClients.forEach`），所以拿它当
      // 「该重新订阅了」的可靠信号：此刻再订阅一次就会命中 `isProcessing: true`
      // → `attachConnection`，从而接上这一轮的实时帧。
      //
      // 看着像多余的「我们不是已经订阅过了吗」—— 不知道 attach 只在订阅时发生
      // 的人一定会想删掉它。别删：删了就是后台任务的审批弹不出来。
      if (event.kind === 'session_status') {
        const statusSessionId = event.sessionId;
        if (!statusSessionId || statusSessionId !== sessionIdRef.current) {
          return;
        }
        const status = String(event.state ?? '');
        const previous = lastStatusRef.current;
        // 只在**迁移进** running 的那一帧补订阅：同一轮里重复到达的 running 帧
        // （或 StrictMode 下的重复派发）会白白多订阅一次，而每次订阅都会换来一段
        // 重放。状态没变就跳过。
        const alreadyRunning =
          previous !== null && previous.sessionId === statusSessionId && previous.state === status;
        lastStatusRef.current = { sessionId: statusSessionId, state: status };
        if (status !== 'running' || alreadyRunning || !isConnected) {
          return;
        }
        sendMessage({
          type: 'chat.subscribe',
          sessions: [{ sessionId: statusSessionId, lastSeq: 0 }],
        });
        return;
      }

      const pendingEvent = toPendingEvent(event);
      if (pendingEvent.kind === 'other') {
        // 快路径：绝大多数帧与本面板无关，连 setState 都不进。
        return;
      }
      setState((previous) => {
        const next = applyPendingEvent(previous, pendingEvent, sessionIdRef.current);
        // reducer 用「同一引用」表示无变化，这里把它变成 React 的 bail-out。
        return next === previous ? previous : next;
      });
    });
  }, [subscribe, sendMessage, isConnected]);

  // 选中会话且 socket 已连上才订阅。依赖 isConnected 是刻意的：每次重连都要
  // 重新订阅一遍（旧连接的订阅随连接一起没了），否则断线重连后待办永远不刷新。
  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId, lastSeq: 0 }],
    });
  }, [sessionId, isConnected, sendMessage]);

  const respond = useCallback(
    (requestId: string, decision: PendingDecision) => {
      if (!requestId) {
        return;
      }
      // 字段名与聊天页 `handlePermissionDecision` 逐字一致 —— 后端
      // `handlePermissionResponse` 认的就是这几个名字。
      sendMessage({
        type: 'chat.permission-response',
        requestId,
        allow: Boolean(decision.allow),
        updatedInput: decision.updatedInput,
        message: decision.message,
        rememberEntry: decision.rememberEntry,
      });
      // 乐观移除：决定已发出，按钮不该再等一个来回才消失。后端若判失败会经
      // `permission_cancelled` / 重订阅的 ack 纠正回来。
      setState((previous) => {
        const next = previous.pendingRequests.filter((request) => request.requestId !== requestId);
        // 没移掉任何东西就别造新对象：setState 拿到同一引用时 React 直接跳过
        // 这次渲染（与 reducer 的引用纪律一致）。
        return next.length === previous.pendingRequests.length ? previous : { ...previous, pendingRequests: next };
      });
    },
    [sendMessage],
  );

  return {
    pendingRequests: state.pendingRequests,
    isProcessing: state.isProcessing,
    respond,
  };
}
```

- [ ] **Step 3: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

若报 `subscribe` 不在 `WebSocketContextType` 上，读 `web/src/contexts/WebSocketContext.tsx:32` 确认签名是 `(listener: ServerEventListener) => () => void`，并按实际类型调整。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/pendingRequestEvents.ts web/src/components/tasks/pendingRequestEvents.test.ts \
        web/src/components/tasks/useSessionPendingRequests.ts
git commit -m "feat(tasks): subscribe the task panel to a session's pending approvals"
```

---


## Task 4: 单条待办卡片（含倒计时）

**Files:**
- Create: `web/src/components/tasks/PendingPromptCard.tsx`
- Create: `web/src/components/tasks/pendingPromptAnswers.ts`
- Test: `web/src/components/tasks/PendingPromptCard.test.tsx`
- Test: `web/src/components/tasks/pendingPromptAnswers.test.ts`

**背景：** 按 `toolName` 分派：`AskUserQuestion` 渲染选项、`ExitPlanMode` 渲染计划、其余渲染通用授权。倒计时复用 Task 1 的纯函数。

**实施中发现的三处对原计划的修正**（评审已确认）：

1. **「总是允许」的 `rememberEntry` 用 `chat/utils/chatPermissions.ts` 的 `buildClaudeToolPermissionEntry`，不要照抄本计划原先草拟的 `Bash(${command})`。** 那个草稿写的是「整条命令」作规则，而聊天页实际生成的是**前缀式**规则（`git commit -m "fix(csv)"` → `Bash(git commit:*)`）。两处若各拼各的，同一句「总是允许」会往 `allowedTools` 里写两条不同的规则，用户此后在聊天页与任务面板看到的行为就不一致。该函数无 DOM 依赖、可直接 import（已实测）。它只对 `Bash` 产出具体规则，其余工具返回裸工具名，故仅当返回值非空时启用按钮。
2. **多选（`multiSelect: true`）必须单独处理。** 原计划的单选式一击即发**不是**聊天页一致性 —— 它就是个图省事的捷径，别把它当成「对齐了聊天页」来读。多选必须有自己的处理，因为题目的语义就是「可以选好几个」，一击即发会给模型一个偏窄的答案，而界面上没有任何东西提示用户本可以多选。**一条容易重复走错的取证**（这次的原假设就是错的）：聊天页的选项点击**不提交** —— `AskUserQuestionPanel.tsx:228` 的 `onClick` 只调 `toggleOption`，提交在页脚那个常驻按钮上（`:362`，`handleSubmit`），键盘路径还得额外按一次 Enter（`:120` 的 `if (isLast) handleSubmit()`）。所以「聊天页多选也一击即发」从来就不成立；反过来，本卡片的单选一击即发是**主动偏离**聊天页，理由是没有页脚的位置、且第二下点击对最常见的一题情形是纯摩擦（详见 `pendingPromptAnswers.ts` 的文件头注释）。
   现在：多选点一下是切换（再点取消），必须按「提交选择」才发出；答案串按聊天页的 `join(', ')` 拼接（顺序 = 点击顺序，聊天页是 `Set` 插入序，不许排序）。
3. **点击语义必须搬进纯函数文件（`pendingPromptAnswers.ts`）才测得到。** 本仓库的 web 测试是 `node:test` + `renderToStaticMarkup`（无 DOM、不能模拟点击）。逻辑留在组件的 `onClick` 闭包里时，「单选误写成切换」「多选误写成一击即发」「答满全部题目才提交」这三类错误在静态标记上完全看不出来（按钮与文案都还在），却会改变发给模型的答案。搬出后这三条都有测试钉着（见 Step 4 的 `pendingPromptAnswers.test.ts` 与 Step 6 的变异核对表）。

**不做的部分**（刻意）：聊天页的键盘层（1-9 选号、0 = Other、Enter、Esc）与 Back/Next 分步器不移植 —— 任务面板是鼠标优先、且还没有焦点模型；「Other」自由输入也不做，它需要一个受控 input 与焦点管理。

**「与聊天页一致」这句话在本任务里只对载荷成立**（连「答满全部题目才提交」都不是共有的：聊天页的 Next 没有 disabled（`AskUserQuestionPanel.tsx:366-378`）、非末题 Enter 无条件前进（`:120`）、末页 Submit 的 disabled 只看当前题（`:363`），所以它能带缺项提交；本卡片的全答完闸门是主动加严）：答案形状（`Record<questionText, answer>` / `join(', ')` / 插入序 / 未作答的题不出现）、`rememberEntry` 的规则串、以及 ExitPlanMode 那两个**载荷**（`'User asked to revise the plan'` / `allow: true`）都必须逐字一致 —— 模型读的是它们。**交互与中文标签是故意不同的**：卡片在 428px 侧栏里没有页脚的位置，单选一击即发、按钮写「让它改 / 开始执行」（聊天页是 `Revise` / `Build`）。改这卡片时请按这条分界线判断哪边能动。

**测试边界：** `PendingPromptCard.test.tsx` 是**静态渲染断言**，只验证「渲染出了哪些文案/标记」，不能验证点击。点击语义由 `pendingPromptAnswers.test.ts` 以纯函数形式覆盖（这是唯一能在本仓库测到它们的方式）。浏览器手测留给 Task 13。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/PendingPromptCard.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { PendingPermissionRequest } from '../chat/types/types';

import { PendingPromptCard } from './PendingPromptCard';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const render = (
  request: PendingPermissionRequest,
  nowMs = NOW,
): string =>
  renderToStaticMarkup(
    <PendingPromptCard
      request={request}
      nowMs={nowMs}
      timeoutMs={TIMEOUT}
      onRespond={() => {}}
    />,
  );

test('AskUserQuestion：渲染每个选项的 label 与 description，且标注不会超时', () => {
  const html = render({
    requestId: 'r1',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [{
        question: 'AppContent 的订阅怎么处理？',
        header: '订阅',
        options: [
          { label: '全部收敛进 store', description: '订阅集中一处' },
          { label: '只收敛弹窗那条', description: '改动最小' },
        ],
      }],
    },
  });

  assert.match(html, /AppContent 的订阅怎么处理/);
  assert.match(html, /全部收敛进 store/);
  assert.match(html, /订阅集中一处/);
  assert.match(html, /只收敛弹窗那条/);
  assert.match(html, /不会超时/);
  assert.doesNotMatch(html, /自动拒绝/);
});

test('ExitPlanMode：渲染计划内容与两个动作，标注不会超时', () => {
  const html = render({
    requestId: 'r2',
    toolName: 'ExitPlanMode',
    receivedAt: new Date(NOW),
    input: { plan: '1. 收紧 store 订阅\n2. 角标等级派生' },
  });

  assert.match(html, /1\. 收紧 store 订阅/);
  assert.match(html, /角标等级派生/);
  assert.match(html, /不会超时/);
});

test('普通工具：渲染工具名与命令原文，并给出倒计时', () => {
  const html = render({
    requestId: 'r3',
    toolName: 'Bash',
    receivedAt: new Date(NOW),
    input: { command: 'git commit -m "fix(csv)"' },
  });

  assert.match(html, /Bash/);
  assert.match(html, /git commit/);
  assert.match(html, /60 秒后自动拒绝/);
});

test('普通工具剩余不足 25 秒：换紧迫文案', () => {
  const html = render(
    { requestId: 'r4', toolName: 'Bash', receivedAt: new Date(NOW), input: { command: 'ls' } },
    NOW + 40_000,
  );
  assert.match(html, /即将自动拒绝（20 秒）/);
});

test('缺少 receivedAt 的普通工具：退回「不会超时」而不是编倒计时', () => {
  const html = render({ requestId: 'r5', toolName: 'Bash', input: { command: 'ls' } });
  assert.match(html, /不会超时/);
});

test('「总是允许」旁标注仅本次会话有效', () => {
  const html = render({
    requestId: 'r6',
    toolName: 'Bash',
    receivedAt: new Date(NOW),
    input: { command: 'ls' },
  });
  assert.match(html, /仅本次会话有效/);
});

test('未知工具名不崩，退化为通用授权卡', () => {
  const html = render({
    requestId: 'r7',
    toolName: 'UnknownTool',
    receivedAt: new Date(NOW),
    input: {},
  });
  assert.ok(html.length > 0);
  assert.match(html, /UnknownTool/);
});

// 多选与单选的判据都是**静态**标记，不靠点击：多选每题有一个显式「提交选择」
// 确认按钮与方框选择符，单选没有（它点一下就走）。点了之后发出去的确是
// 「, 」连接的串 —— 那部分在 pendingPromptAnswers.test.ts 里测，因为
// 这里没有 DOM 可以模拟点击。
test('multiSelect: true 渲染方框选择符与「提交选择」确认按钮', () => {
  const html = render({
    requestId: 'r8',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [{
        question: '哪些地方要一起改？',
        header: '范围',
        multiSelect: true,
        options: [
          { label: '弹窗', description: 'AppContent' },
          { label: '工具栏', description: '加一个开关' },
        ],
      }],
    },
  });

  assert.match(html, /哪些地方要一起改/);
  assert.match(html, /可多选/);
  assert.match(html, /提交选择/);
  // 方框（未选中态）而不是单选的实心点：用户得能一眼看出这里可以选好几个。
  assert.match(html, /☐/);
  assert.doesNotMatch(html, /●/);
  // 确认按钮在，且因为一项都没选而禁用 —— 选中态才解锁。
  assert.match(html, /disabled=""/);
  // 「可多选」与计数里的「点一下取消」都重复出现，所以计数断言放共存用例里做。
});

test('单选问题不渲染确认按钮（保持一击即发）', () => {
  const html = render({
    requestId: 'r9',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [{
        question: '哪个方案？',
        options: [{ label: '甲' }, { label: '乙' }],
      }],
    },
  });

  assert.match(html, /哪个方案/);
  assert.doesNotMatch(html, /提交选择/);
  assert.doesNotMatch(html, /☐/);
});

test('同一张卡里单选与多选共存：只有多选那题带确认按钮，且只出现一次', () => {
  const html = render({
    requestId: 'r10',
    toolName: 'AskUserQuestion',
    receivedAt: new Date(NOW),
    input: {
      questions: [
        { question: '第一题（单选）', options: [{ label: '甲' }] },
        { question: '第二题（多选）', multiSelect: true, options: [{ label: '乙' }] },
      ],
    },
  });

  assert.match(html, /第一题（单选）/);
  assert.match(html, /第二题（多选）/);
  // 确认按钮与「可多选」提示都只属于多选那一题；单选那题仍是实心点。
  assert.equal(html.match(/提交选择/g)?.length, 1);
  assert.equal(html.match(/可多选/g)?.length, 1);
  assert.match(html, /●/);
  assert.match(html, /☐/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptCard.test.tsx`
Expected: FAIL —— `Cannot find module './PendingPromptCard'`

- [ ] **Step 3: 写最小实现**

先写 `web/src/components/tasks/pendingPromptAnswers.ts`（点击语义的纯函数，见上「修正 3」）。下面是它的**最终**内容，与仓库里的文件逐字节一致：

```ts
import type { Question } from '../chat/types/types';

/**
 * 提问卡片的「点一下之后」全部语义。纯函数，无 React 依赖。
 *
 * 为什么要搬出组件：本仓库的 web 测试是 `node:test` + `renderToStaticMarkup`
 * （无 DOM、不能模拟点击）。点击语义若留在组件的 `onClick` 闭包里，**任何**
 * 改法都测不到 —— 包括把「单选替换」误写成「切换」、把「多选等确认」误写成
 * 「一击即发」、把「答满全部题目才提交」整个删掉。这三种错法在静态标记上都
 * 看不出来（按钮还在、文案还在），但它们会改变**发给模型的答案**。所以这里
 * 把「点一下会发生什么」整体收进可测的纯函数，组件只剩接线。
 *
 * **与聊天页 `AskUserQuestionPanel` 的关系分两层，别混：**
 *
 * *答案载荷*逐字一致：`Record<questionText, answer>`、多选 `join(', ')`、保点击
 * 顺序、未作答的题不出现在 `answers` 里。模型读的是这个串，两边必须一样。
 *
 * *交互*是**故意不一样**的。聊天页是个多步对话框：选项点击只调 `toggleOption`
 * （`AskUserQuestionPanel.tsx:228`，不提交），提交发生在页脚那个常驻按钮上
 * （`:362` 的 `handleSubmit`），键盘路径还要额外按一次 Enter（`:120`）。它撑得起
 * 这套东西是因为有常驻页脚与分层键盘。本卡片是 428px 侧栏里的一张紧凑卡，没有
 * 页脚的位置；为了最常见的一题单选再逼用户点第二下是纯粹的摩擦。所以这里：
 * **单选点一下即选中并提交**，多选点一下只切换、必须按卡片自己的「提交选择」。
 *
 * 两边**唯一**真实一致的地方是答案载荷（上面那段）。连「答满全部题目才提交」
 * 也**不**是共有的：聊天页的 Next 按钮没有 disabled（`:366-378`），非末题的
 * Enter 也是无条件前进（`:120`），末页 Submit 的 disabled 只看**当前这一题**
 * 有没有选（`:363`）—— 所以聊天页可以带着未作答的前序题目提交，`buildAnswers`
 * 只把有选的写进 `answers`。本卡片的全答完闸门比它**更严**，这是刻意的：
 * 一份缺项的答案会让模型的提问被静默吞掉，宁可不让点。
 */

/** 选择状态：题目原文 → 已选 label（保点击顺序）。 */
export type PickedState = Record<string, string[]>;

function pickLabels(question: Question, picked: PickedState): string[] {
  return picked[question.question] ?? [];
}

/**
 * 点一个选项后的新选择集，返回新数组。
 *
 * 多选 → 切换（已在里面就移除，否则追加）。
 * 单选 → **替换**成只含这一个。这是这张卡片的语义核心：单选点第二下是
 * 「改主意」，多选点第二下是「加一个」。单选若误走切换，界面照样高亮，
 * 但发出去的答案会多出一项 —— 模型拿到用户并没想要的组合。
 *
 * 模式判据是严格 `=== true`：模型传下来的 input 不受本仓库类型约束，
 * 一个真值（`1`、`'true'`）不该把单选的答案形状带偏。
 *
 * **不排序**：聊天页的 `Set` 按插入序迭代，先点「工具栏」再点「弹窗」，
 * 发出去的就必须是「工具栏, 弹窗」。排序看着整齐，但那是替用户重排他的
 * 选择 —— 多选问答里顺序本身可能带倾向性（先选的往往是首选）。
 */
export function applyPick(picks: readonly string[], label: string, question: Question): string[] {
  if (question.multiSelect !== true) {
    return [label];
  }
  return picks.includes(label) ? picks.filter((pick) => pick !== label) : [...picks, label];
}

/**
 * 点某一题的某个选项的**完整结果**：新状态，以及「现在该不该提交」。
 *
 * `submit` 的判据有两条，缺一不可：
 *  - 这一题是单选 —— 单选在本卡片上是「点完即发」（见文件头：这是**刻意的**交互
 *    差异，不是聊天页的行为）；多选必须等用户按「提交选择」，否则多选就退化成
 *    单选的一击即发（用户本可以再点几个）。
 *  - 全部题目都已有选择 —— 提前提交会让后端拿到一份缺项的答案，模型的提问
 *    就等于被吞了。
 */
export function nextSelection(
  picked: PickedState,
  questions: readonly Question[],
  questionIndex: number,
  label: string,
): { picked: PickedState; submit: boolean } {
  const question = questions[questionIndex];
  if (!question) {
    return { picked, submit: false };
  }

  const next: PickedState = {
    ...picked,
    [question.question]: applyPick(pickLabels(question, picked), label, question),
  };

  const allAnswered = questions.every((item) => (next[item.question] ?? []).length > 0);
  return { picked: next, submit: allAnswered && question.multiSelect !== true };
}

/**
 * 状态 → 提交给后端的 `answers`：题目原文 → 答案串。
 *
 * 连接符必须是 `', '`，与聊天页的 `join(', ')` 逐字一致 —— 模型读的是这个串。
 * 单选是它的退化情形（单元素数组），两条路共用同一个形状，避免单选/多选发出
 * 去的答案在结构上分叉。
 *
 * **没有作答的题目不写进结果**：`answers` 里缺一个 key 与被写进空串不是一回事。
 * 混合卡（A 单选未答 + B 多选）里 B 的「提交选择」是静态可点的，如果这里把 A
 * 写成 `''`，「答满全部题目才提交」那条原则就只守住了单选的路 —— 先答多选、
 * 后答单选时仍会发出一份缺项的答案。
 */
export function formatAnswers(picked: PickedState, questions: readonly Question[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const labels = pickLabels(question, picked);
    if (labels.length > 0) {
      answers[question.question] = labels.join(', ');
    }
  }
  return answers;
}
```

再写 `web/src/components/tasks/PendingPromptCard.tsx`（只负责接线）：

```tsx
import { useState, type ReactNode } from 'react';

import type { PendingPermissionRequest, Question } from '../chat/types/types';
import {
  buildClaudeToolPermissionEntry,
  formatToolInputForDisplay,
} from '../chat/utils/chatPermissions';

import { formatCountdown, remainingSeconds } from './panelPermission';
import { formatAnswers, nextSelection, type PickedState } from './pendingPromptAnswers';
import type { PendingDecision } from './useSessionPendingRequests';

export interface PendingPromptCardProps {
  request: PendingPermissionRequest;
  /** 由父级注入的「现在」，好让倒计时可测且统一节拍。 */
  nowMs: number;
  timeoutMs: number;
  onRespond: (requestId: string, decision: PendingDecision) => void;
}

/** 交互类工具在 claude 通道下没有超时 —— 判据在 panelPermission，别在此另判。 */
const PLAN_TOOL_NAMES = new Set(['ExitPlanMode', 'exit_plan_mode']);

const cardShell = 'flex flex-col gap-2.5 rounded-lg border border-info/40 bg-info/5 p-3';

function Badge({ tone, children }: { tone: 'question' | 'plan' | 'approval'; children: ReactNode }) {
  const cls =
    tone === 'plan'
      ? 'bg-info text-info-foreground'
      : 'bg-warning text-warning-foreground';
  return <span className={`rounded-full px-2 py-0.5 text-3xs font-semibold ${cls}`}>{children}</span>;
}

/**
 * 超时提示。
 *
 * 只在这里出现「自动拒绝」四个字：交互类工具（AskUserQuestion / ExitPlanMode）
 * 与缺 `receivedAt` 的请求都拿不到剩余秒数，此时说一句「不会超时」比编一个
 * 倒计时诚实 —— 倒计时是「再不管就要失败」的告警，报错了比不报更坏。
 */
function TimeoutHint({ request, nowMs, timeoutMs }: { request: PendingPermissionRequest; nowMs: number; timeoutMs: number }) {
  const seconds = remainingSeconds(request, nowMs, timeoutMs);

  if (seconds === null) {
    return <span className="ml-auto text-3xs text-muted-foreground">不会超时 · 等着你</span>;
  }

  const urgent = seconds < 25;
  return (
    <span
      className={`ml-auto rounded-full border px-2 py-0.5 text-3xs font-semibold ${
        urgent
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border bg-muted text-muted-foreground'
      }`}
    >
      {formatCountdown(seconds)}
    </span>
  );
}

/**
 * AskUserQuestion：逐题列选项。
 *
 * 答案载荷 `Record<questionText, answer>` 与聊天页的 `AskUserQuestionPanel` 一致：
 * 多选把 label 用 `', '` 拼成一串，单选就是 label 本身（`formatAnswers`）。
 * 两种模式都**答满全部题目才提交** —— 提前提交会让后端拿到一份缺项的答案，模型
 * 的提问就等于被吞了。（这条比聊天页更严：那边可以带着未作答的前序题目前进，
 * 见 `pendingPromptAnswers.ts` 的文件头。）
 *
 * 交互**不是**聊天页的样子，这是刻意的：聊天页选项点击不提交（提交在页脚的
 * Submit/Next，见 `AskUserQuestionPanel.tsx:362`），因为它有常驻页脚与键盘层；
 * 本卡片没有页脚的位置，单选点一下即选中并提交（若其余题目也已答完）以省掉
 * 那第二下，多选点一下是**切换**（再点取消）、必须按「提交选择」才发出。会给
 * 模型一个多选问题时，用户的意图就是「可以选好几个」—— 单选式的一击即发会让
 * 模型拿到一个偏窄的答案，而界面上没有任何东西提示他本可以多选。
 *
 * 这些点击语义**全部**在 `pendingPromptAnswers.ts` 里（有 node:test 覆盖）——
 * 本文件只负责接线：本仓库的 web 测试没有 DOM、不能模拟点击，逻辑留在这个
 * `onClick` 闭包里就等于没有任何测试碰得到它。**代价**：接线本身（`pick` /
 * `respondWith`）测不到，见该文件与计划 Task 4 Step 6 的边界说明。
 *
 * 刻意**不**移植聊天页的键盘层（1-9 选号、0 = Other、Enter = 前进/提交、
 * Esc = 跳过）与 Back/Next 分步器：任务面板是鼠标优先、且还没有焦点模型，
 * 抄一套半吊子的键盘处理只会制造「有的键有效有的键没效」的错觉。
 *
 * 「Other」自由输入也不做：它需要一个受控 input + 焦点管理，超出本卡片的
 * 范围；聊天页那边仍然由 AskUserQuestionPanel 提供。
 */
function AskUserQuestionBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { questions?: Question[] } | undefined;
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  /** 选择状态。题型差异与「该不该提交」的判断全在 pendingPromptAnswers（有测试）。 */
  const [picked, setPicked] = useState<PickedState>({});

  if (questions.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground">
        这条提问没有可选项，可以直接在下方输入回复。
      </p>
    );
  }

  const respondWith = (state: PickedState) => {
    onRespond(request.requestId, {
      allow: true,
      updatedInput: { ...(input ?? {}), answers: formatAnswers(state, questions) },
    });
  };

  const pick = (questionIndex: number, label: string) => {
    const result = nextSelection(picked, questions, questionIndex, label);
    setPicked(result.picked);
    if (!result.submit) {
      return;
    }
    respondWith(result.picked);
  };

  return (
    <>
      {questions.map((question, questionIndex) => {
        const current = picked[question.question] ?? [];
        const multi = question.multiSelect === true;
        const ready = current.length > 0;
        return (
          <div key={question.question}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs font-semibold text-foreground">{question.question}</span>
              {multi ? <span className="text-3xs text-muted-foreground">可多选</span> : null}
            </div>
            <div
              className="mt-1.5 flex flex-col gap-1"
              role={multi ? 'group' : 'radiogroup'}
              aria-label={question.question}
            >
              {question.options.map((option) => {
                const selected = current.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => pick(questionIndex, option.label)}
                    className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                      selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary'
                    }`}
                  >
                    <span
                      className={`mt-0.5 text-3xs ${selected ? 'text-primary' : 'text-muted-foreground'}`}
                      aria-hidden="true"
                    >
                      {multi ? (selected ? '☑' : '☐') : '●'}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 block text-2xs text-muted-foreground">{option.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {multi ? (
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => respondWith(picked)}
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  提交选择
                </button>
                <span className="text-3xs text-muted-foreground">
                  已选 {current.length} 项 · 再点一下取消
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * ExitPlanMode：计划原文 + 两个动作。
 *
 * **决定的载荷**与聊天页 `PlanDisplay` 逐字一致：`{ allow: false, message:
 * 'User asked to revise the plan' }` 与 `{ allow: true }`。前者是给**模型**读的
 * 协议指令（`PlanDisplay.tsx` 的 `handleRevise` 同一串，模型据此知道要改计划），
 * 拼错一个字就会静默失效，所以它是本卡片里最不能自由发挥的一处。
 *
 * 按钮**标签**则不同：聊天页是英文 `Revise` / `Build`（`PlanDisplay.tsx` 页脚），
 * 这里按任务面板的中文口径写成「让它改 / 开始执行」。标签只给人看，不影响模型。
 */
function PlanBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { plan?: string } | undefined;
  const plan = typeof input?.plan === 'string' ? input.plan : '';

  return (
    <>
      <div className="max-h-40 overflow-hidden whitespace-pre-wrap rounded-md border border-border bg-card p-2.5 text-2xs leading-relaxed text-card-foreground">
        {plan}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onRespond(request.requestId, { allow: false, message: 'User asked to revise the plan' })
          }
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          ↺ 让它改
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: true })}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          ✓ 开始执行
        </button>
      </div>
    </>
  );
}

/**
 * 通用工具授权。
 *
 * `rememberEntry` 不自己拼格式：用聊天页同一个
 * `buildClaudeToolPermissionEntry`，否则「总是允许」写进 `allowedTools` 的规则
 * 与聊天页写的不是同一条，用户的许可会在两处表现不一致。它只对 `Bash` 产出具
 * 体规则（`git commit -m "..."` → `Bash(git commit:*)`，是**前缀**不是整条命令），
 * 别的工具返回裸工具名，因此这里仅当它返回非空时启用按钮。
 * 按钮**标签**不同（聊天页是 `Allow & remember` / `Allow (saved)`，本卡片是
 * 「总是允许」）—— 标签给人看，载荷才是契约。
 */
function ToolApprovalBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { command?: string } | undefined;
  // command 是字符串就显示原文；否则回退到 JSON —— formatToolInputForDisplay 内
  // 部已 try/catch，循环引用不会让渲染炸掉。
  const commandText =
    typeof input?.command === 'string' ? input.command : formatToolInputForDisplay(request.input);
  const rememberEntry = buildClaudeToolPermissionEntry(
    request.toolName,
    formatToolInputForDisplay(request.input),
  );

  return (
    <>
      <div className="rounded-md border border-border bg-card p-2.5">
        <div className="text-xs font-semibold text-foreground">{request.toolName}</div>
        <pre className="mt-1.5 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-2xs text-card-foreground">
          {commandText}
        </pre>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onRespond(request.requestId, { allow: false, message: 'User denied tool use' })
          }
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-muted"
        >
          ✕ 拒绝
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: true })}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          ✓ 允许一次
        </button>
        <button
          type="button"
          disabled={!rememberEntry}
          onClick={() => {
            if (rememberEntry) {
              onRespond(request.requestId, { allow: true, rememberEntry });
            }
          }}
          className="rounded-md bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          ✓ 总是允许
        </button>
      </div>
      <div className="text-3xs text-muted-foreground">
        「总是允许」把它加进 <code className="rounded bg-muted px-1">allowedTools</code>，
        <strong className="font-semibold">仅本次会话有效</strong>，后续同类不再问。
      </div>
    </>
  );
}

/**
 * 单条待办。按 toolName 分派到三种形态。
 *
 * 为什么不用聊天页的 `AskUserQuestionPanel` / `PlanDisplay`：前者是纯 props 驱动
 * 的、技术上能用（`permissionPanelRegistry` 就是按 props 接的），但它是带常驻
 * 页脚与键盘层的多步对话框，塞进 428px 侧栏就散架；后者根本不能用 —— 它从
 * `PermissionContext` 取待办，而那个 Provider 只存在于 `ChatInterface` 内部，
 * 本面板在任务详情里，不在其组件树下。为了给倒计时这类新信息一个落脚点、并
 * 让布局适配侧栏，这里统一自绘。
 */
export function PendingPromptCard({ request, nowMs, timeoutMs, onRespond }: PendingPromptCardProps) {
  const isQuestion = request.toolName === 'AskUserQuestion';
  const isPlan = PLAN_TOOL_NAMES.has(request.toolName);

  const title = isQuestion
    ? '它在等你回答'
    : isPlan
      ? '它写好计划了，等你点头'
      : '要执行一个写操作';

  return (
    <div className={cardShell}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isQuestion ? 'question' : isPlan ? 'plan' : 'approval'}>
          {isQuestion ? '需要选择' : isPlan ? '计划待批准' : '需要授权'}
        </Badge>
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <TimeoutHint request={request} nowMs={nowMs} timeoutMs={timeoutMs} />
      </div>

      {isQuestion ? <AskUserQuestionBody request={request} onRespond={onRespond} /> : null}
      {isPlan ? <PlanBody request={request} onRespond={onRespond} /> : null}
      {isQuestion || isPlan ? null : <ToolApprovalBody request={request} onRespond={onRespond} />}
    </div>
  );
}

export default PendingPromptCard;
```

- [ ] **Step 4: 写第二个测试文件**

创建 `web/src/components/tasks/pendingPromptAnswers.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Question } from '../chat/types/types';

import { applyPick, formatAnswers, nextSelection } from './pendingPromptAnswers';

/** 只关心模式的题目替身：这些用例测的是模式分派，不是题面文案。 */
const singleQ = { question: '它', options: [{ label: '甲' }] };
const singleFalseQ = { question: '它', options: [{ label: '甲' }], multiSelect: false };
const multiQ = { question: '它', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] };
const secondQ = { question: '另一题', options: [{ label: '乙' }] };

test('多选：新 label 追加到末尾，保留点击顺序', () => {
  let picks: string[] = [];
  picks = applyPick(picks, '弹窗', multiQ);
  picks = applyPick(picks, '工具栏', multiQ);
  assert.deepEqual(picks, ['弹窗', '工具栏']);
});

test('多选：再点同一个 label 会移除它', () => {
  assert.deepEqual(applyPick(['弹窗', '工具栏'], '弹窗', multiQ), ['工具栏']);
});

test('多选：不改动别的 label 的顺序（聊天页是插入序，不是字典序）', () => {
  assert.deepEqual(applyPick(['b', 'a'], 'c', multiQ), ['b', 'a', 'c']);
});

test('多选：重复点同一个 label 两次回到起点', () => {
  assert.deepEqual(applyPick(applyPick([], '甲', multiQ), '甲', multiQ), []);
});

test('单选：点第二个 label 是替换而不是追加', () => {
  // 这张卡片最容易写错的一处：单选若误走切换，界面照样高亮，但答案会多一项。
  assert.deepEqual(applyPick(['甲'], '乙', singleQ), ['乙']);
  assert.deepEqual(applyPick(['甲'], '乙', singleFalseQ), ['乙']);
});

test('单选：再点已选中的 label 仍是选中它，不会被取消到一个空集合', () => {
  // 聊天页单选走 clear+add，点已选项的结果还是「选中它」；切换式实现会变成空。
  assert.deepEqual(applyPick(['甲', '乙'], '甲', singleQ), ['甲']);
});

test('multiSelect 缺失或为 false 都走单选 —— 只有严格 true 才是多选', () => {
  // 后端/模型传下来的 input 不受本仓库类型约束，`1`、`'true'` 都可能出现
  // （下面两个 cast 就是故意的：它们在类型上不合法，在运行时却到得了这里）。
  const malformed = [{ multiSelect: 1 }, { multiSelect: 'true' }] as unknown as Question[];
  for (const question of [singleQ, singleFalseQ, ...malformed]) {
    assert.deepEqual(
      applyPick(['甲'], '乙', question as Question),
      ['乙'],
      JSON.stringify(question),
    );
  }
});

test('nextSelection：单选点一下即提交（且全部题目都答完时）', () => {
  const questions = [singleQ];
  const result = nextSelection({}, questions, 0, '甲');
  assert.deepEqual(result.picked, { 它: ['甲'] });
  assert.equal(result.submit, true);
});

test('nextSelection：单选点了但别的题还没答，不提交', () => {
  const questions = [singleQ, { question: '另一题', options: [{ label: '丙' }] }];
  const result = nextSelection({}, questions, 0, '甲');
  assert.deepEqual(result.picked, { 它: ['甲'] });
  assert.equal(result.submit, false);
});

test('nextSelection：多选点了**不**提交，必须等确认按钮', () => {
  // 这是多选唯一的意义所在：点一下是「选上」，不是「答完」。
  const result = nextSelection({}, [multiQ], 0, '甲');
  assert.deepEqual(result.picked, { 它: ['甲'] });
  assert.equal(result.submit, false);
});

test('nextSelection：多选已选中一项，再点取消回到空 —— 也不提交', () => {
  const first = nextSelection({}, [multiQ], 0, '甲');
  const second = nextSelection(first.picked, [multiQ], 0, '甲');
  assert.deepEqual(second.picked, { 它: [] });
  assert.equal(second.submit, false);
});

test('nextSelection：越界的题目下标不炸，原样返回且不提交', () => {
  const result = nextSelection({}, [singleQ], 5, '甲');
  assert.deepEqual(result.picked, {});
  assert.equal(result.submit, false);
});

test('formatAnswers：用「逗号 + 空格」连接，与聊天页 join(", ") 逐字一致', () => {
  assert.deepEqual(formatAnswers({ 它: ['弹窗', '工具栏'] }, [multiQ]), { 它: '弹窗, 工具栏' });
  assert.deepEqual(formatAnswers({ 它: ['只有一个'] }, [multiQ]), { 它: '只有一个' });
  assert.deepEqual(formatAnswers({}, [multiQ]), {});
});

test('formatAnswers：没作答的题目不写进结果（不是写成空串）', () => {
  // 混合卡里多选的「提交选择」是静态可点的：此时别的题可能还没作答。若这里
  // 把未答的题写成 ''，后端会拿到一份看着「答过了」的缺项答案。
  const questions = [singleQ, secondQ];
  assert.deepEqual(formatAnswers({ 它: ['甲'] }, questions), { 它: '甲' });
  const both = { 它: ['甲'], 另一题: ['乙'] };
  assert.deepEqual(formatAnswers(both, questions), { 它: '甲', 另一题: '乙' });
});

test('formatAnswers：单选与多选共用同一形状（单选是单元素退化情形）', () => {
  // 钉住前提：哪天有人把单选特化成别的形状（例如包一层数组字面量），两种模式
  // 发出去的答案就分叉了，而聊天页与后端只认这一种。
  assert.deepEqual(formatAnswers({ 它: ['甲'] }, [singleQ]), { 它: '甲' });
  assert.deepEqual(
    formatAnswers(nextSelection({}, [singleQ], 0, '甲').picked, [singleQ]),
    { 它: '甲' },
  );
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptCard.test.tsx src/components/tasks/pendingPromptAnswers.test.ts`
Expected: PASS —— `# pass 24`、`# fail 0`

- [ ] **Step 6: 变异核对（这类断言到底抓得住什么）**

逐条改坏、确认有测试变红，再改回（本仓库没有 mutation runner，手工做）：

| 改法 | 预期变红的用例 |
| --- | --- |
| 倒计时改回渲染裸数字（`formatCountdown(seconds)` → `{seconds}`） | 普通工具的两条 |
| 无超时分支编一个倒计时 | 全部「不会超时」用例 |
| `multiSelect` 恒为 false（卡片不再渲染确认按钮与方框） | 多选的两条 |
| 单/多选标记符互换 | 多选那条 + 单选那条 |
| `applyPick` 去掉 `if (multiSelect !== true)`（单选也走切换） | 单选的三条 |
| 单选也允许点一下取消（`[label]` → 切换） | 「再点已选中的 label」 |
| `question.multiSelect !== true` 写成 `!question.multiSelect`（宽松真值） | 「只有严格 true 才是多选」 |
| `join(', ')` 写成 `join(',')` | 分隔符那条 |
| `[...picks, label]` 加 `.sort()` | 保序的两条 |
| `nextSelection` 去掉 `question.multiSelect !== true`（多选也一击即发） | 「多选点了不提交」 |
| `nextSelection` 去掉 `allAnswered &&`（缺项也提交） | 「其它题还没答，不提交」 |
| `nextSelection` 去掉越界守卫 | 越界那条（抛错） |
| `formatAnswers` 把未作答写成 `''` | 「没作答的题目不写进结果」+ 分隔符那条 |

**实测结果**（2026-09-28 手工跑，改坏 → 跑 → 改回 → 逐字节 diff 确认还原）：上表每一行都至少让一条用例变红，没有一行是「改坏了却全绿」。其中前三表面上的「卡片静态标记」格（倒计时 / 无超时 / 多选确认按钮 / 标记符）只证明**渲染**对，点击语义那几格才是真正守住答案形状的东西 —— 所以 `pendingPromptAnswers.ts` 的存在本身是这张表的前提：没有它，表里后八行改坏之后静态断言**全绿**。

**接线层：这是一条边界，不是一个缺口。** 上表覆盖不到 `pick()` / `respondWith()` 的接线本身（把 `nextSelection` 的返回值丢掉、把 `questionIndex` 传成常量、按钮 `onClick` 接到空函数）。这不是「漏测」—— 它是本仓库无 DOM 环境的固有边界，而且这一层的规模使它可以被**读**完：`PendingPromptCard.tsx` 里 `pick` 与 `respondWith` 两个函数体合计约 12 行，没有分支、没有状态机，逐行读一遍即可判定对错。评审这一层请直接读那 12 行，不要指望测试。

**残留风险一句话**：静态渲染测试证明**按钮在**，纯函数测试证明**决定是对的**，但没有任何自动化测试证明**按钮接的是对的决定** —— 那道缝就是 Task 13 的浏览器核对项 17-20。

`nextSelection` / `applyPick` / `formatAnswers` 这三组语义**没有静态标记**可断言，所以它们的守卫就是上面这张表 —— 六格覆盖（多选/单选 × 提交/不提交 × 缺项 × 越界）。

- [ ] **Step 7: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 8: 提交**

```bash
git add web/src/components/tasks/PendingPromptCard.tsx web/src/components/tasks/PendingPromptCard.test.tsx \
        web/src/components/tasks/pendingPromptAnswers.ts web/src/components/tasks/pendingPromptAnswers.test.ts
git commit -m "feat(tasks): render a single pending approval as a dispatchable card"
```

## Task 5: 待办区（队列条 + 空态）

**Files:**
- Create: `web/src/components/tasks/PendingPromptList.tsx`
- Create: `web/src/components/tasks/pendingPromptQueue.ts`（纯函数，见下）
- Test: `web/src/components/tasks/PendingPromptList.test.tsx`
- Test: `web/src/components/tasks/pendingPromptQueue.test.ts`

**背景：** 队列长度 > 1 才渲染队列条（单条时更干净）；只渲染当前那一条的完整卡片，其余显示为队列步骤。

> **与初稿的偏离（已按实测更正，见本段末尾的证据）：** 初稿把「谁是当前」做成了组件内
> 的 `useState` 下标 + clamp effect，并在 `handleRespond` 里乐观推进。那台状态机是**死的**：
> `setIndex` 只在 `handleRespond` 里被调用，而它读的 `previous` 恒为最初那个 0，于是
> `Math.min(previous, sorted.length - 2)` 在长度 ≥2 时恒等于 0 —— 没有任何东西能推动下标，
> 「当前」永远是队头。而真正让队列前移的是**父级**：`useSessionPendingRequests.respond`
> 已把答掉的那条从 `pendingRequests` 里摘掉（乐观移除，`useSessionPendingRequests.ts:183`），
> 父级重渲染即新的入参，队头自然换人。因此本任务改为**从入参直接派生**：`current = sorted[0]`，
> 无本地状态。这既与那台下标的**唯一可达行为**等价，又不会在父级改主意（后端纠正）时与真源错位。
> 决定逻辑随之全部移进 `pendingPromptQueue.ts`（纯函数），因为 web 测试无 DOM、无法驱动重渲染，
> 留在组件里就测不到 —— 与 Task 4 把点击语义移进 `pendingPromptAnswers.ts` 同一条纪律。
>
> **证据：** 初稿的测试 5 与初稿实现一起跑是 **fail 1 / pass 4**（已复现）。它的断言
> `cmdIndex < html.indexOf('还有 2 件事等你') || cmdIndex < questionIndex` 在初稿那份渲染里
> **两个子句都是 false**：`echo b1` 在 1627，队列条在 243，题面在 850。所以它是**因为错误的
> 理由挂掉**的，而不是「后半段恒真、所以空转」。反过来说，把排序整个删掉会让它**通过** ——
> 那时 `echo b1` 根本不进 DOM，`indexOf` 返回 -1，`-1 < 243` 为真。可见这条断言跟踪的是
> 「命令原文在不在」，而不是「会超时的那条排第一」。
> 同一批里**真正恒真**的是测试 4（`assert.match(html, /问题 a1/)`）：题面在队列行里也出现，
> 无论谁当当前项它都过。
> 见下方 Step 1 里重写的断言。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/pendingPromptQueue.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PendingPermissionRequest } from '../chat/types/types';

import { pendingQueueView, summarizePendingRequest } from './pendingPromptQueue';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const ask = (id: string, question = `问题 ${id}`): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'AskUserQuestion',
  receivedAt: new Date(NOW),
  input: { questions: [{ question, options: [{ label: '好' }] }] },
});

/** 已过去 `agoMs` 的普通工具 —— 剩余时间就是 `TIMEOUT - agoMs`。 */
const bash = (id: string, agoMs: number): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'Bash',
  receivedAt: new Date(NOW - agoMs),
  input: { command: `echo ${id}` },
});

const view = (requests: PendingPermissionRequest[]) => pendingQueueView(requests, TIMEOUT);

test('零条待办：current 为 null，且不显示队列条', () => {
  const result = view([]);
  assert.equal(result.current, null);
  assert.equal(result.showQueue, false);
});

test('单条待办：不显示队列条（队里只有一条不是队）', () => {
  const result = view([ask('a1')]);
  assert.equal(result.current?.requestId, 'a1');
  assert.equal(result.showQueue, false);
});

test('两条待办：显示队列条', () => {
  assert.equal(view([ask('a1'), ask('a2')]).showQueue, true);
});

// 这一条钉的是**当前项的推导方式**：它是排序后的队头，不是入参数组的第一项，
// 也不是最后一项。曾经的计划稿用「入参下标 + clamp effect」来推当前项，下标
// 恒为 0（没有任何交互能推动它），那套状态机是死的；队头推导既等价又不需要
// 任何状态，队列前移也就不用额外代码。
test('current 是队头（会超时的排最前），不是数组第一项、也不是最后一项', () => {
  const result = view([ask('a1'), bash('b1', 50_000)]);
  assert.equal(result.sorted[0].requestId, 'b1');
  assert.equal(result.sorted[1].requestId, 'a1');
  assert.equal(result.current?.requestId, 'b1');
});

// 「答完一条自动前移」不需要任何本地状态：父级是唯一真源，它把答掉的那条从
// 数组里摘掉之后，队头自然换了人。这里模拟的就是父级摘完之后的入参。
test('父级摘掉已答的那条后，队头前移；只剩一条时队列条随之消失', () => {
  const before = view([ask('a1'), bash('b1', 50_000)]);
  assert.equal(before.current?.requestId, 'b1');

  const after = view([ask('a1')]);
  assert.equal(after.current?.requestId, 'a1');
  assert.equal(after.showQueue, false);
});

test('摘要：AskUserQuestion 用第一道题面', () => {
  assert.equal(summarizePendingRequest(ask('a1', 'AppContent 的订阅怎么处理？')), '回答「AppContent 的订阅怎么处理？」');
});

// 输入形状不可信时给一句兜底，别把 undefined / 空串拼进界面。
test('摘要：AskUserQuestion 的 input 形状不对时兜底，不抛也不拼 undefined', () => {
  const malformed: PendingPermissionRequest[] = [
    { ...ask('a1'), input: undefined },
    { ...ask('a2'), input: {} },
    { ...ask('a3'), input: { questions: [] } },
    { ...ask('a4'), input: { questions: [{ options: [] }] } },
    { ...ask('a5'), input: { questions: 'not-an-array' } },
    { ...ask('a6'), input: { questions: [{}] } },
  ];
  for (const request of malformed) {
    assert.equal(summarizePendingRequest(request), '回答一个问题');
  }
});

test('摘要：计划工具的两个拼写都给同一句话', () => {
  const plan = { requestId: 'p1', toolName: 'ExitPlanMode', receivedAt: new Date(NOW), input: { plan: '1. 收紧 store 订阅' } };
  const snake = { ...plan, requestId: 'p2', toolName: 'exit_plan_mode' };
  assert.equal(summarizePendingRequest(plan), '确认它写的计划');
  assert.equal(summarizePendingRequest(snake), '确认它写的计划');
});

test('摘要：普通工具带上工具名', () => {
  assert.equal(summarizePendingRequest(bash('b1', 0)), '允许 Bash 执行');
});
```

创建 `web/src/components/tasks/PendingPromptList.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { PendingPermissionRequest } from '../chat/types/types';

import { PendingPromptList } from './PendingPromptList';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const ask = (id: string, question = `问题 ${id}`): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'AskUserQuestion',
  receivedAt: new Date(NOW),
  input: { questions: [{ question, options: [{ label: '好' }] }] },
});

/** 已过去 `agoMs` 的普通工具 —— 剩余时间就是 `TIMEOUT - agoMs`。 */
const bash = (id: string, agoMs: number): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'Bash',
  receivedAt: new Date(NOW - agoMs),
  input: { command: `echo ${id}` },
});

const render = (requests: PendingPermissionRequest[]): string =>
  renderToStaticMarkup(
    <PendingPromptList requests={requests} nowMs={NOW} timeoutMs={TIMEOUT} onRespond={() => {}} />,
  );

/** 完整卡片的壳体类名（来自 PendingPromptCard 的 `cardShell`）。 */
const CARD_SHELL = 'border-info/40';

test('零条待办：整个待办区不渲染（连空壳都不留）', () => {
  assert.equal(render([]), '');
});

test('单条待办：渲染卡片，但不渲染队列条（一条的「队」是噪音）', () => {
  const html = render([ask('a1')]);
  assert.doesNotMatch(html, /还有 \d+ 件事等你/);
  assert.match(html, /问题 a1/);
});

test('两条待办：渲染队列条并给出总数', () => {
  const html = render([bash('b1', 50_000), ask('a1')]);
  assert.match(html, /还有 2 件事等你/);
});

// 「只完整渲染当前那一条」的判据必须是**卡片独有的**内容，不能拿队列行也会
// 打印的题面/命令原文来断言 —— 那些字符串在队列行里也出现，断言恒真。
// 卡片壳体只该出现一次，非当前项的那张不该存在。
test('两条待办：只完整渲染当前那一条卡片，其余不在卡片形态里出现', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);

  assert.equal(html.split(CARD_SHELL).length - 1, 1);

  // 当前项是 b1（会超时，排最前）—— 卡片里是它的工具授权形态。
  assert.match(html, /要执行一个写操作/);
  assert.match(html, /echo b1/);

  // a1 只在队列行里以短描述出现，绝不以卡片形态出现。
  assert.match(html, /回答「问题 a1」/);
  assert.doesNotMatch(html, /它在等你回答/);
});

test('当前项是会超时的那条，且它的倒计时出现在卡片里', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);

  // 卡片的 TimeoutHint 用 formatCountdown；剩余 10 秒 → 紧迫措辞。
  assert.match(html, /即将自动拒绝（10 秒）/);
  // 永不超时的 a1 在队列行里说「不会超时」。
  assert.match(html, /不会超时/);
});

test('队列行按超时时刻升序：越快到期排越前', () => {
  const html = render([ask('a1'), bash('b1', 50_000), bash('b2', 10_000)]);

  // b1 已过 50 秒 → 只剩 10 秒；b2 已过 10 秒 → 还剩 50 秒。
  // 升序即「b1 在前」：10 秒那行必须早于 50 秒那行。
  const ten = html.indexOf('即将自动拒绝（10 秒）');
  const fifty = html.indexOf('50 秒后自动拒绝');
  assert.ok(ten >= 0 && fifty >= 0);
  assert.ok(ten < fifty, '越快到期的排在前面');
});

test('永不超时的请求沉到队底，不会顶掉会超时的当前项', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);

  // 当前卡片是 b1，不是 a1。
  assert.match(html, /echo b1/);
  assert.equal(html.split(CARD_SHELL).length - 1, 1);
  assert.doesNotMatch(html, /它在等你回答/);
});

test('队列行的摘要：普通工具带工具名，交互类工具不等于卡片文案', () => {
  const html = render([ask('a1'), ask('a2')]);

  // 两条都是 AskUserQuestion、都不超时 —— 队头是入参第一条（稳定排序）。
  assert.match(html, /回答「问题 a1」/);
  assert.match(html, /回答「问题 a2」/);
  // 卡片只画一条。
  assert.equal(html.split(CARD_SHELL).length - 1, 1);
});

test('未知工具名不崩，队列行退化为通用摘要', () => {
  const html = render([
    bash('b1', 0),
    { requestId: 'u1', toolName: 'UnknownTool', receivedAt: new Date(NOW), input: {} },
  ]);

  assert.match(html, /允许 UnknownTool 执行/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptList.test.tsx src/components/tasks/pendingPromptQueue.test.ts`
Expected: FAIL —— `Cannot find module './PendingPromptList'`（或 `./pendingPromptQueue`）

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/pendingPromptQueue.ts`：

```ts
/**
 * 待办队列的派生：谁是当前那一条、要不要画队列条、每行写什么。
 *
 * 纯函数，无 React 依赖 —— 本仓库的 web 测试没有 DOM、不能模拟点击，任何留在
 * 组件 `onClick` / 组件状态里的决定都测不到。Task 4 的点击语义就是这么被逼进
 * `pendingPromptAnswers.ts` 的，这里同理。
 *
 * **当前项的推导**：队头（排序后的第一项），不引入任何下标状态。
 * 曾经的计划稿用「入参下标 + clamp effect」：下标从一个从不变化的状态出发，
 * 只有 `handleRespond` 里那行乐观推进动过它 —— 但乐观推进读的又是同一个
 * `index`，它恒为 0，所以整台状态机是死的，队头永远是「当前」。而真正让队列
 * 前移的是**父级**：`useSessionPendingRequests.respond` 已把答掉的那条从
 * `pendingRequests` 里摘掉（乐观移除），父级重渲染即新的入参，队头自然换人。
 * 派生队头既是同一个结果，又不必假设「本地状态」与「父级真源」不会打架 ——
 * 摘除由父级负责时，本地下标还会在父级改主意（比如后端纠正）时错位。
 */

import type { PendingPermissionRequest } from '../chat/types/types';

import { formatCountdown, remainingSeconds, sortPendingRequests } from './panelPermission';

/**
 * 计划类工具的**分派**拼写。这与 `PendingPromptCard.tsx` 里的 `PLAN_TOOL_NAMES`
 * 是同一对：SDK 实际发的是 `ExitPlanMode`，`exit_plan_mode` 是历史/别处的拼写，
 * 前端一律两种都认（见该卡片、`ToolRenderer.tsx:50`、`PlanDisplay.tsx:43`）。
 * 它不是「交互型工具」契约 —— 那份名单在 `autoApproveDeny.ts`，与此无关，
 * 别把两者并成一个。
 */
const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(['ExitPlanMode', 'exit_plan_mode']);

export interface PendingQueueView {
  /** 排序后的队列：会超时的在前（超时时刻升序），永不超时的沉底。 */
  sorted: PendingPermissionRequest[];
  /** 当前要完整渲染的那一条；空队为 null。 */
  current: PendingPermissionRequest | null;
  /** 队列条只在**两条及以上**时画：一条的「队」是噪音。 */
  showQueue: boolean;
}

/** 把一队待办折成「当前项 + 要不要画队列条」。 */
export function pendingQueueView(
  requests: readonly PendingPermissionRequest[],
  timeoutMs: number,
): PendingQueueView {
  const sorted = sortPendingRequests(requests, timeoutMs);
  return {
    sorted,
    current: sorted[0] ?? null,
    showQueue: sorted.length > 1,
  };
}

/**
 * 队列里一行的短描述（非当前项用）。
 *
 * `input` 的形状不可信（它一路从后端帧透传过来），所以每一层都当可能是任意值
 * 来收：拿不到题面就退化成「回答一个问题」，不把 `undefined` 或空串拼进界面。
 */
export function summarizePendingRequest(request: PendingPermissionRequest): string {
  if (request.toolName === 'AskUserQuestion') {
    const input = request.input as { questions?: unknown } | undefined;
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const first = (questions[0] as { question?: unknown } | undefined)?.question;
    return typeof first === 'string' && first ? `回答「${first}」` : '回答一个问题';
  }
  if (PLAN_TOOL_NAMES.has(request.toolName)) {
    return '确认它写的计划';
  }
  return `允许 ${request.toolName} 执行`;
}

/**
 * 队列一行的剩余时间文案。永不超时的请求与卡片口径一致说「不会超时」——
 * 这里刻意不复用卡片的 `TimeoutHint`（那是带边框的胶囊，塞进 11px 的行里会撑破），
 * 但文案复用 `formatCountdown`，免得「自动拒绝」的措辞分头漂开。
 */
export function pendingTimeText(
  request: PendingPermissionRequest,
  nowMs: number,
  timeoutMs: number,
): string {
  const seconds = remainingSeconds(request, nowMs, timeoutMs);
  return seconds === null ? '不会超时' : formatCountdown(seconds);
}
```

创建 `web/src/components/tasks/PendingPromptList.tsx`：

```tsx
import type { PendingPermissionRequest } from '../chat/types/types';

import { PendingPromptCard } from './PendingPromptCard';
import { pendingQueueView, pendingTimeText, summarizePendingRequest } from './pendingPromptQueue';
import type { PendingDecision } from './useSessionPendingRequests';

export interface PendingPromptListProps {
  requests: PendingPermissionRequest[];
  nowMs: number;
  timeoutMs: number;
  onRespond: (requestId: string, decision: PendingDecision) => void;
}

/**
 * 待办区：一个会话的待办队列。
 *
 * 为什么是队列、一次只完整显示一条：一个任务对应一个会话，而后端的
 * `canUseTool` 本就要等这一条答复完才会走到下一个工具（见 `panelPermission.ts`
 * 文件头），所以实际几乎总是只有一条。真出现并发时排成一队逐个答，既不会
 * 挤满 428px 面板，也不会漏掉任何一条。
 *
 * 排序键是「超时时刻」——会超时的（普通工具，60 秒后自动拒绝）排在永远等的
 * （AskUserQuestion / ExitPlanMode）前面，因为只有前者会自己消失。
 *
 * **本组件不含任何决定逻辑**：谁是当前、要不要画队列条、每行写什么，全在
 * `pendingPromptQueue.ts`（有 node:test 覆盖）。本仓库的 web 测试没有 DOM、
 * 不能模拟点击也没法驱动重渲染，任何留在组件状态里的「哪条是当前」都测不到。
 * 组件只负责接线与样式，这也是它能被 `renderToStaticMarkup` 完全钉住的原因。
 */
export function PendingPromptList({ requests, nowMs, timeoutMs, onRespond }: PendingPromptListProps) {
  const { sorted, current, showQueue } = pendingQueueView(requests, timeoutMs);

  if (!current) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {showQueue ? (
        <div className="overflow-hidden rounded-lg border border-warning/40 bg-warning/5">
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/25 px-2.5 py-1.5 text-2xs font-semibold text-warning">
            <span>{`还有 ${sorted.length} 件事等你`}</span>
            <span className="ml-auto font-normal text-muted-foreground">先处理会超时的</span>
          </div>
          {sorted.map((request, i) => (
            <div
              key={request.requestId}
              className={`flex items-center gap-2 px-2.5 py-1.5 text-2xs ${
                i === 0 ? 'bg-warning/10 font-medium text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-secondary text-3xs font-semibold">
                {i + 1}
              </span>
              <span className="min-w-0 truncate">{summarizePendingRequest(request)}</span>
              <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                {pendingTimeText(request, nowMs, timeoutMs)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* key 认 requestId：两条 AskUserQuestion 前后替补时，卡片位置会复用同一个
          组件实例，选中态（PendingPromptCard 里的 picked）会从上一题漏到下一题，
          渲染出一个用户没选过的勾。换 key 强制重挂载即可。 */}
      <PendingPromptCard
        key={current.requestId}
        request={current}
        nowMs={nowMs}
        timeoutMs={timeoutMs}
        onRespond={onRespond}
      />
    </div>
  );
}

export default PendingPromptList;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptList.test.tsx src/components/tasks/pendingPromptQueue.test.ts`
Expected: PASS —— `# pass 18`、`# fail 0`

- [ ] **Step 5: typecheck / eslint**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增（实测 0 错误）

Run: `cd /mnt/b/workdir/github/lovdex/web && npx eslint src 2>&1 | tail -3`
Expected: `0 errors / 227 warnings`（基线不动）

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/PendingPromptList.tsx web/src/components/tasks/PendingPromptList.test.tsx \
        web/src/components/tasks/pendingPromptQueue.ts web/src/components/tasks/pendingPromptQueue.test.ts
git commit -m "feat(tasks): queue a session's pending approvals, timeout-first"
```

---
---

## Task 6: 面板内回复区

**Files:**
- Create: `web/src/components/tasks/panelReplyBox.ts`
- Create: `web/src/components/tasks/TaskPanelReplyBox.tsx`
- Test: `web/src/components/tasks/panelReplyBox.test.ts`
- Test: `web/src/components/tasks/TaskPanelReplyBox.test.tsx`

**背景：** 常用语**只填入不发送**（与 `handleInsertQuickReply` 一致，`web/src/components/chat/hooks/useChatComposerState.ts:1282` 那行注释就是「刻意不自动发送」；函数体在 `:1285`）。数据来自既有的 `useQuickReplies` 钩子与 `api.quickReplies`。

> **实施中发现的两处问题（已按实测更正）**
>
> 1. **计划草稿的断言 `assert.doesNotMatch(html, /disabled/)` 是坏的 —— 它在草稿自己的实现上就失败。**
>    Tailwind 的 `disabled:opacity-45` / `disabled:opacity-50` 类名里含 "disabled" 子串，
>    于是「有没有 disabled」永远为真。实测：草稿的 5 条测试对着草稿实现跑是 **pass 3 / fail 2**
>    （第 2 条与第 5 条挂在 `doesNotMatch` 上）。反过来说，若有人把 `assert.match(html, /disabled/)`
>    当成「发送键被禁用了」的证据，它同样恒真 —— 一条**两头都恒真**的断言。
>    现在改为把范围收到目标元素的开标签上，判定 `disabled=""` 这个**属性**：
>    `isDisabled(textareaTag(html))` / `isDisabled(sendButtonTag(html))`。
> 2. **Enter 发送缺了输入法组合态守卫。** 草稿只判 `key === 'Enter' && !shiftKey`。
>    本仓库是中文优先：输入法里 Enter 是「确认候选词」，少了 `isComposing` 判断，
>    敲「nihao」按 Enter 选词会把半成品候选串当消息发出去。既有两处发送入口都做了
>    这个判断（`useChatComposerState.ts:1228`、`QuickRepliesMenu.tsx:304`），本组件按同一口径补上。
>    注意 React 里它在 `event.nativeEvent.isComposing`，不在合成事件顶层。
>
> **两处主动偏离草稿：**
>
> 1. 决定逻辑全部抽进 `panelReplyBox.ts` 纯函数。本仓库 web 测试无 DOM（不能点、不能派发
>    键盘事件），留在 `onClick` / `onKeyDown` 闭包里的判断没有任何测试碰得到 —— 与 Task 4
>    抽出 `pendingPromptAnswers.ts`、Task 5 抽出 `pendingPromptQueue.ts` 同一条纪律。
>    组件因此只剩接线。
> 2. **placeholder 只描述动作，不复述键位**（草稿是 `'回复这个任务…（Enter 发送）'`）。
>    键位归 `panelReply.ts` 的 `hint` 独家声明，placeholder 再写一份就是第二份副本：换发送
>    模型时两处要一起改，还得改一条钉住那个子串的测试 —— 方向是反的。而聊天页的发送键
>    本身还是**可配置**的（`useUiPreferences` 的 `DEFAULTS.sendByCtrlEnter: true`，在
>    `useChatComposerState.ts:1235` 消费），面板此刻读不到那个偏好，写死任何一个键位只会更错。
>    现在 usable 时是 `'回复这个任务…'`，不可用时仍是 `'无法回复'`。
>
> 两个待决项（开场提出的）定为：**常用语列表为空时整行不渲染**（空行是噪音，
> 且会做出「这里能插片段」的虚假承诺）；**发送键在 `willQueue` 时保持可用**
> （发送只是排队不是禁止，`panelReply.ts` 的 `willQueue` 是提示而非闸门 ——
> 加一道闸门会让执行中的任务永远回不了话）。

- [ ] **Step 1: 写失败的测试（纯函数 + 组件）**

创建 `web/src/components/tasks/panelReplyBox.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReplyState } from './panelReply';
import { canSendReply, isSendKey, shouldSendOnEnter, showQuickReplies } from './panelReplyBox';

/** 只关心「能不能敲/能不能发」的替身；文案由 panelReply 拥有，这里不测。 */
const ready: ReplyState = { mode: 'ready', canType: true, willQueue: false, hint: 'hint' };
const queued: ReplyState = { mode: 'queued', canType: true, willQueue: true, hint: 'hint' };
const noSession: ReplyState = { mode: 'no-session', canType: false, willQueue: false, hint: 'hint' };

/** 一个「普通键盘按下」：非组合态、无 Shift。 */
const key = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  ...over,
});

test('canSendReply：可输入且去掉首尾空白后非空才为真', () => {
  assert.equal(canSendReply(ready, '好的'), true);
  assert.equal(canSendReply(ready, '  好的  '), true);
  assert.equal(canSendReply(ready, ''), false);
});

test('canSendReply：纯空白不算内容（只有空格 / 换行 / 制表符都不发）', () => {
  // 少了 trim 的话这些都会变成「可发」——用户按 Enter 发出一串空白给模型。
  for (const blank of [' ', '   ', '\n', '\n\n', '\t', ' \n\t ']) {
    assert.equal(canSendReply(ready, blank), false, JSON.stringify(blank));
  }
});

test('canSendReply：不可输入的会话一律不能发，哪怕框里有内容', () => {
  // 会话被清理后 value 可能还留着上一轮的草稿：只判 value 会放行一次注定失败的发送。
  assert.equal(canSendReply(noSession, '好的'), false);
});

test('canSendReply：排队态仍可发 —— 发送只是排队，不是被禁止', () => {
  // willQueue 是**提示**不是闸门：后端没有服务端队列，前端替它排队。
  // 若有人把 `&& !willQueue` 加进来，执行中的任务就再也回不了话。
  assert.equal(canSendReply(queued, '好的'), true);
});

test('shouldSendOnEnter：Enter 且非 Shift、非组合态、有内容 —— 发送', () => {
  assert.equal(shouldSendOnEnter(ready, '好的', key()), true);
});

test('shouldSendOnEnter：Shift+Enter 是换行，不发送', () => {
  assert.equal(shouldSendOnEnter(ready, '好的', key({ shiftKey: true })), false);
});

test('shouldSendOnEnter：输入法组合中的 Enter 是选字，不发送', () => {
  // 中文输入法里 Enter 用来确认拼音候选词。少了这个判断，用户敲「nihao」按 Enter
  // 选词就会把半成品的候选串当成消息发出去 —— 这是本仓库（中文优先）的必守项，
  // 两处既有发送入口（useChatComposerState / QuickRepliesMenu）都做了同样的判断。
  assert.equal(shouldSendOnEnter(ready, '好的', key({ isComposing: true })), false);
});

test('shouldSendOnEnter：内容为空或纯空白时 Enter 不发', () => {
  assert.equal(shouldSendOnEnter(ready, '', key()), false);
  assert.equal(shouldSendOnEnter(ready, '   ', key()), false);
});

test('shouldSendOnEnter：别的键不发送', () => {
  assert.equal(shouldSendOnEnter(ready, '好的', key({ key: 'a' })), false);
  assert.equal(shouldSendOnEnter(ready, '好的', key({ key: 'Escape' })), false);
});

test('shouldSendOnEnter：队列中（willQueue）照常发送', () => {
  assert.equal(shouldSendOnEnter(queued, '好的', key()), true);
});

test('isSendKey：只看键与修饰键，与内容无关（内容闸门是 canSendReply 的事）', () => {
  // 这个判据决定要不要 preventDefault —— 组合态里绝不能 preventDefault，
  // 否则会干扰输入法选字。所以「有内容」不参与这里。
  assert.equal(isSendKey(key()), true);
  assert.equal(isSendKey(key({ shiftKey: true })), false);
  assert.equal(isSendKey(key({ isComposing: true })), false);
  assert.equal(isSendKey(key({ key: 'a' })), false);
});

test('showQuickReplies：可用且有条目才显示', () => {
  assert.equal(showQuickReplies(ready, 2), true);
});

test('showQuickReplies：列表为空时整行不渲染（空行是噪音，不承诺可插入）', () => {
  assert.equal(showQuickReplies(ready, 0), false);
});

test('showQuickReplies：会话不可用时连常用语也不给 —— 给一个插不进去的片段比不给更糟', () => {
  assert.equal(showQuickReplies(noSession, 3), false);
});
```

创建 `web/src/components/tasks/TaskPanelReplyBox.test.tsx`：

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ReplyState } from './panelReply';
import { TaskPanelReplyBox } from './TaskPanelReplyBox';

const ready = (over: Partial<ReplyState> = {}): ReplyState => ({
  mode: 'ready',
  canType: true,
  willQueue: false,
  hint: 'Enter 发送 · Shift+Enter 换行',
  ...over,
});

const render = (
  props: Partial<Parameters<typeof TaskPanelReplyBox>[0]> = {},
): string =>
  renderToStaticMarkup(
    <TaskPanelReplyBox
      value=""
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[]}
      replyState={ready()}
      onInsertQuickReply={() => {}}
      {...props}
    />,
  );

/**
 * 取某个具体元素的开标签。
 *
 * **不要**对整页用 `assert.match(html, /disabled/)`：本组件里 Tailwind 的
 * `disabled:opacity-45` / `disabled:opacity-50` 类名里就含 "disabled" 这个子串，
 * 于是「有没有 disabled」永远为真，断言恒过。必须把范围收到目标元素上。
 * 同一文件里可能有多个 `<button>`，所以发送键的匹配要带上它的文案。
 */
const tagOf = (html: string, pattern: RegExp): string => {
  const match = html.match(pattern);
  assert.ok(match, `没找到匹配 ${pattern} 的元素`);
  return match[0];
};

const textareaTag = (html: string): string => tagOf(html, /<textarea[^>]*>/);
const sendButtonTag = (html: string): string => tagOf(html, /<button[^>]*>发送<\/button>/);

const isDisabled = (tag: string): boolean => tag.includes('disabled=""');

test('会话被清理：输入框与发送键都禁用，提示不可回复，且常用语整行不出现', () => {
  const html = render({
    value: '上一轮留下的草稿',
    quickReplies: [{ quick_reply_id: 'q1', content: '继续' }],
    replyState: ready({
      mode: 'no-session',
      canType: false,
      willQueue: false,
      hint: '这个会话已被清理，无法再回复',
    }),
  });

  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.equal(isDisabled(textareaTag(html)), true, '输入框应禁用');
  // 框里虽有内容，会话没了也一样发不出去 —— 只判 value 的实现会在这里放行。
  assert.equal(isDisabled(sendButtonTag(html)), true, '发送键应禁用');
  // 插不进去的片段比不给更糟：整行（连带「点一下填入」提示）都不该出现。
  assert.doesNotMatch(html, /继续/);
  assert.doesNotMatch(html, /点一下填入/);
});

test('执行中：输入框仍可编辑（排队不是禁止），提示来自 replyState', () => {
  const html = render({
    replyState: ready({
      mode: 'queued',
      willQueue: true,
      hint: '执行中 · 消息将排队发送，等这一轮结束',
    }),
  });

  assert.match(html, /执行中 · 消息将排队发送，等这一轮结束/);
  assert.equal(isDisabled(textareaTag(html)), false, '排队态输入框必须可编辑');
});

test('执行中：有内容时发送键可用 —— 排队态不是发送闸门', () => {
  const html = render({
    value: '好的',
    replyState: ready({ mode: 'queued', willQueue: true, hint: 'x' }),
  });

  assert.equal(isDisabled(sendButtonTag(html)), false, '排队态有内容应当能发');
});

test('常用语渲染为可点的 chip，并声明「点一下填入，不会直接发送」', () => {
  const html = render({
    quickReplies: [
      { quick_reply_id: 'q1', content: '继续' },
      { quick_reply_id: 'q2', content: '先停下' },
    ],
  });

  assert.match(html, /继续/);
  assert.match(html, /先停下/);
  assert.match(html, /点一下填入，不会直接发送/);
});

test('常用语列表为空：不渲染 chip 容器，也不出现「点一下填入」', () => {
  const html = render({ quickReplies: [] });

  assert.doesNotMatch(html, /点一下填入/);
});

test('header 恒有「↩ 快速回复」，与是否可用无关', () => {
  assert.match(render(), /↩ 快速回复/);
  assert.match(render({ replyState: ready({ mode: 'no-session', canType: false, hint: 'x' }) }), /↩ 快速回复/);
});

test('发送键：内容为纯空白时禁用（trim 后为空不该发空白）', () => {
  assert.equal(isDisabled(sendButtonTag(render({ value: '   ' }))), true);
  assert.equal(isDisabled(sendButtonTag(render({ value: '\n' }))), true);
});

test('发送键：有内容时可用', () => {
  assert.equal(isDisabled(sendButtonTag(render({ value: '好的' }))), false);
});

test('hint 逐字取自 replyState，组件不自己派生文案', () => {
  // 用一句别处不存在的文案：若组件把 hint 硬编码或重新推导，这里必挂。
  const html = render({ replyState: ready({ hint: '哨兵文案-Zz9' }) });

  assert.match(html, /哨兵文案-Zz9/);
});

test('placeholder 只说做什么，不复述 hint 里的键位', () => {
  // 键位由 panelReply.ts 的 hint 独家声明。这里若再写一份（曾经是
  // 「回复这个任务…（Enter 发送）」），换发送模型时就得两处一起改 —— 还得改这条
  // 钉住它的测试，而聊天页的发送键本身还是可配置的（sendByCtrlEnter）。所以
  // placeholder 只描述动作。
  const disabledPlaceholder =
    render({ replyState: ready({ mode: 'no-session', canType: false, hint: 'x' }) }).match(
      /placeholder="([^"]*)"/,
    )?.[1] ?? '';
  assert.equal(disabledPlaceholder, '无法回复');

  const readyPlaceholder = render().match(/placeholder="([^"]*)"/)?.[1] ?? '';
  assert.equal(readyPlaceholder, '回复这个任务…');
  // 回归守卫：谁把键位重新写进 placeholder，这条就红。
  assert.equal(readyPlaceholder.includes('Enter'), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskPanelReplyBox.test.tsx src/components/tasks/panelReplyBox.test.ts`
Expected: FAIL —— `Cannot find module './TaskPanelReplyBox'` / `'./panelReplyBox'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/panelReplyBox.ts`：

```ts
/**
 * 回复区里「什么情况下能发、Enter 该不该发、常用语给不给看」的判据。
 *
 * 纯函数，无 React 依赖。搬出组件的理由是 Task 4/5 已经踩过的那一条：本仓库的
 * web 测试是 `node:test` + `renderToStaticMarkup`（无 DOM、不能模拟点击、不能
 * 派发键盘事件）。逻辑若留在组件的 `onClick` / `onKeyDown` 闭包里，**任何**改法
 * 都测不到 —— 包括「没内容也能发」「Shift+Enter 也发」「输入法选字时把半成品发
 * 出去」「会话被清理了还给常用语」。这些在静态标记上完全看不出来。搬出后组件
 * 只剩接线，判据才有 node:test 钉着。
 */

import type { ReplyState } from './panelReply';

/** 发送键的事件形状（取 React 合成事件里我们真正用到的那几个字段）。 */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  /** 输入法组合态。中文优先的仓库里这一条是必守项，见 shouldSendOnEnter。 */
  isComposing: boolean;
}

/**
 * 现在能不能发。`value.trim()` 非空是核心：只判 `value.length > 0` 会让一串
 * 空格 / 换行也算「有内容」，用户按 Enter 就把空白发给模型了。
 *
 * 刻意**不**看 `willQueue`：排队不是禁止。会话在跑时后端以 `RUN_IN_PROGRESS`
 * 拒 `chat.send`、服务端没有队列，前端替它排队（见 `panelReply.ts` 文件头），
 * 所以「发送」在排队态下必须照常可用 —— 加个 `&& !willQueue` 就等于执行中的
 * 任务永远回不了话。
 */
export function canSendReply(replyState: ReplyState, value: string): boolean {
  return replyState.canType && value.trim().length > 0;
}

/**
 * 这一下按键**是不是**「要发送」的键（Enter、非 Shift、非组合态）。
 *
 * 与内容无关是刻意的：它的用途是决定要不要 `preventDefault`。组合态里**绝不能**
 * preventDefault，否则会打断输入法选字 —— 所以「有内容」这层闸门留给
 * `canSendReply`，这里只认键本身。
 *
 * 两个修饰键判据都对齐聊天页：`Shift+Enter` 换行（两处既有入口的文案与行为），
 * `isComposing` 时 Enter 是「确认候选词」而不是「发送」—— 少了它，中文输入法下
 * 敲「nihao」按 Enter 选词会把半成品候选串当成消息发出去。聊天页的两处发送入口
 * （`useChatComposerState` 与 `QuickRepliesMenu`）都做了同样的判断。
 */
export function isSendKey(event: SendKeyEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

/** 这一下按键应不应该真的把内容发出去：先是发送键，再是内容非空。 */
export function shouldSendOnEnter(replyState: ReplyState, value: string, event: SendKeyEvent): boolean {
  return isSendKey(event) && canSendReply(replyState, value);
}

/**
 * 常用语那一行给不给看。两个条件缺一不可：
 *  - 会话可用（`canType`）—— 给一个插不进去的片段，比什么都不给更糟；
 *  - 列表非空 —— 渲染一行空的 chip 容器是纯噪音（同一理由也用在 header 的
 *    「点一下填入」提示上）。
 */
export function showQuickReplies(replyState: ReplyState, count: number): boolean {
  return replyState.canType && count > 0;
}
```

创建 `web/src/components/tasks/TaskPanelReplyBox.tsx`：

```tsx
import type { ReplyState } from './panelReply';
import { canSendReply, shouldSendOnEnter, showQuickReplies } from './panelReplyBox';

export interface QuickReplyItem {
  quick_reply_id: string;
  content: string;
}

export interface TaskPanelReplyBoxProps {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  quickReplies: QuickReplyItem[];
  replyState: ReplyState;
  /**
   * 点常用语：**只填入、不发送**。与聊天页的 `handleInsertQuickReply` 同一语义
   * （`web/src/components/chat/hooks/useChatComposerState.ts`，那里的注释写着
   * 「刻意不自动发送」）—— 片段是起点不是终稿，直接发出去等于替你按了回车。
   */
  onInsertQuickReply: (item: QuickReplyItem) => void;
}

/**
 * 面板内的回复区。
 *
 * 发送走的仍然是 `chat.send`（复用 `buildTaskChatSend`），与任务页「开始执行 /
 * 重试」同一条通道，所以这里没有新的协议概念 —— 只是把入口从会话页搬到了面板里。
 *
 * 本组件**不含**任何判断逻辑：「能不能发」「Enter 该不该发」「常用语给不给看」
 * 全在 `panelReplyBox.ts`（有 node:test 覆盖），文案由 `panelReply.ts` 的
 * `replyState` 拥有，这里只负责接线与样式。本仓库的 web 测试无 DOM（不能点、
 * 不能按键），留在 `onClick` / `onKeyDown` 闭包里的判断等于没有任何测试碰得到。
 */
export function TaskPanelReplyBox({
  value,
  onChange,
  onSend,
  quickReplies,
  replyState,
  onInsertQuickReply,
}: TaskPanelReplyBoxProps) {
  const disabled = !replyState.canType;
  const canSend = canSendReply(replyState, value);
  const chipsVisible = showQuickReplies(replyState, quickReplies.length);

  return (
    <div className="border-t border-border px-3.5 pb-3 pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span>↩ 快速回复</span>
        {chipsVisible ? (
          <span className="ml-auto text-3xs">点一下填入，不会直接发送</span>
        ) : null}
      </div>

      {chipsVisible ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {quickReplies.map((item) => (
            <button
              key={item.quick_reply_id}
              type="button"
              onClick={() => onInsertQuickReply(item)}
              className="rounded-full border border-dashed border-primary/45 bg-primary/5 px-2.5 py-0.5 text-2xs text-primary"
            >
              {item.content}
            </button>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
        <textarea
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送、Shift+Enter 换行；输入法组合态里的 Enter 是选字，
            // 既不发也不能 preventDefault（会打断输入法），判据见 shouldSendOnEnter。
            // `isComposing` 在 React 合成事件的 `nativeEvent` 上，不在顶层 —— 与
            // 聊天页两处发送入口（useChatComposerState / QuickRepliesMenu）一致。
            if (!shouldSendOnEnter(replyState, value, {
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            })) {
              return;
            }
            event.preventDefault();
            onSend();
          }}
          // 只说「做什么」，不写键位：键位由 panelReply.ts 的 hint 独家声明
          // （ready 态那句「Enter 发送 · Shift+Enter 换行」）。这里再写一遍就是第二份
          // 副本 —— 聊天页的发送键还是**可配置**的（useUiPreferences 的 sendByCtrlEnter，
          // 默认 Ctrl+Enter），面板此刻读不到那个偏好，写死某个键位只会更错。
          placeholder={disabled ? '无法回复' : '回复这个任务…'}
          className="w-full resize-none border-none bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <span className="mr-auto text-3xs text-muted-foreground">{replyState.hint}</span>
          <button
            type="button"
            disabled={!canSend}
            onClick={onSend}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-45"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

export default TaskPanelReplyBox;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskPanelReplyBox.test.tsx src/components/tasks/panelReplyBox.test.ts`
Expected: PASS —— `# pass 24`、`# fail 0`（组件 10 + 纯函数 14）

- [ ] **Step 5: 变异核对（确认断言抓得住，实测 13/13 全红）**

逐条改坏、确认有测试变红，再改回（本仓库没有 mutation runner，手工做）：

| 改法 | 结果 |
| --- | --- |
| `canSendReply` 丢掉 `canType` | 红（fail 2） |
| `canSendReply` 去掉 `trim()` | 红（fail 3） |
| `canSendReply` 加上 `!willQueue`（排队不许发） | 红（fail 3） |
| `isSendKey` 丢掉 `shiftKey` 判断 | 红（fail 2） |
| `isSendKey` 丢掉 `isComposing` 判断 | 红（fail 2） |
| `showQuickReplies` 丢掉 `canType` | 红（fail 2） |
| `showQuickReplies` 的 `count > 0` 改成 `>= 0` | 红（fail 2） |
| 组件的 `chipsVisible` 忽略 `canType` | 红（fail 1） |
| 组件的 `textarea` 恒不禁用 | 红（fail 1） |
| 组件的发送键 `disabled={!canSend}` 改成 `false` | 红（fail 2） |
| 组件的 `hint` 硬编码 | 红（fail 3） |
| 组件 placeholder 忽略禁用态（两个分支同文案） | 红（fail 1） |
| 组件 placeholder 重新写死键位（`'…（Enter 发送）'`） | 红（fail 1） |

**实测结果**（2026-09-28 手工跑，改坏 → 跑 → 改回 → 逐字节 diff 确认还原）：
上表 13 行**全部**至少让一条用例变红，**零存活**。

**接线层：这是一条边界，不是一个缺口。** 上表覆盖不到「`onInsertQuickReply` 是否真的接到
父级的 `buildQuickReplyInput`」「`onSend` 接到哪里」—— `onInsertQuickReply` / `onSend` 都是
父级（Task 10）注入的回调，本组件只负责在正确时机调用它们。本组件里剩下的接线是
两个 `onClick` 与一个 `onKeyDown` 分支，逐行可读完。

- [ ] **Step 6: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增（实测 0 错误；eslint 亦为基线 0 errors / 227 warnings）

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskPanelReplyBox.tsx web/src/components/tasks/TaskPanelReplyBox.test.tsx \
        web/src/components/tasks/panelReplyBox.ts web/src/components/tasks/panelReplyBox.test.ts
git commit -m "feat(tasks): add the summary panel reply box with quick replies"
```

---

## Task 7: 面板容器

**Files:**
- Create: `web/src/components/tasks/TaskSummaryPanel.tsx`
- Test: `web/src/components/tasks/TaskSummaryPanel.test.tsx`

**背景：** 把前面几块拼起来。数据全靠 props 传入（面板本身不取数），这样可静态渲染测试。面板的分区顺序：头部 → chip → **待办区** → 完成度 → 最近结果 → 属性 → **回复区** → 底部。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/TaskSummaryPanel.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { TaskSummaryPanel } from './TaskSummaryPanel';

/**
 * 「现在」刻意放在 updated_at 之后（而不是计划稿里的 1_700_000_000_000 ——
 * 那是 2023 年，比夹具里的时间戳还早，相对时间会一律读成「刚刚」，夹具自相矛盾）。
 */
const NOW = Date.parse('2026-09-28T06:25:00.000Z');

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    task_id: 't1',
    title: '修复导出 CSV 时表头错位',
    description: '导出大于 1000 行时表头会重复出现',
    status: 'in_progress',
    sub_status: 'waiting_answer',
    priority: 'P1',
    label: 'bug',
    project_id: 'p1',
    session_id: 's1',
    ai_summary: '已定位到 csv-export.ts:88 的分页边界判断，正在补测试。',
    executor_provider: 'claude',
    executor_model: 'claude-sonnet-4-6',
    created_at: '2026-09-28T06:02:00.000Z',
    updated_at: '2026-09-28T06:20:00.000Z',
    ...over,
  }) as Task;

const render = (over: Partial<Parameters<typeof TaskSummaryPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    <TaskSummaryPanel
      task={baseTask()}
      isProcessing={false}
      pendingRequests={[]}
      nowMs={NOW}
      timeoutMs={60_000}
      resultText=""
      replyValue=""
      onReplyChange={() => {}}
      onReplySend={() => {}}
      quickReplies={[]}
      onInsertQuickReply={() => {}}
      onRespond={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
      onOpenDetail={() => {}}
      {...over}
    />,
  );

/**
 * 取某个按钮的**开标签原文**。
 *
 * 为什么不能直接 `assert.doesNotMatch(html, /disabled/)`：Tailwind 的
 * `disabled:opacity-40` 在**每次**渲染里都含这个子串，那种断言恒真（Task 6 已踩过）。
 * 也不能对整段 html 找 `\bdisabled\b` —— 类名里的 `disabled:` 同样命中。
 * 只有把范围收窄到这一个元素、并认 React 输出的布尔属性原文（`disabled=""`）
 * 才分得出「禁用」与「没禁用」。
 */
function openTagOf(html: string, label: string): string {
  const end = html.indexOf(`>${label}</button>`);
  assert.ok(end >= 0, `未找到按钮「${label}」`);
  return html.slice(html.lastIndexOf('<button', end), end + 1);
}

test('头部：标题与关闭按钮', () => {
  const html = render();
  assert.match(html, /修复导出 CSV 时表头错位/);
  assert.match(html, /aria-label="关闭面板"/);
});

test('状态 chip 用 sub_status 的细标签，不是 status 的粗标签', () => {
  const html = render();
  // SUB_STATUS_META.waiting_answer 的 label 是「等你回答」。
  assert.match(html, /等你回答/);
  // 粗标签「进行中」（STATUS_META.in_progress）不该出现 —— 细标签可用时它必须让位。
  assert.doesNotMatch(html, /进行中/);
});

test('sub_status 为空时回退到 status 的粗标签（todo / done 列的常态）', () => {
  const html = render({ task: baseTask({ sub_status: null, status: 'todo' }) });
  assert.match(html, /待办/);
  // 计划稿的 `sub_status ?? 'running'` 会在这里写出「会话运行中」—— 一条待办任务。
  assert.doesNotMatch(html, /会话运行中/);
});

test('优先级与标签 chip 用 META 的中文文案，不是枚举原文', () => {
  const html = render();
  assert.match(html, /P1 高/);
  assert.match(html, /BUG/);
  // 原始枚举值「bug」不该以独立 chip 形态出现（LABEL_META.bug.label 是「BUG」）。
  assert.doesNotMatch(html, />bug</);
});

test('有待办时渲染待办区', () => {
  const html = render({
    pendingRequests: [
      {
        requestId: 'r1',
        toolName: 'Bash',
        receivedAt: new Date(NOW),
        input: { command: 'git commit -m "fix"' },
      },
    ],
  });
  assert.match(html, /git commit/);
  assert.match(html, /需要授权/);
});

test('无待办时不渲染待办区（auto 模式 / 无人值守任务的常态）', () => {
  const html = render({ pendingRequests: [] });
  assert.doesNotMatch(html, /需要授权/);
  assert.doesNotMatch(html, /需要选择/);
  assert.doesNotMatch(html, /不会超时/);
});

test('无 ai_summary 时不渲染完成度区块', () => {
  assert.match(render(), /完成度/);
  assert.doesNotMatch(render({ task: baseTask({ ai_summary: null }) }), /完成度/);
});

test('有结果文本时渲染最近结果，默认折叠（因此显示「展开全部 ↓」）', () => {
  const html = render({ resultText: '修复了分页边界的 off-by-one，单测覆盖 1500 行场景。' });
  assert.match(html, /最近结果/);
  assert.match(html, /off-by-one/);
  assert.match(html, /展开全部 ↓/);
});

test('无结果文本时不渲染最近结果', () => {
  const html = render({ resultText: '' });
  assert.doesNotMatch(html, /最近结果/);
  assert.doesNotMatch(html, /展开全部/);
});

test('属性行：引擎带模型、创建与活动各自成行', () => {
  const html = render();
  assert.match(html, /引擎/);
  assert.match(html, /claude · claude-sonnet-4-6/);
  assert.match(html, /创建/);
  assert.match(html, /活动/);
  // updated_at 距 NOW 恰好 5 分钟 —— 绝对时差，与时区无关。
  assert.match(html, /5 分钟前/);
});

test('底部两个动作都在', () => {
  const html = render();
  assert.match(html, /在会话里处理 →/);
  assert.match(html, /任务详情 →/);
});

test('会话可用时，「在会话里处理」可点，回复区可输入', () => {
  const html = render();
  assert.ok(!openTagOf(html, '在会话里处理 →').includes('disabled=""'));
  assert.match(html, /Enter 发送/);
});

test('会话被清理的任务：回复区禁用、提示不可回复，底部入口也禁用', () => {
  // session_id 仍在、但指向被硬删的会话行（后端置 session_deleted）—— 与「没有
  // session_id」对用户是同一种「会话没了」，两个入口都必须一起关掉。
  const html = render({ task: baseTask({ session_deleted: true }) });
  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.ok(openTagOf(html, '在会话里处理 →').includes('disabled=""'));
  // 「任务详情 →」是唯一出口，任何情况下都不能被关掉。
  assert.ok(!openTagOf(html, '任务详情 →').includes('disabled=""'));
});

test('无 session_id 的任务：回复区禁用，但「任务详情 →」仍可点', () => {
  const html = render({ task: baseTask({ session_id: null }) });
  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.ok(openTagOf(html, '在会话里处理 →').includes('disabled=""'));
  assert.ok(!openTagOf(html, '任务详情 →').includes('disabled=""'));
});

test('执行中：回复区说明消息会排队，但输入框仍可编辑', () => {
  const html = render({ isProcessing: true });
  assert.match(html, /排队发送/);
  // 排队不等于禁止 —— 输入框必须还能敲（它没有 disabled=""）。
  const areaEnd = html.indexOf('placeholder=');
  const areaStart = html.lastIndexOf('<textarea', areaEnd);
  assert.ok(!html.slice(areaStart, areaEnd).includes('disabled=""'));
});

test('常用语仅在会话可用时给到回复区', () => {
  const quickReplies = [{ quick_reply_id: 'q1', content: '好的，继续' }];
  assert.match(render({ quickReplies }), /好的，继续/);
  // 会话被清理：给一个插不进去的片段比不给更糟，回复区自己会收起这一行。
  assert.doesNotMatch(render({ quickReplies, task: baseTask({ session_id: null }) }), /好的，继续/);
});```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskSummaryPanel.test.tsx`
Expected: FAIL —— `Cannot find module './TaskSummaryPanel'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/TaskSummaryPanel.tsx`：

```tsx
import { useMemo, useState, type ReactNode } from 'react';

import type { Task } from '../../types/app';
import type { PendingPermissionRequest } from '../chat/types/types';

import { replyState } from './panelReply';
import { PendingPromptList } from './PendingPromptList';
import { LABEL_META, PRIORITY_META, STATUS_META, SUB_STATUS_META } from './taskStatus';
import { TaskPanelReplyBox, type QuickReplyItem } from './TaskPanelReplyBox';
import { formatAbsoluteTime, formatRelativeTime } from './taskTimestamp';
import type { PendingDecision } from './useSessionPendingRequests';

export interface TaskSummaryPanelProps {
  task: Task;
  isProcessing: boolean;
  pendingRequests: PendingPermissionRequest[];
  /** 由父级注入的「现在」，统一面板内所有相对时间与倒计时的节拍，也让测试可钉。 */
  nowMs: number;
  timeoutMs: number;
  resultText: string;
  replyValue: string;
  onReplyChange: (next: string) => void;
  onReplySend: () => void;
  quickReplies: QuickReplyItem[];
  onInsertQuickReply: (item: QuickReplyItem) => void;
  onRespond: (requestId: string, decision: PendingDecision) => void;
  onClose: () => void;
  onOpenSession: () => void;
  onOpenDetail: () => void;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-4xs uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/**
 * chip 行里的一枚小胶囊。`style` 走 META 的配色（`PRIORITY_META.bg` /
 * `LABEL_META.bg` 是 `hsl(var(--x) / 0.1)` 这种**合法**的 CSS 颜色值）。
 *
 * 状态 chip 例外：`SUB_STATUS_META.color` / `STATUS_META.color` 是
 * `hsl(var(--warning))` —— 它**不能**直接塞进 `backgroundColor`，拼不出合法颜色。
 * 所以状态 chip 只取 `color` 染字，底色留给 `className`（默认 `bg-muted`，
 * 与 SubStatusBadge 同款）。
 */
function Chip({
  children,
  style,
  className = 'bg-muted',
}: {
  children: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${className}`} style={style}>
      {children}
    </span>
  );
}

/**
 * 任务缩略面板。
 *
 * 面板本身**不取数** —— 所有数据由 TaskBoardPage 传入。两个原因：一是可静态渲染
 * 测试（本仓库前端无 jsdom，组件测试只能断言 markup）；二是面板要跟随列表的选中
 * 行切换，「选中哪一条」天然属于父级，面板自己再存一份就会与列表打架。
 *
 * 「任务详情 →」是唯一跳转到全页详情的入口。在此之前，点列表行只会**展开面板**
 * —— 把「看一眼」和「进入」这两件事分开，是这次改造的全部目的。
 */
export function TaskSummaryPanel({
  task,
  isProcessing,
  pendingRequests,
  nowMs,
  timeoutMs,
  resultText,
  replyValue,
  onReplyChange,
  onReplySend,
  quickReplies,
  onInsertQuickReply,
  onRespond,
  onClose,
  onOpenSession,
  onOpenDetail,
}: TaskSummaryPanelProps) {
  const [resultExpanded, setResultExpanded] = useState(false);

  const state = useMemo(
    () => replyState({ task, isProcessing, hasPendingPrompt: pendingRequests.length > 0 }),
    [task, isProcessing, pendingRequests.length],
  );

  /**
   * 头部状态点 / chip 的取值：细标签（sub_status）优先，没有才退回粗标签（status）。
   *
   * 计划稿写的是 `SUB_STATUS_META[task.sub_status ?? 'running']`，那在 `sub_status`
   * 为 null 时会**凭空**报出「会话运行中」—— 而 null 恰恰是 todo / done 列的常态
   * （后端只在有实时或持久细标签时才置值），一条待办任务会被显示成正在跑。回退到
   * `STATUS_META[task.status]` 才是它真正的状态。
   */
  const subMeta = task.sub_status ? SUB_STATUS_META[task.sub_status] : undefined;
  const statusLabel = subMeta?.label ?? STATUS_META[task.status].label;
  const statusColor = subMeta?.color ?? STATUS_META[task.status].color;

  /**
   * 会话能不能用由 `panelReply.ts` 的 `hasOpenableSession` 独家判定（同时覆盖
   * 「没有 session_id」与「session_id 指向被硬删的会话行」两种形态）。这里只把它
   * 的结果取出来给底部按钮复用，**不另抄一份判据** —— 抄第二份就等于绕过了那唯一
   * 副本，将来多出一种「会话不可用」的形态时会静默放行。
   */
  const hasSession = state.mode !== 'no-session';

  return (
    <>
      <div className="flex items-start gap-2 border-b border-border px-3.5 py-2.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor }} />
        <span className="min-w-0 flex-1 break-words text-xs font-semibold leading-snug text-foreground">
          {task.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭面板"
          className="rounded px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3.5 py-3">
        <div className="flex flex-wrap gap-1.5">
          <Chip style={{ color: statusColor }}>
            {statusLabel}
          </Chip>
          {task.priority ? (
            <Chip
              style={{
                color: PRIORITY_META[task.priority].color,
                backgroundColor: PRIORITY_META[task.priority].bg,
              }}
            >
              {PRIORITY_META[task.priority].label}
            </Chip>
          ) : null}
          {LABEL_META[task.label] ? (
            <Chip style={{ color: LABEL_META[task.label].color, backgroundColor: LABEL_META[task.label].bg }}>
              {LABEL_META[task.label].label}
            </Chip>
          ) : null}
        </div>

        {/* 待办区是条件渲染的 —— 无待办时它连空壳都不留（PendingPromptList 自己
            返回 null）。`auto` / `bypassPermissions` 模式与无人值守任务下，SDK 根本
            不会发 `can_useTool`，这里就是常态。 */}
        <PendingPromptList
          requests={pendingRequests}
          nowMs={nowMs}
          timeoutMs={timeoutMs}
          onRespond={onRespond}
        />

        {task.ai_summary ? (
          <Section label="完成度">
            <div className="rounded-lg border border-border bg-muted p-2.5 text-xs leading-relaxed text-card-foreground">
              {task.ai_summary}
            </div>
          </Section>
        ) : null}

        {resultText ? (
          <Section label="最近结果">
            <div
              className={`rounded-lg border border-border bg-muted p-2.5 text-xs leading-relaxed text-card-foreground ${
                resultExpanded ? '' : 'max-h-24 overflow-hidden'
              }`}
            >
              {resultText}
            </div>
            <button
              type="button"
              onClick={() => setResultExpanded((previous) => !previous)}
              className="mt-1 text-2xs font-medium text-primary"
            >
              {resultExpanded ? '收起 ↑' : '展开全部 ↓'}
            </button>
          </Section>
        ) : null}

        <section className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">引擎</span>
          <span className="text-foreground">
            {task.executor_provider}
            {task.executor_model ? ` · ${task.executor_model}` : ''}
          </span>
          <span className="text-muted-foreground">创建</span>
          <span className="text-foreground">{formatAbsoluteTime(task.created_at)}</span>
          <span className="text-muted-foreground">活动</span>
          <span className="text-foreground">{formatRelativeTime(task.updated_at, new Date(nowMs))}</span>
        </section>
      </div>

      {/* 常用语不在这里预筛：`TaskPanelReplyBox` 内部的 `showQuickReplies` 已经
          用同一个 `canType` 判定过（会话被清理时整行都不画）。在这里再写一遍
          `hasSession ? … : []` 是同一条件的第二份副本 —— 下层已经是唯一副本了，
          上层这份不产生任何可见差异（mutation 存活率测试证实），只会诱使后来的
          人以为「面板筛了一道」，挪走下层的判断时才发现两处都在管。 */}
      <TaskPanelReplyBox
        value={replyValue}
        onChange={onReplyChange}
        onSend={onReplySend}
        quickReplies={quickReplies}
        replyState={state}
        onInsertQuickReply={onInsertQuickReply}
      />

      <div className="flex gap-2 border-t border-border px-3.5 py-2.5">
        <button
          type="button"
          disabled={!hasSession}
          onClick={onOpenSession}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-foreground hover:bg-accent disabled:opacity-40"
        >
          在会话里处理 →
        </button>
        <button
          type="button"
          onClick={onOpenDetail}
          className="ml-auto rounded-md bg-primary px-3 py-1.5 text-2xs text-primary-foreground hover:opacity-90"
        >
          任务详情 →
        </button>
      </div>
    </>
  );
}

export default TaskSummaryPanel;```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskSummaryPanel.test.tsx`
Expected: PASS —— `# pass 16`、`# fail 0`

**已核对并已落地的真实 API：**
- `SUB_STATUS_META`（`web/src/components/tasks/taskStatus.ts:20`）是 `Record<SubStatus, { label: string; color: string }>` —— 字段名就是 `label` / `color`，没有 `dot`。**`waiting_answer` 的 label 是「等你回答」，不是「等待回答」**（计划初稿的断言写错了，实测文件已按真值钉住）。
- **`sub_status` 为 null 时必须退回 `STATUS_META[task.status]`**，不能写 `SUB_STATUS_META[task.sub_status ?? 'running']` —— null 是 todo / done 列的常态，那样会把一条待办任务显示成「会话运行中」。
- **状态 chip 不能把 `SUB_STATUS_META.color` 塞进 `backgroundColor`**：它是 `hsl(var(--warning))` 这种**裸变量**，拼不出合法颜色（`PRIORITY_META.bg` / `LABEL_META.bg` 才是 `hsl(var(--x) / 0.1)` 的合法值，可以直接当底色）。
- 时间格式化用的是 `formatAbsoluteTime(iso)` 与 `formatRelativeTime(iso, now)`（`web/src/components/tasks/taskTimestamp.ts:58` 与 `:41`）—— **没有** `formatTaskTimestamp` 这个函数。
- `useQuickReplies()` 返回的是 `{ items, isLoading, error, refresh, create, update, remove, markUsed }`（`web/src/components/chat/hooks/useQuickReplies.ts:164`）—— 列表字段叫 `items`，不是 `quickReplies`，接入时用解构改名。
- `QuickReply` 的真实类型在 `web/src/components/chat/hooks/useQuickReplies.ts:6`，本计划里的 `QuickReplyItem` 是它的结构子集（`{ quick_reply_id, content }`），可直接传。

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskSummaryPanel.tsx web/src/components/tasks/TaskSummaryPanel.test.tsx
git commit -m "feat(tasks): assemble the task summary panel"
```

---

## Task 8: 桌面默认表格视图

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx:37`
- Test: `web/src/components/tasks/taskViewMode.test.ts`（新建，测默认值纯逻辑）

**背景：** 用户要求「电脑端可以关闭看板视图，只保留表格视图，和手机端刚好相反」。现状 `effectiveView = isMobile ? 'board' : viewMode`（:51），桌面默认 `'board'`。只需把桌面默认翻成 `'table'`，手机端强制看板保持不变。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/taskViewMode.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TASK_VIEW_MODE, effectiveTaskViewMode } from './taskViewMode';

test('电脑端默认表格', () => {
  assert.equal(DEFAULT_TASK_VIEW_MODE, 'table');
  assert.equal(effectiveTaskViewMode({ isMobile: false, stored: DEFAULT_TASK_VIEW_MODE }), 'table');
});

test('电脑端可以手动开看板', () => {
  assert.equal(effectiveTaskViewMode({ isMobile: false, stored: 'board' }), 'board');
});

test('手机端强制看板，无视存储值', () => {
  // 手机上表格按钮整个不渲染，所以「存储里选了表格」不是一种可达状态；
  // 真要出现也不能信它，否则会渲染出一个没有对应按钮的视图。
  assert.equal(effectiveTaskViewMode({ isMobile: true, stored: 'table' }), 'board');
  assert.equal(effectiveTaskViewMode({ isMobile: true, stored: 'board' }), 'board');
});```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskViewMode.test.ts`
Expected: FAIL —— `Cannot find module './taskViewMode'`

- [ ] **Step 3: 写实现**

创建 `web/src/components/tasks/taskViewMode.ts`：

```ts
export type TaskViewMode = 'board' | 'table';

/**
 * 电脑端默认表格。
 *
 * 看板四列在宽屏上横向拉得过开，一屏能看见的任务反而比表格少；表格的
 * 「截止 / 最近活动」两列也只在桌面排得下。手机端相反 —— 表格横向撑不开，
 * 所以那边强制看板（见 `effectiveTaskViewMode`）。
 *
 * **这个新默认值只对没存过偏好的用户生效。** `useLocalStorage` 是纯 `useState`、
 * 不跨实例同步，也不会去认旧值；已经手动选过看板的老用户在 localStorage 里存着
 * `'board'`，会一直保持看板。这是**有意为之**：他们表达过偏好，一次改版不该
 * 把它悄悄抹掉。所以不要在这里加「迁移」逻辑去把旧值改写成表格 —— 那会把
 * 「默认值变了」变成「你的选择被推翻了」。
 */
export const DEFAULT_TASK_VIEW_MODE: TaskViewMode = 'table';

/**
 * 决定实际渲染哪种视图。
 *
 * 分成「平台」与「存储偏好」两层：手机端不是「默认看板」而是**没有选择**
 * （表格按钮在 <640px 整个不渲染），所以那边无视存储值；桌面端才读偏好。
 */
export function effectiveTaskViewMode({
  isMobile,
  stored,
}: {
  isMobile: boolean;
  stored: TaskViewMode;
}): TaskViewMode {
  return isMobile ? 'board' : stored;
}```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSCONFIG_PATH; unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskViewMode.test.ts`
Expected: PASS —— `# pass 3`、`# fail 0`（已实测）

- [ ] **Step 5: 接进 TaskBoard**

修改 `web/src/components/tasks/TaskBoard.tsx`。第 37 行：

```ts
// 改前
const [viewMode, setViewMode] = useLocalStorage<'board' | 'table'>('taskViewMode', 'board');
// 改后
const [viewMode, setViewMode] = useLocalStorage<TaskViewMode>('taskViewMode', DEFAULT_TASK_VIEW_MODE);
```

第 51 行：

```ts
// 改前
const effectiveView = isMobile ? 'board' : viewMode;
// 改后
const effectiveView = effectiveTaskViewMode({ isMobile, stored: viewMode });
```

并在文件顶部 import 处补：

```ts
import { DEFAULT_TASK_VIEW_MODE, effectiveTaskViewMode } from './taskViewMode';
import type { TaskViewMode } from './taskViewMode';
```

把第 37 行上方原有的注释（解释移动端强制看板那段）保留 —— 它解释的正是 `effectiveTaskViewMode` 的行为。

- [ ] **Step 6: typecheck + 全量测试**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/*.test.ts src/components/tasks/*.test.tsx 2>&1 | tail -8
```
Expected: typecheck 零新增；测试全绿

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/taskViewMode.ts web/src/components/tasks/taskViewMode.test.ts web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): default the desktop task page to the table view"
```

---

## Task 9: 列表点击改为展开面板

**Files:**
- Modify: `web/src/components/tasks/TaskCard.tsx:43,54`
- Modify: `web/src/components/tasks/TaskTableView.tsx:55,316-318`
- Modify: `web/src/components/tasks/TaskBoard.tsx`

**背景：** 把「点卡片 = 跳页」改成「点卡片 = 展开面板」。跳转变成面板底部的显式动作。

- [ ] **Step 1: TaskCard 改为回调**

在 `web/src/components/tasks/TaskCard.tsx` 的 props 接口里新增可选回调，并把自身的导航改掉：

```ts
// props 接口里新增
/** 点卡片：就地展开面板。未传时退回旧的跳转行为（其它调用点可能还在用）。 */
onOpenPanel?: (task: Task) => void;
```

第 54 行改为：

```tsx
onClick={() => {
  if (onOpenPanel) {
    onOpenPanel(task);
  } else {
    navigate(`/task/${task.task_id}`);
  }
}}
```

保留 `useNavigate` 与 `navigate` —— 作为未传回调时的兜底。

- [ ] **Step 2: TaskTableView 行点击改语义**

`web/src/components/tasks/TaskTableView.tsx` 里 `onOpenTask`（第 55 行声明，第 316-318 行使用）保持不变 —— 它的语义本来就是「打开这条任务」，由调用方决定是导航还是展开面板。**不要改这个文件**，改动集中在 TaskBoard 的传参上。

- [ ] **Step 3: TaskBoard 接上**

在 `web/src/components/tasks/TaskBoard.tsx` 中：

1. 新增状态：

```ts
/** 当前展开在右栏的任务 id；null = 面板关闭。 */
const [panelTaskId, setPanelTaskId] = useState<string | null>(null);
```

2. 找到 `manualTasksOf(filteredTasks)` 那一段之后，派生当前任务：

```ts
const panelTask = useMemo(
  () => (panelTaskId ? tasks.find((task) => task.task_id === panelTaskId) ?? null : null),
  [tasks, panelTaskId],
);
```

3. 把两处 `onOpenTask={(task) => navigate(`/task/${task.task_id}`)}`（第 466、480 行附近，收件箱条与表格行）改为：

```tsx
onOpenTask={(task) => setPanelTaskId(task.task_id)}
```

4. 给 `TaskCard` 传回调。找到渲染 `TaskCard` 的位置（第 508-520 行附近），补上：

```tsx
<TaskCard
  // ...既有 props 保持不动
  onOpenPanel={(task) => setPanelTaskId(task.task_id)}
/>
```

- [ ] **Step 4: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -8`
Expected: 零新增。若 `TaskCard` 的 props 是 `memo` 包裹的严格类型，确认新增的 `onOpenPanel` 已加入其 props 接口（不只是解构）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskCard.tsx web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): open the summary panel instead of navigating on task click"
```

---

## Task 10: 右栏容器与关闭行为

**Files:**
- Modify: `web/src/components/tasks/TaskBoard.tsx`

**背景：** 面板放进右栏；关闭时右栏整个收起、列表回到全宽；收起态点任意行自动重新展开，并回到刚才那一条（「关闭」≠「取消选中」）。

- [ ] **Step 1: 加容器与开关**

在 `web/src/components/tasks/TaskBoard.tsx` 中，找到渲染 `TaskTableView` / 看板列的那段（第 468 行附近 `{effectiveView === 'table' ? (`），用一个 flex 容器包住列表与右栏：

```tsx
<div className={`flex min-h-0 flex-1 ${panelTask ? '' : 'closed'}`}>
  <div className="flex min-w-0 flex-1 flex-col overflow-auto">
    {/* 原有的 {effectiveView === 'table' ? <TaskTableView .../> : <看板列 .../>} 整段移到这里 */}
  </div>
  {panelTask ? (
    <div className="hidden w-[428px] shrink-0 flex-col border-l border-border lg:flex">
      <TaskSummaryPanel
        task={panelTask}
        isProcessing={isProcessing}
        pendingRequests={pendingRequests}
        nowMs={nowMs}
        timeoutMs={TOOL_APPROVAL_TIMEOUT_MS}
        resultText={panelResult}
        replyValue={replyValue}
        onReplyChange={setReplyValue}
        onReplySend={sendPanelReply}
        quickReplies={quickReplies}
        onInsertQuickReply={insertQuickReply}
        onRespond={respond}
        onClose={() => setPanelTaskId(null)}
        onOpenSession={() => {
            if (panelTask.session_id) {
              navigate(`/session/${panelTask.session_id}`);
            }
          }}
        onOpenDetail={() => navigate(`/task/${panelTask.task_id}`)}
      />
    </div>
  ) : null}
</div>
```

**窄屏**（`lg` 以下）右栏是 `hidden`，所以还要一个 sheet 分支。在同一个组件里补：

```tsx
{panelTask && isMobile ? (
  <Dialog open onOpenChange={(open) => { if (!open) setPanelTaskId(null); }}>
    <DialogContent variant="sheet" className="flex max-h-[85dvh] flex-col p-0">
      <TaskSummaryPanel
        {/* 与上面同样的 props */}
      />
    </DialogContent>
  </Dialog>
) : null}
```

`Dialog` / `DialogContent` 从 `'../../shared/view/ui'` 导入（参考 `web/src/components/tasks/ScheduledTasksPanel.tsx:309-333` 的既有写法）。

- [ ] **Step 2: 加工具栏开关**

在 header 里「＋ 新建任务」按钮**之前**插入（对齐 `TaskBoard.tsx:380-396` 那一带）：

```tsx
<button
  type="button"
  onClick={() => setPanelTaskId((previous) => (previous ? null : (boardTasks[0]?.task_id ?? null)))}
  className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:bg-accent"
  title="隐藏 / 显示右侧缩略面板"
>
  {panelTask ? '隐藏面板' : '显示面板'}
</button>
```

- [ ] **Step 3: 关闭态的点击要能重新展开**

上面的 `onOpenTask` / `onOpenPanel` 都是 `setPanelTaskId(task.task_id)`，天然会在关闭态下重新展开并回到该条 —— **不需要额外逻辑**。验证方式见 Step 5 的手测清单。

- [ ] **Step 4: 接数据（回复 / 待办 / 结果）**

在 `TaskBoard.tsx` 里补上：

```ts
// 已有：const { subscribe, sendMessage } = useWebSocket();
const { pendingRequests, isProcessing, respond } = useSessionPendingRequests(panelTask?.session_id ?? null);

const { items: quickReplies, markUsed } = useQuickReplies();
const [replyValue, setReplyValue] = useState('');
const TOOL_APPROVAL_TIMEOUT_MS = 60_000;
```

**建议**：`TOOL_APPROVAL_TIMEOUT_MS` 直接内联常量并加注释说明它镜像后端 `providers.claude.toolApprovalTimeoutMs` 的默认值（`backend/server/modules/config/config.ts:47`）。更好的做法是后面单独开一个任务从后端配置接口读，本任务不扩这一块。

- [ ] **Step 5: 发送回复**

```ts
const sendPanelReply = useCallback(() => {
  if (!panelTask?.session_id) {
    return;
  }
  const content = replyValue.trim();
  if (!content) {
    return;
  }
  sendMessage(buildTaskChatSend(panelTask.session_id, panelTask, content));
  setReplyValue('');
}, [panelTask, replyValue, sendMessage]);
```

`buildTaskChatSend` 从 `'./taskExecution'` 导入（已有该模块，`web/src/components/tasks/taskExecution.ts:120`）。

常用语插入：

```ts
const insertQuickReply = useCallback((item: { quick_reply_id: string; content: string }) => {
  setReplyValue((previous) => buildQuickReplyInput(previous, item.content));
  markUsed(item.quick_reply_id);
}, [markUsed]);
```

`buildQuickReplyInput` 从 `'../chat/utils/quickReplyInsert'` 导入（`web/src/components/chat/utils/quickReplyInsert.ts:9`），它实现「已有内容则追加、空则填入」。

**切任务时清空草稿**：

```ts
useEffect(() => {
  setReplyValue('');
}, [panelTaskId]);
```

- [ ] **Step 6: 结果文本**

面板的「最近结果」需要最近一条助手消息。复用 `TaskDetail` 的做法（`web/src/components/tasks/TaskDetail.tsx:165-207`）：

```ts
const [panelResult, setPanelResult] = useState('');

useEffect(() => {
  const sessionId = panelTask?.session_id;
  if (!sessionId) {
    setPanelResult('');
    return;
  }

  let cancelled = false;
  (async () => {
    try {
      const messages = await api.unifiedSessionMessages(sessionId, 'claude', {});
      const text = pickLastAssistantText(messages);
      if (!cancelled) {
        setPanelResult(text ?? '');
      }
    } catch {
      if (!cancelled) {
        setPanelResult('');
      }
    }
  })();

  return () => {
    cancelled = true;
  };
}, [panelTask?.session_id, panelTask?.updated_at]);
```

`pickLastAssistantText` 与 `api` 的导入位置照 `TaskDetail.tsx` 现有写法抄（读该文件顶部的 import 段确认确切路径）。

- [ ] **Step 7: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10`
Expected: 零新增

- [ ] **Step 8: 构建**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx vite build 2>&1 | tail -8`
Expected: 构建成功

- [ ] **Step 9: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): dock the summary panel beside the list and collapse it cleanly"
```

---

## Task 11: 等待横幅指向面板

**Files:**
- Modify: `web/src/components/tasks/TaskDetail.tsx:599-627`

**背景：** 详情页的等待横幅（`TaskDetail.tsx:599-627`）现在只有「去处理」纯导航，拿不到 `input`。任务页现在能就地答了，所以详情页的文案应改为引导回任务页。

**注意：** 这个任务**不删**详情页的横幅 —— 直接访问 `/task/:id` 深链的用户仍需看到「有东西在等」的提示。只是把引导语从「去会话回复」改成「回任务面板处理」。

- [ ] **Step 1: 改文案与目标**

在 `web/src/components/tasks/TaskDetail.tsx:599-627` 区域，把横幅的按钮文案与目标改为：

```tsx
<button
  type="button"
  onClick={() => navigate('/tasks')}
  className="..."
>
  去任务面板处理
</button>
```

并把说明文字由「去会话里回复它即可继续」改为：

```
任务面板里可以直接回答，不必跳进会话。
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskDetail.tsx
git commit -m "feat(tasks): point the waiting banner at the summary panel"
```

---

## Task 12: 回归检查

**Files:**
- 只读检查，无代码改动

- [ ] **Step 1: 确认没有改到帧格式**

```bash
cd /mnt/b/workdir/github/lovdex
git diff main --stat -- web/src/components/chat/ backend/
```
Expected: `web/src/components/chat/` 下**零改动**（本计划刻意不碰 `useChatRealtimeHandlers.ts` —— 任务页走独立订阅，不放开原作用域）；`backend/` 零改动。

若 `useChatRealtimeHandlers.ts` 出现在 diff 里，说明实现时误改，需要回退：那条路是聊天页的，本次不需要动。

- [ ] **Step 2: 全量前端测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx' | tr '\n' ' ') 2>&1 | tail -12
```
Expected: **全绿**（`# fail 0`）。**不要**比对一个写死的总数 —— 每个任务都会新增用例，
算术总和必然漂。改为看两件事：（a）fail 为 0；（b）下面这几本任务新增的测试文件都在
输出里，且各自 `# tests` 的行数非空、不与上表差太多：

```bash
cd /mnt/b/workdir/github/lovdex/web
for f in panelPermission panelReply pendingRequestEvents pendingPromptAnswers \\
         PendingPromptCard pendingPromptQueue PendingPromptList panelReplyBox TaskPanelReplyBox; do
  n=$(unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/$f.test.* 2>/dev/null \\
      | grep -E '^# tests' | awk '{{print $3}}')
  echo "$f: $n"
done
```

**2026-09-28（Task 6 完成时）实测的形状**，供下一个读者对照：

| 文件 | 用例数 | 任务 |
| --- | --- | --- |
| `panelPermission.test.ts` | 10 | Task 1 |
| `panelReply.test.ts` | 10 | Task 2 |
| `pendingRequestEvents.test.ts` | 28 | Task 3 |
| `pendingPromptAnswers.test.ts` | 15 | Task 4 |
| `PendingPromptCard.test.tsx` | 10 | Task 4 |
| `pendingPromptQueue.test.ts` | 9 | Task 5 |
| `PendingPromptList.test.tsx` | 9 | Task 5 |
| `panelReplyBox.test.ts` | 14 | Task 6 |
| `TaskPanelReplyBox.test.tsx` | 10 | Task 6 |

（Task 1–5 的草稿各自写的「期望 pass 数」也偏小，实际如上 —— 实现时按「全绿 + 文件都在」
判，不要按草稿的算术。实测口径：全仓当时 **954 pass / 0 fail**；把 Task 6 的两个测试文件
排除后再跑是 **930 pass / 0 fail**，即 Task 6 净增 24。**以 `# fail 0` 为准，不要给总数
配一个会被下一次任务改掉的期望值。**）

- [ ] **Step 3: lint 与 typecheck 零新增**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
npx eslint src/components/tasks/ 2>&1 | tail -10
```
Expected: 两者错误数都与任务开始前相同（零新增）

- [ ] **Step 4: 确认后端未被触碰**

```bash
cd /mnt/b/workdir/github/lovdex && git diff main --stat -- backend/ | tail -3
```
Expected: 空输出

- [ ] **Step 5: 提交（若无改动则跳过）**

本任务不产生代码改动；若发现需要修补，单独提交并说明。

---

## Task 13: 浏览器端验证

**Files:**
- 只读，无代码改动

**背景：** 本仓库前端无 jsdom，交互无法自动化测试。这一步是**唯一**能验证点击链路的地方。参考 `docs/preview/tasks-final.html` 的预期行为（该预览已用无头浏览器逐项验证过 35 项断言）。

- [ ] **Step 1: 起 dev server 并确认基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run dev
```
确认 dev server 在 5188 端口（后端在 3188）。用局域网 IP 访问：`http://172.26.13.157:5188/tasks`
（**不要用 localhost** —— 用户从手机 / 其它机器访问时 localhost 指向它自己。）

- [ ] **Step 2: 逐项手测（对照 spec §5 与预览）**

1. 打开 `/tasks` → 默认是**表格**视图（清掉 `localStorage['taskViewMode']` 后验证）。
2. 点一行 → 右侧面板展开，该行高亮；**选中行恒为 1**。
3. 点另一行 → 内容替换，不用关面板。
4. 点同一行 → 收起。点 ✕ → 右栏收掉、列表回到全宽（表格明显变宽）。
5. 点工具栏「显示面板」→ 重新展开并回到刚才那条；按钮文案在「隐藏面板 / 显示面板」间切换。
6. 收起态点任意行 → 自动重新展开。
7. 切到看板 → 点卡片也能展开面板；再切回表格。
8. 找一条 `sub_status === 'waiting_answer'` 的任务 → 面板出现选项按钮与「不会超时」。
9. 找一条等普通工具授权的 → 命令原文 + 倒计时；**观察倒计时真的在走**，临近时变红。
10. 点一个选项 → 该条淡出；若还有下一条，队列自动前移。
11. 点常用语 → 文字进输入框、光标就位、**没有自动发送**。
12. 输入内容后 Enter → 发送成功，任务状态经 `task_upserted` 就地刷新。
13. 找一条正在执行的任务 → 回复区显示「排队发送」提示。
14. 找一条无 `session_id` 的任务 → 回复区禁用、无常用语、无待办区。
15. 窄屏（视口 <1024px）→ 面板变为底部 sheet，能上下拉。
16. 375px 视口 → 只有看板，无「表格」按钮。
17. **接线核对（单选）**：找一个 `AskUserQuestion` 且**只有一题、非多选**的待办，点其中一个选项 → 该条待办**立刻消失**（乐观移除），不需要再点第二个按钮；任务随后恢复运行（状态回到 `running` / 面板里出现后续输出）。点下去没反应 = `pick` 的接线断了；要再点一次「提交选择」才消失 = 单选被误接成了多选路径。
18. **接线核对（多选）**：找一个 `multiSelect: true` 的待办，依次点**两个**选项 → 两个都保持高亮、方框变 `☑`、旁边计数读作「已选 2 项」，且**此时待办仍在**（点一下不会提交）；再点其中一个取消 → 计数回到 1；最后点「提交选择」→ 待办消失。模型侧最终应拿到两个 label 以 `', '` 连接的答案（有回显就核对连接符与顺序 = 点击顺序）。
19. **接线核对（跨题闸门）**：造一个**两题**的提问（第一题单选、第二题多选）→ 先答第二题（多选）并点「提交选择」→ **不应发出**、待办仍在；回到第一题点一个选项 → 两题都答完，待办才消失。
20. **接线核对（计划）**：`ExitPlanMode` 待办点「开始执行」→ 待办消失、任务继续；点「让它改」→ 待办消失、模型的下一段输出是在**修订计划**（不是直接开工）—— 这一条同时验证了那句给模型读的 `'User asked to revise the plan'` 没被改坏。

> 17-20 是**唯一**能覆盖卡片接线层（`pick` / `respondWith`）的地方：纯函数测试证明「决定是对的」，静态渲染测试证明「按钮在」，而**没有任何自动化测试能证明「按钮接的是对的决定」** —— 这三者之间的那道缝就是这里。详见 Task 4 Step 6。

- [ ] **Step 3: 记录结果**

把每一步的实际结果写进 PR 描述或 commit message。**任何一项与预期不符都要先报告，不要标为完成。**

---

## 自检记录

**Spec 覆盖：** §2.1 面板 → Task 7/10；§2.2 内联待办 → Task 1/3/4/5；§2.3 队列排序 → Task 1/5；§2.4 无待办三情形 → Task 2/5/7（条件渲染）；§2.5 执行中回复 → Task 2/6；§3 平台分流 → Task 8；§4 改动范围 → 全部任务；§5 验收 → Task 12/13。

**与 spec 的偏差（已确认，需在实现时留意）：**
spec §4.2 原写「修改 `useChatRealtimeHandlers.ts`，把 pending 请求的作用域放开」。探查后发现**不需要**：任务页走独立订阅钩子（Task 3），原作用域保持不动。这样做更安全 —— 不会让聊天页的待办在两处重复渲染。Task 12 Step 1 专门守着这条。

**类型一致性：** `PendingDecision` 在 Task 3 定义、Task 4/5/7 消费；`ReplyState` 在 Task 2 定义、Task 6/7 消费；`QuickReplyItem` 在 Task 6 定义、Task 7/10 消费；`PendingPromptCardProps.onRespond` 与 `PendingPromptListProps.onRespond`、`TaskSummaryPanelProps.onRespond` 签名一致，均为 `(requestId: string, decision: PendingDecision) => void`。`DEFAULT_TASK_VIEW_MODE` / `effectiveTaskViewMode` 在 Task 8 定义并同任务内接入。
