import type { ProjectSession } from '../types/app';

/**
 * Resolve the display title for a session.
 *
 * Priority: user-set `custom_name` (rename UI / disk custom-title / codex
 * thread_name) → auto `summary` (ai-title / last-prompt / last agent message)
 * → legacy `name` / `title`. Returns `undefined` when none are non-empty so
 * callers can apply their own fallback (placeholder text, session id, etc.).
 */
export function resolveSessionTitle(
  session: ProjectSession | null | undefined,
): string | undefined {
  if (!session) {
    return undefined;
  }

  const candidates = [
    session.custom_name,
    session.summary,
    session.name,
    session.title,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}
