/**
 * Auto-verdict trigger: when a non-operator session completes, schedule a
 * headless operator run to judge the work and write a summary + verdict onto
 * the task.
 *
 * Design constraints (per Task 9 spec):
 * - **Recursion guard**: operator sessions (is_operator=true) never trigger
 *   their own verdict — the operator judging operator output would loop.
 * - **Concurrency**: at most `max_concurrent` headless runs are active at any
 *   time; excess jobs queue and are pumped when a slot frees.
 * - **Failure isolation**: a headless run that rejects is caught and logged,
 *   never propagated — the caller (a session-status hook) must not crash.
 * - **Config-gated**: early-returns when `enabled` or `auto_verdict_enabled`
 *   is false.
 *
 * `scheduleAutoVerdict` accepts injectable `runHeadless` and `getConfig` seams
 * so unit tests can spy without real Claude calls or DB-backed config. In
 * production both default to the real implementations.
 */

import { runOperatorHeadless } from '@/claude-sdk.js';
import { getOperatorConfig, type OperatorConfig } from './operator.config.js';

export type RunHeadless = (args: {
  sessionId: string;
  taskId: string;
  title: string;
}) => Promise<void>;
export type GetOperatorConfig = () => OperatorConfig;

/** Number of headless verdict runs currently in flight. */
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
 * Schedule an auto-verdict headless run for a just-completed session.
 *
 * @param sessionId  - the session whose transcript to judge
 * @param taskId     - the task to write the verdict onto
 * @param title      - task title (passed to the verdict prompt)
 * @param isOperator - whether the session is an operator session (recursion guard)
 * @param runHeadless - injectable seam (defaults to real runOperatorHeadless)
 * @param getConfig   - injectable seam (defaults to real getOperatorConfig)
 */
export function scheduleAutoVerdict(
  sessionId: string,
  taskId: string,
  title: string,
  isOperator: boolean,
  runHeadless: RunHeadless = runOperatorHeadless,
  getConfig: GetOperatorConfig = getOperatorConfig,
): void {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.auto_verdict_enabled) return;
  if (isOperator) return; // recursion guard

  queue.push(async () => {
    try {
      await runHeadless({ sessionId, taskId, title });
    } catch (e) {
      // Swallow: a headless verdict failure must never crash the caller
      // (the session-status hook runs synchronously in the WS event loop).
      console.error('[operator-verdict] headless run failed', e);
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
