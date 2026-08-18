import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { runBootstrap } from '../bootstrap.service.js';
import type { SshRunner, FilePush, BootstrapInput } from '../bootstrap.service.js';

type RunnerCall = string[];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Fake runner that returns ok for every command unless the command's joined
 * argv matches one of the `fail` substrings (in which case it returns not-ok),
 * and echoes a canned stdout for probes so callers can assert on them.
 */
function fakeRunner(opts?: { fail?: string[]; stdout?: (argv: string[]) => string }): {
  runner: SshRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: SshRunner = async (argv) => {
    calls.push(argv);
    const joined = argv.join(' ');
    const failed = (opts?.fail ?? []).some((f) => joined.includes(f));
    const stdout = opts?.stdout ? opts.stdout(argv) : '';
    return { ok: !failed, stdout, stderr: failed ? 'boom' : '' };
  };
  return { runner, calls };
}

function fakePush(opts?: { fail?: boolean }): {
  push: FilePush;
  calls: { localPath: string; remotePath: string }[];
} {
  const calls: { localPath: string; remotePath: string }[] = [];
  const push: FilePush = async (localPath, remotePath) => {
    calls.push({ localPath, remotePath });
    if (opts?.fail) return { ok: false, error: 'scp failed' };
    return { ok: true };
  };
  return { push, calls };
}

const baseInput: BootstrapInput = {
  host: 'example.com',
  sshUser: 'deploy',
  token: 'tok-abc-123',
  serverUrl: 'ws://main:8080/api/remote-agents/ws',
  roots: ['/srv/projA', '/srv/projB'],
};

test('happy path returns online + tokenHash and probes node/claude/config', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push, installScriptPath: '/local/install.sh' });

  assert.equal(result.status, 'online');
  assert.equal(result.tokenHash, sha256(baseInput.token));
  assert.equal(result.hostId?.length, 36, 'a fresh hostId (uuid) is generated when none is supplied');

  const joined = calls.map((c) => c.join(' '));
  assert.ok(joined.some((c) => c.includes('node -v')), 'expected a node -v probe');
  assert.ok(joined.some((c) => c.includes('claude -v')), 'expected a claude -v probe');

  // config.json is written via a heredoc; the heredoc command must embed the
  // serverUrl and roots so the remote lite agent can connect back.
  const configCmd = joined.find((c) => c.includes('config.json'));
  assert.ok(configCmd, 'expected a config.json write command');
  assert.ok(configCmd!.includes(baseInput.serverUrl), 'config embeds serverUrl');
  assert.ok(configCmd!.includes('/srv/projA'), 'config embeds roots');
});

test('with push+unit, install.sh + unit template are pushed and install runs', async () => {
  const { runner, calls } = fakeRunner();
  const { push, calls: pushCalls } = fakePush();

  const result = await runBootstrap(
    { ...baseInput, litePackagePath: '/build/lite.tgz' },
    { runner, push, installScriptPath: '/local/install.sh' },
  );

  assert.equal(result.status, 'online');
  assert.deepEqual(pushCalls, [
    { localPath: '/local/install.sh', remotePath: '~/.lovdex-remote/install.sh' },
    { localPath: 'remote-agent/deploy/systemd-unit.template', remotePath: '~/.lovdex-remote/lovdex-agent.service' },
    { localPath: '/build/lite.tgz', remotePath: '~/.lovdex-remote/lite.tgz' },
  ]);

  const joined = calls.map((c) => c.join(' '));
  assert.ok(
    joined.some((c) => c.includes('bash ~/.lovdex-remote/install.sh')),
    'install runs after the pushes',
  );
});

test('hostId is caller-supplied and stable across redeploys (C1)', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  const input = { ...baseInput, hostId: 'host-42' };

  const first = await runBootstrap(input, { runner, push, installScriptPath: '/local/install.sh' });
  const second = await runBootstrap(input, { runner, push, installScriptPath: '/local/install.sh' });

  assert.equal(first.hostId, 'host-42');
  assert.equal(second.hostId, 'host-42', 'redeploy keeps the same hostId');

  const configCmd = calls.map((c) => c.join(' ')).find((c) => c.includes('config.json'));
  assert.ok(configCmd, 'expected a config.json write command');
  assert.ok(configCmd!.includes('host-42'), 'config embeds the supplied hostId');
});

test('node missing returns error hint and stops before install', async () => {
  const { runner, calls } = fakeRunner({ fail: ['node -v'] });
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /node not found/i);

  const joined = calls.map((c) => c.join(' '));
  assert.ok(!joined.some((c) => c.includes('install.sh')), 'must not run install after node probe fails');
  assert.ok(!joined.some((c) => c.includes('claude -v')), 'must not probe claude after node fails');
});

test('claude missing returns install hint', async () => {
  const { runner } = fakeRunner({ fail: ['claude -v'] });
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /npm i -g @anthropic-ai\/claude-code/);
});

test('uname probe failure returns error early', async () => {
  const { runner, calls } = fakeRunner({ fail: ['uname'] });
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push });

  assert.equal(result.status, 'error');
  const joined = calls.map((c) => c.join(' '));
  assert.ok(!joined.some((c) => c.includes('node -v')), 'must not probe node after uname fails');
});

test('empty roots fail fast before any ssh command (I5)', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  const result = await runBootstrap({ ...baseInput, roots: [] }, { runner, push });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /roots must contain at least one path/);
  assert.equal(calls.length, 0, 'no ssh command is sent for empty roots');
});

test('apiKey containing a newline is rejected (M1)', async () => {
  const { runner } = fakeRunner();
  const { push } = fakePush();

  const result = await runBootstrap(
    { ...baseInput, apiKey: 'sk-ant-secret\nEVIL' },
    { runner, push, installScriptPath: '/local/install.sh' },
  );

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /newline/);
});

test('install failure yields status error', async () => {
  const { runner } = fakeRunner({ fail: ['install.sh'] });
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push, installScriptPath: '/local/install.sh' });

  assert.equal(result.status, 'error');
});

test('push failure yields status error', async () => {
  const { runner } = fakeRunner();
  const { push } = fakePush({ fail: true });

  const result = await runBootstrap(baseInput, { runner, push, installScriptPath: '/local/install.sh' });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /scp failed|upload/i);
});

test('missing push reports partial (not online) and still writes config (M5)', async () => {
  const { runner, calls } = fakeRunner();

  const result = await runBootstrap(baseInput, { runner });

  assert.equal(result.status, 'partial');
  assert.match(result.message ?? '', /defer/i);
  const joined = calls.map((c) => c.join(' '));
  assert.ok(joined.some((c) => c.includes('config.json')), 'config still written');
  assert.ok(!joined.some((c) => c.includes('install.sh')), 'install deferred when no push');
});

test('identityFile and port are threaded into ssh argv', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  await runBootstrap(
    { ...baseInput, identityFile: '/keys/id_ed25519', port: 2222 },
    { runner, push, installScriptPath: '/local/install.sh' },
  );

  const first = calls[0];
  assert.ok(first.includes('-i'), 'argv contains -i');
  assert.ok(first.includes('/keys/id_ed25519'), 'argv contains identity path');
  assert.ok(first.includes('-p'), 'argv contains -p');
  assert.ok(first.includes('2222'), 'argv contains port');
  assert.ok(first.includes('deploy@example.com'), 'argv contains user@host');
  assert.ok(first.includes('StrictHostKeyChecking=accept-new'), 'argv contains host-key policy');
  assert.ok(first.includes('ConnectTimeout=15'), 'argv bounds connect latency');
  assert.ok(first.includes('BatchMode=yes'), 'argv forbids interactive password prompts');
});

test('default port 22 and no identity omits -p and -i', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  await runBootstrap(baseInput, { runner, push, installScriptPath: '/local/install.sh' });

  const first = calls[0];
  assert.ok(!first.includes('-p'), 'omits -p at default port');
  assert.ok(!first.includes('-i'), 'omits -i without identity');
});

test('apiKey is written to the env file when provided', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  await runBootstrap(
    { ...baseInput, apiKey: 'sk-ant-secret' },
    { runner, push, installScriptPath: '/local/install.sh' },
  );

  const joined = calls.map((c) => c.join(' '));
  const envCmd = joined.find((c) => c.includes('ANTHROPIC_API_KEY'));
  assert.ok(envCmd, 'expected an env-file write');
  assert.ok(envCmd!.includes('sk-ant-secret'), 'env file embeds the api key');
  assert.ok(envCmd!.includes('.env'), 'env write targets the .env path');
});