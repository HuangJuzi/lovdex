import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listGitIgnoredDirPaths } from '../git-ignored-dirs.service.js';

type TestContext = { after: (fn: () => void) => void };

function makeTempDir(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-ignored-dirs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(dir: string) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

/** Commits the given paths — git only reports nested ignored directories this way
 *  once the repository has a real index, which every project being browsed has. */
function commit(dir: string, paths: string[]) {
  execFileSync('git', ['add', ...paths], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('lists whole directories git ignores, as absolute paths', (t) => {
  const dir = makeTempDir(t);
  initRepo(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\ndesktop/dist/\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};\n');
  fs.mkdirSync(path.join(dir, 'cache', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cache', 'inner', 'blob.bin'), 'x');
  fs.mkdirSync(path.join(dir, 'desktop', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'desktop', 'dist', 'app.js'), 'x');
  fs.mkdirSync(path.join(dir, 'desktop', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'desktop', 'src', 'main.ts'), 'export {};\n');
  commit(dir, ['.gitignore', 'src/index.ts', 'desktop/src/main.ts']);

  const ignored = listGitIgnoredDirPaths(dir);

  assert.ok(ignored.has(path.join(dir, 'cache')), 'top-level ignored dir is listed');
  assert.ok(ignored.has(path.join(dir, 'desktop', 'dist')), 'nested ignored dir is listed');
  assert.ok(!ignored.has(path.join(dir, 'src')), 'tracked dirs are not listed');
  assert.ok(!ignored.has(path.join(dir, 'desktop', 'src')), 'tracked dirs keep their siblings');
});

test('a directory holding tracked files is not skipped wholesale', (t) => {
  const dir = makeTempDir(t);
  initRepo(dir);
  // `logs/` is ignored, but one file inside was force-added earlier — git lists
  // the ignored files individually rather than collapsing the directory, so the
  // tree must keep walking it (otherwise the tracked file disappears).
  fs.writeFileSync(path.join(dir, '.gitignore'), 'logs/\n');
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'keep.log'), 'keep\n');
  execFileSync('git', ['add', '-f', 'logs/keep.log'], { cwd: dir });
  commit(dir, ['.gitignore']);

  const ignored = listGitIgnoredDirPaths(dir);

  assert.ok(!ignored.has(path.join(dir, 'logs')));
});

test('returns an empty set outside a git repository', (t) => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'cache'));
  fs.writeFileSync(path.join(dir, 'cache', 'blob.bin'), 'x');

  assert.equal(listGitIgnoredDirPaths(dir).size, 0);
});

test('returns an empty set for a path that does not exist', () => {
  assert.equal(listGitIgnoredDirPaths('/definitely/not/here/lovdex').size, 0);
});

test('paths stay relative to the directory that was asked about', (t) => {
  const dir = makeTempDir(t);
  initRepo(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\n');
  fs.mkdirSync(path.join(dir, 'pkg', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'cache', 'blob.bin'), 'x');
  fs.writeFileSync(path.join(dir, 'pkg', 'index.ts'), 'export {};\n');
  commit(dir, ['.gitignore', 'pkg/index.ts']);

  const ignored = listGitIgnoredDirPaths(path.join(dir, 'pkg'));

  assert.ok(ignored.has(path.join(dir, 'pkg', 'cache')), 'nested root resolves to its own cache dir');
});
