import { execFile } from 'node:child_process';

import type { FilePush, SshRunner } from './bootstrap.service.js';

/**
 * Real ssh/scp transport for the bootstrap service.
 *
 * The bootstrap module issues every remote command as an argv array through the
 * {@link SshRunner} seam; these factories bind that seam to the system `ssh` /
 * `scp` binaries via `execFile` (never a shell string — no metacharacter
 * injection). `execFile` is injected so the factories stay unit-testable
 * without spawning a real process.
 */

type ExecFileFn = typeof execFile;

export type SshRunnerConfig = {
  /** Bounds failure latency; ssh's own -o ConnectTimeout is set per invocation
   *  in bootstrap.service, this is the hard process kill timeout. */
  timeoutMs?: number;
  /** Injected for tests; defaults to node:child_process execFile. */
  execFileFn?: ExecFileFn;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Build the {@link SshRunner} that bootstrap.service calls with a fully-formed
 * ssh argv (already carrying `-o StrictHostKeyChecking=accept-new`,
 * `-o ConnectTimeout=15`, `-o BatchMode=yes`, `-i identity`, the remote target
 * and the remote command). We only prepend the binary name and run it.
 */
export function createSshRunner(config: SshRunnerConfig = {}): SshRunner {
  const exec = config.execFileFn ?? execFile;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (argv: string[]) =>
    new Promise((resolve) => {
      exec('ssh', argv, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (error instanceof Error ? error.message : '')),
        });
      });
    });
}

export type ScpPushConfig = {
  /** Absolute path to the ed25519 private key, or null (rely on agent/default). */
  identityFile?: string | null;
  /** Remote ssh port (omitted / 22 → no -P flag). */
  port?: number;
  /** `user@host` the remote path is relative to. */
  remote: string;
  timeoutMs?: number;
  execFileFn?: ExecFileFn;
};

/**
 * Build the {@link FilePush} used by bootstrap.service to copy install.sh, the
 * systemd unit and the lite package to the remote. The bootstrap layer passes a
 * bare `remotePath` (e.g. `~/.lovdex-remote/install.sh`); scp needs it prefixed
 * with the `user@host:` destination, which we take from `config.remote`.
 *
 * `scp` uses `-P` (uppercase) for the port, unlike ssh's `-p`. StrictHostKey is
 * `accept-new` to match the ssh probe and avoid an interactive prompt hanging
 * the deploy request.
 */
export function createScpPush(config: ScpPushConfig): FilePush {
  const exec = config.execFileFn ?? execFile;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (localPath: string, remotePath: string) =>
    new Promise((resolve) => {
      const argv = [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'BatchMode=yes',
      ];
      if (config.identityFile) argv.push('-i', config.identityFile);
      if (config.port && config.port !== 22) argv.push('-P', String(config.port));
      argv.push(localPath, `${config.remote}:${remotePath}`);
      exec('scp', argv, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: String(stderr || (error instanceof Error ? error.message : 'scp failed')).trim(),
          });
          return;
        }
        resolve({ ok: true });
      });
    });
}
