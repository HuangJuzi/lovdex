import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { readLocalGitIdentity } from '@/modules/remote-agents/remote-git.service.js';
import {
  refreshRemoteProjectsIndex,
  setOnlineHostsLookup,
} from '@/modules/remote-agents/remote-projects.index.js';
import {
  getRemoteAgentsRuntime,
  setRemoteAgentsRuntime,
} from '@/modules/remote-agents/runtime.js';
import {
  findWorktreeEntryByPath,
  parseWorktreeListPorcelain,
  runGitCommand,
  validateWorktreeBranchName,
} from '@/modules/worktrees/services/worktree-git.service.js';
import { worktreeFileSystem } from '@/modules/worktrees/worktrees.module.js';
import { AppError } from '@/shared/utils.js';

const SAMPLE_PORCELAIN = [
  'worktree /home/user/repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /home/user/repo-worktrees/feature-login',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/login',
  '',
  'worktree /home/user/repo-worktrees/spike',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  'locked reason text',
  '',
].join('\n');

test('parseWorktreeListPorcelain parses main, branch, detached and locked entries', () => {
  const entries = parseWorktreeListPorcelain(SAMPLE_PORCELAIN);

  assert.equal(entries.length, 3);

  assert.equal(entries[0].branch, 'main');
  assert.equal(entries[0].headSha, '1111111111111111111111111111111111111111');
  assert.equal(entries[0].isDetached, false);

  assert.equal(entries[1].branch, 'feature/login');
  assert.ok(entries[1].path.endsWith('feature-login'));

  assert.equal(entries[2].branch, null);
  assert.equal(entries[2].isDetached, true);
  assert.equal(entries[2].isLocked, true);
});

test('parseWorktreeListPorcelain handles output without a trailing blank line', () => {
  const entries = parseWorktreeListPorcelain(
    'worktree /home/user/repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main',
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, 'main');
});

test('findWorktreeEntryByPath matches normalized paths', () => {
  const entries = parseWorktreeListPorcelain(SAMPLE_PORCELAIN);
  const found = findWorktreeEntryByPath(entries, '/home/user/repo-worktrees/feature-login/');
  assert.equal(found.branch, 'feature/login');
});

test('findWorktreeEntryByPath throws a 404 AppError for unknown paths', () => {
  const entries = parseWorktreeListPorcelain(SAMPLE_PORCELAIN);
  assert.throws(
    () => findWorktreeEntryByPath(entries, '/home/user/elsewhere'),
    (error: unknown) =>
      error instanceof AppError && error.code === 'WORKTREE_NOT_FOUND' && error.statusCode === 404,
  );
});

test('validateWorktreeBranchName accepts slash-separated branch names', () => {
  assert.equal(validateWorktreeBranchName(' feature/login-form '), 'feature/login-form');
});

test('validateWorktreeBranchName rejects unsafe names', () => {
  for (const invalidName of [
    '', '   ', '-oops', '.', '..', 'bad name', 'bad;name', 'bad$(name)',
    'foo..bar', 'foo.', 'foo//bar', 'foo.lock', 'feature/foo.LOCK', '/feature', 'feature/',
    '.hidden', 'feature/.hidden', 'feature/./name',
  ]) {
    assert.throws(
      () => validateWorktreeBranchName(invalidName),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_BRANCH_NAME',
      `expected "${invalidName}" to be rejected`,
    );
  }
});

/** Create a throwaway git repo so the local spawn path hits real git. */
async function withLocalGitRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'lovdex-worktree-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'pipe' });
    await fn(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

/**
 * Point `lookupHostForPath` at a synthetic online host whose roots cover
 * `/home/u/repo`. The host lookup + exact project map are module state in
 * remote-projects.index.js, so injecting through its exported seams is the
 * supported way to fake a hosted path (a later test resets it).
 */
function enableFakeRemoteHost(): void {
  setOnlineHostsLookup(() => [{ hostId: 'host-remote-1', roots: ['/home/u/repo'] }]);
  refreshRemoteProjectsIndex([]);
}

test('runGitCommand routes a hosted cwd to the remote git RPC and maps the result', async () => {
  enableFakeRemoteHost();
  const calls: { hostId: string; method: string; params: Record<string, unknown> }[] = [];
  setRemoteAgentsRuntime({
    registry: {
      rpc: async (hostId: string, method: string, params: unknown) => {
        calls.push({ hostId, method, params: params as Record<string, unknown> });
        return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      },
    } as never,
    fsClient: {} as never,
  });

  const res = await runGitCommand(['rev-parse', 'HEAD'], '/home/u/repo');

  // The module injects the local git identity when one is configured; match
  // whatever the module actually read.
  const identity = readLocalGitIdentity();
  const expectedParams: Record<string, unknown> = {
    args: ['rev-parse', 'HEAD'],
    cwd: '/home/u/repo',
    timeoutMs: 300000,
  };
  if (identity) expectedParams.identity = identity;
  assert.deepEqual(calls, [{ hostId: 'host-remote-1', method: 'git/exec', params: expectedParams }]);
  assert.equal(res.stdout, 'abc123\n');
  assert.equal(res.stderr, '');
});

test('runGitCommand converts a remote git/exec failure into a GIT_COMMAND_FAILED AppError', async () => {
  enableFakeRemoteHost();
  setRemoteAgentsRuntime({
    registry: {
      rpc: async () => ({
        stdout: '',
        stderr: 'fatal: not a git repository\n',
        exitCode: 128,
      }),
    } as never,
    fsClient: {} as never,
  });

  await assert.rejects(
    runGitCommand(['rev-parse', '--show-toplevel'], '/home/u/repo'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'GIT_COMMAND_FAILED' &&
      error.statusCode === 500 &&
      String(error.details) === 'fatal: not a git repository',
  );
});

test('runGitCommand maps a remote transport failure to a GIT_REMOTE_EXEC_FAILED AppError', async () => {
  enableFakeRemoteHost();
  setRemoteAgentsRuntime({
    registry: {
      rpc: async () => {
        throw new Error('remote host offline: host-remote-1');
      },
    } as never,
    fsClient: {} as never,
  });

  // A transport hiccup must never be misread downstream as NOT_A_GIT_REPOSITORY;
  // it carries its own 502 contract with the raw transport message.
  await assert.rejects(
    runGitCommand(['rev-parse', 'HEAD'], '/home/u/repo'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'GIT_REMOTE_EXEC_FAILED' &&
      error.statusCode === 502 &&
      error.details === 'remote host offline: host-remote-1',
  );
});

test('runGitCommand falls back to the local git spawn for a non-hosted cwd', async () => {
  // No host covers local temp dirs — force the host lookup to null so this test
  // is deterministic regardless of other tests' host injection.
  setOnlineHostsLookup(() => null);
  refreshRemoteProjectsIndex([]);
  await withLocalGitRepo(async (repoDir) => {
    const res = await runGitCommand(['rev-parse', '--is-inside-work-tree'], repoDir);
    assert.equal(res.stdout.trim(), 'true');
    assert.equal(res.stderr, '');
  });
});

test('runGitCommand surfaces local git failure as a GIT_COMMAND_FAILED AppError', async () => {
  setOnlineHostsLookup(() => null);
  refreshRemoteProjectsIndex([]);
  await withLocalGitRepo(async (repoDir) => {
    await assert.rejects(
      runGitCommand(['merge', '--bogus-flag'], repoDir),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'GIT_COMMAND_FAILED' &&
        error.statusCode === 500 &&
        Boolean(error.details),
    );
  });
});

test('pathExists routes a hosted path to the remote fs stat and maps stat.exists', async () => {
  enableFakeRemoteHost();
  const statCalls: string[] = [];
  setRemoteAgentsRuntime({
    registry: {} as never,
    fsClient: {
      stat: async (_hostId: string, p: string) => {
        statCalls.push(p);
        return { exists: true, isDirectory: true, isFile: false, size: 0, mtimeMs: 0 };
      },
    } as never,
  });

  assert.equal(await worktreeFileSystem.pathExists('/home/u/repo'), true);
  assert.equal(await worktreeFileSystem.pathExists('/home/u/repo/worktrees/x'), true);
  assert.deepEqual(statCalls, ['/home/u/repo', '/home/u/repo/worktrees/x']);
});

test('pathExists returns false when the remote stat reports a missing path', async () => {
  enableFakeRemoteHost();
  setRemoteAgentsRuntime({
    registry: {} as never,
    fsClient: {
      stat: async () => ({ exists: false, isDirectory: false, isFile: false, size: 0, mtimeMs: 0 }),
    } as never,
  });

  assert.equal(await worktreeFileSystem.pathExists('/home/u/repo/missing'), false);
});

test('pathExists falls back to local access for a non-hosted path', async () => {
  setOnlineHostsLookup(() => null);
  refreshRemoteProjectsIndex([]);
  await withLocalGitRepo(async (repoDir) => {
    assert.equal(await worktreeFileSystem.pathExists(repoDir), true);
    assert.equal(await worktreeFileSystem.pathExists(path.join(repoDir, 'nope')), false);
  });
});

after(() => {
  // Restore pristine module state so the fake hosts/runtime never leak into
  // later worktree tests (hosts + runtime are singleton seams in
  // remote-projects.index.js / runtime.js).
  setOnlineHostsLookup(() => null);
  refreshRemoteProjectsIndex([]);
  setRemoteAgentsRuntime(null as never);
  assert.throws(() => getRemoteAgentsRuntime(), /not configured/);
});
