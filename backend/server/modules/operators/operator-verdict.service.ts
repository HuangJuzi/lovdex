/**
 * Auto-verdict trigger: when a non-operator session completes, schedule a
 * judgement of the work and write a summary + verdict onto the task.
 *
 * Two channels, selected by `operator_config.verdict_mode`:
 * - **llm** (default): one DeepSeek-Flash text completion
 *   (`operator-verdict-llm.ts`). Cheap enough to run on every completion.
 * - **provider**: the legacy full operator headless session
 *   (`runOperatorHeadless`), which spawns a whole Claude Code agent to read the
 *   transcript via MCP tools.
 *
 * In `llm` mode a transport / timeout / schema failure falls back to the
 * provider channel, so switching to `llm` is strictly cheaper, never less
 * covered. A `skipped` outcome (no readable evidence) does NOT fall back — the
 * provider path applies the same pre-check and would reach the same conclusion,
 * so a fallback would only burn a session.
 *
 * Design constraints (per Task 9 spec):
 * - **Recursion guard**: operator sessions (is_operator=true) never trigger
 *   their own verdict — the operator judging operator output would loop.
 * - **Concurrency**: at most `max_concurrent` runs are active at any time;
 *   excess jobs queue and are pumped when a slot frees. The slot is held for
 *   the whole judgement, including any llm→provider fallback.
 * - **Failure isolation**: a run that rejects is caught and logged, never
 *   propagated — the caller (a session-status hook) must not crash.
 * - **Config-gated**: early-returns when `enabled` or `auto_verdict_enabled`
 *   is false.
 *
 * `scheduleAutoVerdict` accepts injectable `runHeadless`, `getConfig` and
 * `runLlm` seams so unit tests can spy without real LLM calls or DB-backed
 * config. In production all three default to the real implementations.
 */

import { runOperatorHeadless } from '@/claude-sdk.js';
import { runLlmVerdict, type VerdictLlmOutcome } from './operator-verdict-llm.js';
import { getOperatorConfig, type OperatorConfig } from './operator.config.js';

export type RunHeadless = (args: {
  sessionId: string;
  taskId: string;
  title: string;
}) => Promise<void>;
export type RunLlmVerdict = (args: {
  sessionId: string;
  taskId: string;
  title: string;
}) => Promise<VerdictLlmOutcome>;
export type GetOperatorConfig = () => OperatorConfig;

/** Number of verdict judgements currently in flight (either channel). */
let active = 0;
/** Pending jobs waiting for a concurrency slot. */
const queue: Array<() => Promise<void>> = [];

/**
 * Drain the queue up to `max_concurrent`. Called after a job is scheduled and
 * after a job completes (in the `.finally`). Reads the latest config each pump
 * so a runtime `max_concurrent` change is respected on the next slot.
 */
async function pump(getConfig: GetOperatorConfig): Promise<void> {
  const cfg = getConfig();
  while (queue.length > 0 && active < cfg.max_concurrent) {
    const job = queue.shift()!;
    active++;
    job().finally(() => {
      active--;
      pump(getConfig);
    });
  }
}

/**
 * Schedule an auto-verdict judgement for a just-completed session.
 *
 * @param sessionId  - the session whose transcript to judge
 * @param taskId     - the task to write the verdict onto
 * @param title      - task title (passed to the verdict prompt)
 * @param isOperator - whether the session is an operator session (recursion guard)
 * @param runHeadless - injectable seam (defaults to real runOperatorHeadless)
 * @param getConfig   - injectable seam (defaults to real getOperatorConfig)
 * @param runLlm      - injectable seam (defaults to the real LLM channel)
 */
export function scheduleAutoVerdict(
  sessionId: string,
  taskId: string,
  title: string,
  isOperator: boolean,
  runHeadless: RunHeadless = runOperatorHeadless,
  getConfig: GetOperatorConfig = getOperatorConfig,
  runLlm: RunLlmVerdict = runLlmVerdict,
): void {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.auto_verdict_enabled) return;
  if (isOperator) return; // recursion guard

  queue.push(async () => {
    try {
      // Read the mode at run time, not at schedule time: a job can sit in the
      // queue behind `max_concurrent`, and a config change made in the meantime
      // should apply to it.
      if (getConfig().verdict_mode !== 'provider') {
        let outcome: VerdictLlmOutcome = 'failed';
        try {
          outcome = await runLlm({ sessionId, taskId, title });
        } catch (e) {
          // The real channel resolves 'failed' rather than rejecting; a
          // rejection here means an injected/custom implementation blew up.
          // Treat it exactly like 'failed' so the provider fallback still runs
          // instead of the task going unjudged.
          console.error('[operator-verdict] llm channel threw', e);
        }
        // 'written' — done. 'skipped' — no evidence; the provider path applies
        // the same pre-check, so falling back would only burn a session.
        if (outcome !== 'failed') return;
        console.error('[operator-verdict] llm channel failed — falling back to provider', {
          sessionId,
          taskId,
        });
      }
      await runHeadless({ sessionId, taskId, title });
    } catch (e) {
      // Swallow: a verdict failure must never crash the caller (the
      // session-status hook runs synchronously in the WS event loop).
      console.error('[operator-verdict] verdict run failed', e);
    }
  });
  pump(getConfig);
}

/**
 * Test-only: reset the module-level queue and active counter. Unit tests call
 * this in beforeEach / after the suite so leftover in-flight jobs from one
 * test don't bleed concurrency budget into the next.
 */
export function __resetAutoVerdictQueue(): void {
  active = 0;
  queue.length = 0;
}
