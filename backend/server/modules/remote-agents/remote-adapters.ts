import { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';
import { PassThrough } from 'node:stream';

import { REMOTE_MAX_READ_BYTES, type RemoteFsClient } from './remote-fs.service.js';

/**
 * Remote-aware adapters that let the git routes' local `spawn('git', …)` and
 * `fs.*` calls transparently become RPCs when the involved path lives on a
 * remote host (per {@link lookupHostForPath}).
 *
 * Both factories resolve their remote dependencies through lazy getters
 * (`getRemoteGit` / `getRemoteFs`) instead of concrete clients: `git.routes.ts`
 * is mounted at app init, before `setRemoteAgentsRuntime` fires at boot, so the
 * first RPC must resolve the runtime at request time — never at construction.
 */

type LookupHost = (path: string | undefined) => string | null;

type RemoteGitExecFn = (
  hostId: string,
  args: string[],
  options: { cwd: string; identity?: { name: string; email: string } | null },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Least child shape git.routes' `spawnAsync` needs (the rest is duck-typed). */
type ChildShim = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
  pid: number;
};

/**
 * Wrap a local `spawn` (cross-spawn) so that `spawn('git', args, { cwd })`
 * becomes a single `git/exec` RPC whenever `cwd` resolves to a remote host.
 *
 * The returned shim mirrors the observable cross-spawn child behavior the git
 * routes rely on: RPC stdout/stderr are streamed through PassThrough streams
 * and `close` fires with the exit code; a transport failure emits `error` then
 * `close` with code 1. The local spawn only runs for non-git commands or
 * non-hosted cwds — never both.
 */
export function createRemoteAwareSpawn(opts: {
  localSpawn: (cmd: string, args: string[], options: Record<string, unknown>) => unknown;
  getRemoteGit: () => { exec: RemoteGitExecFn };
  lookupHost: LookupHost;
  identity: { name: string; email: string } | null;
}) {
  return function wrappedSpawn(command: string, args: string[], options?: { cwd?: string }): unknown {
    if (command !== 'git' || !options?.cwd) {
      return opts.localSpawn(command, args, (options ?? {}) as Record<string, unknown>);
    }
    const hostId = opts.lookupHost(options.cwd);
    if (!hostId) return opts.localSpawn(command, args, (options ?? {}) as Record<string, unknown>);

    const child = new EventEmitter() as ChildShim;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.pid = -1;

    opts
      .getRemoteGit()
      .exec(hostId, args, { cwd: options.cwd, identity: opts.identity })
      .then((res) => {
        if (res.stdout) child.stdout.write(res.stdout);
        child.stdout.end();
        if (res.stderr) child.stderr.write(res.stderr);
        child.stderr.end();
        child.emit('close', res.exitCode);
      })
      .catch((err: unknown) => {
        // Transport failure — mirror cross-spawn's 'error' then 'close'.
        const e = err instanceof Error ? err : new Error(String(err));
        child.emit('error', e);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1);
      });
    return child;
  };
}

/** fs/promises-compatible shim: the git routes only read these fields off stats. */
function toStatsLike(remote: {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}): Stats {
  return {
    isDirectory: () => remote.isDirectory,
    isFile: () => remote.isFile,
    size: remote.size,
    mtimeMs: remote.mtimeMs,
  } as unknown as Stats;
}

/**
 * Wrap `node:fs/promises` so `access`/`stat`/`readFile`/`rm`/`unlink` become
 * remote `fs/*` RPCs when the path has a host; local paths keep hitting the real
 * filesystem. Every other key is passed through to the local `fs` so the proxy
 * stays duck-type-compatible with the full fs/promises surface for callers that
 * touch methods the git routes do not use.
 */
export function createRemoteAwareFileSystem(opts: {
  localFs: typeof import('node:fs/promises');
  getRemoteFs: () => RemoteFsClient;
  lookupHost: LookupHost;
}) {
  const local = opts.localFs as unknown as Record<string, (...args: unknown[]) => unknown>;

  // Entries are typed with `never` params purely to satisfy strict param
  // variance when a routed wrapper (hostId/p/…) is slotted in; the real arg
  // list flows through `unknown[]` closures and explicit casts.
  const proxy: Record<string, (...args: never[]) => Promise<unknown>> = {};
  const wrapPath = (name: string, remote: (...args: never[]) => Promise<unknown>) => {
    proxy[name] = (async (...args: unknown[]) => {
      const p = args[0] as string;
      const hostId = opts.lookupHost(p);
      if (!hostId) return local[name](...args);
      return (remote as (...a: unknown[]) => Promise<unknown>)(hostId, p, ...args.slice(1));
    }) as (...args: never[]) => Promise<unknown>;
  };

  wrapPath('access', async (hostId: string, p: string) => {
    const s = await opts.getRemoteFs().stat(hostId, p);
    if (!s.exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });

  wrapPath('stat', async (hostId: string, p: string) => {
    const s = await opts.getRemoteFs().stat(hostId, p);
    if (!s.exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return toStatsLike(s);
  });

  wrapPath('readFile', async (hostId: string, p: string, enc?: string) => {
    const r = await opts
      .getRemoteFs()
      .read(hostId, p, REMOTE_MAX_READ_BYTES, enc === 'base64' ? 'base64' : 'utf8');
    if (r.truncated) throw Object.assign(new Error('file too large'), { code: 'ETOOBIG' });
    return r.content;
  });

  wrapPath('rm', async (hostId: string, p: string, _fsOptions?: { recursive?: boolean }) => {
    const s = await opts.getRemoteFs().stat(hostId, p);
    return opts.getRemoteFs().delete(hostId, p, s.isDirectory ? 'directory' : 'file');
  });

  wrapPath('unlink', async (hostId: string, p: string) =>
    opts.getRemoteFs().delete(hostId, p, 'file'),
  );

  // Pass through every other fs/promises method (also covers the 5 wrapped ones
  // for local paths when their host lookup fails).
  for (const key of Object.keys(local)) {
    if (proxy[key] || typeof local[key] !== 'function') continue;
    proxy[key] = (async (...args: unknown[]) =>
      (local[key] as (...a: unknown[]) => unknown)(...args)) as (...args: never[]) => Promise<unknown>;
  }

  return proxy as unknown as typeof import('node:fs/promises');
}