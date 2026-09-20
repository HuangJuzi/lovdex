import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SkillStore } from '@/shared/skill-store.js';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';
import { skillNodeLabel, skillStoreForNode, userSkillRoot } from './skill-node.js';
import type { SkillSyncAuditInput } from './skill-sync.db.js';
import type {
  ApplyRequest,
  SkillNode,
  SkillScope,
  SkillSyncAction,
  SkillSyncEntry,
  SkillSyncResult,
  SkillSyncResultEntry,
  SyncPlan,
} from './types.js';

/** How long a previewed plan stays applicable. */
export const PLAN_TTL_MS = 10 * 60 * 1000;

/** The minimum shape the service needs from the projects repository. */
export type ProjectLookup = (projectId: number) => { project_path: string; remote_host_id: string | null } | null;

export type SkillSyncServiceDeps = {
  getRegistry: () => RemoteAgentsRegistry;
  getProjectById: ProjectLookup;
  audit: (input: SkillSyncAuditInput) => void;
  /** Test seam. */
  now?: () => number;
  /** Test seam: two local directories standing in for two nodes. */
  localStore?: SkillStore;
  localRootOverride?: { fromRoot: string; toRoot: string };
};

export type PlanRequest = {
  from: SkillNode;
  to: SkillNode;
  scope: SkillScope;
  projectId?: number;
  targetProjectId?: number;
};

/** Which side of the sync a root is being resolved for. */
export type SyncSide = 'from' | 'to';

type CachedPlan = { plan: SyncPlan; createdAt: number };

export type SkillSyncService = {
  plan(req: PlanRequest): Promise<SyncPlan>;
  /** Root resolution, exposed so the browse endpoint does not have to plan. */
  resolveRoot(node: SkillNode, scope: SkillScope, projectId: number | undefined, side: SyncSide): string;
  takePlan(planId: string): SyncPlan | null;
  apply(req: ApplyRequest): Promise<SkillSyncResult>;
};

function actionFor(fromHash: string | undefined, toHash: string | undefined): SkillSyncAction {
  if (fromHash === undefined) return 'onlyTarget';
  if (toHash === undefined) return 'create';
  return fromHash === toHash ? 'same' : 'update';
}

export function createSkillSyncService(deps: SkillSyncServiceDeps): SkillSyncService {
  const now = deps.now ?? (() => Date.now());
  const plans = new Map<string, CachedPlan>();

  /** Lazily sweeps expired entries; the map is small (one entry per preview). */
  function sweep(): void {
    const cutoff = now() - PLAN_TTL_MS;
    for (const [id, entry] of plans) {
      if (entry.createdAt < cutoff) plans.delete(id);
    }
  }

  function storeFor(node: SkillNode): SkillStore {
    if (node.kind === 'local' && deps.localStore) return deps.localStore;
    return skillStoreForNode(node, deps.getRegistry);
  }

  /**
   * Resolves the skill root for one side of the sync.
   *
   * `side` matters because BOTH endpoints may be local (a local→local sync is
   * how the tests drive the orchestrator), and the two sides need different
   * roots.
   *
   * Project scope requires the project row so the path AND the host can be
   * cross-checked — pairing a remote node with a local project row would
   * otherwise read the wrong machine's disk.
   */
  function rootFor(
    node: SkillNode,
    scope: SkillScope,
    projectId: number | undefined,
    side: SyncSide,
  ): string {
    if (scope === 'user') {
      if (node.kind === 'local' && deps.localRootOverride) {
        return side === 'from' ? deps.localRootOverride.fromRoot : deps.localRootOverride.toRoot;
      }
      return userSkillRoot(node);
    }
    const field = side === 'from' ? 'projectId' : 'targetProjectId';
    if (projectId === undefined) {
      throw new Error(`${field} is required for project scope (${skillNodeLabel(node)})`);
    }
    const project = deps.getProjectById(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const projectHost = project.remote_host_id ?? null;
    const nodeHost = node.kind === 'remote' ? node.hostId : null;
    if (projectHost !== nodeHost) {
      throw new Error(
        `project ${projectId} lives on ${projectHost ?? 'local'} but node ${skillNodeLabel(node)} was given`,
      );
    }
    return path.join(project.project_path, '.claude', 'skills');
  }

  return {
    resolveRoot: rootFor,

    async plan(req) {
      sweep();
      if (req.scope === 'project') {
        // Both ids are validated up front: rootFor resolves the FROM side first,
        // and a request that is merely missing targetProjectId would otherwise
        // be reported as `project not found` (or the reverse) — the wrong remedy.
        if (req.projectId === undefined) {
          throw new Error(`projectId is required for project scope (${skillNodeLabel(req.from)})`);
        }
        if (req.targetProjectId === undefined) {
          throw new Error(
            `targetProjectId is required for project scope (${skillNodeLabel(req.to)})`,
          );
        }
      }
      const fromRoot = rootFor(req.from, req.scope, req.projectId, 'from');
      const toRoot = rootFor(req.to, req.scope, req.targetProjectId, 'to');

      const [fromManifest, toManifest] = await Promise.all([
        storeFor(req.from).manifest(fromRoot),
        storeFor(req.to).manifest(toRoot),
      ]);

      const fromByName = new Map(fromManifest.entries.map((e) => [e.name, e]));
      const toByName = new Map(toManifest.entries.map((e) => [e.name, e]));
      const names = [...new Set([...fromByName.keys(), ...toByName.keys()])].sort();

      const entries: SkillSyncEntry[] = names.map((name) => {
        const from = fromByName.get(name);
        const to = toByName.get(name);
        // An inert entry (unreadable / oversized) has contentHash '' — treat it
        // as "hash unknown" so the action is never computed against a lie, and
        // carry the reason so apply can refuse it explicitly.
        const fromHash = from && !from.error ? from.contentHash : undefined;
        const toHash = to && !to.error ? to.contentHash : undefined;
        const blocked = from?.error ?? to?.error;
        return {
          name,
          action: actionFor(fromHash, toHash),
          ...(fromHash !== undefined ? { fromHash } : {}),
          ...(toHash !== undefined ? { toHash } : {}),
          ...(from && !from.error ? { bytes: from.totalBytes } : {}),
          ...(from?.description ? { description: from.description } : {}),
          ...(blocked ? { error: blocked } : {}),
        };
      });

      const plan: SyncPlan = {
        planId: randomUUID(),
        from: req.from,
        to: req.to,
        scope: req.scope,
        ...(req.projectId !== undefined ? { projectId: req.projectId } : {}),
        ...(req.targetProjectId !== undefined ? { targetProjectId: req.targetProjectId } : {}),
        fromRoot,
        toRoot,
        entries,
        summary: {
          create: entries.filter((e) => e.action === 'create').length,
          update: entries.filter((e) => e.action === 'update').length,
          same: entries.filter((e) => e.action === 'same').length,
          onlyTarget: entries.filter((e) => e.action === 'onlyTarget').length,
        },
        createdAt: now(),
      };
      plans.set(plan.planId, { plan, createdAt: plan.createdAt });
      return plan;
    },

    takePlan(planId) {
      sweep();
      const cached = plans.get(planId);
      if (!cached) return null;
      // Single use: a preview authorises ONE apply. Re-applying the same planId
      // would skip the drift checks the second time around.
      plans.delete(planId);
      return cached.plan;
    },
  };
}
