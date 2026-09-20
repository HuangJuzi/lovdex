import express, { type Request, type Response } from 'express';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';
import { parseSkillNode, skillStoreForNode } from './skill-node.js';
import type { SkillSyncService } from './skill-sync.service.js';
import type { SkillNode, SkillScope } from './types.js';

export type SkillSyncRouterDeps = {
  service: SkillSyncService;
  getRegistry: () => RemoteAgentsRegistry;
  /** Node picker data: local plus every registered host, with online state. */
  listNodes: () => { label: string; name: string; online: boolean; reason?: string }[];
  /** Overridable for tests. */
  manifest?: (node: SkillNode, scope: SkillScope, projectId?: number) => Promise<unknown>;
};

function requireNode(raw: unknown, field: string): SkillNode {
  if (typeof raw !== 'string') throw new Error(`${field} must be a node label`);
  return parseSkillNode(raw);
}

function requireScope(raw: unknown): SkillScope {
  if (raw !== 'user' && raw !== 'project') throw new Error('scope must be "user" or "project"');
  return raw;
}

function optionalId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error('projectId must be an integer');
  return n;
}

export function createSkillSyncRouter(deps: SkillSyncRouterDeps): express.Router {
  const router = express.Router();

  const defaultManifest = (node: SkillNode, scope: SkillScope, projectId?: number) =>
    skillStoreForNode(node, deps.getRegistry).manifest(
      deps.service.resolveRoot(node, scope, projectId, 'from'),
    );

  router.get('/nodes', (_req: Request, res: Response) => {
    res.json({ nodes: deps.listNodes() });
  });

  router.get('/manifest', async (req: Request, res: Response, next) => {
    try {
      const node = requireNode(req.query.node, 'node');
      const scope = requireScope(req.query.scope);
      const projectId = optionalId(req.query.projectId);
      const impl = deps.manifest ?? defaultManifest;
      res.json(await impl(node, scope, projectId));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sync/plan', async (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const plan = await deps.service.plan({
        from: requireNode(body.from, 'from'),
        to: requireNode(body.to, 'to'),
        scope: requireScope(body.scope),
        ...(optionalId(body.projectId) !== undefined ? { projectId: optionalId(body.projectId) } : {}),
        ...(optionalId(body.targetProjectId) !== undefined
          ? { targetProjectId: optionalId(body.targetProjectId) }
          : {}),
      });
      res.json(plan);
    } catch (err) {
      next(err);
    }
  });

  router.post('/sync/apply', async (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.planId !== 'string' || body.planId.length === 0) {
        throw new Error('planId is required');
      }
      const names = Array.isArray(body.names)
        ? body.names.filter((n): n is string => typeof n === 'string')
        : undefined;
      const result = await deps.service.apply({
        planId: body.planId,
        ...(names !== undefined ? { names } : {}),
        force: body.force === true,
        // The route is behind authenticateToken, so this is always a human.
        actor: 'user',
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
