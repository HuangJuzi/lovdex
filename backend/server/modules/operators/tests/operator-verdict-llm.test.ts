/**
 * Unit tests for the lightweight LLM verdict channel.
 *
 * This channel replaces "spawn a full operator headless session to judge the
 * transcript" with a single DeepSeek-Flash text completion. The LLM is the only
 * external dependency, so it is injected via the `oneShot` seam — everything
 * else (prompt building, schema validation, timeout, outcome classification) is
 * real code under test.
 *
 * The outcome tri-state is the contract the trigger relies on:
 *   'written' — a schema-valid verdict was persisted
 *   'skipped' — deliberately not judged (no evidence); must NOT fall back
 *   'failed'  — transport/LLM/validation failure; caller may fall back
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FINAL_OUTPUT_CHARS,
  MAX_VERDICT_TRANSCRIPT_CHARS,
  VERDICT_LLM_MODEL,
  buildVerdictLlmPrompt,
  parseVerdictLlmResponse,
  runLlmVerdict,
  type VerdictLlmDeps,
} from '@/modules/operators/operator-verdict-llm.js';
import type { AiVerdict } from '@/shared/task-status.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assistant(text: string) {
  return { role: 'assistant', content: text };
}

function user(text: string) {
  return { role: 'user', content: text };
}

/** Capture what runLlmVerdict hands the one-shot runner. */
type OneShotCall = { prompt: string; systemPrompt: string; model?: string };

function makeDeps(opts: {
  messages?: unknown[];
  oneShot?: (args: OneShotCall) => Promise<string | null>;
  historyThrows?: boolean;
  task?: { ai_summary?: string | null; verdict_at?: string | null } | null;
  writeSummaryThrows?: boolean;
}) {
  const calls: OneShotCall[] = [];
  const writes: Array<{ taskId: string; summary: string; verdict: AiVerdict; reason?: string | null }> = [];
  const deps: VerdictLlmDeps = {
    fetchHistory: async () => {
      if (opts.historyThrows) throw new Error('history boom');
      return { messages: opts.messages ?? [user('do the thing'), assistant('done, tests pass')] };
    },
    oneShot: async (args) => {
      calls.push(args);
      return opts.oneShot ? opts.oneShot(args) : null;
    },
    getTask: () => opts.task ?? null,
    writeSummary: (taskId, input) => {
      if (opts.writeSummaryThrows) throw new Error('write boom');
      writes.push({ taskId, ...input });
    },
  };
  return { deps, calls, writes };
}

/** A promise that never settles — safe for the timeout test (no live timers). */
const never = () => new Promise<null>(() => {});

const VALID_JSON = JSON.stringify({
  summary: '已修复登录态丢失，单测通过。',
  verdict: 'done',
  reason: '改动落地且验证通过，仅差提交。',
});

// ===========================================================================
// parseVerdictLlmResponse — schema validation
// ===========================================================================

test('parseVerdictLlmResponse parses a bare JSON object', () => {
  const parsed = parseVerdictLlmResponse(VALID_JSON);
  assert.equal(parsed?.verdict, 'done');
  assert.equal(parsed?.summary, '已修复登录态丢失，单测通过。');
  assert.equal(parsed?.reason, '改动落地且验证通过，仅差提交。');
});

test('parseVerdictLlmResponse returns null for null / empty / whitespace', () => {
  assert.equal(parseVerdictLlmResponse(null), null);
  assert.equal(parseVerdictLlmResponse(''), null);
  assert.equal(parseVerdictLlmResponse('   \n  '), null);
});

test('parseVerdictLlmResponse returns null when there is no JSON at all', () => {
  assert.equal(parseVerdictLlmResponse('这个任务已经完成了。'), null);
});

test('parseVerdictLlmResponse returns null for a verdict outside the four allowed values', () => {
  const raw = JSON.stringify({ summary: 's', verdict: 'completed' });
  assert.equal(parseVerdictLlmResponse(raw), null, 'unknown verdict must be rejected, not coerced');
});

test('parseVerdictLlmResponse returns null for a non-string verdict', () => {
  const raw = JSON.stringify({ summary: 's', verdict: 3 });
  assert.equal(parseVerdictLlmResponse(raw), null);
});

test('parseVerdictLlmResponse returns null when summary is missing or blank', () => {
  assert.equal(parseVerdictLlmResponse(JSON.stringify({ verdict: 'done' })), null);
  assert.equal(parseVerdictLlmResponse(JSON.stringify({ summary: '   ', verdict: 'done' })), null);
});

test('parseVerdictLlmResponse extracts JSON from a ```json fenced block', () => {
  const raw = ['判定如下：', '```json', VALID_JSON, '```'].join('\n');
  assert.equal(parseVerdictLlmResponse(raw)?.verdict, 'done');
});

test('parseVerdictLlmResponse extracts JSON surrounded by prose', () => {
  const raw = `结论：${VALID_JSON}\n以上。`;
  assert.equal(parseVerdictLlmResponse(raw)?.verdict, 'done');
});

test('parseVerdictLlmResponse accepts each of the four verdicts', () => {
  for (const verdict of ['done', 'only_plan', 'needs_review', 'blocked'] as const) {
    const raw = JSON.stringify({ summary: 's', verdict });
    assert.equal(parseVerdictLlmResponse(raw)?.verdict, verdict);
  }
});

test('parseVerdictLlmResponse normalises a missing reason to null', () => {
  const raw = JSON.stringify({ summary: 's', verdict: 'blocked' });
  assert.equal(parseVerdictLlmResponse(raw)?.reason, null);
});

test('parseVerdictLlmResponse trims summary/reason and drops a blank reason', () => {
  const raw = JSON.stringify({ summary: '  s  ', verdict: 'done', reason: '   ' });
  const parsed = parseVerdictLlmResponse(raw);
  assert.equal(parsed?.summary, 's');
  assert.equal(parsed?.reason, null);
});

// ===========================================================================
// buildVerdictLlmPrompt
// ===========================================================================

test('buildVerdictLlmPrompt carries the task id, title, final output and transcript', () => {
  const { system, user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: '修登录',
    transcript: '[user] 修登录\n\n[assistant] 好了',
    finalOutput: '好了',
    priorVerdict: null,
  });
  assert.match(system, /Lovdex/);
  assert.match(userPrompt, /t1/);
  assert.match(userPrompt, /修登录/);
  assert.match(userPrompt, /好了/);
  assert.match(userPrompt, /\[user\] 修登录/);
});

test('buildVerdictLlmPrompt lists all four verdicts so the model knows the vocabulary', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: null,
  });
  for (const verdict of ['done', 'only_plan', 'needs_review', 'blocked']) {
    assert.match(userPrompt, new RegExp(verdict));
  }
});

test('buildVerdictLlmPrompt includes the prior-verdict weak-reference block only when present', () => {
  const without = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: null,
  });
  assert.doesNotMatch(without.user, /此前的判定/);

  const withPrior = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: { summary: '之前判过 done', verdictAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.match(withPrior.user, /此前的判定/);
  assert.match(withPrior.user, /之前判过 done/);
});

// ===========================================================================
// buildVerdictLlmPrompt — operator-supplied criteria override
//
// The override replaces ONLY the judgement criteria. The task header, the
// prior-verdict block, the evidence blocks and the JSON output contract are
// invariant: `parseVerdictLlmResponse` rejects anything without the JSON shape,
// so an override that dropped it would silently degrade every verdict to a
// provider fallback.
// ===========================================================================

const OVERRIDE = '只看有没有跑 E2E 冒烟，跑了才算 done。';

test('buildVerdictLlmPrompt replaces the default criteria when an override is given', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: null,
    promptOverride: OVERRIDE,
  });
  assert.match(userPrompt, /只看有没有跑 E2E 冒烟/);
  assert.doesNotMatch(userPrompt, /判定要同时权衡三方面/);
});

test('buildVerdictLlmPrompt uses the default criteria when the override is null', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: null,
    promptOverride: null,
  });
  assert.match(userPrompt, /判定要同时权衡三方面/);
});

test('buildVerdictLlmPrompt ignores a whitespace-only override', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: null,
    promptOverride: '   \n  ',
  });
  assert.match(userPrompt, /判定要同时权衡三方面/);
});

test('an override keeps the evidence blocks so the model still sees the work', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 'THE_TRANSCRIPT',
    finalOutput: 'THE_FINAL_OUTPUT',
    priorVerdict: null,
    promptOverride: OVERRIDE,
  });
  assert.match(userPrompt, /THE_FINAL_OUTPUT/);
  assert.match(userPrompt, /THE_TRANSCRIPT/);
  assert.match(userPrompt, /<<<FINAL_OUTPUT/);
  assert.match(userPrompt, /<<<TRANSCRIPT/);
});

test('an override keeps the JSON output contract the parser depends on', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 't1',
    title: 'x',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: null,
    promptOverride: OVERRIDE,
  });
  assert.match(userPrompt, /只输出 JSON/);
  assert.match(userPrompt, /"verdict"/);
});

test('an override keeps the task header and the prior-verdict block', () => {
  const { user: userPrompt } = buildVerdictLlmPrompt({
    taskId: 'task-42',
    title: '修登录',
    transcript: 't',
    finalOutput: 'f',
    priorVerdict: { summary: '上次判 done', verdictAt: '2026-01-01T00:00:00.000Z' },
    promptOverride: OVERRIDE,
  });
  assert.match(userPrompt, /task-42/);
  assert.match(userPrompt, /修登录/);
  assert.match(userPrompt, /上次判 done/);
});

test('runLlmVerdict forwards the override into the prompt it sends', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });

  await runLlmVerdict({
    sessionId: 's1',
    taskId: 't1',
    title: 'x',
    deps,
    promptOverride: OVERRIDE,
  });

  assert.match(calls[0].prompt, /只看有没有跑 E2E 冒烟/);
  assert.doesNotMatch(calls[0].prompt, /判定要同时权衡三方面/);
});

test('runLlmVerdict uses the default criteria when no override is supplied', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.match(calls[0].prompt, /判定要同时权衡三方面/);
});

test('runLlmVerdict still writes a verdict when an override is in play', async () => {
  const { deps, writes } = makeDeps({ oneShot: async () => VALID_JSON });

  const outcome = await runLlmVerdict({
    sessionId: 's1',
    taskId: 't1',
    title: 'x',
    deps,
    promptOverride: OVERRIDE,
  });

  assert.equal(outcome, 'written');
  assert.equal(writes[0].verdict, 'done');
});

// ===========================================================================
// runLlmVerdict — happy path
// ===========================================================================

test('runLlmVerdict writes the parsed verdict and reports written', async () => {
  const { deps, writes } = makeDeps({ oneShot: async () => VALID_JSON });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'written');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].taskId, 't1');
  assert.equal(writes[0].verdict, 'done');
  assert.equal(writes[0].summary, '已修复登录态丢失，单测通过。');
});

test('runLlmVerdict asks the one-shot runner for the provider default slot', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, VERDICT_LLM_MODEL);
  // A SLOT name, never a concrete id: the slot resolves through
  // providers.claude.defaultModel, so swapping the deployment's model needs no
  // source change. Hardcoding an id here would pin this channel to whatever id
  // happened to be current when it was written.
  assert.equal(VERDICT_LLM_MODEL, 'default');
});

test('runLlmVerdict lets the caller override the model', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps, model: 'Other-Model' });

  assert.equal(calls[0].model, 'Other-Model');
});

// ---------------------------------------------------------------------------
// Configurable model (Operator settings → 自动判定 → 状态判断模型)
// ---------------------------------------------------------------------------

test('runLlmVerdict uses the model from the injected config getter', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });
  deps.getModel = () => 'Kimi-K3';

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(calls[0].model, 'Kimi-K3');
});

test('runLlmVerdict falls back to the built-in model when the configured one is blank', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });
  deps.getModel = () => '   ';

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(calls[0].model, VERDICT_LLM_MODEL);
});

test('runLlmVerdict falls back to the built-in model when no config getter is wired', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(calls[0].model, VERDICT_LLM_MODEL);
});

test('an explicit model argument wins over the configured one', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });
  deps.getModel = () => 'FromConfig';

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps, model: 'FromArg' });

  assert.equal(calls[0].model, 'FromArg');
});

test('runLlmVerdict trims the configured model', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });
  deps.getModel = () => '  GLM-5.2  ';

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(calls[0].model, 'GLM-5.2');
});

test('a throwing config getter does not break the verdict (falls back to built-in)', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });
  deps.getModel = () => {
    throw new Error('config read boom');
  };

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'written');
  assert.equal(calls[0].model, VERDICT_LLM_MODEL);
});

test('runLlmVerdict sends a system prompt distinct from the user prompt', async () => {
  const { deps, calls } = makeDeps({ oneShot: async () => VALID_JSON });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.ok(calls[0].systemPrompt.length > 0);
  assert.notEqual(calls[0].systemPrompt, calls[0].prompt);
});

// ===========================================================================
// runLlmVerdict — transcript handling
// ===========================================================================

test('runLlmVerdict truncates an over-long transcript before prompting', async () => {
  // Per-message compaction caps each message at 1200 chars, so it takes many
  // messages to exceed the whole-transcript budget — one huge message would
  // pass this test without ever exercising the truncation.
  const filler = 'x'.repeat(1_200);
  const messages = [
    ...Array.from({ length: 100 }, (_, i) => user(`${i}:${filler}`)),
    assistant('done'),
  ];
  const { deps, calls } = makeDeps({ messages, oneShot: async () => VALID_JSON });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.ok(
    calls[0].prompt.length <= MAX_VERDICT_TRANSCRIPT_CHARS + MAX_FINAL_OUTPUT_CHARS + 5_000,
    `prompt should be bounded, got ${calls[0].prompt.length}`,
  );
  // The decisive evidence survives even when the transcript is cut.
  assert.match(calls[0].prompt, /done/);
});

test('runLlmVerdict skips (without calling the LLM) when the transcript has no assistant output', async () => {
  const { deps, calls, writes } = makeDeps({
    messages: [user('只有用户发言')],
    oneShot: async () => VALID_JSON,
  });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'skipped');
  assert.equal(calls.length, 0, 'no evidence → must not spend an LLM call');
  assert.equal(writes.length, 0, 'no evidence → must not label the task');
});

test('runLlmVerdict passes the prior verdict record to the prompt when the task has one', async () => {
  const { deps, calls } = makeDeps({
    oneShot: async () => VALID_JSON,
    task: { ai_summary: '上次判 done', verdict_at: '2026-01-01T00:00:00.000Z' },
  });

  await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.match(calls[0].prompt, /上次判 done/);
});

// ===========================================================================
// runLlmVerdict — failure paths (must never throw, never label blindly)
// ===========================================================================

test('runLlmVerdict reports failed when the one-shot runner rejects', async () => {
  const { deps, writes } = makeDeps({
    oneShot: async () => {
      throw new Error('llm boom');
    },
  });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'failed');
  assert.equal(writes.length, 0);
});

test('runLlmVerdict reports failed when the one-shot runner returns null', async () => {
  const { deps, writes } = makeDeps({ oneShot: async () => null });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'failed');
  assert.equal(writes.length, 0);
});

test('runLlmVerdict reports failed on an unparseable response', async () => {
  const { deps, writes } = makeDeps({ oneShot: async () => '我觉得这个任务做完了' });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'failed');
  assert.equal(writes.length, 0);
});

test('runLlmVerdict reports failed on an out-of-vocabulary verdict and writes nothing', async () => {
  const { deps, writes } = makeDeps({
    oneShot: async () => JSON.stringify({ summary: 's', verdict: 'completed' }),
  });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'failed');
  assert.equal(writes.length, 0, 'an invalid verdict must never reach the DB');
});

test('runLlmVerdict reports failed when reading the transcript throws', async () => {
  const { deps, calls } = makeDeps({ historyThrows: true, oneShot: async () => VALID_JSON });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'failed');
  assert.equal(calls.length, 0);
});

test('runLlmVerdict times out a hanging LLM call and reports failed', async () => {
  const { deps, writes } = makeDeps({ oneShot: never });

  const outcome = await runLlmVerdict({
    sessionId: 's1',
    taskId: 't1',
    title: 'x',
    deps,
    timeoutMs: 25,
  });

  assert.equal(outcome, 'failed');
  assert.equal(writes.length, 0);
});

test('runLlmVerdict reports failed (does not throw) when persisting the verdict throws', async () => {
  const { deps } = makeDeps({ oneShot: async () => VALID_JSON, writeSummaryThrows: true });

  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x', deps });

  assert.equal(outcome, 'failed');
});

test('runLlmVerdict reports failed (does not throw) when no deps are wired', async () => {
  // No `deps` and no initVerdictLlm() call in this file → the production
  // "index.js forgot to wire us" path. Must degrade, never crash the hook.
  const outcome = await runLlmVerdict({ sessionId: 's1', taskId: 't1', title: 'x' });
  assert.equal(outcome, 'failed');
});
