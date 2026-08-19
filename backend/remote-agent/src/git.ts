import { spawn } from 'node:child_process';

import { resolveWithinRoots } from './fs.js';

export type GitExecRequest = {
  args: string[];
  cwd: string;
  identity?: { name: string; email: string };
  timeoutMs?: number;
};

export type GitExecResult = { stdout: string; stderr: string; exitCode: number };

/** 禁止的 git 重定向选项：防止 -C / --git-dir / --work-tree 把操作引到 roots 之外。 */
const BLOCKED_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--exec-path']);

export function createGitService(deps: { roots: string[]; spawnFn?: typeof spawn }) {
  const doSpawn: typeof spawn = deps.spawnFn ?? spawn;
  return {
    async exec(req: GitExecRequest, signal?: AbortSignal): Promise<GitExecResult> {
      const cwd = resolveWithinRoots(req.cwd, deps.roots);
      for (const arg of req.args) {
        if (arg.includes('\0')) throw new Error('git arg contains NUL');
        const name = arg.split('=', 1)[0];
        if (BLOCKED_OPTIONS.has(name)) throw new Error('git option not allowed: ' + arg);
      }
      const identityArgs: string[] = [];
      if (req.identity) {
        identityArgs.push('-c', `user.name=${req.identity.name}`, '-c', `user.email=${req.identity.email}`);
      }
      return new Promise<GitExecResult>((resolve, reject) => {
        // detached: the child becomes a process-group leader, so abort/timeout
        // can SIGKILL the WHOLE group. git fetch/pull/push spawn helper children
        // (git-remote-http, ssh, ...) that inherit the stdout/stderr pipe FDs;
        // killing only the parent would leave `close` waiting for those helpers
        // (RPC hang + leaked helpers on a stuck network operation).
        const child = doSpawn('git', [...identityArgs, ...req.args], {
          cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let stdout = '';
        let stderr = '';
        // Settle exactly once. On abort/timeout we reject IMMEDIATELY (the group
        // kill frees the pipes in turn, but `close` may lag behind orphaned
        // helpers); a late `close`/`error` must be ignored.
        let settled = false;

        const killGroup = () => {
          if (typeof child.pid === 'number') {
            try {
              process.kill(-child.pid, 'SIGKILL');
              return;
            } catch {
              // group already gone — fall through to the direct kill
            }
          }
          try {
            child.kill('SIGKILL');
          } catch {
            // process already gone
          }
        };

        let timeout: NodeJS.Timeout | undefined;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          fn();
        };

        const onAbort = (): void => {
          killGroup();
          settle(() => reject(new Error('git command aborted')));
        };

        timeout = setTimeout(() => {
          killGroup();
          settle(() => reject(new Error('git command timed out')));
        }, req.timeoutMs ?? 300_000);

        if (signal) {
          if (signal.aborted) onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }

        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err) => {
          settle(() => reject(err));
        });
        child.on('close', (code) => {
          settle(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
        });
      });
    },
  };
}