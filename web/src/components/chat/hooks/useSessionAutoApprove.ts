import { useCallback, useEffect, useState } from 'react';

import { safeLocalStorage } from '../utils/chatStorage';

/** The slice of the Storage API this hook needs; injected so tests can pass a fake. */
export interface AutoApproveStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Session-scoped "the user turned auto-approval off here" flag.
 *
 * Keyed by session and persisted, mirroring the existing
 * `permissionMode-${sessionId}` key in useChatProviderState. Persisting matters:
 * a reload that silently restored auto-approval would be invisible — tool calls
 * stop being shown — and the user would only find out when something they wanted
 * to approve was auto-denied.
 *
 * This is a pure frontend preference and never reaches the unattended paths:
 * scheduled / assistant / headless runs go through `startTaskRun` and read the
 * task row directly, never through `chat.send`.
 */
export function autoApproveOverrideKey(sessionId: string): string {
  return `autoApproveOff-${sessionId}`;
}

/** The task flag minus the session override. Pure; four quadrants in the test. */
export function resolveEffectiveAutoApprove(taskFlag: boolean, override: boolean): boolean {
  return taskFlag && !override;
}

export function readAutoApproveOverride(
  sessionId: string | null | undefined,
  storage: AutoApproveStorage = safeLocalStorage,
): boolean {
  if (!sessionId) return false;
  return storage.getItem(autoApproveOverrideKey(sessionId)) === '1';
}

export function writeAutoApproveOverride(
  sessionId: string | null | undefined,
  override: boolean,
  storage: AutoApproveStorage = safeLocalStorage,
): void {
  if (!sessionId) return;
  storage.setItem(autoApproveOverrideKey(sessionId), override ? '1' : '0');
}

export interface UseSessionAutoApproveArgs {
  sessionId: string | null | undefined;
  /** The linked task's `auto_approve === 1`; `undefined` means "no linked task". */
  taskFlag: boolean | undefined;
}

export interface UseSessionAutoApproveResult {
  /** Whether to render the toggle at all — only when the task has it on. */
  show: boolean;
  /** The state the button renders. */
  enabled: boolean;
  toggle: () => void;
  /**
   * `false` only when this send must be downgraded. Typed `false | undefined`
   * (not `boolean`) so a caller cannot accidentally send `true` — the backend
   * would ignore it, but the type makes the mistake unrepresentable here.
   */
  clientAutoApprove: false | undefined;
}

export function useSessionAutoApprove({
  sessionId,
  taskFlag,
}: UseSessionAutoApproveArgs): UseSessionAutoApproveResult {
  const [override, setOverride] = useState(() => readAutoApproveOverride(sessionId));

  // Re-read when the user switches sessions; a stale override from the previous
  // session must not leak into this one.
  useEffect(() => {
    setOverride(readAutoApproveOverride(sessionId));
  }, [sessionId]);

  const toggle = useCallback(() => {
    setOverride((previous) => {
      const next = !previous;
      writeAutoApproveOverride(sessionId, next);
      return next;
    });
  }, [sessionId]);

  const show = taskFlag === true;
  return {
    show,
    enabled: resolveEffectiveAutoApprove(show, override),
    toggle,
    clientAutoApprove: override ? false : undefined,
  };
}
