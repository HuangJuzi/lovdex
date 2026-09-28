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
- Create: `web/src/components/tasks/useSessionPendingRequests.ts`
- Test: 无（React hook，本仓库无 jsdom 无法测；其全部判断逻辑已在 Task 1 抽成纯函数并覆盖）

**背景（本计划最关键的一步）：** 任务页**不能**用 `PermissionContext` —— 它的唯一 Provider 在 `web/src/components/chat/view/ChatInterface.tsx:452`，而 `/tasks` 是独立路由，树上没有它，`usePermission()` 只会返回 `null`。

任务页有 `WebSocketProvider`（挂在 `App.tsx:126`，所有路由之上）。所以钩子自己走订阅：

1. 挂载 / `sessionId` 变化时发 `chat.subscribe`（`sessions: [{ sessionId, lastSeq: 0 }]`）。
2. 后端 `handleChatSubscribe`（`backend/server/modules/websocket/services/chat-websocket.service.ts:347`）回 `chat_subscribed`，带 `pendingPermissions`；运行中时还会 `attachConnection`，后续 `permission_request` / `permission_cancelled` 实时到达。
3. 答复发 `chat.permission-response`，帧格式与 `handlePermissionDecision`（`web/src/components/chat/hooks/useChatComposerState.ts:1329`）完全一致。

- [ ] **Step 1: 写实现**

创建 `web/src/components/tasks/useSessionPendingRequests.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../contexts/WebSocketContext';
import type { PendingPermissionRequest } from '../chat/types/types';

export interface PendingDecision {
  allow?: boolean;
  message?: string;
  rememberEntry?: string | null;
  updatedInput?: unknown;
}

export interface UseSessionPendingRequestsResult {
  pendingRequests: PendingPermissionRequest[];
  /** 该会话当前是否在跑。来自 `chat_subscribed` 的 ack 与 `complete` 事件。 */
  isProcessing: boolean;
  respond: (requestId: string, decision: PendingDecision) => void;
}

/**
 * 按会话收取待办（工具审批）请求。
 *
 * 为什么不复用 `PermissionContext`：它的唯一 Provider 在 ChatInterface 内部，
 * 而任务页是独立路由，拿不到 —— `usePermission()` 在树上返回 null。
 * 这里改用同一套 socket 协议自己订阅：`chat.subscribe` 的 ack 带回
 * `pendingPermissions`（覆盖「打开页面时已经有待办」），运行中的会话还会被
 * `attachConnection`，于是 `permission_request` / `permission_cancelled` 实时到达。
 *
 * 答复帧格式与聊天页的 `handlePermissionDecision` 逐字段一致，
 * 后端 `handlePermissionResponse` 是同一个 handler，所以两处答复完全等价。
 */
export function useSessionPendingRequests(
  sessionId: string | null | undefined,
): UseSessionPendingRequestsResult {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const [pendingRequests, setPendingRequests] = useState<PendingPermissionRequest[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  /** 当前订阅的会话 id。socket 回调是异步的，不能读闭包里的 sessionId。 */
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  sessionIdRef.current = sessionId ?? null;

  // 换会话时清空：上一个会话的待办不能显示在新会话的面板上。
  useEffect(() => {
    setPendingRequests([]);
    setIsProcessing(false);
  }, [sessionId]);

  // 订阅。依赖 isConnected 是为了在断线重连后重新订阅 —— 这条任务页没有
  // 聊天页那套 lastSeq 续传，重订阅拿全量 pendingPermissions 就够了。
  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }

    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId, lastSeq: 0 }],
    });
  }, [sessionId, isConnected, sendMessage]);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      const msg = message as {
        kind?: string;
        sessionId?: string;
        requestId?: string;
        toolName?: string;
        input?: unknown;
        context?: unknown;
        pendingPermissions?: PendingPermissionRequest[];
        isProcessing?: boolean;
      };

      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) {
        return;
      }

      switch (msg.kind) {
        case 'chat_subscribed': {
          if (msg.sessionId !== currentSessionId) {
            return;
          }
          setIsProcessing(Boolean(msg.isProcessing));
          setPendingRequests(
            Array.isArray(msg.pendingPermissions)
              ? msg.pendingPermissions.map((request) => ({
                  ...request,
                  // ack 里的 receivedAt 是可选字段，补一个本地时刻，
                  // 否则倒计时算不出来（Task 1 会把缺失时间戳当作永不超时）。
                  receivedAt: request.receivedAt ? new Date(request.receivedAt) : new Date(),
                }))
              : [],
          );
          return;
        }

        case 'permission_request': {
          if (!msg.requestId || msg.sessionId !== currentSessionId) {
            return;
          }
          setPendingRequests((previous) => {
            if (previous.some((request) => request.requestId === msg.requestId)) {
              return previous;
            }
            return [...previous, {
              requestId: msg.requestId as string,
              toolName: msg.toolName || 'UnknownTool',
              input: msg.input,
              context: msg.context,
              sessionId: currentSessionId,
              receivedAt: new Date(),
            }];
          });
          setIsProcessing(true);
          return;
        }

        case 'permission_cancelled': {
          if (!msg.requestId) {
            return;
          }
          setPendingRequests((previous) =>
            previous.filter((request) => request.requestId !== msg.requestId),
          );
          return;
        }

        case 'complete': {
          // run 结束：待办随之失效（后端也会发 permission_cancelled，
          // 这里兜底，防止那一帧丢了导致按钮永久挂着）。
          if (msg.sessionId !== currentSessionId) {
            return;
          }
          setIsProcessing(false);
          setPendingRequests([]);
          return;
        }

        default:
          return;
      }
    });

    return unsubscribe;
  }, [subscribe]);

  const respond = useCallback(
    (requestId: string, decision: PendingDecision) => {
      if (!requestId) {
        return;
      }
      sendMessage({
        type: 'chat.permission-response',
        requestId,
        allow: Boolean(decision.allow),
        updatedInput: decision.updatedInput,
        message: decision.message,
        rememberEntry: decision.rememberEntry,
      });
      // 乐观移除：与聊天页一致（useChatComposerState.ts 的 handlePermissionDecision）。
      setPendingRequests((previous) =>
        previous.filter((request) => request.requestId !== requestId),
      );
    },
    [sendMessage],
  );

  return { pendingRequests, isProcessing, respond };
}
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

若报 `subscribe` 不在 `WebSocketContextType` 上，读 `web/src/contexts/WebSocketContext.tsx:32` 确认签名是 `(listener: ServerEventListener) => () => void`，并按实际类型调整。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/useSessionPendingRequests.ts
git commit -m "feat(tasks): subscribe the task panel to a session's pending approvals"
```

---

## Task 4: 单条待办卡片（含倒计时）

**Files:**
- Create: `web/src/components/tasks/PendingPromptCard.tsx`
- Test: `web/src/components/tasks/PendingPromptCard.test.tsx`

**背景：** 按 `toolName` 分派：`AskUserQuestion` 渲染选项、`ExitPlanMode` 渲染计划、其余渲染通用授权。倒计时复用 Task 1 的纯函数。本任务的测试是**静态渲染断言**（`renderToStaticMarkup`），只验证「渲染出了哪些文案」，不能验证点击——交互留给浏览器手测（Task 13）。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/PendingPromptCard.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { PendingPromptCard } from './PendingPromptCard';
import type { PendingPermissionRequest } from '../chat/types/types';

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptCard.test.tsx`
Expected: FAIL —— `Cannot find module './PendingPromptCard'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/PendingPromptCard.tsx`：

```tsx
import { useMemo, useState } from 'react';

import type { PendingPermissionRequest } from '../chat/types/types';
import type { Question } from '../chat/types/types';
import { formatCountdown, isInteractiveTool, remainingSeconds } from './panelPermission';
import type { PendingDecision } from './useSessionPendingRequests';

export interface PendingPromptCardProps {
  request: PendingPermissionRequest;
  /** 由父级注入的「现在」，好让倒计时可测且统一节拍。 */
  nowMs: number;
  timeoutMs: number;
  onRespond: (requestId: string, decision: PendingDecision) => void;
}

const cardShell = 'flex flex-col gap-2.5 rounded-lg border border-info/40 bg-info/5 p-3';

function Badge({ tone, children }: { tone: 'question' | 'plan' | 'approval'; children: React.ReactNode }) {
  const cls = tone === 'question'
    ? 'bg-warning text-warning-foreground'
    : tone === 'plan'
      ? 'bg-info text-info-foreground'
      : 'bg-warning text-warning-foreground';
  return (
    <span className={`rounded-full px-2 py-0.5 text-3xs font-semibold ${cls}`}>{children}</span>
  );
}

/** 超时提示：会超时的显示倒计时（临近时转红），不会超时的显示「不会超时」。 */
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

function AskUserQuestionBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { questions?: Question[] } | undefined;
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const [picked, setPicked] = useState<Record<string, string>>({});

  if (questions.length === 0) {
    return null;
  }

  const answer = (questionText: string, label: string) => {
    const next = { ...picked, [questionText]: label };
    setPicked(next);

    // 单问题直接提交；多问题要全部答完才提交（与聊天页 AskUserQuestionPanel 的
    // 「最后一次选择即发送」语义对齐，这里简化为顺序作答）。
    if (Object.keys(next).length >= questions.length) {
      const answers: Record<string, string> = {};
      for (const question of questions) {
        const value = next[question.question];
        if (value) {
          answers[question.question] = value;
        }
      }
      onRespond(request.requestId, { allow: true, updatedInput: { ...(input ?? {}), answers } });
    }
  };

  return (
    <>
      {questions.map((question) => (
        <div key={question.question}>
          <div className="text-xs font-semibold text-foreground">{question.question}</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {question.options.map((option) => {
              const selected = picked[question.question] === option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => answer(question.question, option.label)}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left ${
                    selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary'
                  }`}
                >
                  <span className="text-2xs font-semibold text-muted-foreground">●</span>
                  <span>
                    <span className="block text-xs font-medium text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-2xs text-muted-foreground">{option.description}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

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
      <div className="max-h-40 overflow-hidden rounded-md border border-border bg-card p-2.5 text-2xs leading-relaxed text-card-foreground whitespace-pre-wrap">
        {plan}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: false, message: 'User asked to revise the plan' })}
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-foreground"
        >
          ↺ 让它改
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: true })}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          ✓ 开始执行
        </button>
      </div>
    </>
  );
}

function ToolApprovalBody({
  request,
  onRespond,
}: {
  request: PendingPermissionRequest;
  onRespond: PendingPromptCardProps['onRespond'];
}) {
  const input = request.input as { command?: string } | undefined;
  const command = typeof input?.command === 'string' ? input.command : JSON.stringify(request.input ?? {}, null, 2);
  const rememberEntry = request.toolName === 'Bash' ? `Bash(${command})` : null;

  return (
    <>
      <div className="rounded-md border border-border bg-card p-2.5">
        <div className="text-xs font-semibold text-foreground">{request.toolName}</div>
        <pre className="mt-1.5 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-2xs text-card-foreground">
          {command}
        </pre>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: false, message: 'User denied tool use' })}
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-destructive"
        >
          ✕ 拒绝
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, { allow: true })}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          ✓ 允许一次
        </button>
        <button
          type="button"
          disabled={!rememberEntry}
          onClick={() => rememberEntry && onRespond(request.requestId, { allow: true, rememberEntry })}
          className="rounded-md bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground disabled:opacity-40"
        >
          ✓ 总是允许
        </button>
      </div>
      <div className="text-3xs text-muted-foreground">
        「总是允许」把它加进 <code className="rounded bg-muted px-1">allowedTools</code>，<strong className="font-semibold">仅本次会话有效</strong>，后续同类不再问
      </div>
    </>
  );
}

/**
 * 单条待办。按 toolName 分派到三种形态。
 *
 * 为什么不用聊天页的 `AskUserQuestionPanel` / `PlanDisplay`：
 * 前者可以（props 驱动），后者不行 —— 它从 `PermissionContext` 取待办，
 * 而那个 Provider 只存在于 ChatInterface 内部。为了两条路行为一致、
 * 且让倒计时/队列这些新信息有地方放，这里统一自绘。
 */
export function PendingPromptCard({ request, nowMs, timeoutMs, onRespond }: PendingPromptCardProps) {
  const tone = useMemo(() => {
    if (request.toolName === 'AskUserQuestion') return 'question' as const;
    if (request.toolName === 'ExitPlanMode' || request.toolName === 'exit_plan_mode') return 'plan' as const;
    return 'approval' as const;
  }, [request.toolName]);

  const isPlan = tone === 'plan';
  const isQuestion = tone === 'question';
  const interactive = isInteractiveTool(request.toolName);

  const title = isQuestion
    ? '它在等你回答'
    : isPlan
      ? '它写好计划了，等你点头'
      : '要执行一个写操作';

  return (
    <div className={cardShell}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{isQuestion ? '需要选择' : isPlan ? '计划待批准' : '需要授权'}</Badge>
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <TimeoutHint request={request} nowMs={nowMs} timeoutMs={timeoutMs} />
      </div>

      {isQuestion ? <AskUserQuestionBody request={request} onRespond={onRespond} /> : null}
      {isPlan ? <PlanBody request={request} onRespond={onRespond} /> : null}
      {!isQuestion && !isPlan ? <ToolApprovalBody request={request} onRespond={onRespond} /> : null}

      {interactive ? (
        <div className="text-3xs text-muted-foreground">点选项即发送 · 也可以直接在下方输入一段回复</div>
      ) : null}
    </div>
  );
}

export default PendingPromptCard;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptCard.test.tsx`
Expected: PASS —— `# pass 7`、`# fail 0`

若 `bg-info/5`、`text-3xs`、`bg-warning` 等类名不存在，读 `web/tailwind.config.js` 与 `web/src/index.css` 对齐实际 token；断言只写在文案上，配色改类名不影响测试。

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/PendingPromptCard.tsx web/src/components/tasks/PendingPromptCard.test.tsx
git commit -m "feat(tasks): render pending approvals inline with their auto-deny countdown"
```

---

## Task 5: 待办区（队列条 + 空态）

**Files:**
- Create: `web/src/components/tasks/PendingPromptList.tsx`
- Test: `web/src/components/tasks/PendingPromptList.test.tsx`

**背景：** 队列长度 > 1 才渲染队列条（单条时更干净）；只渲染当前那一条的完整卡片，其余显示为队列步骤。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/PendingPromptList.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { PendingPromptList } from './PendingPromptList';
import type { PendingPermissionRequest } from '../chat/types/types';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const ask = (id: string): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'AskUserQuestion',
  receivedAt: new Date(NOW),
  input: { questions: [{ question: `问题 ${id}`, options: [{ label: '好' }] }] },
});

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

test('零条待办：整个待办区不渲染', () => {
  assert.equal(render([]), '');
});

test('单条待办：不渲染队列条（保持面板干净）', () => {
  const html = render([ask('a')]);
  assert.doesNotMatch(html, /还有 \d+ 件事等你/);
  assert.match(html, /问题 a/);
});

test('两条待办：渲染队列条并给出总数', () => {
  const html = render([bash('b1', 50_000), ask('a1')]);
  assert.match(html, /还有 2 件事等你/);
});

test('多条时只完整渲染当前那一条，其余以步骤呈现', () => {
  const html = render([bash('b1', 50_000), ask('a1')]);
  // 会超时的那条（b1）排在最前，它才是「当前」。
  assert.match(html, /echo b1/);
  assert.match(html, /问题 a1/);
});

test('队列条里会超时的排在前面', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);
  const cmdIndex = html.indexOf('echo b1');
  const questionIndex = html.indexOf('问题 a1');
  assert.ok(cmdIndex >= 0 && questionIndex >= 0);
  // 当前卡片（含命令原文）出现在队列步骤之前。
  assert.ok(cmdIndex < html.indexOf('还有 2 件事等你') || cmdIndex < questionIndex);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptList.test.tsx`
Expected: FAIL —— `Cannot find module './PendingPromptList'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/PendingPromptList.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';

import type { PendingPermissionRequest } from '../chat/types/types';
import { PendingPromptCard } from './PendingPromptCard';
import type { PendingDecision } from './useSessionPendingRequests';
import { remainingSeconds, sortPendingRequests } from './panelPermission';

export interface PendingPromptListProps {
  requests: PendingPermissionRequest[];
  nowMs: number;
  timeoutMs: number;
  onRespond: (requestId: string, decision: PendingDecision) => void;
}

/** 队列里一条待办的短描述，用于非当前项。 */
function summarize(request: PendingPermissionRequest): string {
  if (request.toolName === 'AskUserQuestion') {
    const input = request.input as { questions?: Array<{ question?: string }> } | undefined;
    const first = input?.questions?.[0]?.question;
    return first ? `回答「${first}」` : '回答一个问题';
  }
  if (request.toolName === 'ExitPlanMode' || request.toolName === 'exit_plan_mode') {
    return '确认它写的计划';
  }
  return `允许 ${request.toolName} 执行`;
}

/**
 * 待办区：串行队列，一次完整显示一条。
 *
 * 之所以是队列而不是并排的卡片堆：一个任务对应一个会话，而后端的
 * `canUseTool` 本就要等这一条答复完才会走到下一个工具，所以实际几乎
 * 总是只有一条。真出现并发时排成一队逐个答，既不会挤满面板，
 * 也不会漏掉任何一条。
 *
 * 排序键是「超时时刻」——会超时的（普通工具，60 秒后自动拒绝）排在
 * 永远等的（AskUserQuestion / ExitPlanMode）前面。
 */
export function PendingPromptList({ requests, nowMs, timeoutMs, onRespond }: PendingPromptListProps) {
  const sorted = useMemo(() => sortPendingRequests(requests, timeoutMs), [requests, timeoutMs]);

  // 当前项被答掉后队列会前移；用一个显式下标而不是只看 sorted[0]，
  // 这样「答完第一条、第二条自动升为当前」不需要额外状态。
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (index >= sorted.length) {
      setIndex(0);
    }
  }, [sorted.length, index]);

  if (sorted.length === 0) {
    return null;
  }

  const currentIndex = Math.min(index, sorted.length - 1);
  const current = sorted[currentIndex];
  const showQueue = sorted.length > 1;

  const handleRespond = (requestId: string, decision: PendingDecision) => {
    onRespond(requestId, decision);
    // 乐观前进到下一条。
    setIndex((previous) => Math.min(previous, Math.max(0, sorted.length - 2)));
  };

  return (
    <div className="flex flex-col gap-2.5">
      {showQueue ? (
        <div className="overflow-hidden rounded-lg border border-warning/40 bg-warning/5">
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/25 px-2.5 py-1.5 text-2xs font-semibold text-warning">
            <span>还有 {sorted.length} 件事等你</span>
            <span className="ml-auto font-normal text-muted-foreground">先处理会超时的</span>
          </div>
          {sorted.map((request, i) => {
            const seconds = remainingSeconds(request, nowMs, timeoutMs);
            return (
              <div
                key={request.requestId}
                className={`flex items-center gap-2 px-2.5 py-1.5 text-2xs ${
                  i === currentIndex ? 'bg-warning/10 font-medium text-foreground' : 'text-muted-foreground'
                }`}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-secondary text-3xs font-semibold">
                  {i + 1}
                </span>
                <span>{summarize(request)}</span>
                <span className="ml-auto text-3xs text-muted-foreground">
                  {seconds === null ? '不会超时' : `${seconds} 秒后自动拒绝`}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <PendingPromptCard
        request={current}
        nowMs={nowMs}
        timeoutMs={timeoutMs}
        onRespond={handleRespond}
      />
    </div>
  );
}

export default PendingPromptList;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/PendingPromptList.test.tsx`
Expected: PASS —— `# pass 5`、`# fail 0`

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/PendingPromptList.tsx web/src/components/tasks/PendingPromptList.test.tsx
git commit -m "feat(tasks): queue a session's pending approvals, timeout-first"
```

---

## Task 6: 面板内回复区

**Files:**
- Create: `web/src/components/tasks/TaskPanelReplyBox.tsx`
- Test: `web/src/components/tasks/TaskPanelReplyBox.test.tsx`

**背景：** 常用语**只填入不发送**（与 `handleInsertQuickReply` 一致，`web/src/components/chat/hooks/useChatComposerState.ts:1285`）。数据来自既有的 `useQuickReplies` 钩子与 `api.quickReplies`。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/tasks/TaskPanelReplyBox.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskPanelReplyBox } from './TaskPanelReplyBox';

test('会话被清理：输入框禁用，提示不可回复，且不显示常用语', () => {
  const html = renderToStaticMarkup(
    <TaskPanelReplyBox
      value=""
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[{ quick_reply_id: 'q1', content: '继续' }]}
      replyState={{
        mode: 'no-session',
        canType: false,
        willQueue: false,
        hint: '这个会话已被清理，无法再回复',
      }}
      onInsertQuickReply={() => {}}
    />,
  );

  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /继续/);
});

test('执行中：提示会排队，但输入框仍可编辑', () => {
  const html = renderToStaticMarkup(
    <TaskPanelReplyBox
      value=""
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[]}
      replyState={{
        mode: 'queued',
        canType: true,
        willQueue: true,
        hint: '执行中 · 消息将排队发送，等这一轮结束',
      }}
      onInsertQuickReply={() => {}}
    />,
  );

  assert.match(html, /执行中 · 消息将排队发送/);
  assert.doesNotMatch(html, /disabled/);
});

test('常用语渲染为可点的 chip，并声明「点一下填入」', () => {
  const html = renderToStaticMarkup(
    <TaskPanelReplyBox
      value=""
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[
        { quick_reply_id: 'q1', content: '继续' },
        { quick_reply_id: 'q2', content: '先停下' },
      ]}
      replyState={{ mode: 'ready', canType: true, willQueue: false, hint: 'Enter 发送' }}
      onInsertQuickReply={() => {}}
    />,
  );

  assert.match(html, /继续/);
  assert.match(html, /先停下/);
  assert.match(html, /点一下填入/);
});

test('内容为空时发送按钮禁用', () => {
  const html = renderToStaticMarkup(
    <TaskPanelReplyBox
      value=""
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[]}
      replyState={{ mode: 'ready', canType: true, willQueue: false, hint: 'Enter 发送' }}
      onInsertQuickReply={() => {}}
    />,
  );
  assert.match(html, /disabled/);
});

test('有内容时发送按钮可用', () => {
  const html = renderToStaticMarkup(
    <TaskPanelReplyBox
      value="好的"
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[]}
      replyState={{ mode: 'ready', canType: true, willQueue: false, hint: 'Enter 发送' }}
      onInsertQuickReply={() => {}}
    />,
  );
  // 发送按钮不应该带 disabled
  assert.doesNotMatch(html, /disabled/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskPanelReplyBox.test.tsx`
Expected: FAIL —— `Cannot find module './TaskPanelReplyBox'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/TaskPanelReplyBox.tsx`：

```tsx
import type { ReplyState } from './panelReply';

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
   * （见 web/src/components/chat/hooks/useChatComposerState.ts，那里有明确注释
   * 说明「刻意不自动发送」）—— 片段是起点不是终稿，直接发出去等于替你按了回车。
   */
  onInsertQuickReply: (item: QuickReplyItem) => void;
}

/**
 * 面板内的回复区。
 *
 * 发送走的仍然是 `chat.send`（复用 `buildTaskChatSend`），与任务页「开始执行 /
 * 重试」同一条通道，所以这里没有新的协议概念 —— 只是把入口从会话页搬到了面板里。
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
  const canSend = replyState.canType && value.trim().length > 0;

  return (
    <div className="border-t border-border px-3.5 pb-3 pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span>↩ 快速回复</span>
        {quickReplies.length > 0 && replyState.canType ? (
          <span className="ml-auto text-3xs">点一下填入，不会直接发送</span>
        ) : null}
      </div>

      {quickReplies.length > 0 && replyState.canType ? (
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
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canSend) {
                onSend();
              }
            }
          }}
          placeholder={disabled ? '无法回复' : '回复这个任务…（Enter 发送）'}
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

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskPanelReplyBox.test.tsx`
Expected: PASS —— `# pass 5`、`# fail 0`

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: 零新增

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/tasks/TaskPanelReplyBox.tsx web/src/components/tasks/TaskPanelReplyBox.test.tsx
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

import { TaskSummaryPanel } from './TaskSummaryPanel';
import type { Task } from '../../types/app';

const NOW = 1_700_000_000_000;

const baseTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1',
  title: '修复导出 CSV 时表头错位',
  description: '导出大于 1000 行时表头会重复出现',
  status: 'in_progress',
  sub_status: 'waiting_answer',
  priority: 'P1',
  project_id: 'p1',
  session_id: 's1',
  ai_summary: '已定位到 csv-export.ts:88 的分页边界判断，正在补测试。',
  executor_provider: 'claude',
  executor_model: 'claude-sonnet-4-6',
  created_at: '2026-09-28T06:02:00.000Z',
  updated_at: '2026-09-28T06:20:00.000Z',
  ...over,
} as Task);

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

test('渲染标题、状态 chip 与完成度', () => {
  const html = render();
  assert.match(html, /修复导出 CSV 时表头错位/);
  assert.match(html, /等待回答/);
  assert.match(html, /P1/);
  assert.match(html, /已定位到 csv-export\.ts:88/);
});

test('有待办时渲染待办区', () => {
  const html = render({
    pendingRequests: [{
      requestId: 'r1',
      toolName: 'Bash',
      receivedAt: new Date(NOW),
      input: { command: 'git commit -m "fix"' },
    }],
  });
  assert.match(html, /git commit/);
});

test('无待办时不渲染待办区（auto 模式 / 无人值守任务的常态）', () => {
  const html = render({ pendingRequests: [] });
  assert.doesNotMatch(html, /需要授权/);
  assert.doesNotMatch(html, /需要选择/);
});

test('底部两个动作都在：在会话里处理、任务详情', () => {
  const html = render();
  assert.match(html, /在会话里处理/);
  assert.match(html, /任务详情/);
});

test('无 ai_summary 时不渲染完成度区块', () => {
  const html = render({ task: baseTask({ ai_summary: null }) });
  assert.doesNotMatch(html, /完成度/);
});

test('有结果文本时渲染最近结果并可展开', () => {
  const html = render({ resultText: '修复了分页边界的 off-by-one，单测覆盖 1500 行场景。' });
  assert.match(html, /最近结果/);
  assert.match(html, /off-by-one/);
});

test('会话被清理的任务：回复区禁用且提示不可回复', () => {
  const html = render({ task: baseTask({ session_id: null }) });
  assert.match(html, /这个会话已被清理，无法再回复/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskSummaryPanel.test.tsx`
Expected: FAIL —— `Cannot find module './TaskSummaryPanel'`

- [ ] **Step 3: 写最小实现**

创建 `web/src/components/tasks/TaskSummaryPanel.tsx`：

```tsx
import { useMemo, useState } from 'react';

import type { Task } from '../../types/app';
import type { PendingPermissionRequest } from '../chat/types/types';
import { PendingPromptList } from './PendingPromptList';
import { TaskPanelReplyBox } from './TaskPanelReplyBox';
import type { QuickReplyItem } from './TaskPanelReplyBox';
import type { PendingDecision } from './useSessionPendingRequests';
import { replyState } from './panelReply';
import { SUB_STATUS_META } from './taskStatus';
import { formatAbsoluteTime, formatRelativeTime } from './taskTimestamp';

export interface TaskSummaryPanelProps {
  task: Task;
  isProcessing: boolean;
  pendingRequests: PendingPermissionRequest[];
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-4xs uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/**
 * 任务缩略面板。
 *
 * 面板本身不取数 —— 所有数据由 TaskBoardPage 传入。这样做的原因有两个：
 * 一是可静态渲染测试（本仓库前端无 jsdom，组件测试只能断言 markup），
 * 二是面板要跟随列表的选中行切换，状态天然属于父级。
 *
 * 「任务详情 →」是唯一跳转到全页详情的入口。在此之前，点列表行只会展开
 * 面板 —— 把「看一眼」和「进入」这两件事分开，是这次改造的全部目的。
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

  const statusMeta = SUB_STATUS_META[task.sub_status ?? 'running'];
  const statusLabel = statusMeta?.label ?? task.status;
  const statusDot = statusMeta?.color ?? 'var(--muted-foreground)';
  const hasSession = Boolean(task.session_id);

  return (
    <>
      <div className="flex items-start gap-2 border-b border-border px-3.5 py-2.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: statusDot }} />
        <span className="flex-1 text-xs font-semibold leading-snug text-foreground">{task.title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭面板"
          className="rounded px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-auto px-3.5 py-3">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-2xs text-warning">
            {statusLabel}
          </span>
          {task.priority ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-2xs text-secondary-foreground">
              {task.priority}
            </span>
          ) : null}
          {task.label ? (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-2xs text-secondary-foreground">
              {task.label}
            </span>
          ) : null}
        </div>

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
                resultExpanded ? '' : 'max-h-22 overflow-hidden'
              }`}
            >
              {resultText}
            </div>
            <button
              type="button"
              onClick={() => setResultExpanded((previous) => !previous)}
              className="mt-1 text-2xs text-primary"
            >
              {resultExpanded ? '收起 ↑' : '展开全部 ↓'}
            </button>
          </Section>
        ) : null}

        <section className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">引擎</span>
          <span className="text-foreground">
            {task.executor_provider ?? '—'}
            {task.executor_model ? ` · ${task.executor_model}` : ''}
          </span>
          <span className="text-muted-foreground">创建</span>
          <span className="text-foreground">{formatAbsoluteTime(task.created_at)}</span>
          <span className="text-muted-foreground">活动</span>
          <span className="text-foreground">{formatRelativeTime(task.updated_at, new Date(nowMs))}</span>
        </section>
      </div>

      <TaskPanelReplyBox
        value={replyValue}
        onChange={onReplyChange}
        onSend={onReplySend}
        quickReplies={hasSession ? quickReplies : []}
        replyState={state}
        onInsertQuickReply={onInsertQuickReply}
      />

      <div className="flex gap-2 border-t border-border px-3.5 py-2.5">
        <button
          type="button"
          disabled={!hasSession}
          onClick={onOpenSession}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-2xs text-foreground disabled:opacity-40"
        >
          在会话里处理 →
        </button>
        <button
          type="button"
          onClick={onOpenDetail}
          className="ml-auto rounded-md bg-primary px-3 py-1.5 text-2xs text-primary-foreground"
        >
          任务详情 →
        </button>
      </div>
    </>
  );
}

export default TaskSummaryPanel;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/TaskSummaryPanel.test.tsx`
Expected: PASS —— `# pass 7`、`# fail 0`

**已核对的真实 API（写实现时按这些来）：**
- `SUB_STATUS_META`（`web/src/components/tasks/taskStatus.ts:20`）是 `Record<SubStatus, { label: string; color: string }>` —— 字段名就是 `label` / `color`，没有 `dot`。
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
  assert.equal(effectiveTaskViewMode({ isMobile: true, stored: 'table' }), 'board');
  assert.equal(effectiveTaskViewMode({ isMobile: true, stored: 'board' }), 'board');
});
```

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
 * 「截止 / 最近活动」两列在桌面才排得下。手机端相反 —— 表格横向撑不开，
 * 所以强制看板（见 effectiveTaskViewMode）。
 *
 * 注意：`useLocalStorage` 是纯 useState、不跨实例同步，所以这个新默认值
 * 只对**没有存过偏好**的用户生效；已经手动选过看板的老用户会保持看板。
 * 这是有意为之 —— 他们表达过偏好，不该被一次改版覆盖。
 */
export const DEFAULT_TASK_VIEW_MODE: TaskViewMode = 'table';

export function effectiveTaskViewMode({
  isMobile,
  stored,
}: {
  isMobile: boolean;
  stored: TaskViewMode;
}): TaskViewMode {
  return isMobile ? 'board' : stored;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && unset TSCONFIG_PATH; unset TSX_TSCONFIG_PATH && npx tsx --test src/components/tasks/taskViewMode.test.ts`
Expected: PASS —— `# pass 3`、`# fail 0`

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
Expected: 全绿，且新增测试数 = 8 + 6 + 7 + 5 + 5 + 7 + 3 = 41

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

- [ ] **Step 3: 记录结果**

把每一步的实际结果写进 PR 描述或 commit message。**任何一项与预期不符都要先报告，不要标为完成。**

---

## 自检记录

**Spec 覆盖：** §2.1 面板 → Task 7/10；§2.2 内联待办 → Task 1/3/4/5；§2.3 队列排序 → Task 1/5；§2.4 无待办三情形 → Task 2/5/7（条件渲染）；§2.5 执行中回复 → Task 2/6；§3 平台分流 → Task 8；§4 改动范围 → 全部任务；§5 验收 → Task 12/13。

**与 spec 的偏差（已确认，需在实现时留意）：**
spec §4.2 原写「修改 `useChatRealtimeHandlers.ts`，把 pending 请求的作用域放开」。探查后发现**不需要**：任务页走独立订阅钩子（Task 3），原作用域保持不动。这样做更安全 —— 不会让聊天页的待办在两处重复渲染。Task 12 Step 1 专门守着这条。

**类型一致性：** `PendingDecision` 在 Task 3 定义、Task 4/5/7 消费；`ReplyState` 在 Task 2 定义、Task 6/7 消费；`QuickReplyItem` 在 Task 6 定义、Task 7/10 消费；`PendingPromptCardProps.onRespond` 与 `PendingPromptListProps.onRespond`、`TaskSummaryPanelProps.onRespond` 签名一致，均为 `(requestId: string, decision: PendingDecision) => void`。`DEFAULT_TASK_VIEW_MODE` / `effectiveTaskViewMode` 在 Task 8 定义并同任务内接入。
