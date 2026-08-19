import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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