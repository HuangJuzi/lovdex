import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createGitService } from '../git.js';

test('git/exec runs git status inside roots', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email t@t && git config user.name T', { cwd: root });
  execSync('echo hi > a.txt', { cwd: root });
  const svc = createGitService({ roots: [root] });
  const res = await svc.exec({ args: ['status', '--porcelain'], cwd: root });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /a\.txt/);
  rmSync(root, { recursive: true, force: true });
});

test('git/exec rejects blocked options', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  const svc = createGitService({ roots: [root] });
  await assert.rejects(() => svc.exec({ args: ['--git-dir=/etc'], cwd: root }), /not allowed/);
  rmSync(root, { recursive: true, force: true });
});

test('git/exec rejects cwd outside roots', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  const svc = createGitService({ roots: [root] });
  await assert.rejects(() => svc.exec({ args: ['status'], cwd: '/etc' }), /outside allowed root/);
  rmSync(root, { recursive: true, force: true });
});

/**
 * A spawn whose child NEVER exits and never emits `close`/`error` — models a
 * network git operation (`fetch`/`pull`/`push`) whose helper children
 * (git-remote-http, ssh, ...) are stuck so the pipe FDs never close.
 */
function makeStuckSpawn(): typeof spawn {
  const child = new EventEmitter() as unknown as EventEmitter & {
    pid: number;
    kill: () => boolean;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.pid = 424242;
  child.kill = () => true;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const fakeSpawn = () => child;
  return fakeSpawn as unknown as typeof spawn;
}

test('git/exec rejects immediately on an already-aborted signal (stuck helpers cannot hang it)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  const svc = createGitService({ roots: [root], spawnFn: makeStuckSpawn() });
  const controller = new AbortController();
  controller.abort();
  // Guard: if exec waited on `close`, the stuck fake spawn would hang past the
  // 2s race and this test would fail with the 'hang' outcome.
  const outcome = await Promise.race([
    svc.exec({ args: ['pull', 'origin'], cwd: root }, controller.signal).then(
      () => 'resolved',
      (err: Error) => `rejected:${err.message}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('hang'), 2000)),
  ]);
  assert.match(outcome, /^rejected:git command aborted$/);
  rmSync(root, { recursive: true, force: true });
});