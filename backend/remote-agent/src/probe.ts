import { execFile } from 'node:child_process';

import type { RemoteHostProbe, RemoteProvider, RemoteProviderProbe } from '../../server/shared/agent-runtime/protocol.js';

const PROVIDER_BIN: Record<RemoteProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  qoder: 'qodercli',
};

function runVersion(bin: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, out: '' });
      resolve({ ok: true, out: String(stdout || stderr).trim().split('\n')[0] ?? '' });
    });
  });
}

export async function probeRemoteHost(): Promise<RemoteHostProbe> {
  const entries = await Promise.all(
    (Object.entries(PROVIDER_BIN) as [RemoteProvider, string][]).map(async ([provider, bin]) => {
      const r = await runVersion(bin);
      const probe: RemoteProviderProbe = { provider, installed: r.ok, version: r.ok ? r.out : null };
      return probe;
    }),
  );
  const git = await runVersion('git');
  return {
    providers: entries,
    gitInstalled: git.ok,
    gitVersion: git.ok ? git.out : null,
    nodeVersion: process.version,
    os: `${process.platform} ${process.arch}`,
  };
}