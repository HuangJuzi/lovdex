import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScpPush, createSshRunner, createSshpassPubkeyInjector } from '../ssh-runner.js';
import { sshArgs } from '../bootstrap.service.js';

type Call = { file: string; argv: string[] };

/**
 * Fake node:child_process execFile: records the invocation and invokes the
 * callback with the scripted outcome. Only the (file, args, options, cb)
 * overload is exercised by the runner/push factories.
 */
function fakeExecFile(outcome: { error?: Error; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const fn = ((file: string, argv: string[], _options: unknown, cb: unknown) => {
    calls.push({ file, argv });
    (cb as (e: Error | null, out: string, err: string) => void)(
      outcome.error ?? null,
      outcome.stdout ?? '',
      outcome.stderr ?? '',
    );
    return {} as never;
  }) as never;
  return { fn, calls };
}

test('createSshRunner runs ssh with the given argv and maps success', async () => {
  const { fn, calls } = fakeExecFile({ stdout: 'Linux host 6.1\n' });
  const runner = createSshRunner({ execFileFn: fn });
  const res = await runner(['-o', 'BatchMode=yes', 'user@host', 'uname', '-a']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'ssh');
  assert.deepEqual(calls[0].argv, ['-o', 'BatchMode=yes', 'user@host', 'uname', '-a']);
  assert.equal(res.ok, true);
  assert.equal(res.stdout, 'Linux host 6.1\n');
});

test('createSshRunner maps a non-zero exit to ok:false with stderr', async () => {
  const { fn } = fakeExecFile({ error: new Error('exit 255'), stderr: 'Permission denied' });
  const runner = createSshRunner({ execFileFn: fn });
  const res = await runner(['user@host', 'node', '-v']);
  assert.equal(res.ok, false);
  assert.equal(res.stderr, 'Permission denied');
});

test('createScpPush builds scp argv with identity, port and user@host:remote dest', async () => {
  const { fn, calls } = fakeExecFile({});
  const push = createScpPush({
    execFileFn: fn,
    identityFile: '/keys/id_ed25519',
    port: 2222,
    remote: 'deploy@1.2.3.4',
  });
  const res = await push('/local/install.sh', '~/.lovdex-remote/install.sh');

  assert.equal(res.ok, true);
  assert.equal(calls[0].file, 'scp');
  assert.deepEqual(calls[0].argv, [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
    '-i',
    '/keys/id_ed25519',
    '-P',
    '2222',
    '/local/install.sh',
    'deploy@1.2.3.4:~/.lovdex-remote/install.sh',
  ]);
});

test('createScpPush maps failure to {ok:false,error}', async () => {
  const { fn } = fakeExecFile({ error: new Error('scp: connection refused'), stderr: 'lost connection' });
  const push = createScpPush({ execFileFn: fn, remote: 'u@h' });
  const res = await push('/a', '~/b');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'lost connection');
});

test('createScpPush omits -i and -P for default port 22 / no identity', async () => {
  const { fn, calls } = fakeExecFile({});
  const push = createScpPush({ execFileFn: fn, remote: 'deploy@1.2.3.4' });
  await push('/local/install.sh', '~/.lovdex-remote/install.sh');
  assert.deepEqual(calls[0].argv, [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
    '/local/install.sh',
    'deploy@1.2.3.4:~/.lovdex-remote/install.sh',
  ]);
});

test('createScpPush keeps -i for an explicit identity on port 22 (no -P)', async () => {
  const { fn, calls } = fakeExecFile({});
  const push = createScpPush({ execFileFn: fn, remote: 'u@h', identityFile: '/keys/id_ed25519', port: 22 });
  await push('/a', '~/b');
  assert.deepEqual(calls[0].argv, [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
    '-i',
    '/keys/id_ed25519',
    '/a',
    'u@h:~/b',
  ]);
});

test('createSshpassPubkeyInjector builds sshpass argv with the embedded idempotent pubkey command', async () => {
  const { fn, calls } = fakeExecFile({});
  const inject = createSshpassPubkeyInjector({ execFileFn: fn });
  const pubkey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAtestkey lovdex';
  const res = await inject({
    host: '10.0.0.9',
    port: 2222,
    sshUser: 'deploy',
    pubkey,
    password: 's3cret',
  });

  assert.equal(res.ok, true);
  assert.equal(calls[0].file, 'sshpass');
  const remoteCmd =
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `(grep -qF '${pubkey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubkey}' >> ~/.ssh/authorized_keys) && ` +
    `chmod 600 ~/.ssh/authorized_keys`;
  assert.deepEqual(calls[0].argv, [
    '-p',
    's3cret',
    'ssh',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-p',
    '2222',
    'deploy@10.0.0.9',
    remoteCmd,
  ]);
});

test('createSshpassPubkeyInjector defaults the port to 22 when omitted', async () => {
  const { fn, calls } = fakeExecFile({});
  const inject = createSshpassPubkeyInjector({ execFileFn: fn });
  await inject({ host: 'h', sshUser: 'u', pubkey: 'ssh-ed25519 AAAA lovdex', password: 'pw' });
  // -p <password>, then ssh, ..., -p <port> — the port flag is the second -p.
  assert.equal(calls[0].argv[8], '22');
  assert.equal(calls[0].argv[9], 'u@h');
});

test('createSshpassPubkeyInjector maps a non-zero exit to {ok:false,error}', async () => {
  const { fn } = fakeExecFile({ error: new Error('exit 5'), stderr: 'Permission denied, please try again.' });
  const inject = createSshpassPubkeyInjector({ execFileFn: fn });
  const res = await inject({ host: 'h', sshUser: 'u', pubkey: 'k', password: 'bad' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Permission denied, please try again.');
});

test('createSshpassPubkeyInjector falls back to a generic error when stderr is empty', async () => {
  const { fn } = fakeExecFile({ error: new Error('exit 5'), stderr: '' });
  const inject = createSshpassPubkeyInjector({ execFileFn: fn });
  const res = await inject({ host: 'h', sshUser: 'u', pubkey: 'k', password: 'bad' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'pubkey injection failed');
});

test('sshArgs omits -i/-p for no identity and port 22; adds them only when needed', () => {
  // default: no identity, port 22 (undefined) → no -i, no -p
  assert.deepEqual(sshArgs('u@h', null, undefined, ['uname']), [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
    'u@h',
    'uname',
  ]);
  // explicit identity, default port → -i only
  assert.deepEqual(sshArgs('u@h', '/k', undefined, ['node', '-v']), [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
    '-i',
    '/k',
    'u@h',
    'node',
    '-v',
  ]);
  // custom port → -p present
  assert.deepEqual(sshArgs('u@h', null, 2222, ['node', '-v']), [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
    '-p',
    '2222',
    'u@h',
    'node',
    '-v',
  ]);
});
