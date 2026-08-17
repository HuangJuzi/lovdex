/**
 * Single source of truth for the two-layer task status domain.
 *
 * Layer 1 `status` — board column (4 values): todo / in_progress / in_review /
 * done. `backlog` has been folded into `todo`.
 *
 * Layer 2 `sub_status` — the fine-grained badge shown at a card's bottom-left,
 * a refinement of the column it sits in. Persisted subset (DB CHECK) holds the
 * AI verdicts (done/only_plan/needs_review/blocked) plus `failed`; realtime
 * values (running / waiting_* / pending_acceptance) are derived by the service's
 * decorate() on every read.
 */

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export const SUB_STATUSES = [
  'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
  'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** Persisted subset — the only values allowed in the tasks.sub_status column. */
export const PERSISTED_SUB_STATUSES = [
  'failed', 'done', 'only_plan', 'needs_review', 'blocked',
  // A run that ended at an AskUserQuestion / ExitPlanMode gate leaves the task
  // waiting for a human decision — a durable state that must survive the run
  // ending and a backend restart, so it is persisted (not just a realtime
  // overlay). Without it the board reads "进行中" for a session that has in
  // fact stopped, which is exactly the "in progress = no human needed"
  // contradiction. Cleared when the user answers and a fresh run starts.
  'waiting_answer', 'waiting_plan',
] as const;
export type PersistedSubStatus = (typeof PERSISTED_SUB_STATUSES)[number];

/** AI post-run verdicts (written by writeSummary → sub_status column). */
export const AI_VERDICTS = ['done', 'only_plan', 'needs_review', 'blocked'] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];

export function isSubStatus(value: unknown): value is SubStatus {
  return typeof value === 'string' && (SUB_STATUSES as readonly string[]).includes(value);
}

export function isPersistedSubStatus(value: unknown): value is PersistedSubStatus {
  return typeof value === 'string' && (PERSISTED_SUB_STATUSES as readonly string[]).includes(value);
}

export function isAiVerdict(value: unknown): value is AiVerdict {
  return typeof value === 'string' && (AI_VERDICTS as readonly string[]).includes(value);
}

export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD that also resolves to the same calendar date (rejects 2026-02-30). */
export function isTaskDeadline(value: unknown): value is string {
  if (typeof value !== 'string' || !DEADLINE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const TASK_LABELS = ['bug', 'feature', 'optimization', 'refactor', 'docs', 'other', 'reminder'] as const;
export type TaskLabel = (typeof TASK_LABELS)[number];

export function isTaskLabel(value: unknown): value is TaskLabel {
  return typeof value === 'string' && (TASK_LABELS as readonly string[]).includes(value);
}
