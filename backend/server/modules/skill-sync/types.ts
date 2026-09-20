import type { SkillApplyInput, SkillStore } from '@/shared/skill-store.js';

export type { SkillApplyInput, SkillStore };

/**
 * A sync endpoint. "local" is the machine running the main server; every other
 * node is a remote host with a lite agent. Both implement the same
 * {@link SkillStore}, which is why the orchestrator has no branching.
 */
export type SkillNode = { kind: 'local' } | { kind: 'remote'; hostId: string };

export type SkillScope = 'user' | 'project';

/** `onlyTarget` is display-only in v1 — there is no delete path. */
export type SkillSyncAction = 'create' | 'update' | 'same' | 'onlyTarget';

export type SkillSyncEntry = {
  name: string;
  action: SkillSyncAction;
  fromHash?: string;
  toHash?: string;
  bytes?: number;
  description?: string;
  /**
   * Set when either side could not be fingerprinted (oversized / unreadable).
   * `action` is then computed from "hash unknown" and `apply` refuses the entry
   * outright — an unreadable TARGET must never be mistaken for an absent one,
   * or the sync would overwrite content it could not read.
   */
  error?: string;
};

/**
 * A previewed sync. Held server-side under `planId` (see the plan cache) so the
 * client cannot hand back a doctored plan — the two optimistic-concurrency
 * checks are only meaningful if the plan is the one the server produced.
 */
export type SyncPlan = {
  planId: string;
  from: SkillNode;
  to: SkillNode;
  scope: SkillScope;
  projectId?: number;
  targetProjectId?: number;
  fromRoot: string;
  toRoot: string;
  entries: SkillSyncEntry[];
  summary: { create: number; update: number; same: number; onlyTarget: number };
  createdAt: number;
};

export type SkillSyncResultEntry = {
  name: string;
  status: 'ok' | 'failed' | 'conflict' | 'skipped';
  action?: 'create' | 'update';
  backupPath?: string;
  error?: string;
};

export type SkillSyncResult = {
  planId: string;
  from: SkillNode;
  to: SkillNode;
  entries: SkillSyncResultEntry[];
  summary: { ok: number; failed: number; conflict: number; skipped: number };
};

export type ApplyRequest = {
  planId: string;
  /** Optional subset of plan entries to transfer (create/update only). */
  names?: string[];
  actor: 'user' | 'operator' | 'system';
  force?: boolean;
};
