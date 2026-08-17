import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitRepo, findCommitAtOrBefore, rewindFilesToCommit } from '../git-rewind.js';

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-rewind-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  return dir;
}
import { execSync } from 'node:child_process';

test('isGitRepo true inside a repo, false outside', async () => {
  const dir = freshRepo();
  assert.equal(await isGitRepo(dir), true);
  const nonRepo = mkdtempSync(join(tmpdir(), 'notgit-'));
  assert.equal(await isGitRepo(nonRepo), false);
  rmSync(dir, { recursive: true, force: true });
  rmSync(nonRepo, { recursive: true, force: true });
});

test('findCommitAtOrBefore returns the commit at or before a timestamp', async () => {
  const dir = freshRepo();
  writeFileSync(join(dir, 'a.txt'), 'v1');
  execSync('git add a.txt && git commit -q -m one', { cwd: dir });
  const ts = new Date().toISOString();
  const commit = await findCommitAtOrBefore(dir, ts);
  assert.ok(commit, 'expected a commit');
  rmSync(dir, { recursive: true, force: true });
});

test('rewindFilesToCommit restores file contents to the commit', async () => {
  const dir = freshRepo();
  writeFileSync(join(dir, 'a.txt'), 'v1');
  execSync('git add a.txt && git commit -q -m one', { cwd: dir });
  const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
  writeFileSync(join(dir, 'a.txt'), 'v2-uncommitted');
  await rewindFilesToCommit(dir, commit);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'v1');
  rmSync(dir, { recursive: true, force: true });
});
