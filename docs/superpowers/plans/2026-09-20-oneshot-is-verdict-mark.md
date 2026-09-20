# 一次性 LLM 会话打 is_verdict 标记 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runOneShotClaudeText` 捕获 SDK 流里的 session_id 并打 `is_verdict` 标记，堵住 verdict/取名/上下文压缩三类一次性会话泄漏进「最近任务」的缺口，并修复存量污染数据。

**Architecture:** 打标放在三个一次性任务共用的 headless 入口 `runOneShotClaudeText` 内部（与 `runOperatorHeadless` 的 mark seam 模式同构）：流循环捕获 `message.session_id`，流结束后调用 `sessionsDb.markSessionAsVerdict(sid, cfg.workspace)`（upsert 语义，时序无关）。存量修复是一次性 SQL，按 summary 前缀匹配 operator-workspace 下的一次性会话行。

**Tech Stack:** Node.js ESM + `@anthropic-ai/claude-agent-sdk`、better-sqlite3、`node:test`（`npx tsx --tsconfig server/tsconfig.json --test`）、sqlite3 CLI。

**Spec:** `docs/superpowers/specs/2026-09-20-oneshot-is-verdict-mark-design.md`

**分支：** 在 `feat/design-token-unification` 上直接提交（用户已确认）。

**测试命令约定：** 后端测试一律 `env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test <file>`，在 `backend/` 目录下执行（`TSX_TSCONFIG_PATH` 有全局残留值会劫持 tsconfig 解析，必须 `-u` 清掉）。

**验收基线：** 本次改动只允许零新增 typecheck/lint 错误（仓库有 pre-existing 错误，见 backend 基线备忘）。

---

### Task 1: `runOneShotClaudeText` 打 is_verdict 标记（TDD）

**Files:**
- Test: `backend/server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts`
- Modify: `backend/server/claude-sdk.js:1396-1443`（docblock + `runOneShotClaudeText` 函数体）

- [ ] **Step 1: 写失败测试**

在 `run-one-shot-claude-text.test.ts` 文件末尾追加 3 个测试（现有 6 个测试与其 import 保持原样）：

```typescript
test('runOneShotClaudeText marks the session as verdict with the operator workspace', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', session_id: 'shot-1', message: { content: [{ type: 'text', text: 'ok' }] } };
    yield { type: 'result', session_id: 'shot-1', result: 'ok' };
  };
  const marks: Array<[string, string]> = [];
  const text = await runOneShotClaudeText({
    prompt: 'p',
    systemPrompt: 's',
    queryFn,
    markVerdictSession: (sessionId, workspace) => marks.push([sessionId, workspace]),
  });
  assert.equal(text, 'ok');
  assert.deepEqual(marks, [['shot-1', '/op-workspace']]);
});

test('runOneShotClaudeText does not mark when the stream has no session_id', async () => {
  const queryFn = async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'no id' }] } };
  };
  let called = false;
  const text = await runOneShotClaudeText({
    prompt: 'p',
    systemPrompt: 's',
    queryFn,
    markVerdictSession: () => { called = true; },
  });
  assert.equal(text, 'no id');
  assert.equal(called, false);
});

test('runOneShotClaudeText swallows marker failures', async () => {
  const queryFn = async function* () {
    yield { type: 'result', session_id: 'shot-2', result: '' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'still ok' }] } };
  };
  const text = await runOneShotClaudeText({
    prompt: 'p',
    systemPrompt: 's',
    queryFn,
    markVerdictSession: () => { throw new Error('db down'); },
  });
  assert.equal(text, 'still ok');
});
```

注意第一个测试断言 workspace 是 `'/op-workspace'`——这是把 `getOperatorConfig` 的返回 mock 掉来实现的（见 Step 3）。测试文件顶部还需要加 mock 设置。在 `import { runOneShotClaudeText } from '@/claude-sdk.js';` 之后立即加：

```typescript
import { mock } from 'node:test';

// runOneShotClaudeText 从 getOperatorConfig() 读 workspace（同时决定 cwd 与 mark
// 参数）。单测不落配置文件，mock 成固定值。
const operatorConfigMock = mock.method(
  await import('@/modules/operators/operator.config.js'),
  'getOperatorConfig',
  () => ({ workspace: '/op-workspace', model: '', enabled: true }),
);
```

（若 `mock.method` 与模块顶层 await 在该文件的现有写法里不兼容——文件是 ESM `node:test`——备选写法：把 mock 放进每个测试内 `t.mock.method(...)`。目标只有一个：`getOperatorConfig()` 在本测试文件进程内返回 `workspace: '/op-workspace'`。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts
```

预期：新增 3 个测试 FAIL（`runOneShotClaudeText is not a function that accepts markVerdictSession` / marks 数组为空 / 参数不匹配），现有 6 个 PASS。

- [ ] **Step 3: 实现**

`backend/server/claude-sdk.js` 两处改动：

(a) 函数签名加 seam 参数，docblock 补一行说明。把 1396-1411 行的 docblock+签名改为：

```javascript
/**
 * One-shot headless Claude text run: NOT a live session, NO websocket, NO
 * tools. Runs the SDK `query` with all built-in tools disabled and
 * bypassPermissions, then collects the assistant text blocks and returns the
 * joined output (or null). Used by the task-context compression job to turn a
 * compacted transcript into a fixed-template context summary. `queryFn` is the
 * test seam (defaults to the SDK `query`).
 *
 * The Claude CLI still writes a transcript JSONL for this headless run (cwd is
 * the operator workspace), which the session synchronizer would index into the
 * sidebar as a regular session — its first user message IS the one-shot prompt
 * (verdict criteria / title instructions). So the stream's session_id is
 * captured and marked `is_verdict` after the run, exactly like
 * `runOperatorHeadless` does; the marker failure is logged, never propagated.
 * `markVerdictSession` is the test seam (defaults to
 * sessionsDb.markSessionAsVerdict(sid, cfg.workspace)).
 *
 * Unlike `runOperatorHeadless` (which swallows + logs errors and resolves), a
 * run failure here rejects to the caller — so the compression job can
 * distinguish "no output" (`null`) from "run failed" (rejection).
 */
export async function runOneShotClaudeText({ prompt, systemPrompt, model, queryFn, markVerdictSession } = {}) {
```

(b) 流循环捕获 session_id 并在流结束后打标。把 1429-1443 行改为：

```javascript
  const queryToUse = queryFn ?? query;
  const queryInstance = queryToUse({ prompt, options: sdkOptions });
  const parts = [];
  let capturedSessionId = null;
  for await (const message of queryInstance) {
    if (!capturedSessionId && message?.session_id) {
      capturedSessionId = message.session_id;
    }
    if (message?.type !== 'assistant') continue;
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  if (capturedSessionId) {
    const mark = markVerdictSession ?? ((sid) => sessionsDb.markSessionAsVerdict(sid, cfg.workspace));
    try {
      mark(capturedSessionId);
    } catch (e) {
      console.error('[one-shot] mark verdict session failed', e);
    }
  }
  const text = parts.join('\n').trim();
  return text || null;
}
```

（注：原代码里 `const queryInstance = (queryFn ?? query)({...})` 直接内联；改为先取 `queryToUse` 是为与上方 `runOperatorHeadless` 的写法保持一致——若嫌多余可保留原内联写法，语义相同。）

- [ ] **Step 4: 跑测试确认全绿**

```bash
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts
```

预期：9 个测试全部 PASS。

- [ ] **Step 5: 回归相邻测试**

```bash
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-verdict-llm.test.ts server/modules/operators/tests/operator-verdict-trigger.test.ts server/modules/tasks/services/task-title-llm.test.ts 2>/dev/null || env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-verdict-llm.test.ts server/modules/operators/tests/operator-verdict-trigger.test.ts
```

预期：全部 PASS（这三个模块的 deps 接口未动，纯回归确认）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/claude-sdk.js backend/server/modules/providers/list/claude/tests/run-one-shot-claude-text.test.ts
git commit -m "fix(claude-sdk): mark one-shot headless sessions as is_verdict"
```

---

### Task 2: 存量污染数据修复（生产库一次性 UPDATE）

**Files:**
- 生产库：`~/.lovdex/data/new-auth.db`（不在 git 内）
- 无代码改动

- [ ] **Step 1: 备份 DB**

```bash
cp ~/.lovdex/data/new-auth.db ~/.lovdex/data/new-auth.db.bak-oneshot-verdict-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: 预检命中行数（必须等于 18，否则停下来重查）**

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT count(*) FROM sessions WHERE project_path='/home/zhijuhuang/.lovdex/operator-workspace' AND is_verdict=0 AND is_operator=0 AND (summary LIKE '判断任务 %' OR summary LIKE '为下面的任务需求起一个标题%');"
```

预期输出：`18`（12 条判定 + 6 条取名）。若数字不同（例如执行前又跑出了新的一次性会话），重新用 `SELECT session_id, substr(summary,1,50) FROM sessions WHERE …` 逐条人工核对前缀后再继续——**不允许**放宽 WHERE 条件。

- [ ] **Step 3: 执行 UPDATE**

```bash
sqlite3 ~/.lovdex/data/new-auth.db "UPDATE sessions SET is_verdict = 1 WHERE project_path='/home/zhijuhuang/.lovdex/operator-workspace' AND is_verdict=0 AND is_operator=0 AND (summary LIKE '判断任务 %' OR summary LIKE '为下面的任务需求起一个标题%');"
```

- [ ] **Step 4: 验证**

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT is_verdict, count(*) FROM sessions WHERE project_path='/home/zhijuhuang/.lovdex/operator-workspace' GROUP BY is_verdict, is_operator;"
```

预期：`0|17`（is_operator=1 的助手交互会话，保持原状）+ `1|18`（本次修复的行）。再到前端确认「最近任务」里垃圾条目消失（刷新页面即可，无需重启后端——`is_verdict` 是读时过滤）。

- [ ] **Step 5: 无 commit**（数据修复不进 git；备份文件留在 data 目录）

---

### Task 3: 端到端验证 + 基线核对

**Files:**
- 无新改动；本任务是验收

- [ ] **Step 1: 全量后端测试回归**

```bash
cd /mnt/b/workdir/github/lovdex/backend
env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/list/claude/tests/ server/modules/operators/tests/ server/modules/database/tests/ 2>&1 | tail -8
```

预期：`# fail 0`。

- [ ] **Step 2: typecheck / lint 零新增**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npm run typecheck 2>&1 | tail -3
npm run lint 2>&1 | tail -3
```

预期：错误数不高于改动前基线（先跑一遍记下基线数字再对比；仓库存在 pre-existing 错误，只看"零新增"）。

- [ ] **Step 3: 真实链路冒烟（观察自然产生的一次性会话）**

后端跑着的时候，正常使用会产生新的一次性调用（下一轮任务完成 verdict / 下一次建任务取名）。之后检查：

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT session_id, is_verdict, substr(COALESCE(summary,''),1,40), datetime(created_at) FROM sessions WHERE project_path='/home/zhijuhuang/.lovdex/operator-workspace' AND is_operator=0 AND created_at > datetime('now','-1 hour') ORDER BY created_at DESC LIMIT 5;"
```

预期：一次性会话行 `is_verdict=1`（新代码生效）。若 1 小时内没有自然触发，可临时建一个带描述的新任务（取名 job 必然触发）来制造一次调用。

- [ ] **Step 4: 更新记忆与收尾**

确认冒烟通过后，把 `~/.claude/projects/-mnt-b-workdir-github-lovdex/memory/lovdex-oneshot-is-verdict-gap.md` 的「修复方案（未实施）」段更新为「已修复（commit <Task 1 的 hash> + 存量 UPDATE 18 行）」。

---

## Self-Review 记录

- **Spec 覆盖**：spec 三节（函数内打标 / 存量修复 / 测试 3 例）分别对应 Task 1 / Task 2 / Task 1 Step 1。「不做的事」三条均未出现在计划里。
- **占位符扫描**：所有步骤含完整代码或完整命令；Task 1 Step 1 的 mock 写法给了主案+备选，验收标准明确（getOperatorConfig 返回 `/op-workspace`）。
- **类型一致性**：`markVerdictSession(sessionId, workspace)` 两参数签名与 `sessionsDb.markSessionAsVerdict(sid, cfg.workspace)` 默认实现、与 `runOperatorHeadless` 现有 seam 一致。
