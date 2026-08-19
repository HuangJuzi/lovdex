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

export function createGitService(deps: { roots: string[] }) {
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
        const child = spawn('git', [...identityArgs, ...req.args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
        }, req.timeoutMs ?? 300_000);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            child.kill('SIGKILL');
          }, { once: true });
        }
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
      });
    },
  };
}