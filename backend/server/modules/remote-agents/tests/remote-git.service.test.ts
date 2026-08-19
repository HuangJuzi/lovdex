import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRemoteGitClient } from '../remote-git.service.js';

test('exec forwards args + identity to git/exec', async () => {
  let received: unknown = null;
  const reg = {
    rpc: async (_h: string, m: string, p: unknown, t?: number, s?: AbortSignal) => {
      if (m === 'git/exec') { received = { p, t, s }; return { stdout: 'ok', stderr: '', exitCode: 0 }; }
      throw new Error('unexpected');
    },
  };
  const client = createRemoteGitClient(() => reg as never);
  const res = await client.exec('h1', ['status'], { cwd: '/home/u/p', identity: { name: 'A', email: 'a@b' } });
  assert.equal(res.stdout, 'ok');
  const pr = received as unknown as { p: { identity: { name: string }; args: string[] }; t: number };
  assert.equal(pr.p.identity.name, 'A');
  assert.equal(pr.p.args[0], 'status');
  assert.equal(pr.t, 300_000);
});

test('exec omits identity when null', async () => {
  let received: unknown = null;
  const reg = {
    rpc: async (_h: string, _m: string, p: unknown) => { received = p; return { stdout: '', stderr: '', exitCode: 0 }; },
  };
  const client = createRemoteGitClient(() => reg as never);
  await client.exec('h1', ['rev-parse', '--is-inside-work-tree'], { cwd: '/x' });
  assert.ok(!(received as { identity?: unknown }).identity);
});