import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAllChangedFiles,
  getChangedFileCount,
  getStatusLabel,
  hasChangedFiles,
  parseCommitFiles,
} from './gitPanelUtils';
import type { GitStatusResponse } from '../types/types';

test('getAllChangedFiles flattens every status group and handles null', () => {
  assert.deepEqual(getAllChangedFiles(null), []);

  const status: GitStatusResponse = {
    modified: ['a.ts'],
    added: ['b.ts', 'c.ts'],
    deleted: ['d.ts'],
    // untracked intentionally omitted to exercise the `|| []` fallback
  } as GitStatusResponse;

  // Order follows FILE_STATUS_GROUPS: modified, added, deleted, untracked.
  assert.deepEqual(getAllChangedFiles(status), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  assert.equal(getChangedFileCount(status), 4);
  assert.equal(hasChangedFiles(status), true);
  assert.equal(hasChangedFiles(null), false);
  assert.equal(hasChangedFiles({} as GitStatusResponse), false);
});

test('getStatusLabel maps known codes and falls back to the raw status', () => {
  assert.equal(getStatusLabel('M'), 'Modified');
  assert.equal(getStatusLabel('A'), 'Added');
  assert.equal(getStatusLabel('D'), 'Deleted');
  assert.equal(getStatusLabel('U'), 'Untracked');
  // Unknown code returns itself.
  assert.equal(getStatusLabel('X' as never), 'X');
});

test('parseCommitFiles extracts per-file status and diff counts', () => {
  const showOutput = [
    'diff --git a/src/added.ts b/src/added.ts',
    'new file mode 100644',
    'index 0000000..abc1234',
    '--- /dev/null',
    '+++ b/src/added.ts',
    '@@ -0,0 +1,2 @@',
    '+line one',
    '+line two',
    'diff --git a/README.md b/README.md',
    'index 111..222 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,2 +1,1 @@',
    '-old line',
    '+new line',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    'index 333..000',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-removed',
  ].join('\n');

  const summary = parseCommitFiles(showOutput);

  assert.equal(summary.totalFiles, 3);

  const added = summary.files[0];
  assert.equal(added.path, 'src/added.ts');
  assert.equal(added.directory, 'src/');
  assert.equal(added.filename, 'added.ts');
  assert.equal(added.status, 'A');
  assert.equal(added.insertions, 2);
  assert.equal(added.deletions, 0);

  const modified = summary.files[1];
  assert.equal(modified.path, 'README.md');
  assert.equal(modified.directory, '');
  assert.equal(modified.filename, 'README.md');
  assert.equal(modified.status, 'M');
  assert.equal(modified.insertions, 1);
  assert.equal(modified.deletions, 1);

  const deleted = summary.files[2];
  assert.equal(deleted.path, 'gone.ts');
  assert.equal(deleted.status, 'D');
  assert.equal(deleted.insertions, 0);
  assert.equal(deleted.deletions, 1);

  assert.equal(summary.totalInsertions, 3);
  assert.equal(summary.totalDeletions, 2);
});

test('parseCommitFiles returns an empty summary for output without diffs', () => {
  const summary = parseCommitFiles('commit abc\nAuthor: nobody\n\n    message body\n');
  assert.deepEqual(summary, {
    files: [],
    totalFiles: 0,
    totalInsertions: 0,
    totalDeletions: 0,
  });
});
