import express, { type Request, type Response } from 'express';

import { AppError } from '@/shared/utils.js';

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

/**
 * Errors a caller can act on — a bad label, an offline host, a lite that needs
 * deploying, an expired preview. These carry a message the UI must show
 * verbatim, so they are raised as {@link AppError} (400) rather than a bare
 * Error, which the global handler would flatten into an opaque
 * "Internal server error" and hide the remedy.
 */
function badRequest(message: string): AppError {
  return new AppError(message, { code: 'BAD_REQUEST', statusCode: 400 });
}

/** Runs `fn`, re-raising anything it throws as a 400 with its own message. */
async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw badRequest(err instanceof Error ? err.message : String(err));
  }
}

function requireNode(raw: unknown, field: string): SkillNode {
  if (typeof raw !== 'string') throw badRequest(`${field} must be a node label`);
  return parseSkillNode(raw);
}

function requireScope(raw: unknown): SkillScope {
  if (raw !== 'user' && raw !== 'project') {
    throw badRequest('scope must be "user" or "project"');
  }
  return raw;
}

function optionalId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw badRequest('projectId must be an integer');
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
      res.json(await asBadRequest(() => impl(node, scope, projectId)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sync/plan', async (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const projectId = optionalId(body.projectId);
      const targetProjectId = optionalId(body.targetProjectId);
      const plan = await asBadRequest(() =>
        deps.service.plan({
          from: requireNode(body.from, 'from'),
          to: requireNode(body.to, 'to'),
          scope: requireScope(body.scope),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(targetProjectId !== undefined ? { targetProjectId } : {}),
        }),
      );
      res.json(plan);
    } catch (err) {
      next(err);
    }
  });

  router.post('/sync/apply', async (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.planId !== 'string' || body.planId.length === 0) {
        throw badRequest('planId is required');
      }
      const names = Array.isArray(body.names)
        ? body.names.filter((n): n is string => typeof n === 'string')
        : undefined;
      const result = await asBadRequest(() =>
        deps.service.apply({
          planId: body.planId as string,
          ...(names !== undefined ? { names } : {}),
          force: body.force === true,
          // The route is behind authenticateToken, so this is always a human.
          actor: 'user',
        }),
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
