import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkRunGuard,
  classifyToolError,
  createRepeatedErrorTracker,
  DEFAULT_RUN_GUARD_CONFIG,
  describeRunGuardReason,
  isFatalApiError,
  resolveRunGuardConfig,
} from '@/modules/operators/run-guard.js';

test('isFatalApiError recognises the incident 402 wording and its variants', () => {
  assert.equal(isFatalApiError('API Error: 402 余额不足，请充值'), true);
  assert.equal(isFatalApiError('402 Payment Required'), true);
  assert.equal(isFatalApiError('insufficient balance for this request'), true);
  assert.equal(isFatalApiError('Error: out of credits'), true);
  assert.equal(isFatalApiError('credit limit exceeded'), true);
  // Normal tool failures must NOT trip the fatal branch.
  assert.equal(isFatalApiError('Permission request timed out'), false);
  assert.equal(isFatalApiError('command not found: foo'), false);
  assert.equal(isFatalApiError(''), false);
});

test('classifyToolError keys on the normalized error text alone', () => {
  assert.equal(classifyToolError('Permission request timed out'), 'Permission request timed out');
  assert.equal(classifyToolError('  Permission   request\ttimed out  '), 'Permission request timed out');
  assert.equal(classifyToolError(''), null);
  assert.equal(classifyToolError(undefined), null);
  assert.equal(classifyToolError(42), null);
});

test('createRepeatedErrorTracker trips only after N identical consecutive failures', () => {
  const tracker = createRepeatedErrorTracker(5);
  for (let i = 0; i < 4; i++) {
    assert.equal(tracker.record('Permission request timed out'), false);
  }
  assert.equal(tracker.record('Permission request timed out'), true, '5th identical error trips');

  // A successful tool (null key) resets the streak.
  const reset = createRepeatedErrorTracker(5);
  reset.record('Permission request timed out');
  reset.record('Permission request timed out');
  reset.reset();
  assert.equal(reset.record('Permission request timed out'), false, 'reset restarts the count');

  // A different error restarts from 1 rather than accumulating.
  const rotate = createRepeatedErrorTracker(3);
  rotate.record('Permission request timed out');
  rotate.record('Permission request timed out');
  rotate.record('some other error');
  rotate.record('some other error');
  assert.equal(rotate.record('some other error'), true, 'new key reaches its own threshold');
});

test('checkRunGuard trips each fuse at the configured threshold', () => {
  const started = 1_000_000;
  const base = { turns: 0, totalTokens: 0, totalCostUsd: 0, lastActivityAtMs: started, consecutiveApprovalTimeouts: 0 };

  // Turn fuse.
  const turns = checkRunGuard({ ...base, turns: 300 }, { maxTurns: 300 }, started + 1);
  assert.equal(turns.ok, false);
  assert.equal(turns.reason, 'max_turns');

  // Wall-clock fuse.
  const dur = checkRunGuard(base, { maxDurationMs: 1000 }, started + 1000);
  assert.equal(dur.ok, false);
  assert.equal(dur.reason, 'max_duration');

  // Token fuse.
  const tok = checkRunGuard({ ...base, totalTokens: 500_000 }, { maxTotalTokens: 500_000 }, started);
  assert.equal(tok.ok, false);
  assert.equal(tok.reason, 'max_tokens');

  // Cost fuse.
  const cost = checkRunGuard({ ...base, totalCostUsd: 10 }, { maxBudgetUsd: 10 }, started);
  assert.equal(cost.ok, false);
  assert.equal(cost.reason, 'max_budget');

  // Under budget → ok.
  const ok = checkRunGuard({ ...base, turns: 5 }, { maxTurns: 300, maxDurationMs: 1000 }, started + 10);
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
});

test('wall-clock fuse is activity-aware: idle time between turns does not count', () => {
  const opened = 1_000_000;
  const base = { turns: 0, totalTokens: 0, totalCostUsd: 0, lastActivityAtMs: opened, consecutiveApprovalTimeouts: 0 };
  const cfg = { maxDurationMs: 60 * 60 * 1000 };

  // The activity-aware anchor is set at the last REAL progress event, not the
  // stream open. A resumed run re-arms it at queryClaudeSDK entry; the fuse
  // fires only when the anchor has NOT advanced for the full budget, so idle
  // time between turns never counts.
  const resumedAt = opened + 5 * 60 * 60 * 1000;
  // Simulate the real incident: the session is idle for 2h after the last
  // progress event, but the budget window is measured FROM that event. With a
  // 3h budget the run must survive; with the 1h budget it trips (a genuinely
  // stuck stream, or a resumed run that produced no new progress).
  const survives3h = checkRunGuard({ ...base, lastActivityAtMs: resumedAt }, { maxDurationMs: 3 * 60 * 60 * 1000 }, resumedAt + 2 * 60 * 60 * 1000);
  assert.equal(survives3h.ok, true, 'idle wall time is not counted against the fuse');
  const trips1h = checkRunGuard({ ...base, lastActivityAtMs: resumedAt }, cfg, resumedAt + 2 * 60 * 60 * 1000);
  assert.equal(trips1h.ok, false, 'no progress for the full budget trips the fuse');

  // Once real work resumes, the anchor keeps advancing with every progress
  // event; a stuck stream whose last real frame is > budget old trips it.
  const stuck = checkRunGuard(
    { ...base, lastActivityAtMs: opened + 10_000 },
    cfg,
    opened + 10_000 + 60 * 60 * 1000 + 1,
  );
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, 'max_duration');

  // The reported minutes are measured from the anchor, not the stream open.
  const dur = checkRunGuard(
    { ...base, lastActivityAtMs: opened + 60 * 60 * 1000 },
    cfg,
    opened + 60 * 60 * 1000 + 90 * 60 * 1000,
  );
  assert.equal(dur.ok, false);
  assert.equal(dur.detail, '90 分钟');
});

test('checkRunGuard treats 0 as disabled for every fuse', () => {
  const started = 1_000_000;
  const counters = { turns: 10_000, totalTokens: 9e9, totalCostUsd: 999, lastActivityAtMs: started, consecutiveApprovalTimeouts: 0 };
  const res = checkRunGuard(counters, { maxTurns: 0, maxDurationMs: 0, maxTotalTokens: 0, maxBudgetUsd: 0 }, started + 9e9);
  assert.equal(res.ok, true);
});

test('approval-timeout fuse trips after N consecutive unanswered approvals', () => {
  const started = 1_000_000;
  const base = { turns: 0, totalTokens: 0, totalCostUsd: 0, lastActivityAtMs: started, consecutiveApprovalTimeouts: 0 };

  // 4 consecutive timeouts stay under the 5 cap.
  const under = checkRunGuard(
    { ...base, consecutiveApprovalTimeouts: 4 },
    { maxApprovalTimeouts: 5 },
    started,
  );
  assert.equal(under.ok, true);

  // The 5th consecutive timeout trips the fuse with the streak detail.
  const trips = checkRunGuard(
    { ...base, consecutiveApprovalTimeouts: 5 },
    { maxApprovalTimeouts: 5 },
    started,
  );
  assert.equal(trips.ok, false);
  assert.equal(trips.reason, 'repeated_approval_timeout');
  assert.equal(trips.detail, '5/5');

  // 0 disables the fuse entirely.
  const disabled = checkRunGuard(
    { ...base, consecutiveApprovalTimeouts: 99 },
    { maxApprovalTimeouts: 0 },
    started,
  );
  assert.equal(disabled.ok, true);
});

test('resolveRunGuardConfig applies defaults, zero-preserving, and ignores junk', () => {
  const dflt = resolveRunGuardConfig(undefined);
  assert.deepEqual(dflt, { ...DEFAULT_RUN_GUARD_CONFIG });

  const overridden = resolveRunGuardConfig({ runGuard: { maxTurns: 10, maxDurationMs: 60_000, maxApprovalTimeouts: 3 } });
  assert.equal(overridden.maxTurns, 10);
  assert.equal(overridden.maxDurationMs, 60_000);
  assert.equal(overridden.maxApprovalTimeouts, 3);
  assert.equal(overridden.maxRepeatedErrors, DEFAULT_RUN_GUARD_CONFIG.maxRepeatedErrors);

  // 0 must be preserved as "disabled", not coerced to a default.
  const zeroed = resolveRunGuardConfig({ runGuard: { maxTurns: 0 } });
  assert.equal(zeroed.maxTurns, 0);

  // Junk/negative values degrade to defaults.
  const junk = resolveRunGuardConfig({ runGuard: { maxTurns: -5, maxBudgetUsd: 'nope' } });
  assert.equal(junk.maxTurns, DEFAULT_RUN_GUARD_CONFIG.maxTurns);
  assert.equal(junk.maxBudgetUsd, DEFAULT_RUN_GUARD_CONFIG.maxBudgetUsd);
});

test('describeRunGuardReason yields a human-readable reason for every fuse', () => {
  assert.match(describeRunGuardReason('max_turns', '300/300'), /最大轮次/);
  assert.match(describeRunGuardReason('repeated_tool_error', 'Permission request timed out'), /连续失败/);
  assert.match(describeRunGuardReason('fatal_api_error', '402'), /致命错误/);
  assert.match(describeRunGuardReason('repeated_approval_timeout', '5/5'), /连续超时/);
});
