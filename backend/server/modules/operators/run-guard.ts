/**
 * Session-level run guardrails for the Claude SDK runtime.
 *
 * This is the in-process enforcement layer behind the incident where two
 * unattended `default`-permission task sessions each burned ~2500 turns and a
 * ~4 MB transcript before dying on a 402 (balance exhausted). It implements
 * four independent fuses, all driven off the streaming event loop in
 * `claude-sdk.js`:
 *
 * - **Turn fuse** (`maxTurns`): count completed assistant turns. The SDK's own
 *   `maxTurns` option is not usable for this — it aborts the *CLI process* at
 *   the option level and cannot surface a Lovdex-side reason into the session's
 *   terminal `complete`, which is what `onSessionStatus('failed')` keys off.
 * - **Wall-clock fuse** (`maxDurationMs`): terminate the run once it has been
 *   streaming longer than the budget. Covers the "one infinite turn" shape the
 *   turn fuse alone misses.
 * - **Token/cost fuse** (`maxTotalTokens` / `maxBudgetUsd`): accumulate the
 *   SDK `result.usage` totals. This is the one fuse with a real cost ceiling —
 *   a 2500-turn run on the most-expensive model is what actually emptied the
 *   balance.
 * - **Repeated-failure fuse** (`maxRepeatedErrors`): N consecutive
 *   `is_error`-flagged tool results of the SAME error text (the runaway
 *   signature in the incident — `Permission request timed out` again and again)
 *   trip the fuse. Deliberately NOT keyed on "the model retried any tool" — a
 *   headless run legitimately re-runs a flaky read. It is keyed on "the same
 *   error keeps recurring without clearing".
 *
 * The reason is surfaced so `queryClaudeSDK` can terminate the loop, emit a
 * terminal `complete` with the failure, and fold the reason into the run's last
 * assistant text (which is what the task verdict reads).
 *
 * This module is pure: `checkRunGuard` decides from the counters it is handed
 * and never touches the clock, the SDK, or the DB, so it is trivially
 * unit-testable.
 */

export type RunGuardConfig = {
  maxTurns: number;
  maxDurationMs: number;
  maxTotalTokens: number;
  maxBudgetUsd: number;
  maxRepeatedErrors: number;
  defaultTaskModel: string;
};

/** Default budgets. Overridable via `app.config.json` → `providers.claude.runGuard`. */
export const DEFAULT_RUN_GUARD_CONFIG: RunGuardConfig = {
  /** Max completed turns per run. 0 = disabled. */
  maxTurns: 300,
  /** Max wall-clock streaming time per run, in ms. 0 = disabled. */
  maxDurationMs: 60 * 60 * 1000,
  /** Max cumulative tokens (input+output, across all turns) per run. 0 = disabled. */
  maxTotalTokens: 0,
  /** Max estimated spend in USD (from the SDK `result.total_cost_usd`). 0 = disabled. */
  maxBudgetUsd: 0,
  /** Consecutive same-error tool failures before the run is killed. 0 = disabled. */
  maxRepeatedErrors: 5,
  /**
   * Model slot used for an auto-dispatched sub-task with no explicit
   * `executor_model`. Must be a *cheap* slot: a null model falls through to the
   * most-expensive runtime default (the incident's sub-tasks ran on the opus
   * tier), so the guard pins the cheap tier instead of inheriting null.
   */
  defaultTaskModel: 'haiku',
};

/** Fatal API errors that must end the run on FIRST sight (see `isFatalApiError`). */
const FATAL_API_PATTERNS: readonly RegExp[] = [
  /402\b/,
  /insufficient\s+balance/i,
  /out\s+of\s+(credits|quota|funds)/i,
  /credit\s+limit\s+(reached|exceeded)/i,
  /payment\s+required/i,
  /billing\b/i,
  /余额不足/i,
  /欠费/i,
  /请充值/i,
];

export type RunGuardReason =
  | 'max_turns'
  | 'max_duration'
  | 'max_tokens'
  | 'max_budget'
  | 'repeated_tool_error'
  | 'fatal_api_error';

/** Human-readable reason for the session/task `sub_status` + transcript. */
export function describeRunGuardReason(reason: RunGuardReason, detail?: string): string {
  switch (reason) {
    case 'max_turns':
      return `会话熔断：达到最大轮次上限${detail ? `（${detail}）` : ''}，已终止。`;
    case 'max_duration':
      return `会话熔断：达到最大运行时长上限${detail ? `（${detail}）` : ''}，已终止。`;
    case 'max_tokens':
      return `会话熔断：累计 token 达到上限${detail ? `（${detail}）` : ''}，已终止。`;
    case 'max_budget':
      return `会话熔断：估算成本达到上限${detail ? `（${detail}）` : ''}，已终止。`;
    case 'repeated_tool_error':
      return `会话熔断：同一错误连续失败${detail ? `（${detail}）` : ''}，已终止。`;
    case 'fatal_api_error':
      return `会话已终止：API 返回致命错误${detail ? `（${detail}）` : ''}。`;
  }
}

/**
 * Recognizes a fatal, do-not-retry API error string (402 balance exhausted,
 * invalid key, unauthorized). The incident's terminal state was `API Error:
 * 402 余额不足，请充值` — matching is conservative and substring/prefix based
 * because the exact wording comes from the gateway/CLI, not Lovdex.
 */
export function isFatalApiError(text: string): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return FATAL_API_PATTERNS.some((re) => re.test(haystack));
}

/**
 * Classifies a tool error string for the repeated-failure counter. Returns a
 * stable non-empty key for any error-ish text, or null when there is nothing
 * to count (so a successful tool or an empty result never feeds the fuse).
 *
 * The key is the normalized error text alone — NOT the tool name. The runaway
 * signature in the incident was the same message (`Permission request timed
 * out`) repeating, and the model could in principle rotate tools while hitting
 * the same unresolved error; keying on the message collapses that to one error
 * class and trips the fuse regardless of which tool carried it.
 */
export function classifyToolError(errorText: unknown): string | null {
  const raw = typeof errorText === 'string' ? errorText.trim() : '';
  if (!raw) return null;
  // Collapse whitespace + truncate so long/parameterized messages still dedupe.
  return raw.replace(/\s+/g, ' ').slice(0, 160);
}

export type RunGuardCounters = {
  turns: number;
  totalTokens: number;
  totalCostUsd: number;
  startedAtMs: number;
};

export type RunGuardCheck = {
  ok: boolean;
  reason: RunGuardReason | null;
  detail: string;
};

/**
 * Decide whether a run has tripped a fuse given the current counters and the
 * configured budgets. `nowMs` is passed in (rather than read here) so tests can
 * drive the wall-clock fuse deterministically.
 */
export function checkRunGuard(
  counters: RunGuardCounters,
  config: Partial<RunGuardConfig>,
  nowMs: number,
): RunGuardCheck {
  const maxTurns = config.maxTurns ?? DEFAULT_RUN_GUARD_CONFIG.maxTurns;
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_RUN_GUARD_CONFIG.maxDurationMs;
  const maxTotalTokens = config.maxTotalTokens ?? DEFAULT_RUN_GUARD_CONFIG.maxTotalTokens;
  const maxBudgetUsd = config.maxBudgetUsd ?? DEFAULT_RUN_GUARD_CONFIG.maxBudgetUsd;

  if (maxTurns > 0 && counters.turns >= maxTurns) {
    return { ok: false, reason: 'max_turns', detail: `${counters.turns}/${maxTurns}` };
  }
  if (maxDurationMs > 0 && nowMs - counters.startedAtMs >= maxDurationMs) {
    const minutes = Math.round((nowMs - counters.startedAtMs) / 60000);
    return { ok: false, reason: 'max_duration', detail: `${minutes} 分钟` };
  }
  if (maxTotalTokens > 0 && counters.totalTokens >= maxTotalTokens) {
    return { ok: false, reason: 'max_tokens', detail: `${counters.totalTokens}/${maxTotalTokens}` };
  }
  if (maxBudgetUsd > 0 && counters.totalCostUsd >= maxBudgetUsd) {
    return {
      ok: false,
      reason: 'max_budget',
      detail: `$${counters.totalCostUsd.toFixed(2)}/$${maxBudgetUsd.toFixed(2)}`,
    };
  }
  return { ok: true, reason: null, detail: '' };
}

/**
 * Tracks consecutive identical tool failures so `queryClaudeSDK` can trip the
 * repeated-failure fuse. "Identical" is the normalized error text
 * (`classifyToolError`): the same error advancing the streak; any allow resets
 * it. This is the in-process mirror of the incident's `Permission request timed
 * out` ×2500 death spiral — five unanswered approvals on the same tool kill the
 * run instead of letting it re-roll the prompt forever.
 */
export type RepeatedErrorTracker = {
  /** Record one tool failure; returns true the moment the fuse should trip. */
  record(errorText: unknown): boolean;
  /** Reset the streak (e.g. a tool finally succeeded / a different error). */
  reset(): void;
};

export function createRepeatedErrorTracker(maxRepeated: number): RepeatedErrorTracker {
  let key: string | null = null;
  let count = 0;
  return {
    record(errorText) {
      const nextKey = classifyToolError(errorText);
      if (!nextKey) return false;
      if (nextKey === key) {
        count += 1;
      } else {
        key = nextKey;
        count = 1;
      }
      return maxRepeated > 0 && count >= maxRepeated;
    },
    reset() {
      key = null;
      count = 0;
    },
  };
}

/**
 * Resolve the effective run-guard budget object from the claude provider config
 * (or any object that may carry a `runGuard` block). Missing/zero values fall
 * back to the built-in defaults; the returned object is always fully concrete.
 */
export function resolveRunGuardConfig(raw: unknown): RunGuardConfig {
  const block =
    raw && typeof raw === 'object' ? (raw as { runGuard?: unknown }).runGuard : undefined;
  const cfg = block && typeof block === 'object' ? (block as Partial<RunGuardConfig>) : {};
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    maxTurns: num(cfg.maxTurns, DEFAULT_RUN_GUARD_CONFIG.maxTurns),
    maxDurationMs: num(cfg.maxDurationMs, DEFAULT_RUN_GUARD_CONFIG.maxDurationMs),
    maxTotalTokens: num(cfg.maxTotalTokens, DEFAULT_RUN_GUARD_CONFIG.maxTotalTokens),
    maxBudgetUsd: num(cfg.maxBudgetUsd, DEFAULT_RUN_GUARD_CONFIG.maxBudgetUsd),
    maxRepeatedErrors: num(cfg.maxRepeatedErrors, DEFAULT_RUN_GUARD_CONFIG.maxRepeatedErrors),
    defaultTaskModel:
      typeof cfg.defaultTaskModel === 'string' && cfg.defaultTaskModel.trim()
        ? cfg.defaultTaskModel.trim()
        : DEFAULT_RUN_GUARD_CONFIG.defaultTaskModel,
  };
}
