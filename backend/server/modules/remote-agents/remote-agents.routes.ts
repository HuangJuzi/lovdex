import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { BootstrapInput, BootstrapResult } from './bootstrap.service.js';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';
import type { RemoteFsClient } from './remote-fs.service.js';
import type { RemoteHostsRepository } from './remote-host.db.js';
import type { RemoteTunnelsManager } from './remote-tunnels.js';
import type { SshpassPubkeyInjector } from './ssh-runner.js';

export type RemoteAgentsRouterDeps = {
  repo: RemoteHostsRepository;
  registry: RemoteAgentsRegistry;
  fsClient: RemoteFsClient;
  /** Lovdex ed25519 public key, surfaced so users can authorize it manually. */
  publicKey: string;
  /**
   * Deterministic per-host token (HMAC-SHA256(hostId) keyed by the server
   * secret), so redeploys REUSE the same token and its hash — a running lite's
   * auth never silently rotates. Persists the sha256 of the token for the
   * ws verifyToken lookup.
   */
  tokenFor: (hostId: string) => string;
  /** Wraps runBootstrap with the real ssh runner + file push. */
  bootstrap: (input: BootstrapInput) => Promise<BootstrapResult>;
  /** Path to the Lovdex ed25519 private key used for ssh, or null. */
  identityFile: string | null;
  /** Main server ws URL the lite connects back to (default for non-tunnel hosts). */
  serverUrl: string;
  /**
   * Per-host ssh -R reverse tunnels (see remote-tunnels.ts). Hosts with a
   * `tunnel_port` get `ws://127.0.0.1:<port>` as their lite serverUrl instead
   * of the global one — for targets that cannot reach the main server at all.
   */
  tunnels: RemoteTunnelsManager;
  /**
   * One-time password → pubkey injector (ssh-copy-id equivalent). When
   * configured, `authType: 'password'` registration uses the supplied password
   * ONCE to append `publicKey` to the target's authorized_keys, then discards
   * it (never persisted). Optional: when absent, password auth returns 501.
   */
  injectPubkey?: SshpassPubkeyInjector;
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
      // Project each row explicitly: agent_token_hash / key_credential_id are
      // credentials and must never be serialized out of the router.
      const hosts = deps.repo.list().map((host) => ({
        host_id: host.host_id,
        name: host.name,
        host: host.host,
        port: host.port,
        ssh_user: host.ssh_user,
        os: host.os,
        status: host.status,
        last_error: host.last_error,
        last_seen_at: host.last_seen_at,
        online: deps.registry.isOnline(host.host_id),
        tunnel_port: host.tunnel_port,
        tunnel_running: host.tunnel_port !== null && deps.tunnels.isRunning(host.host_id),
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
      // Password is read but NEVER persisted, logged, or stored in a column —
      // it is used once for the pubkey injection below then discarded.
      const password = readStringField(req.body, 'password');
      const portRaw = (req.body as Record<string, unknown> | undefined)?.port;
      const port =
        typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw > 0 ? portRaw : undefined;

      if (!name || !host || !sshUser) {
        throw new AppError('name, host and sshUser are required', {
          code: 'REMOTE_HOST_INVALID',
          statusCode: 400,
        });
      }

      // Password auth: inject the Lovdex pubkey FIRST using the one-time
      // password. Only on success do we create the host row — a failed
      // injection must leave no dangling, un-deployable host behind.
      if (authType === 'password') {
        if (!password) {
          throw new AppError('password required for password auth', {
            code: 'REMOTE_PASSWORD_REQUIRED',
            statusCode: 400,
          });
        }
        if (!deps.injectPubkey) {
          throw new AppError('password pubkey injection not configured', {
            code: 'REMOTE_INJECT_UNSUPPORTED',
            statusCode: 501,
          });
        }
        const injected = await deps.injectPubkey({
          host,
          port,
          sshUser,
          pubkey: deps.publicKey,
          password,
        });
        if (!injected.ok) {
          throw new AppError(injected.error ?? 'pubkey injection failed', {
            code: 'REMOTE_PASSWORD_INJECT_FAILED',
            statusCode: 502,
          });
        }
      }

      const hostId = crypto.randomUUID();
      deps.repo.create({ host_id: hostId, name, host, ssh_user: sshUser, port });
      // Generates the host token and persists its hash against the new row.
      deps.tokenFor(hostId);

      res.json(createApiSuccessResponse({ hostId }));
    }),
  );

  // 4. Deploy (bootstrap) the lite agent onto a registered host.
  //
  // WARNING: this is a BLOCKING ssh+scp call (typically 5-15+s). Task 16's
  // frontend should poll GET / while the row status is 'deploying' rather than
  // blocking on this response; a later iteration may move deploy behind a
  // job+status endpoint.
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

      // Optional body roots override. The lite config schema requires
      // roots.min(1) — validate a non-empty array when one is provided.
      const rawBody = req.body as Record<string, unknown> | undefined;
      const providedRoots = rawBody?.roots;
      let roots: string[] = [`/home/${host.ssh_user}`];
      if (providedRoots !== undefined) {
        if (
          !Array.isArray(providedRoots)
          || providedRoots.length === 0
          || providedRoots.some((r) => typeof r !== 'string' || r.trim().length === 0)
        ) {
          throw new AppError('roots must be a non-empty array of paths', {
            code: 'REMOTE_DEPLOY_INVALID_ROOTS',
            statusCode: 400,
          });
        }
        roots = providedRoots.map((r) => (r as string).trim());
      }

      let result: BootstrapResult;
      try {
        // Tunnel hosts dial their own loopback through the ssh -R forward (they
        // cannot reach the main server's LAN address at all); (re)ensure the
        // forward is up before pushing config so the lite connects immediately.
        if (host.tunnel_port !== null) {
          deps.tunnels.ensure(host);
        }
        result = await deps.bootstrap({
          host: host.host,
          port: host.port,
          sshUser: host.ssh_user,
          identityFile: deps.identityFile,
          // Deterministic per-host token: redeploy mints the SAME token (and
          // persists the same sha256) — a running lite is never bricked by an
          // interrupted deploy resetting its auth.
          token: deps.tokenFor(hostId),
          serverUrl: host.tunnel_port
            ? `ws://127.0.0.1:${host.tunnel_port}/api/remote-agents/ws`
            : deps.serverUrl,
          hostId: host.host_id,
          roots,
        });
      } catch (error) {
        deps.repo.updateStatus(hostId, 'error', error instanceof Error ? error.message : 'bootstrap failed');
        throw new AppError(error instanceof Error ? error.message : 'remote deploy failed', {
          code: 'REMOTE_DEPLOY_FAILED',
          statusCode: 502,
        });
      }

      // Persist the conservative classification — we have no DB 'partial'
      // status, so anything short of fully online is stored as 'error' — but
      // echo the lite's actual result to the client so the partial-vs-error
      // distinction is not lost to the caller.
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

  // 5. Enable / disable the per-host ssh -R reverse tunnel. When enabled, the
  //    host's lite connects BACK through the tunnel (ws://127.0.0.1:<port>)
  //    instead of the global serverUrl — for targets that cannot reach the
  //    main server's LAN address (VLAN-isolated / firewalled subnets).
  router.post(
    '/:hostId/tunnel',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      const host = deps.repo.getById(hostId);
      if (!host) {
        throw new AppError('remote host not found', {
          code: 'REMOTE_HOST_NOT_FOUND',
          statusCode: 404,
        });
      }
      const portRaw = (req.body as Record<string, unknown> | undefined)?.port;
      const port = typeof portRaw === 'number' ? portRaw : Number.parseInt(String(portRaw ?? ''), 10);
      // Loophack binds are unprivileged on the target; reject ports < 1024.
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new AppError('tunnel port must be an integer in [1024, 65535]', {
          code: 'REMOTE_TUNNEL_INVALID_PORT',
          statusCode: 400,
        });
      }
      deps.repo.setTunnelPort(hostId, port);
      deps.tunnels.ensure({ ...host, tunnel_port: port });
      res.json(
        createApiSuccessResponse({
          tunnel_port: port,
          tunnel_running: deps.tunnels.isRunning(hostId),
        }),
      );
    }),
  );

  router.delete(
    '/:hostId/tunnel',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      deps.repo.setTunnelPort(hostId, null);
      deps.tunnels.stop(hostId);
      res.json(createApiSuccessResponse({ tunnel_port: null }));
    }),
  );

  // 6. Browse remote directories for the "pick a project folder" flow.
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
        const listing = await deps.fsClient.list(host.host_id, path);
        res.json(createApiSuccessResponse({ dirs: listing.entries, path: listing.path }));
      } catch (error) {
        throw new AppError(error instanceof Error ? error.message : 'remote filesystem RPC failed', {
          code: 'REMOTE_FS_ERROR',
          statusCode: 502,
        });
      }
    }),
  );

  // 7. Remove a host: drop the DB row, clear its registry session bindings,
  //    stop any ssh -R tunnel and close the live socket so the agent tears
  //    down immediately (4001 'host removed') rather than lingering until its
  //    next heartbeat.
  router.delete(
    '/:hostId',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      deps.repo.remove(hostId);
      deps.registry.clearSessionsForHost(hostId);
      deps.registry.closeHost(hostId);
      deps.tunnels.stop(hostId);
      res.json(createApiSuccessResponse({ removed: true }));
    }),
  );

  return router;
}
