import { execFileSync } from 'node:child_process';

import { makeGitExecParamsSchema, type GitExecResult } from '@/shared/agent-runtime/protocol.js';

import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

/** Local git identity (`user.name`/`user.email`) injected into remote git/exec calls. */
export type GitIdentity = { name: string; email: string } | null;

/**
 * Git RPC client over a remote lite agent.
 *
 * `exec` forwards to the registry's `git/exec` rpc for the given host. Identity
 * (from the local git global config) and timeout are validated via the same
 * schema the lite uses, so params sent over the wire always satisfy lite-side
 * parsing. `getRegistry` is a thunk so the live registry is resolved lazily
 * (the runtime seam is wired at boot, after construction).
 */
export type RemoteGitClient = {
  exec(
    hostId: string,
    args: string[],
    opts: { cwd: string; identity?: GitIdentity; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GitExecResult>;
};

export function createRemoteGitClient(getRegistry: () => RemoteAgentsRegistry): RemoteGitClient {
  const reg = () => getRegistry();
  return {
    exec(hostId, args, opts) {
      const params = makeGitExecParamsSchema().parse({
        args,
        cwd: opts.cwd,
        ...(opts.identity ? { identity: opts.identity } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return reg().rpc<GitExecResult>(hostId, 'git/exec', params, opts.timeoutMs ?? 300_000, opts.signal);
    },
  };
}

/**
 * Read the local git identity from the user's global git config. Returns a
 * value only when BOTH name and email are configured; any failure (git not
 * installed, no config, ...) yields an empty string for that key, and a partial
 * config degrades to null so the remote keeps using its own global config.
 */
export function readLocalGitIdentity(): GitIdentity {
  const get = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const name = get('user.name');
  const email = get('user.email');
  return name && email ? { name, email } : null;
}