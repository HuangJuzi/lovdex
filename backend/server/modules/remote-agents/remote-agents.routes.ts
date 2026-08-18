import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { BootstrapInput, BootstrapResult } from './bootstrap.service.js';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';
import type { RemoteFsClient } from './remote-fs.service.js';
import type { RemoteHostsRepository } from './remote-host.db.js';

export type RemoteAgentsRouterDeps = {
  repo: RemoteHostsRepository;
  registry: RemoteAgentsRegistry;
  fsClient: RemoteFsClient;
  /** Lovdex ed25519 public key, surfaced so users can authorize it manually. */
  publicKey: string;
  /** Deterministic per-host token; generates the token AND persists its hash. */
  tokenFor: (hostId: string) => string;
  /** Wraps runBootstrap with the real ssh runner + file push. */
  bootstrap: (input: BootstrapInput) => Promise<BootstrapResult>;
  /** Path to the Lovdex ed25519 private key used for ssh, or null. */
  identityFile: string | null;
  /** Main server ws URL the lite connects back to. */
  serverUrl: string;
};

function readStringField(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readQueryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

export function createRemoteAgentsRouter(deps: RemoteAgentsRouterDeps): express.Router {
  const router = express.Router();

  // 1. List hosts with a live `online` flag from the registry.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const hosts = deps.repo.list().map((host) => ({
        ...host,
        online: deps.registry.isOnline(host.host_id),
      }));
      res.json(createApiSuccessResponse({ hosts }));
    }),
  );

  // 2. Expose the Lovdex public key for manual authorized_keys placement.
  router.get(
    '/pubkey',
    asyncHandler(async (_req, res) => {
      res.json(createApiSuccessResponse({ publicKey: deps.publicKey }));
    }),
  );

  // 3. Register a new host.
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const name = readStringField(req.body, 'name');
      const host = readStringField(req.body, 'host');
      const sshUser = readStringField(req.body, 'sshUser');
      const authType = readStringField(req.body, 'authType');
      const portRaw = (req.body as Record<string, unknown> | undefined)?.port;
      const port =
        typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw > 0 ? portRaw : undefined;

      if (authType === 'password') {
        throw new AppError(
          'password auth not supported in Phase 1 — place the pubkey manually then retry with lovdex_key',
          { code: 'REMOTE_PASSWORD_UNSUPPORTED', statusCode: 400 },
        );
      }

      if (!name || !host || !sshUser) {
        throw new AppError('name, host and sshUser are required', {
          code: 'REMOTE_HOST_INVALID',
          statusCode: 400,
        });
      }

      const hostId = crypto.randomUUID();
      deps.repo.create({ host_id: hostId, name, host, ssh_user: sshUser, port });
      // Generates the host token and persists its hash against the new row.
      deps.tokenFor(hostId);

      res.json(createApiSuccessResponse({ hostId }));
    }),
  );

  // 4. Deploy (bootstrap) the lite agent onto a registered host.
  router.post(
    '/:hostId/deploy',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      const host = deps.repo.getById(hostId);
      if (!host) {
        throw new AppError('remote host not found', {
          code: 'REMOTE_HOST_NOT_FOUND',
          statusCode: 404,
        });
      }

      deps.repo.updateStatus(hostId, 'deploying');

      let result: BootstrapResult;
      try {
        result = await deps.bootstrap({
          host: host.host,
          port: host.port,
          sshUser: host.ssh_user,
          identityFile: deps.identityFile,
          token: deps.tokenFor(hostId),
          serverUrl: deps.serverUrl,
          hostId: host.host_id,
          // bootstrap only writes config, but the lite's config schema requires
          // roots.min(1). Seed a sensible default (the ssh user's home); real
          // projects refine their own roots later.
          roots: [`/home/${host.ssh_user}`],
        });
      } catch (error) {
        deps.repo.updateStatus(hostId, 'error', error instanceof Error ? error.message : 'bootstrap failed');
        throw new AppError(error instanceof Error ? error.message : 'remote deploy failed', {
          code: 'REMOTE_DEPLOY_FAILED',
          statusCode: 502,
        });
      }

      deps.repo.updateStatus(hostId, result.status === 'online' ? 'online' : 'error', result.message ?? null);

      res.json(
        createApiSuccessResponse({
          status: result.status,
          message: result.message,
          hostId: result.hostId,
        }),
      );
    }),
  );

  // 5. Browse remote directories for the "pick a project folder" flow.
  router.get(
    '/:hostId/dirs',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      const host = deps.repo.getById(hostId);
      if (!host) {
        throw new AppError('remote host not found', {
          code: 'REMOTE_HOST_NOT_FOUND',
          statusCode: 404,
        });
      }

      if (!deps.registry.isOnline(host.host_id)) {
        throw new AppError('remote host is offline', {
          code: 'REMOTE_HOST_OFFLINE',
          statusCode: 409,
        });
      }

      const path = readQueryString(req.query.path) || '~';
      try {
        const dirs = await deps.fsClient.list(host.host_id, path);
        res.json(createApiSuccessResponse({ dirs }));
      } catch (error) {
        throw new AppError(error instanceof Error ? error.message : 'remote filesystem RPC failed', {
          code: 'REMOTE_FS_ERROR',
          statusCode: 502,
        });
      }
    }),
  );

  // 6. Remove a host: drop the DB row and clear its registry session bindings.
  router.delete(
    '/:hostId',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      deps.repo.remove(hostId);
      // Any sessions/approvals still routed to this host must not linger; the
      // live socket (if any) is torn down by the ws layer on the next hello,
      // when the host id no longer resolves to a row.
      deps.registry.clearSessionsForHost(hostId);
      res.json(createApiSuccessResponse({ removed: true }));
    }),
  );

  return router;
}
