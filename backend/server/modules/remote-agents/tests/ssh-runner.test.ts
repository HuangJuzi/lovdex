import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScpPush, createSshRunner } from '../ssh-runner.js';

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
