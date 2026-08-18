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

  const joined = calls.map((c) => c.join(' '));
  assert.ok(
    joined.some((c) => c.includes('node -v')),
    'expected a node -v probe',
  );
  assert.ok(
    joined.some((c) => c.includes('claude -v')),
    'expected a claude -v probe',
  );

  // config.json is written via a heredoc; the last heredoc command must embed
  // the serverUrl and roots so the remote lite agent can connect back.
  const configCmd = joined.find((c) => c.includes('config.json'));
  assert.ok(configCmd, 'expected a config.json write command');
  assert.ok(configCmd!.includes(baseInput.serverUrl), 'config embeds serverUrl');
  assert.ok(configCmd!.includes('/srv/projA'), 'config embeds roots');
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

test('missing push defers systemd install but still writes config', async () => {
  const { runner, calls } = fakeRunner();

  const result = await runBootstrap(baseInput, { runner });

  assert.equal(result.status, 'online');
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
