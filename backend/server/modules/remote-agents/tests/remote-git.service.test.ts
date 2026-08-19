import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createRemoteGitClient, readLocalGitIdentity } from '../remote-git.service.js';

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

test('exec omits identity when name or email parts are empty strings', async () => {
  let received: unknown = null;
  const reg = {
    rpc: async (_h: string, _m: string, p: unknown) => { received = p; return { stdout: '', stderr: '', exitCode: 0 }; },
  };
  const client = createRemoteGitClient(() => reg as never);
  await client.exec('h1', ['status'], { cwd: '/x', identity: { name: '', email: 'a@b' } });
  assert.ok(!(received as { identity?: unknown }).identity);
});

test('exec forwards a caller timeoutMs to both rpc and schema params', async () => {
  let received: unknown = null;
  const reg = {
    rpc: async (_h: string, m: string, p: unknown, t?: number, s?: AbortSignal) => {
      if (m === 'git/exec') { received = { p, t, s }; return { stdout: '', stderr: '', exitCode: 0 }; }
      throw new Error('unexpected');
    },
  };
  const client = createRemoteGitClient(() => reg as never);
  await client.exec('h1', ['status'], { cwd: '/x', timeoutMs: 180_000 });
  const pr = received as unknown as { p: { timeoutMs?: number }; t: number };
  assert.equal(pr.t, 180_000);
  assert.equal(pr.p.timeoutMs, 180_000);
});

/** Build an isolated git config: HOME/XDG point at temp dirs so the real
 *  user's ~/.gitconfig and system config can never leak into the read. */
function isolateGitConfig(content: string | null): { getEnv: () => NodeJS.ProcessEnv; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), 'lovdex-git-home-'));
  const xdg = mkdtempSync(path.join(tmpdir(), 'lovdex-git-xdg-'));
  const base = { ...process.env };
  delete base.GIT_CONFIG_GLOBAL;
  delete base.GIT_CONFIG_SYSTEM;
  base.GIT_CONFIG_NOSYSTEM = '1';
  if (content !== null) writeFileSync(path.join(home, '.gitconfig'), content, 'utf8');
  const getEnv = (): NodeJS.ProcessEnv => ({ ...base, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg });
  const cleanup = (): void => {
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  };
  return { getEnv, cleanup };
}

test('readLocalGitIdentity returns {name,email} when both are configured', () => {
  const { getEnv, cleanup } = isolateGitConfig('[user]\n\tname = Test User\n\temail = t@e.com\n');
  try {
    assert.deepEqual(readLocalGitIdentity(getEnv), { name: 'Test User', email: 't@e.com' });
  } finally {
    cleanup();
  }
});

test('readLocalGitIdentity returns null when only name is configured', () => {
  const { getEnv, cleanup } = isolateGitConfig('[user]\n\tname = Test User\n');
  try {
    assert.equal(readLocalGitIdentity(getEnv), null);
  } finally {
    cleanup();
  }
});

test('readLocalGitIdentity returns null when only email is configured', () => {
  const { getEnv, cleanup } = isolateGitConfig('[user]\n\temail = t@e.com\n');
  try {
    assert.equal(readLocalGitIdentity(getEnv), null);
  } finally {
    cleanup();
  }
});

test('readLocalGitIdentity returns null when neither is configured', () => {
  const { getEnv, cleanup } = isolateGitConfig(null);
  try {
    assert.equal(readLocalGitIdentity(getEnv), null);
  } finally {
    cleanup();
  }
});

test('readLocalGitIdentity returns null when git is not on PATH', () => {
  const { getEnv, cleanup } = isolateGitConfig('[user]\n\tname = Test User\n\temail = t@e.com\n');
  const deadPath = (): NodeJS.ProcessEnv => ({ ...getEnv(), PATH: '/nonexistent' });
  try {
    assert.equal(readLocalGitIdentity(deadPath), null);
  } finally {
    cleanup();
  }
});