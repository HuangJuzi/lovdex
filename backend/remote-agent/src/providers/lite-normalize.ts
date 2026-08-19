/**
 * Lite-side message normalization helpers for the non-claude provider runners
 * (codex / opencode / qoder).
 *
 * The lite cannot import the main server's `shared/utils.ts` (it pulls the whole
 * `@/`-aliased server tree, including app config, into the lite bundle). These
 * helpers re-implement the handful of pure `createNormalizedMessage` /
 * `createCompleteMessage` shapes the local runners (`backend/server/openai-codex.js`,
 * `backend/server/opencode-runner.js`, `backend/server/qoder-runner.js`) send over
 * the WebSocket, so the `{ _remoteNorm: true, message }` payloads pushed to main
 * (Task 13 passthrough) carry THE SAME `NormalizedMessage` shape the local path
 * emits. Envelope field ordering and defaults mirror `server/shared/utils.ts`
 * exactly; only `id`/`timestamp` (random per call anyway) differ in their bytes.
 */
import { randomUUID } from 'node:crypto';

/** Narrow an unknown value to a plain object (mirror of server `readObjectRecord`). */
export function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * The `NormalizedMessage` shape main's passthrough expects (server
 * `shared/types.ts`). Kept structural here because `@/shared/types.js` is not
 * importable from the lite bundle (would drag the aliased server tree in).
 */
export type LiteNormalizedMessage = Record<string, unknown> & {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: string;
  kind: string;
};

/** Mirror of `utils.generateMessageId` (`msg_<uuid>`, prefix from kind). */
export function generateMessageId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID()}`;
}

/** Mirror of `utils.createNormalizedMessage` — fills id/sessionId/timestamp. */
export function createNormalizedMessage(
  fields: Record<string, unknown> & { kind: string; provider: string },
): LiteNormalizedMessage {
  return {
    ...fields,
    id: (fields.id as string | undefined) || generateMessageId(fields.kind),
    sessionId: (fields.sessionId as string | undefined) || '',
    timestamp: (fields.timestamp as string | undefined) || new Date().toISOString(),
    provider: fields.provider,
  };
}

type CompleteOptions = {
  provider: string;
  sessionId?: string | null;
  actualSessionId?: string | null;
  exitCode?: number | null;
  aborted?: boolean;
};

/**
 * Mirror of `utils.createCompleteMessage` — the unified terminal lifecycle
 * message every local provider run ends with.
 */
export function createCompleteMessage(opts: CompleteOptions): LiteNormalizedMessage {
  const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 1;
  const aborted = Boolean(opts.aborted);
  return createNormalizedMessage({
    kind: 'complete',
    provider: opts.provider,
    sessionId: opts.sessionId || null,
    actualSessionId: opts.actualSessionId || opts.sessionId || null,
    exitCode,
    success: exitCode === 0 && !aborted,
    aborted,
  });
}

/**
 * Mirror of `utils.flattenPromptForWindowsShell`: newline runs collapse to spaces
 * ONLY on win32 before passing a prompt as a positional CLI arg (cmd.exe .cmd
 * shims drop everything after the first newline). No-op on POSIX (which is where
 * the lite runs).
 */
export function flattenPromptForWindowsShell(prompt: string): string {
  if (typeof prompt !== 'string' || process.platform !== 'win32') {
    return prompt;
  }
  return prompt.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Mirror of the qoder history filter (`qoder-sessions.provider.ts`). Qoder's
 * live stream can inject system-reminder / interruption banner rows that the
 * web chat must never render as user bubbles; prefixes are copied verbatim.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
] as const;

export function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}