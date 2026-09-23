# 自动审批拒绝的会话渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让自动审批按策略拒绝的 tool_result 在会话里不再渲染成红色 `Error` —— 交互型工具（没人可问）降成一行 info，危险操作被拦保留醒目框但标题改「已自动拒绝」、配色转 warning，真·工具错误一字不改。

**Architecture:** 策略模块（`auto-approve-policy.ts`）导出纯分类函数，成为「这条结果是不是自动拒绝」的唯一事实来源；两个 provider 在归一化 tool_result 时打上 `autoApproveDeny` 字段；前端按结构化字段换渲染，**不认识任何后端中文**。分类必须发生在归一化层而非前端，因为 `permission_auto` 是纯 ws 帧、刷新即丢，历史回放只能凭 transcript 内容判断。

**Tech Stack:** TypeScript / Node `node:test` + `tsx` / React 18 + `renderToStaticMarkup`（web 测试无 DOM 环境）

**Spec:** `docs/superpowers/specs/2026-09-23-auto-approve-deny-rendering-design.md`

---

## 开工前必读

**1. 记录你自己的基线。** 本仓库两边基线都不干净，验收标准是「零新增」，不是「全绿」。2026-09-23 在 HEAD `9ea8f41` 实测：

| 检查 | 基线 |
|---|---|
| `cd backend && npx tsc --noEmit -p server/tsconfig.json` | **14 errors** |
| `cd backend && npx eslint server/` | **47 errors, 226 warnings** |
| `cd web && npx tsc --noEmit -p tsconfig.json` | **0 errors** |
| `cd web && npx eslint src/` | **0 errors, 227 warnings** |

基线会漂（有并发会话在同一工作区提交）。**每个 Task 结束前自己重跑一遍对比数字，不要相信上表。**

**2. 测试命令必须带 `env -u TSX_TSCONFIG_PATH`。** 环境里全局导出了 `TSX_TSCONFIG_PATH=server/tsconfig.json`，会让 `npx tsx` 在 web 目录下解析错 tsconfig。两边都显式 unset。

```bash
# 后端（注意 --tsconfig，后端用 @/ 路径别名）
cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test <file>

# web（无别名，web 测试一律相对路径 import）
cd web && env -u TSX_TSCONFIG_PATH npx tsx --test <file>
```

**3. 提交只 stage 自己的文件。** 同一工作区有并发会话（探查期间 HEAD 从 `eeab8fb` 漂到 `9ea8f41`），工作区里有 `web/src/components/tasks/AnchorPopover.tsx`、`anchorPlacement.ts`、`anchorPlacement.test.ts` 等**不属于本次改动**的未提交文件。每次 commit 用显式路径 `git add <file> <file>`，**永远不要 `git add -A` / `git add .`**。

**4. 不要切分支。** 会抢走并发会话的 HEAD。

**5. commit message 禁止加 `Co-Authored-By` 署名行。**

---

## File Structure

**后端**

| 文件 | 职责 | 改动 |
|---|---|---|
| `backend/server/modules/permissions/auto-approve-policy.ts` | 策略 + 分类的唯一事实来源 | 导出 `COMMAND_RULES`、新增 `AUTO_APPROVE_BLOCKED_PREFIX` 与 `classifyAutoApproveDeny` |
| `backend/server/shared/types.ts` | 归一化消息契约 | 新增 `AutoApproveDenyKind` 类型 + `NormalizedMessage.autoApproveDeny`（顶层与 `toolResult` 子形状） |
| `backend/server/modules/providers/list/claude/claude-sessions.provider.ts` | claude 归一化 | `normalizeMessage` 与 `fetchHistory` 两处打标 |
| `backend/server/modules/providers/list/qoder/qoder-sessions.provider.ts` | qoder 归一化 | 同上，两处 |

**前端**

| 文件 | 职责 | 改动 |
|---|---|---|
| `web/src/components/chat/utils/autoApproveDeny.ts` | 前端侧的交互型工具集合与 `permission_auto` 分类 | **新建** |
| `web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.tsx` | 被自动拒绝的 tool_result 的渲染 | **新建** |
| `web/src/stores/useSessionStore.ts` | 前端归一化消息契约 | 加字段 |
| `web/src/components/chat/types/types.ts` | UI 消息契约 | `ToolResult` / `ChatMessage` 加字段 |
| `web/src/components/chat/hooks/useChatMessages.ts` | 归一化消息 → UI 消息 | 透传字段；`permission_auto` 分支换判据 |
| `web/src/components/chat/view/subcomponents/MessageComponent.tsx` | 消息渲染路由 | 红框分支拆三分支 |
| `web/src/components/chat/tools/ToolRenderer.tsx` | 工具卡状态 | `deriveToolStatus` 认 `autoApproveDeny` |
| `web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx` | ⚡ 实时提示 | 判据从文案嗅探换成结构化字段 |

---

## Task 0: 记录基线

**Files:** 无（只读）

- [ ] **Step 1: 跑四遍基线并存档**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"
npx eslint server/ 2>&1 | tail -2

cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
npx eslint src/ 2>&1 | tail -2
```

把四个数字记在便签上。后续每个 Task 的验收都要跟这组数字比。

- [ ] **Step 2: 确认工作区里的并发改动**

```bash
cd /mnt/b/workdir/github/lovdex && git status --short
```

预期：看到 `AnchorPopover.tsx` 等**不属于本次**的改动。记住它们，commit 时避开。

---

## Task 1: 策略模块导出分类函数

**Files:**
- Modify: `backend/server/modules/permissions/auto-approve-policy.ts`（`COMMAND_RULES` 在 `:122`，文件末尾在 `:324`）
- Test: `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`

- [ ] **Step 1: 写失败测试**

打开 `backend/server/modules/permissions/tests/auto-approve-policy.test.ts`，把顶部 import 块改成（只加三项，其余保持原样）：

```ts
import {
  AUTO_APPROVE_BLOCKED_PREFIX,
  AUTO_APPROVE_MODE,
  COMMAND_RULES,
  classifyAutoApproveDeny,
  decideAutoApproval,
  normalizePermissionMode,
  resolveTaskAutoApprove,
  TOOLS_REQUIRING_INTERACTION,
  UNATTENDED_INTERACTION_DENY_REASON,
} from '@/modules/permissions/auto-approve-policy.js';
```

在文件末尾追加：

```ts
// --- 分类：自动审批拒绝的 tool_result ---

test('classifies the unattended interaction denial', () => {
  assert.equal(
    classifyAutoApproveDeny(true, UNATTENDED_INTERACTION_DENY_REASON),
    'interaction',
  );
});

test('classifies a blocked dangerous command by its reason prefix', () => {
  const decision = decideAutoApproval('Bash', { command: 'git push origin main' });
  assert.equal(decision.behavior, 'deny');
  assert.equal(
    classifyAutoApproveDeny(true, decision.behavior === 'deny' ? decision.reason : ''),
    'blocked',
  );
});

test('classifies a credential-path denial as blocked too', () => {
  const decision = decideAutoApproval('Write', { file_path: '~/.ssh/id_rsa' });
  assert.equal(decision.behavior, 'deny');
  assert.equal(
    classifyAutoApproveDeny(true, decision.behavior === 'deny' ? decision.reason : ''),
    'blocked',
  );
});

test('every command rule reason carries the blocked prefix', () => {
  // 约定：新加规则时漏掉前缀，UI 就会把那条拒绝渲染成红框 Error。这里钉住。
  assert.ok(COMMAND_RULES.length > 0, 'sanity: the rule list must not be empty');
  for (const rule of COMMAND_RULES) {
    assert.ok(
      rule.reason.startsWith(AUTO_APPROVE_BLOCKED_PREFIX),
      `rule reason must start with "${AUTO_APPROVE_BLOCKED_PREFIX}": ${rule.reason}`,
    );
  }
});

test('ordinary tool output is not classified as an auto-approval denial', () => {
  assert.equal(classifyAutoApproveDeny(true, 'file contents'), undefined);
  assert.equal(classifyAutoApproveDeny(true, ''), undefined);
  assert.equal(classifyAutoApproveDeny(true, undefined), undefined);
  assert.equal(classifyAutoApproveDeny(true, { content: 'x' }), undefined);
  // 必须逐字相等，不能靠「包含关键词」命中——模型可能把这句话抄进正常输出里。
  assert.equal(
    classifyAutoApproveDeny(true, `前缀 ${UNATTENDED_INTERACTION_DENY_REASON}`),
    undefined,
  );
});

test('a non-error result is never classified, even with identical content', () => {
  assert.equal(classifyAutoApproveDeny(false, UNATTENDED_INTERACTION_DENY_REASON), undefined);
  assert.equal(classifyAutoApproveDeny(undefined, UNATTENDED_INTERACTION_DENY_REASON), undefined);
});

test('the two classifications are mutually exclusive', () => {
  assert.equal(
    classifyAutoApproveDeny(true, UNATTENDED_INTERACTION_DENY_REASON),
    'interaction',
  );
  assert.ok(!UNATTENDED_INTERACTION_DENY_REASON.startsWith(AUTO_APPROVE_BLOCKED_PREFIX));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
```

预期：FAIL —— `classifyAutoApproveDeny` / `AUTO_APPROVE_BLOCKED_PREFIX` / `COMMAND_RULES` 未导出，报 SyntaxError 或 undefined。

- [ ] **Step 3: 实现**

改 `auto-approve-policy.ts` 三处。

**(a)** 把 `:122` 的 `const COMMAND_RULES` 改成导出：

```ts
/**
 * 危险操作的拒绝规则。导出是为了让测试能遍历断言每条 reason 的前缀约定
 * （见 `AUTO_APPROVE_BLOCKED_PREFIX`）—— 生产代码只经 `decideAutoApproval` 使用。
 */
export const COMMAND_RULES: readonly CommandRule[] = [
```

**(b)** 在 `UNATTENDED_INTERACTION_DENY_REASON`（`:37-38`）之后追加：

```ts
/**
 * 危险操作拒绝理由的统一前缀。`COMMAND_RULES` 每条 reason 都必须以它开头 ——
 * `classifyAutoApproveDeny` 靠它把「策略拦下的危险操作」和「工具真的报错」分开，
 * 漏一条就会把红框留在会话里。测试遍历规则钉住这个约定。
 */
export const AUTO_APPROVE_BLOCKED_PREFIX = '拒绝：';
```

**(c)** 在 `decideAutoApproval` 函数结束后（`:256` 之后、`resolveTaskAutoApprove` 之前）插入：

```ts
/**
 * 把一条 tool_result 分类成自动审批拒绝；不是自动拒绝就返回 undefined。
 *
 * 会话里的 tool_result 只带 `isError` 和一段文本 —— SDK 把 `canUseTool` 的
 * deny message 原样写进 content，所以文案是唯一可得的信号（已核实 transcript
 * 里 content 是纯字符串、与 reason 逐字相等）。前端据此换渲染，因此它不需要
 * 认识任何中文。
 *
 * `isError` 参与判定：只有被拒的工具调用才会拿到这段文案，正常输出即使碰巧
 * 相等也不是拒绝。
 */
export function classifyAutoApproveDeny(
  isError: unknown,
  content: unknown,
): 'interaction' | 'blocked' | undefined {
  if (!isError) return undefined;
  if (typeof content !== 'string') return undefined;
  const text = content.trim();
  if (text === UNATTENDED_INTERACTION_DENY_REASON) return 'interaction';
  if (text.startsWith(AUTO_APPROVE_BLOCKED_PREFIX)) return 'blocked';
  return undefined;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/permissions/tests/auto-approve-policy.test.ts
```

预期：PASS，`# fail 0`，测试数比改动前多 7 个。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/permissions/auto-approve-policy.ts \
        backend/server/modules/permissions/tests/auto-approve-policy.test.ts
git commit -m "feat(permissions): classify auto-approval denials on tool results"
```

---

## Task 2: 契约加字段 + claude provider 打标

**Files:**
- Modify: `backend/server/shared/types.ts`（`NormalizedMessage` 的 `autoApproveReason` 在 `:263-264`，`toolResult` 子形状在 `:267-271`）
- Modify: `backend/server/modules/providers/list/claude/claude-sessions.provider.ts`（类型 `:53-58`；`normalizeMessage` 的 tool_result 分支 `:449-470`；`fetchHistory` 的 `toolResultMap` `:760-773` 与预挂 `:782-792`）
- Test: `backend/server/modules/providers/list/claude/tests/auto-approve-deny-tag.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/providers/list/claude/tests/auto-approve-deny-tag.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { UNATTENDED_INTERACTION_DENY_REASON } from '@/modules/permissions/auto-approve-policy.js';

const provider = new ClaudeSessionsProvider();
const SID = 'sess-auto-approve';

/** 造一条 transcript 里的 user 行，里面挂一个 tool_result。 */
function transcriptRow(toolUseId: string, content: string, isError: boolean) {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    sessionId: SID,
    timestamp: '2026-09-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  };
}

test('an unattended interaction denial is tagged as interaction', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T1', UNATTENDED_INTERACTION_DENY_REASON, true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.ok(result, 'expected a normalized tool_result');
  assert.equal(result.isError, true);
  assert.equal(result.autoApproveDeny, 'interaction');
});

test('a blocked dangerous command is tagged as blocked', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T2', '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, 'blocked');
});

test('a genuine tool error is left untagged', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T3', 'Error: ENOENT: no such file or directory', true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.isError, true);
  assert.equal(result?.autoApproveDeny, undefined);
});

test('a successful result is left untagged', () => {
  const out = provider.normalizeMessage(transcriptRow('T4', 'file contents', false), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.autoApproveDeny, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/claude/tests/auto-approve-deny-tag.test.ts
```

预期：FAIL —— `result.autoApproveDeny` 是 `undefined`，断言 `'interaction'` 失败。

- [ ] **Step 3: 加契约字段**

改 `backend/server/shared/types.ts`。

在 `export type NormalizedMessage = {`（`:229`）**正上方**插入类型声明：

```ts
/**
 * 自动审批按策略拒绝的分类，挂在被拒的 tool_result 上。
 *
 * SDK 把 `canUseTool` 的 deny message 原样写成 `is_error: true` 的 tool_result，
 * 前端只看得到「一个错误 + 一段中文」。这个字段由后端从拒绝理由反推
 * （理由文案的唯一来源是 permissions 策略模块），让前端不必认识任何中文。
 *
 * - `'interaction'`：交互型工具（AskUserQuestion / ExitPlanMode）没人可问 ——
 *   预期内的正常结果
 * - `'blocked'`：危险操作被策略拦下 —— 值得看一眼，但不是错误
 */
export type AutoApproveDenyKind = 'interaction' | 'blocked';
```

在 `autoApproveReason?: string;`（`:264`）之后加顶层字段：

```ts
  /** 仅 tool_result：见 `AutoApproveDenyKind`。 */
  autoApproveDeny?: AutoApproveDenyKind;
```

把 `toolResult` 子形状（`:267-271`）改成：

```ts
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
    /** 仅 tool_result：见 `AutoApproveDenyKind`。 */
    autoApproveDeny?: AutoApproveDenyKind;
  };
```

- [ ] **Step 4: claude provider 打标**

改 `backend/server/modules/providers/list/claude/claude-sessions.provider.ts` 四处。

**(a)** 顶部 import 区（`:10` 那批 `@/modules/...` 之间）加：

```ts
import { classifyAutoApproveDeny, type AutoApproveDenyKind } from '@/modules/permissions/auto-approve-policy.js';
```

**(b)** `ClaudeToolResult`（`:53-58`）加字段：

```ts
type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  /** 见 `AutoApproveDenyKind`。 */
  autoApproveDeny?: AutoApproveDenyKind;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};
```

**(c)** `normalizeMessage` 的 tool_result 分支（`:449-470`）—— 把 `const isLocalWorkflow` 之后的内容改成（**新增 `resultContent` 局部量并复用它，别重复 stringify**）：

```ts
          if (part.type === 'tool_result') {
            const tur = (raw.toolUseResult || part.toolUseResult) as AnyRecord | undefined;
            const isLocalWorkflow = tur?.taskType === 'local_workflow';
            const resultContent = typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content);
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: resultContent,
              isError: Boolean(part.is_error),
              autoApproveDeny: classifyAutoApproveDeny(part.is_error, resultContent),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
              // Lift WorkflowOutput fields for local_workflow so the frontend
              // card can offer re-run/resume without parsing toolUseResult.
              taskId: isLocalWorkflow ? tur?.taskId : undefined,
              taskType: isLocalWorkflow ? tur?.taskType : undefined,
              workflowName: isLocalWorkflow ? tur?.workflowName : undefined,
              runId: isLocalWorkflow ? tur?.runId : undefined,
              scriptPath: isLocalWorkflow ? tur?.scriptPath : undefined,
              transcriptDir: isLocalWorkflow ? tur?.transcriptDir : undefined,
              summary: isLocalWorkflow ? tur?.summary : undefined,
            }));
          } else if (part.type === 'text') {
```

**(d)** `fetchHistory` 的 `toolResultMap` 构造（`:760-773`）改成：

```ts
    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            // 分类只看文案，所以拿归一化后的字符串来判，而不是原始 part.content。
            const text = typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content);
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              autoApproveDeny: classifyAutoApproveDeny(part.is_error, text),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }
```

**(e)** 同一函数里的预挂（`:782-792`）改成：

```ts
        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          autoApproveDeny: toolResult.autoApproveDeny,
          toolUseResult: toolResult.toolUseResult,
        };
```

> **为什么 (d) 和 (e) 都要改**：历史路径下 `fetchHistory` 把结果**预挂**到 tool_use 上，而前端优先读预挂的那个（`useChatMessages.ts:214`：`msg.toolResult || toolResultMap.get(msg.toolId)`）。只改 (c) 的话刷新会话后红框会回来。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/claude/tests/auto-approve-deny-tag.test.ts
```

预期：PASS，`# fail 0`。

- [ ] **Step 6: 跑既有 provider 测试确认没打破**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/claude/tests/workflow-normalize.test.ts server/modules/providers/list/claude/tests/workflow-history.test.ts
```

预期：PASS，`# fail 0`。

- [ ] **Step 7: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/shared/types.ts \
        backend/server/modules/providers/list/claude/claude-sessions.provider.ts \
        backend/server/modules/providers/list/claude/tests/auto-approve-deny-tag.test.ts
git commit -m "feat(providers): tag auto-approval denials on claude tool results"
```

---

## Task 3: qoder provider 打标

结构与 Task 2 完全对称。qoder 的 auto-approve 已上线（`backend/server/qoder-runner.js:483-500`），不打标 qoder 会话会继续显示红框。

**Files:**
- Modify: `backend/server/modules/providers/list/qoder/qoder-sessions.provider.ts`（类 `QoderSessionsProvider` 在 `:216`；类型 `QoderToolResult` 在 `:15-20`；`normalizeMessage` 的 tool_result 分支 `:255-268`；`fetchHistory` 的 `toolResultMap` `:556-570` 与预挂 `:584-590`）
- Test: `backend/server/modules/providers/list/qoder/tests/auto-approve-deny-tag.test.ts`（新建，目录已存在）

- [ ] **Step 1: 写失败测试**

新建 `backend/server/modules/providers/list/qoder/tests/auto-approve-deny-tag.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { QoderSessionsProvider } from '@/modules/providers/list/qoder/qoder-sessions.provider.js';
import { UNATTENDED_INTERACTION_DENY_REASON } from '@/modules/permissions/auto-approve-policy.js';

const provider = new QoderSessionsProvider();
const SID = 'sess-qoder-auto-approve';

function transcriptRow(toolUseId: string, content: string, isError: boolean) {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    sessionId: SID,
    timestamp: '2026-09-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  };
}

test('an unattended interaction denial is tagged as interaction', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T1', UNATTENDED_INTERACTION_DENY_REASON, true),
    SID,
  );
  const result = out.find((m) => m.kind === 'tool_result');
  assert.ok(result, 'expected a normalized tool_result');
  assert.equal(result.isError, true);
  assert.equal(result.autoApproveDeny, 'interaction');
});

test('a blocked dangerous command is tagged as blocked', () => {
  const out = provider.normalizeMessage(
    transcriptRow('T2', '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）', true),
    SID,
  );
  assert.equal(out.find((m) => m.kind === 'tool_result')?.autoApproveDeny, 'blocked');
});

test('a genuine tool error is left untagged', () => {
  const out = provider.normalizeMessage(transcriptRow('T3', 'boom: command failed', true), SID);
  const result = out.find((m) => m.kind === 'tool_result');
  assert.equal(result?.isError, true);
  assert.equal(result?.autoApproveDeny, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/qoder/tests/auto-approve-deny-tag.test.ts
```

预期：FAIL —— `autoApproveDeny` 是 `undefined`，断言 `'interaction'` 失败。

- [ ] **Step 3: 实现**

**(a)** 顶部 import 区加：

```ts
import { classifyAutoApproveDeny, type AutoApproveDenyKind } from '@/modules/permissions/auto-approve-policy.js';
```

**(b)** `QoderToolResult`（`:15-20`）加字段：

```ts
type QoderToolResult = {
  content: unknown;
  isError: boolean;
  /** 见 `AutoApproveDenyKind`。 */
  autoApproveDeny?: AutoApproveDenyKind;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};
```

**(c)** `normalizeMessage` 的 tool_result 分支（`:255-268`）改成：

```ts
          if (part.type === 'tool_result') {
            const resultContent = typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content);
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: resultContent,
              isError: Boolean(part.is_error),
              autoApproveDeny: classifyAutoApproveDeny(part.is_error, resultContent),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
```

**(d)** `fetchHistory` 的 `toolResultMap`（`:556-570`）改成：

```ts
    const toolResultMap = new Map<string, QoderToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            // 分类只看文案，所以拿归一化后的字符串来判，而不是原始 part.content。
            const text = typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content);
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              autoApproveDeny: classifyAutoApproveDeny(part.is_error, text),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }
```

**(e)** 预挂（`:584-590`）改成：

```ts
        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          autoApproveDeny: toolResult.autoApproveDeny,
          toolUseResult: toolResult.toolUseResult,
        };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/qoder/tests/auto-approve-deny-tag.test.ts
```

预期：PASS，`# fail 0`。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/providers/list/qoder/qoder-sessions.provider.ts \
        backend/server/modules/providers/list/qoder/tests/auto-approve-deny-tag.test.ts
git commit -m "feat(providers): tag auto-approval denials on qoder tool results"
```

---

## Task 4: 前端契约与透传

**Files:**
- Create: `web/src/components/chat/utils/autoApproveDeny.ts`
- Modify: `web/src/stores/useSessionStore.ts`（`autoApproveReason` 在 `:70`，`toolResult` 在 `:73`）
- Modify: `web/src/components/chat/types/types.ts`（`ToolResult` `:21-27`，`ChatMessage` `:43-70`）
- Modify: `web/src/components/chat/hooks/useChatMessages.ts`（tool_use 分支 `:213-237`）
- Test: `web/src/components/chat/hooks/useChatMessages.test.ts`（新建）
- Test: `web/src/components/chat/utils/autoApproveDeny.test.ts`（新建）

- [ ] **Step 1: 新建前端分类模块**

新建 `web/src/components/chat/utils/autoApproveDeny.ts`：

```ts
/**
 * 自动审批在**前端**侧的分类。
 *
 * 后端已经把「被自动拒绝的 tool_result」标好了（`NormalizedMessage.autoApproveDeny`），
 * 前端渲染直接读那个字段。这里只补一件事：`permission_auto` 那条实时提示帧
 * 不带分类，得靠工具名自己算 —— 交互型工具在无人值守时**必然**被拒（没人可应答），
 * 与「危险操作被拦」不是一回事，渲染强度也不同。
 */
export type AutoApproveDenyKind = 'interaction' | 'blocked';

/**
 * 交互型工具：它们需要有人在对端回答问题，无人值守时必然被策略拒绝。
 * 与 `tools/configs/toolConfigs.ts` 里注册的 `AskUserQuestion` / `ExitPlanMode` 同名。
 */
export const AUTO_APPROVE_INTERACTION_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

/**
 * 由 `permission_auto` 帧的字段算出分类。放行返回 undefined。
 *
 * 判据是**工具名**，不是文案 —— 后端改措辞不该让这里失效。
 */
export function classifyAutoApproveNotice(
  toolName: string | undefined,
  behavior: string | undefined,
): AutoApproveDenyKind | undefined {
  if (behavior !== 'deny') return undefined;
  return AUTO_APPROVE_INTERACTION_TOOLS.has(toolName ?? '') ? 'interaction' : 'blocked';
}
```

- [ ] **Step 2: 写这个模块的测试**

新建 `web/src/components/chat/utils/autoApproveDeny.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_APPROVE_INTERACTION_TOOLS,
  classifyAutoApproveNotice,
} from './autoApproveDeny';

test('both interaction tools are covered', () => {
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('AskUserQuestion'), true);
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('ExitPlanMode'), true);
  assert.equal(AUTO_APPROVE_INTERACTION_TOOLS.has('Bash'), false);
});

test('a denied interaction tool classifies as interaction', () => {
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'deny'), 'interaction');
  assert.equal(classifyAutoApproveNotice('ExitPlanMode', 'deny'), 'interaction');
});

test('a denied ordinary tool classifies as blocked', () => {
  assert.equal(classifyAutoApproveNotice('Bash', 'deny'), 'blocked');
});

test('an allow has no classification', () => {
  assert.equal(classifyAutoApproveNotice('Bash', 'allow'), undefined);
  assert.equal(classifyAutoApproveNotice('AskUserQuestion', 'allow'), undefined);
});

test('a missing tool name still classifies as blocked, never interaction', () => {
  assert.equal(classifyAutoApproveNotice(undefined, 'deny'), 'blocked');
});
```

- [ ] **Step 3: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/utils/autoApproveDeny.test.ts
```

预期：PASS，`# fail 0`（这是纯新增模块，第一次跑就该过）。

- [ ] **Step 4: 写透传的失败测试**

新建 `web/src/components/chat/hooks/useChatMessages.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizedToChatMessages } from './useChatMessages';
import type { NormalizedMessage } from '../../../stores/useSessionStore';

const base = {
  sessionId: 's1',
  timestamp: '2026-09-23T00:00:00.000Z',
  provider: 'claude',
} as const;

/** 测试只需要几个字段，但函数签名要完整消息；一处收口，别在每个用例里写 cast。 */
function rows(partial: Array<Record<string, unknown>>): NormalizedMessage[] {
  return partial as unknown as NormalizedMessage[];
}

test('threads autoApproveDeny from the standalone tool_result message (live shape)', () => {
  const messages = normalizedToChatMessages(rows([
    { ...base, id: 'u1', kind: 'tool_use', toolName: 'AskUserQuestion', toolInput: {}, toolId: 'T1' },
    {
      ...base,
      id: 'r1',
      kind: 'tool_result',
      toolId: 'T1',
      content: '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。',
      isError: true,
      autoApproveDeny: 'interaction',
    },
  ]));

  const toolUse = messages.find((m) => m.isToolUse);
  assert.ok(toolUse, 'expected a tool_use message');
  assert.equal(toolUse.toolResult?.autoApproveDeny, 'interaction');
  assert.equal(toolUse.toolResult?.isError, true);
});

test('threads autoApproveDeny from a pre-attached toolResult (history shape)', () => {
  const messages = normalizedToChatMessages(rows([
    {
      ...base,
      id: 'u2',
      kind: 'tool_use',
      toolName: 'Bash',
      toolInput: {},
      toolId: 'T2',
      toolResult: {
        content: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
        isError: true,
        autoApproveDeny: 'blocked',
      },
    },
  ]));

  const toolUse = messages.find((m) => m.isToolUse);
  assert.equal(toolUse?.toolResult?.autoApproveDeny, 'blocked');
});

test('a genuine tool error carries no autoApproveDeny', () => {
  const messages = normalizedToChatMessages(rows([
    { ...base, id: 'u3', kind: 'tool_use', toolName: 'Read', toolInput: {}, toolId: 'T3' },
    { ...base, id: 'r3', kind: 'tool_result', toolId: 'T3', content: 'ENOENT', isError: true },
  ]));

  const toolUse = messages.find((m) => m.isToolUse);
  assert.equal(toolUse?.toolResult?.isError, true);
  assert.equal(toolUse?.toolResult?.autoApproveDeny, undefined);
});
```

- [ ] **Step 5: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/hooks/useChatMessages.test.ts
```

预期：FAIL —— 前两条断言 `autoApproveDeny` 得到 `undefined`，期望 `'interaction'` / `'blocked'`。第三条应当已经 PASS（它断言的就是现状）。

- [ ] **Step 6: 加前端类型**

**(a)** `web/src/stores/useSessionStore.ts` —— 在 `autoApproveReason?: string;`（`:70`）之后加：

```ts
  /** 仅 tool_result：后端标好的自动审批拒绝分类，见 shared/types.ts 的 AutoApproveDenyKind。 */
  autoApproveDeny?: 'interaction' | 'blocked';
```

把 `toolResult`（`:73`）改成：

```ts
  toolResult?: {
    content: string;
    isError: boolean;
    toolUseResult?: unknown;
    autoApproveDeny?: 'interaction' | 'blocked';
  } | null;
```

**(b)** `web/src/components/chat/types/types.ts` —— 顶部加 import：

```ts
import type { AutoApproveDenyKind } from '../utils/autoApproveDeny';
```

`ToolResult`（`:21-27`）加字段：

```ts
export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  /** 后端标好的自动审批拒绝分类；真·工具错误上没有这个字段。 */
  autoApproveDeny?: AutoApproveDenyKind;
  [key: string]: unknown;
}
```

`ChatMessage` 里 `toolResult?: ToolResult | null;` 之后加：

```ts
  /**
   * 仅 `type: 'notice'` 的自动审批提示：分类决定渲染强度。
   * 由 `useChatMessages` 从 `permission_auto` 帧算出（见 utils/autoApproveDeny.ts）。
   */
  autoApproveDenyKind?: AutoApproveDenyKind;
```

- [ ] **Step 7: 透传字段**

改 `web/src/components/chat/hooks/useChatMessages.ts` 的 tool_use 分支（`:230-236`）：

```ts
        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
              // 自动审批拒绝的分类（后端标好）；普通结果与真·错误都是 undefined。
              autoApproveDeny: (tr as any).autoApproveDeny,
            }
          : null;
```

- [ ] **Step 8: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/hooks/useChatMessages.test.ts src/components/chat/utils/autoApproveDeny.test.ts
```

预期：PASS，`# fail 0`。

- [ ] **Step 9: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/utils/autoApproveDeny.ts \
        web/src/components/chat/utils/autoApproveDeny.test.ts \
        web/src/components/chat/hooks/useChatMessages.test.ts \
        web/src/stores/useSessionStore.ts \
        web/src/components/chat/types/types.ts \
        web/src/components/chat/hooks/useChatMessages.ts
git commit -m "feat(web): thread the auto-approval denial tag into chat messages"
```

---

## Task 5: 渲染三分支

**Files:**
- Create: `web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.tsx`
- Modify: `web/src/components/chat/view/subcomponents/MessageComponent.tsx`（tool result 区 `:208-240`）
- Modify: `web/src/components/chat/tools/ToolRenderer.tsx`（`deriveToolStatus` `:63-71`）
- Test: `web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveDenyNotice } from './AutoApproveDenyNotice';

test('the interaction variant is a quiet info line, never an error', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, {
      kind: 'interaction',
      toolName: 'AskUserQuestion',
      reason: '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。',
    }),
  );
  assert.ok(html.includes('AskUserQuestion'));
  assert.ok(html.includes('无人可应答'));
  // 关键：不能出现 Error 字样，也不能用 destructive 配色。
  assert.ok(!html.includes('Error'), 'must not be labelled Error');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  // 写给模型的指令不能泄漏到 UI。
  assert.ok(!html.includes('请基于现有信息自行判断'), 'the model-facing instruction must not render');
});

test('the blocked variant keeps a box but is not an Error', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, {
      kind: 'blocked',
      toolName: 'Bash',
      reason: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
    }),
  );
  assert.ok(html.includes('已自动拒绝'));
  assert.ok(html.includes('不允许在无人值守时推送远端'));
  assert.ok(!html.includes('Error'), 'must not be labelled Error');
  assert.ok(!html.includes('destructive'), 'must not use the destructive palette');
  assert.ok(html.includes('warning'), 'should use the warning palette');
});

test('a missing tool name degrades gracefully', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoApproveDenyNotice, { kind: 'interaction' }),
  );
  assert.ok(html.includes('无人可应答'));
  assert.ok(!html.includes('undefined'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx
```

预期：FAIL —— 模块不存在。

- [ ] **Step 3: 实现组件**

新建 `web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.tsx`：

```tsx
import type { AutoApproveDenyKind } from '../../utils/autoApproveDeny';

/**
 * 被自动审批按策略拒绝的 tool_result 的渲染。
 *
 * 这类结果在 transcript 里是 `is_error: true` —— SDK 把 `canUseTool` 的 deny
 * message 原样写成了工具报错。但它不是故障：策略按预期工作。所以不能走
 * `MessageComponent` 那个红框 Error 分支。
 *
 * 与 `AutoApproveNotice` 一样是「留痕但不打扰」，不带头像/名称/时间戳的消息
 * 外壳，因此交互型那一行自带 `px-3 sm:px-0` 的横向内缩（与消息外壳一致）。
 */
export function AutoApproveDenyNotice({
  kind,
  toolName,
  reason,
  toolId,
}: {
  kind: AutoApproveDenyKind;
  toolName?: string;
  reason?: string;
  toolId?: string;
}) {
  // 交互型：没人可问是预期内结果，一行灰字带过。
  //
  // 刻意不复用 `reason`：它的后半句「请基于现有信息自行判断并继续，不要再次
  // 请求确认」是写给**模型**的协议指令，不是 UI 文案。而 `'拒绝：…'` 那几条
  // 本来就是面向用户的，所以下面那个分支直接展示原文。
  if (kind === 'interaction') {
    return (
      <div className="my-1 flex items-start gap-2 px-3 text-xs text-muted-foreground sm:px-0">
        <span aria-hidden="true">⚡</span>
        <span>{`无人值守，无人可应答 — 已自动跳过 ${toolName || '提问'}`}</span>
      </div>
    );
  }

  // 危险操作被拦：值得人看一眼，所以保留框体，但标题不是 Error、配色不是红。
  return (
    <div
      id={toolId ? `tool-result-${toolId}` : undefined}
      className="relative mt-2 scroll-mt-4 rounded border border-warning/30 bg-warning/10 p-3"
    >
      <div className="relative mb-2 flex items-center gap-1.5">
        <span aria-hidden="true">⚡</span>
        <span className="text-xs font-medium text-warning">已自动拒绝</span>
      </div>
      <div className="relative text-sm text-warning">{reason}</div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx
```

预期：PASS，`# fail 0`。

- [ ] **Step 5: 接进 MessageComponent**

改 `web/src/components/chat/view/subcomponents/MessageComponent.tsx`。

顶部 import 区（`:20` 的 `AutoApproveNotice` 之后）加：

```ts
import { AutoApproveDenyNotice } from './AutoApproveDenyNotice';
```

把 tool result 区（`:208-240`）的三元表达式改成三分支 —— **只动最外层判断，红框分支与 ToolRenderer 分支原样保留**：

```tsx
                {/* Tool Result Section — Bash renders its output inside the command row above. */}
                {message.toolResult && message.toolName !== 'Bash' && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.autoApproveDeny ? (
                    // 自动审批按策略拒绝：不是工具故障，不画红框 Error。
                    <AutoApproveDenyNotice
                      kind={message.toolResult.autoApproveDeny}
                      toolName={message.toolName}
                      reason={String(message.toolResult.content || '')}
                      toolId={message.toolId}
                    />
                  ) : message.toolResult.isError ? (
                    // Error results - red error box with content
                    <div
                      id={`tool-result-${message.toolId}`}
                      className="relative mt-2 scroll-mt-4 rounded border border-destructive/20 bg-destructive/10 p-3"
                    >
                      <div className="relative mb-2 flex items-center gap-1.5">
                        <svg className="h-4 w-4 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-xs font-medium text-destructive">{t('messageTypes.error')}</span>
                      </div>
                      <div className="relative text-sm text-destructive">
                        <Markdown className="prose prose-sm prose-red max-w-none font-serif dark:prose-invert" onFileOpen={onFileOpen}>
                          {String(message.toolResult.content || '')}
                        </Markdown>
                      </div>
                    </div>
                  ) : (
```

- [ ] **Step 6: 让工具卡徽标也变琥珀色**

改 `web/src/components/chat/tools/ToolRenderer.tsx` 的 `deriveToolStatus`（`:63-71`）：

```ts
function deriveToolStatus(toolResult: any): ToolStatus {
  if (!toolResult) return 'running';
  // 自动审批按策略拒绝的结果不是工具故障：走琥珀色 Denied，不画红色 Error。
  // 判据是后端标好的结构化字段，不嗅探文案。
  if (toolResult.autoApproveDeny) return 'denied';
  if (toolResult.isError) {
    const content = String(toolResult.content || '').toLowerCase().trim();
    if (CLAUDE_DENIAL_MESSAGES.some((msg) => content.includes(msg))) {
      return 'denied';
    }
    return 'error';
  }
  return 'completed';
}
```

- [ ] **Step 7: 跑全部 web 相关测试 + 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx \
  src/components/chat/utils/autoApproveDeny.test.ts \
  src/components/chat/hooks/useChatMessages.test.ts
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
```

预期：测试 `# fail 0`；tsc 计数为 **0**（web 基线就是 0，本次必须保持 0）。

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.tsx \
        web/src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx \
        web/src/components/chat/view/subcomponents/MessageComponent.tsx \
        web/src/components/chat/tools/ToolRenderer.tsx
git commit -m "feat(web): render auto-approval denials without the error chrome"
```

---

## Task 6: ⚡ 实时提示改判据

**背景：** `AutoApproveNotice.tsx` 现在靠 `content.startsWith('已自动拒绝')` 决定配色。交互型的新文案以「无人值守」开头，会**不再匹配**，配色会意外变化。改成结构化字段判据，同时把交互型那条文案换成与工具卡一致的短句（原来那串会带上写给模型的指令）。

**Files:**
- Modify: `web/src/components/chat/hooks/useChatMessages.ts`（`permission_auto` 分支 `:323-334`）
- Modify: `web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx`（整个函数体）
- Test: `web/src/components/chat/view/subcomponents/AutoApproveNotice.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `web/src/components/chat/view/subcomponents/AutoApproveNotice.test.tsx`：

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveNotice } from './AutoApproveNotice';

function render(content: string, autoApproveDenyKind?: 'interaction' | 'blocked') {
  return renderToStaticMarkup(
    React.createElement(AutoApproveNotice, {
      message: { type: 'notice', content, timestamp: 0, autoApproveDenyKind } as never,
    }),
  );
}

test('the colour is driven by the tag, not the copy', () => {
  // 契约测试：同一段文案，只换分类字段，颜色必须跟着字段走。
  // 旧实现按 content.startsWith('已自动拒绝') 判，这段文案两种情况下都是 muted，
  // 所以这条在旧实现上必红 —— 它钉住的正是「判据换成结构化字段」这件事。
  const sameText = '无人值守，无人可应答 — 已自动跳过 AskUserQuestion';
  assert.ok(render(sameText, 'blocked').includes('warning'), 'blocked must be emphasised');
  assert.ok(!render(sameText, 'interaction').includes('warning'), 'interaction must stay muted');
});

test('a blocked denial is emphasised', () => {
  const html = render('已自动拒绝 Bash：拒绝：不允许在无人值守时推送远端', 'blocked');
  assert.ok(html.includes('warning'));
});

test('an interaction skip is quiet', () => {
  const html = render('无人值守，无人可应答 — 已自动跳过 AskUserQuestion', 'interaction');
  assert.ok(!html.includes('warning'));
  assert.ok(html.includes('muted-foreground'));
});

test('an allow is quiet', () => {
  const html = render('已自动放行 Bash');
  assert.ok(!html.includes('warning'));
  assert.ok(html.includes('muted-foreground'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test src/components/chat/view/subcomponents/AutoApproveNotice.test.tsx
```

预期：**只有第一条 FAIL**（`blocked must be emphasised` —— 旧实现看文案不看字段，这段文案不以 `已自动拒绝` 开头，落到 muted）。后三条应当已经 PASS，因为它们描述的正是旧实现的现有行为。

如果四条**全部** PASS，说明判据没被旧文案前缀控制，回去看 `AutoApproveNotice` 当前实现；如果后三条也红，说明改动打破了现有观感。

- [ ] **Step 3: 改 AutoApproveNotice**

把 `web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx` 的函数体整体替换为：

```tsx
export function AutoApproveNotice({ message }: { message: ChatMessage }) {
  // 判据是结构化字段，不是文案：交互型拒绝（没人可问）与放行一样是安静的，
  // 只有「危险操作被拦」才值得用 warning 色提一下。靠 startsWith 判文案会在
  // 后端改措辞时静默失效。
  const emphasized = message.autoApproveDenyKind === 'blocked';
  return (
    <div
      className={`my-1 flex items-start gap-2 px-3 text-xs sm:px-0 ${
        emphasized ? 'text-warning' : 'text-muted-foreground'
      }`}
    >
      <span aria-hidden="true">⚡</span>
      <span>{message.content}</span>
    </div>
  );
}
```

（保留文件顶部的 import 与那段 doc comment 不动。）

- [ ] **Step 4: 改 permission_auto 分支**

改 `web/src/components/chat/hooks/useChatMessages.ts`（`:323-334`）：

```ts
      case 'permission_auto': {
        const kind = classifyAutoApproveNotice(msg.toolName, msg.autoApproveBehavior);
        msgOut.push({
          type: 'notice',
          content: msg.autoApproveBehavior === 'deny'
            ? (kind === 'interaction'
                // 与工具卡里那行同一句话：理由原文的后半句是写给模型的指令，
                // 不该出现在 UI 里。
                ? `无人值守，无人可应答 — 已自动跳过 ${msg.toolName ?? '提问'}`
                : `已自动拒绝 ${msg.toolName ?? '工具'}：${msg.autoApproveReason ?? '无人值守执行中'}`)
            : `已自动放行 ${msg.toolName ?? '工具'}`,
          timestamp: msg.timestamp,
          autoApproveDenyKind: kind,
          ...sharedMetadata,
        });
        break;
      }
```

并在该文件顶部 import 区加：

```ts
import { classifyAutoApproveNotice } from '../utils/autoApproveDeny';
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/chat/view/subcomponents/AutoApproveNotice.test.tsx \
  src/components/chat/hooks/useChatMessages.test.ts
```

预期：PASS，`# fail 0`。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/AutoApproveNotice.tsx \
        web/src/components/chat/view/subcomponents/AutoApproveNotice.test.tsx \
        web/src/components/chat/hooks/useChatMessages.ts
git commit -m "fix(web): key the auto-approval notice off the tag, not the copy"
```

---

## Task 7: 全量验收

**Files:** 无（只跑检查）

- [ ] **Step 1: 跑两边完整测试相关文件**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/permissions/tests/auto-approve-policy.test.ts \
  server/modules/providers/list/claude/tests/auto-approve-deny-tag.test.ts \
  server/modules/providers/list/claude/tests/workflow-normalize.test.ts \
  server/modules/providers/list/claude/tests/workflow-history.test.ts \
  server/modules/providers/list/qoder/tests/auto-approve-deny-tag.test.ts

cd /mnt/b/workdir/github/lovdex/web
env -u TSX_TSCONFIG_PATH npx tsx --test \
  src/components/chat/utils/autoApproveDeny.test.ts \
  src/components/chat/hooks/useChatMessages.test.ts \
  src/components/chat/view/subcomponents/AutoApproveDenyNotice.test.tsx \
  src/components/chat/view/subcomponents/AutoApproveNotice.test.tsx
```

预期：两边 `# fail 0`。

- [ ] **Step 2: 跑完整 provider 测试目录，确认没打破别的东西**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test "server/modules/providers/list/claude/tests/*.test.ts" "server/modules/providers/list/qoder/tests/*.test.ts" 2>&1 | tail -8
```

预期：`# fail 0`。若报 glob 不支持，逐个列文件。

- [ ] **Step 3: 类型检查对比基线**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -c "error TS"

cd /mnt/b/workdir/github/lovdex/web
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
```

预期：backend 数字 **≤ Task 0 记下的基线**（本次是纯增量，不该新增）；web 必须是 **0**。数字变大就逐个看是不是本次引入的。

- [ ] **Step 4: lint 对比基线**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx eslint server/ 2>&1 | tail -2

cd /mnt/b/workdir/github/lovdex/web
npx eslint src/ 2>&1 | tail -2
```

预期：backend errors **≤ 47**；web errors 必须是 **0**（warnings 可增，但新增的应能解释）。

- [ ] **Step 5: 确认真实 transcript 能被正确分类（端到端证据）**

单测只证明「给对了输入就能分类」。还要证明**真实 transcript 里的输入就是对的那一个**——文案差一个标点就会静默退化成红框。

在 `backend/` 下建一个临时探针文件 `backend/probe-auto-approve-deny.ts`（跑完删掉，不要提交）：

```ts
import fs from 'node:fs';
import path from 'node:path';

import { classifyAutoApproveDeny } from './server/modules/permissions/auto-approve-policy.js';

const root = path.join(process.env.HOME ?? '', '.claude', 'projects');
let found = 0;

function walk(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (!entry.name.endsWith('.jsonl')) continue;
    let txt: string;
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of txt.split('\n')) {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const content = record?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== 'tool_result') continue;
        const kind = classifyAutoApproveDeny(part.is_error, part.content);
        if (!kind) continue;
        found += 1;
        console.log(kind, '|', String(part.content).slice(0, 50), '|', p);
      }
    }
  }
}

walk(root);
console.log('total classified:', found);
```

跑：

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json probe-auto-approve-deny.ts
rm probe-auto-approve-deny.ts
```

预期：打出若干条 `interaction` 行，`total classified` ≥ 1。

**2026-09-23 已在规划阶段实跑过一次**，全量 transcript 的输出是：

```
constant: "无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。"
tool_results scanned: 9928
classified: { interaction: 3 }
interaction mismatches: 0
```

即：9928 条 tool_result 里 3 条命中，**逐字不等的 0 条** —— 常量与真实落盘内容完全一致。

**两个注意点**：

1. 探针会把「读取策略文件本身」产生的 tool_result 也算进去（那个文件的内容里含这句中文注释）。所以判 mismatch 时要按长度排除长文本，否则会刷出几百 KB 的误报。
2. `blocked` 目前**命中 0 次** —— 还没有危险命令被拒过的真实记录。所以 `'拒绝：'` 前缀那条路径只有单测覆盖，没有真实数据背书。看到 `classified: { interaction: N }` 而没有 `blocked` 是**正常**的，不要以为坏了。

**若 `interaction` 为 0**：说明匹配没生效，回去逐字比对 `UNATTENDED_INTERACTION_DENY_REASON` 与 transcript 里的实际 content（注意结尾标点、全角半角、有无空格）。这是本任务最可能翻车的地方，**不要跳过**。

- [ ] **Step 6: 确认没有把并发会话的文件提交进来**

```bash
cd /mnt/b/workdir/github/lovdex
git log --oneline -7
git status --short
```

预期：7 个新提交都是本次的；`git status` 里**仍有** `AnchorPopover.tsx` 等并发改动（说明没误提交，也没误删）。

- [ ] **Step 7: 汇报**

把四组基线数字、7 个 commit hash、Step 5 的实测输出贴给用户。**不要 push**（未获授权）。
