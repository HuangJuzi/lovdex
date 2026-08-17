import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGitLogWithStats, parseGitStatusOutput } from '../git-parsing.service.js';

test('parseGitStatusOutput buckets porcelain -z entries', () => {
  // NUL-delimited porcelain=v1 -z entries. Each entry is XY<space><path>.
  const output = [
    ' M src/a.ts', // worktree-modified, not staged
    'A  src/new.ts', // staged addition
    '?? untracked.txt', // untracked
    'D  gone.ts', // staged deletion
  ].join('\0') + '\0';

  const result = parseGitStatusOutput(output);

  // Buckets are string[] of repo-relative paths (not objects).
  assert.ok(result.modified.includes('src/a.ts'));
  assert.ok(result.staged.includes('src/new.ts'));
  assert.ok(result.added.includes('src/new.ts'));
  assert.ok(result.untracked.includes('untracked.txt'));
  assert.ok(result.staged.includes('gone.ts'));
  assert.ok(result.deleted.includes('gone.ts'));

  // Untracked files are not double-counted as staged/modified.
  assert.ok(!result.staged.includes('untracked.txt'));
  assert.ok(!result.modified.includes('untracked.txt'));
});

test('parseGitStatusOutput ignores short/empty entries', () => {
  const result = parseGitStatusOutput('\0\0 M\0');
  assert.deepEqual(result, { modified: [], added: [], deleted: [], untracked: [], staged: [] });
});

test('parseGitStatusOutput handles a rename (two NUL records)', () => {
  // porcelain -z emits `R  old`\0`new`\0`; the second record is the new path,
  // which the parser skips while bucketing the source path.
  const output = 'R  old.txt\0renamed.txt\0';
  const result = parseGitStatusOutput(output);
  assert.ok(result.staged.includes('old.txt'));
  assert.ok(result.modified.includes('old.txt'));
  assert.ok(!result.staged.includes('renamed.txt'));
  assert.ok(!result.untracked.includes('renamed.txt'));
});

test('parseGitLogWithStats parses separated log lines with shortstat', () => {
  const US = '';
  // Format: %H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s
  const header = ['abc123', 'parent1', 'HEAD -> main', 'Alice', 'a@b.c', '2026-01-01T00:00:00Z', 'Add tests'].join(US);
  const stdout = `${header}\n 1 file changed, 5 insertions(+), 2 deletions(-)`;

  const commits = parseGitLogWithStats(stdout);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].hash, 'abc123');
  assert.equal(commits[0].author, 'Alice');
  assert.equal(commits[0].email, 'a@b.c');
  assert.equal(commits[0].date, '2026-01-01T00:00:00Z');
  assert.equal(commits[0].message, 'Add tests');
  assert.deepEqual(commits[0].parents, ['parent1']);
  assert.deepEqual(commits[0].refs, ['HEAD -> main']);
  assert.equal(commits[0].stats, '1 file changed, 5 insertions(+), 2 deletions(-)');
});

test('parseGitLogWithStats handles multiple commits and empty refs/parents', () => {
  const US = '';
  const first = ['aaa', '', '', 'Bob', 'b@x.y', '2026-02-02T00:00:00Z', 'root commit'].join(US);
  const second = ['bbb', 'aaa', 'tag: v1', 'Carol', 'c@x.y', '2026-03-03T00:00:00Z', 'second'].join(US);
  const stdout = `${second}\n 2 files changed, 3 insertions(+)\n${first}`;

  const commits = parseGitLogWithStats(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, 'bbb');
  assert.equal(commits[0].stats, '2 files changed, 3 insertions(+)');
  assert.deepEqual(commits[0].parents, ['aaa']);
  assert.equal(commits[1].hash, 'aaa');
  assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(commits[1].refs, []);
  assert.equal(commits[1].stats, '');
});
