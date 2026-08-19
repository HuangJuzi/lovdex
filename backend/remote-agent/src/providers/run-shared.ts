/**
 * Shared run machinery for the non-claude provider runners (codex / opencode /
 * qoder). Task 12 pulls these out of `agent-run.ts`'s claude manager so the three
 * new runners integrate their CLI/SDK loops with the SAME external contract:
 *
 * - `validateRunCwd` — reject a `cwd` outside the allowlisted roots (mirror of
 *   the I4 fix in `agent-run.ts`); the lite is a code-execution surface.
 * - `createApprovalRegistry` — the pending-approval lifetime main drives via
 *   `approval/respond` and timeouts, mirroring the local qoder
 *   `registerQoderApproval` (`backend/server/qoder-runner.js`): each request is
 *   surfaced on `approval:<requestId>` (`{ appSessionId, approval }`), answered
 *   through {@link respond}, and auto-denied past `approvalTimeoutMs` (pushing a
 *   `cancelled: true` marker back so main can hide the popup — mirror of the
 *   claude `canUseTool` auto-deny in `agent-run.ts`).
 * - `makeRunRecord` — the per-run bookkeeping (aborted flag, AbortController,
 *   done promise) plus the `providerSessionId` early-resolution promise, so
 *   `start()` resolves as soon as the provider-native id is known while the run
 *   keeps going in the background and `whenDone` gates completion.
 *
 * ## TASK 13 RECORDS (main-side porting contract — do not implement here)
 *
 * **List A — dual complete layers**: every non-claude runner pushes a terminal
 * payload on `session:<appSessionId>` that consists of BOTH a wrapped
 * `{ _remoteNorm: true, message: createCompleteMessage(...) }` (the transcript
 * complete) AND a raw `{ type: 'complete', exitCode }` marker (see
 * `makeCompleteMarker`). The claude runner pushes ONLY the raw marker. Task 13's
 * `_remoteNorm` unwrapping must therefore treat the RAW marker purely as a
 * finish/done signal and MUST NOT re-normalize it into another complete,
 * otherwise the main stream sees a double `complete`.
 *
 * **List B — `_remoteNorm` is currently zero-processed**: main's `normalizeRemoteEvent`
 * has no branch for `{ _remoteNorm: true }` — if a `_remoteNorm` message leaks
 * through it today, it is normalized as a raw claude SDK event and produces
 * garbage. Task 13 must implement the passthrough (wire the wrapped `message`
 * straight to the ws writer) BEFORE routing any of the three new providers.
 */
import type { SessionStartParams } from '../agent-run.js';
import { createAllowlistedFs } from '../fs.js';

/** Unknown requestId-shaped labels flow through the same envelope. */
type LooseRecord = Record<string, unknown>;

/**
 * Merges `process.env` + run-specific overrides + `configEnv` into ONE env map.
 *
 * The merge (never a bare configEnv) is mandated by Task 12: spawning a CLI/SDK
 * with bare configEnv would strip PATH and break the child's spawn driver. The
 * narrowed `Object.entries` filter keeps TS happy (process.env values are
 * `string | undefined`; spawn env wants `string`).
 */
export function buildRunEnv(
  base: Record<string, string> | undefined,
  configEnv: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      merged[key] = value;
    }
  }
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      merged[key] = value;
    }
  }
  if (configEnv) {
    for (const [key, value] of Object.entries(configEnv)) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Rejects a `cwd` that is not an existing directory inside the allowlisted
 * host roots. `roots` is a mirror of `cfg.roots`; when it is empty/absent the
 * lite is not root-constrained (tests, minimal setups) and validation is a no-op
 * — identical semantics to `agent-run.ts` start().
 */
export async function validateRunCwd(
  roots: string[] | undefined,
  cwd: string,
): Promise<void> {
  if (!roots || roots.length === 0) {
    return;
  }
  const rootedFs = createAllowlistedFs({ roots });
  const stat = await rootedFs.stat(cwd);
  if (!stat.exists || !stat.isDirectory) {
    throw new Error(`cwd outside allowed roots: ${cwd}`);
  }
}

export type ApprovalRequest = {
  tool_use_id: string;
  name: string;
  input: unknown;
  context?: string;
};

type RegistryEntry = {
  appSessionId: string;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Writes the CLI-side answer when the human decides (`preWrite`). qoder maps
   * this to a `control_response` NDJSON frame on the child stdin mirroring the
   * local `registerQoderApproval({ respond })` closure.
   */
  onAnswer?: (decision: unknown) => void;
};

/**
 * The approval-request registry shared between main's `approval/respond` RPC and
 * the qoder line handler.
 *
 * This is deliberately CALLBACK-driven rather than promise-driven: qoder's
 * stream is event-driven and never awaits an approval (the local runner keeps
 * consuming stdout while a permission is pending), so the answer surface is a
 * closure per request. `respond(requestId, decision)` resolves a pending
 * request and returns whether it existed — the `RunManager.respond` shape main
 * calls. A timeout auto-denies and pushes a `cancelled: true` marker back on
 * `approval:<requestId>` so main can clear a popup that was never answered.
 */
export function createApprovalRegistry(opts: {
  push: (topic: string, payload: unknown) => void;
  approvalTimeoutMs?: number;
}) {
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 120_000;
  const approvals = new Map<string, RegistryEntry>();

  function register(
    requestId: string,
    appSessionId: string,
    approval: ApprovalRequest,
    hooks: { onAnswer?: (decision: unknown) => void; onExpire?: () => void } = {},
  ): void {
    const timer = setTimeout(() => {
      if (!approvals.delete(requestId)) {
        return;
      }
      opts.push(`approval:${requestId}`, {
        appSessionId,
        approval: { ...approval, cancelled: true },
      });
      hooks.onExpire?.();
    }, approvalTimeoutMs);
    approvals.set(requestId, {
      appSessionId,
      timer,
      ...(hooks.onAnswer ? { onAnswer: hooks.onAnswer } : {}),
    });
    opts.push(`approval:${requestId}`, { appSessionId, approval });
  }

  function respond(requestId: string, decision: unknown): boolean {
    const entry = approvals.get(requestId);
    if (!entry) {
      return false;
    }
    approvals.delete(requestId);
    clearTimeout(entry.timer);
    entry.onAnswer?.(decision);
    return true;
  }

  /**
   * Drops a request WITHOUT writing a CLI answer — used when the CLI itself
   * cancelled the request (`control_cancel`) or the run ended, in which case
   * the CLI is not waiting for a response. Mirrors the local runner's
   * `releaseQoderApproval`.
   */
  function release(requestId: string): boolean {
    const entry = approvals.get(requestId);
    if (!entry) {
      return false;
    }
    approvals.delete(requestId);
    clearTimeout(entry.timer);
    return true;
  }

  /** RequestIds still pending for one run (teardown / popup clearing). */
  function pendingFor(appSessionId: string): string[] {
    return Array.from(approvals.entries())
      .filter(([, entry]) => entry.appSessionId === appSessionId)
      .map(([requestId]) => requestId);
  }

  return { register, respond, release, pendingFor };
}

export type ApprovalRegistry = ReturnType<typeof createApprovalRegistry>;

export type RunRecord = {
  appSessionId: string;
  aborted: boolean;
  establishedSid: boolean;
  controller: AbortController;
  /** CLI child to kill on interrupt (opencode/qoder); null for SDK runs. */
  child: import('node:child_process').ChildProcess | null;
  done: Promise<void>;
  doneResolve: () => void;
};

/**
 * Builds the run record plus the `providerSessionId` early-resolution promise.
 * `start()` returns as soon as {@link establishedP} settles from the header
 * `params.providerSessionId` or the first provider-native id the run yields —
 * main's rpc waiter maps that to the provider session and aborts past ~60s, so
 * it must never wait for the whole run (mirror of `agent-run.ts` start()).
 */
export function makeRunRecord(params: SessionStartParams): {
  run: RunRecord;
  established: Promise<string>;
  settleEstablished: (id: string) => void;
  doneResolve: () => void;
} {
  let settleEstablished: (id: string) => void = () => {};
  const established = new Promise<string>((r) => (settleEstablished = r));
  if (params.providerSessionId) {
    settleEstablished(params.providerSessionId);
  }
  let doneResolve: () => void = () => {};
  const done = new Promise<void>((r) => (doneResolve = r));
  const run: RunRecord = {
    appSessionId: params.appSessionId,
    aborted: false,
    establishedSid: Boolean(params.providerSessionId),
    controller: new AbortController(),
    child: null,
    done,
    doneResolve,
  };
  return { run, established, settleEstablished, doneResolve };
}

/**
 * Terminal-marker payload pushed last on `session:<appSessionId>` so main's
 * routing finish()es the run.
 *
 * The failure shape carries TOP-LEVEL `exitCode`/`error` (NOT a nested
 * `_remoteErr`), matching the claude `terminalCompleteEvent` convention: main's
 * existing `normalizeRemoteEvent` reads `raw.exitCode ?? 0`, so a nested marker
 * would mis-report a failed run as `complete{exitCode:0}` clean success.
 *
 * - `done` — whether the run ended as a genuine success (exitCode 0). An
 *   interrupted run passes `done: true` too (abort is not a *failed* run; the
 *   plain marker is main's finish signal, and claude's abort marker carries no
 *   exitCode either, defaulting to 0).
 * - `err` — the failure message, surfaced as a top-level `error` string.
 *
 * TASK 13 LIST A (records for the main-side port): the three non-claude runners
 * push BOTH a wrapped `_remoteNorm` `createCompleteMessage` (the normalized
 * transcript complete) AND this raw `{type:'complete', exitCode}` marker. Task
 * 13's `_remoteNorm` unwrapping must treat this RAW marker ONLY as a finish
 * signal and MUST NOT re-normalize it (claude pushes only the raw marker; the
 * three new runners are wrapped+raw double-layer), otherwise main emits a double
 * `complete`.
 */
export function makeCompleteMarker(done: boolean, err?: unknown): LooseRecord {
  const errMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return {
    type: 'complete',
    exitCode: done ? 0 : 1,
    ...(errMessage ? { error: errMessage } : {}),
  };
}