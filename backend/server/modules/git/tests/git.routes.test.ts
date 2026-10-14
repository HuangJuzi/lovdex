import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import spawn from 'cross-spawn';
import express from 'express';

import { createGitRouter } from '../git.routes.js';

/**
 * Creates a temporary git repository with one committed file and returns its
 * absolute path. Uses execFileSync so setup is synchronous and deterministic.
 * The temp dir is removed as soon as the test ends; cleanup is registered
 * immediately after mkdtemp so a failed setup never leaks the directory.
 */
async function makeTempRepo(t: TestContext): Promise<string> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lovdex-git-test-'));
  t.after(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  run(['init']);
  // `git init -b main` needs git >= 2.28; set the branch explicitly for older gits.
  run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  run(['config', 'user.name', 'Test User']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(repoDir, 'README.md'), '# initial\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  return repoDir;
}

/**
 * Boots the git router (with an injected constant path resolver) on an
 * ephemeral port and runs `run(baseUrl)`.
 */
async function withServer(repoDir: string, run: (base: string) => Promise<void>): Promise<void> {
  const gitRoutes = createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: () => repoDir,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', gitRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('git routes smoke test over a real temp repository', async (t) => {
  const repoDir = await makeTempRepo(t);

  await withServer(repoDir, async (base) => {
    // GET /status on a fresh repo with one commit.
    {
      const res = await fetch(`${base}/api/git/status?project=repo`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        branch: string;
        hasCommits: boolean;
        notGitRepository?: boolean;
      };
      assert.equal(body.branch, 'main');
      assert.equal(body.hasCommits, true);
      assert.ok(!body.notGitRepository);
    }

    // POST /init on an already-initialized repo returns success (idempotent).
    {
      const res = await fetch(`${base}/api/git/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'repo' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { success: boolean };
      assert.equal(body.success, true);
    }

    // Write a new file; it should show up as untracked, then staging should
    // move it into the `staged` bucket.
    {
      await fs.writeFile(path.join(repoDir, 'newfile.txt'), 'hello\n', 'utf8');

      const preStatusRes = await fetch(`${base}/api/git/status?project=repo`);
      assert.equal(preStatusRes.status, 200);
      const preStatusBody = (await preStatusRes.json()) as { untracked: string[] };
      assert.ok(preStatusBody.untracked.includes('newfile.txt'));

      const stageRes = await fetch(`${base}/api/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'repo', files: ['newfile.txt'] }),
      });
      assert.equal(stageRes.status, 200);
      const stageBody = (await stageRes.json()) as { success: boolean };
      assert.equal(stageBody.success, true);

      const statusRes = await fetch(`${base}/api/git/status?project=repo`);
      assert.equal(statusRes.status, 200);
      const statusBody = (await statusRes.json()) as { staged: string[] };
      assert.ok(statusBody.staged.includes('newfile.txt'));
    }

    // Commit the staged file and confirm it becomes the newest commit.
    {
      const commitRes = await fetch(`${base}/api/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'repo',
          message: 'feat test commit',
          files: ['newfile.txt'],
        }),
      });
      assert.equal(commitRes.status, 200);
      const commitBody = (await commitRes.json()) as { success: boolean };
      assert.equal(commitBody.success, true);

      const commitsRes = await fetch(`${base}/api/git/commits?project=repo&limit=5`);
      assert.equal(commitsRes.status, 200);
      const commitsBody = (await commitsRes.json()) as {
        commits: Array<{ message: string }>;
      };
      assert.ok(Array.isArray(commitsBody.commits));
      assert.equal(commitsBody.commits[0].message, 'feat test commit');
    }
  });
});

test('delete-branch reports BRANCH_NOT_MERGED for an unmerged branch and force-deletes it', async (t) => {
  const repoDir = await makeTempRepo(t);
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });

  // A branch whose commit is NOT reachable from main → `git branch -d` refuses.
  run(['checkout', '-b', 'feat/unmerged']);
  await fs.writeFile(path.join(repoDir, 'feature.txt'), 'work\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'unmerged work']);
  run(['checkout', 'main']);

  await withServer(repoDir, async (base) => {
    // Plain delete (-d) must refuse with the structured code.
    const plainRes = await fetch(`${base}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'repo', branch: 'feat/unmerged' }),
    });
    assert.equal(plainRes.status, 409);
    const plainBody = (await plainRes.json()) as { code?: string; error?: string };
    assert.equal(plainBody.code, 'BRANCH_NOT_MERGED');

    // The branch must survive the refused delete.
    const afterPlain = execFileSync('git', ['branch', '--list', 'feat/unmerged'], {
      cwd: repoDir,
      stdio: 'pipe',
    }).toString();
    assert.ok(afterPlain.includes('feat/unmerged'));

    // Force delete (-D) succeeds and removes the branch.
    const forceRes = await fetch(`${base}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'repo', branch: 'feat/unmerged', force: true }),
    });
    assert.equal(forceRes.status, 200);
    const forceBody = (await forceRes.json()) as { success?: boolean };
    assert.equal(forceBody.success, true);

    const afterForce = execFileSync('git', ['branch', '--list', 'feat/unmerged'], {
      cwd: repoDir,
      stdio: 'pipe',
    }).toString();
    assert.equal(afterForce.trim(), '');
  });
});
