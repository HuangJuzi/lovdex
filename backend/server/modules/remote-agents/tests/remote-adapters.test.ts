import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  createRemoteAwareFileSystem,
  createRemoteAwareSpawn,
} from '../remote-adapters.js';

type ChildShim = EventEmitter & { stdout: PassThrough; stderr: PassThrough };
const asChild = (child: unknown) => child as ChildShim;
const waitClose = (child: ChildShim) =>
  new Promise<void>((resolve) => child.on('close', () => resolve()));

test('remote-aware spawn routes git on a hosted cwd to RPC and streams stdout', async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const remoteGit = {
    exec: async (_h: string, args: string[], o: { cwd: string }) => {
      calls.push({ args, cwd: o.cwd });
      return { stdout: 'x', stderr: '', exitCode: 0 };
    },
  };
  let getRemoteGitCalls = 0;
  let localSpawnCalls = 0;
  const spawner = createRemoteAwareSpawn({
    localSpawn: () => {
      // A hosted git cwd must never reach the local spawner.
      localSpawnCalls++;
      return {} as never;
    },
    getRemoteGit: () => {
      getRemoteGitCalls++;
      return remoteGit;
    },
    lookupHost: (p) => (p === '/home/u/p' ? 'h1' : null),
    identity: null,
  });

  const child = asChild(spawner('git', ['rev-parse', '--show-toplevel'], { cwd: '/home/u/p' }));
  const chunks: string[] = [];
  child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
  await waitClose(child);

  assert.equal(chunks.join(''), 'x');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { args: ['rev-parse', '--show-toplevel'], cwd: '/home/u/p' });
  assert.equal(localSpawnCalls, 0);
  // The getter resolves lazily — one per actually-routed spawn, never at construction.
  assert.equal(getRemoteGitCalls, 1);
});

test('remote-aware spawn falls through to local for a non-hosted cwd', () => {
  let local = false;
  const spawner = createRemoteAwareSpawn({
    localSpawn: (_cmd, _args, _o) => {
      local = true;
      return {} as never;
    },
    getRemoteGit: () => ({
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    lookupHost: () => null,
    identity: null,
  });

  spawner('git', ['status'], { cwd: '/local/p' });
  assert.equal(local, true);
});

test('remote-aware spawn emits error then close(1) on RPC transport failure', async () => {
  const spawner = createRemoteAwareSpawn({
    localSpawn: () => ({} as never),
    getRemoteGit: () => ({
      exec: async (): Promise<never> => {
        throw new Error('transport down');
      },
    }),
    lookupHost: () => 'h1',
    identity: null,
  });

  const child = asChild(spawner('git', ['status'], { cwd: '/home/u/p' }));
  const errors: unknown[] = [];
  const codes: number[] = [];
  child.on('error', (e: unknown) => errors.push(e));
  child.on('close', (code: number) => codes.push(code));
  await waitClose(child);

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /transport down/);
  assert.deepEqual(codes, [1]);
});

test('remote-aware fs stat routes to RPC when the path has a host', async () => {
  const calls: string[] = [];
  const fsAsync = createRemoteAwareFileSystem({
    localFs: { access: async () => void 0 } as never,
    getRemoteFs: (() => ({
      stat: async (_h: string, p: string) => {
        calls.push(p);
        return { exists: true, isDirectory: true, isFile: false, size: 0, mtimeMs: 1 };
      },
    })) as never,
    lookupHost: (p) => (p?.startsWith('/home/u/') ? 'h1' : null),
  });

  const res = await fsAsync.stat('/home/u/p/x');
  const stat = res as { isDirectory: () => boolean; isFile: () => boolean };
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isFile(), false);
  assert.deepEqual(calls, ['/home/u/p/x']);
});

test('remote-aware fs access throws ENOENT for a missing remote path', async () => {
  const fsAsync = createRemoteAwareFileSystem({
    localFs: { access: async () => void 0 } as never,
    getRemoteFs: (() => ({
      stat: async () => ({ exists: false, isDirectory: false, isFile: false, size: 0, mtimeMs: 0 }),
    })) as never,
    lookupHost: () => 'h1',
  });

  await assert.rejects(fsAsync.access('/home/u/missing'), (err: unknown) => {
    assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});

test('remote-aware fs readFile routes to RPC and returns content', async () => {
  const calls: { p: string; maxBytes: number; enc: string }[] = [];
  const fsAsync = createRemoteAwareFileSystem({
    localFs: {} as never,
    getRemoteFs: (() => ({
      read: async (_h: string, p: string, maxBytes: number, enc: string) => {
        calls.push({ p, maxBytes, enc });
        return { content: 'hello\nworld\n', truncated: false };
      },
    })) as never,
    lookupHost: () => 'h1',
  });

  const content = await (fsAsync as { readFile: (p: string, enc?: string) => Promise<string> }).readFile(
    '/home/u/p/README.md',
    'utf-8',
  );
  assert.equal(content, 'hello\nworld\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enc, 'utf8');
  assert.equal(calls[0].maxBytes, 32 * 1024 * 1024);
});

test('remote-aware fs rm/unlink route to delete (directory vs file)', async () => {
  const dels: { p: string; type: string }[] = [];
  const fsAsync = createRemoteAwareFileSystem({
    localFs: {} as never,
    getRemoteFs: (() => ({
      stat: async (_h: string, p: string) => ({
        exists: true,
        isDirectory: p.endsWith('/dir'),
        isFile: !p.endsWith('/dir'),
        size: 1,
        mtimeMs: 1,
      }),
      delete: async (_h: string, p: string, type: string) => {
        dels.push({ p, type });
        return { success: true };
      },
    })) as never,
    lookupHost: () => 'h1',
  });

  await fsAsync.rm('/home/u/p/dir', { recursive: true, force: true });
  await fsAsync.unlink('/home/u/p/file.txt');
  assert.deepEqual(dels, [
    { p: '/home/u/p/dir', type: 'directory' },
    { p: '/home/u/p/file.txt', type: 'file' },
  ]);
});

test('remote-aware fs passes through non-routed methods to localFs', async () => {
  let readdirLocal = false;
  const fsAsync = createRemoteAwareFileSystem({
    localFs: {
      stat: async () => ({ isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: 1, mode: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0, atime: new Date(), mtime: new Date(), ctime: new Date(), birthtime: new Date(), dev: 0, ino: 0, nlink: 1, uid: 0, gid: 0, rdev: 0, blocks: 0, blksize: 0 }),
      readdir: async () => {
        readdirLocal = true;
        return ['a.txt'];
      },
    } as never,
    getRemoteFs: (() => ({
      stat: async () => ({ exists: true, isDirectory: true, isFile: false, size: 0, mtimeMs: 1 }),
    })) as never,
    lookupHost: () => 'h1',
  });

  // `readdir` is not routed, so even a hosted path must hit the local fs.
  const entries = await (fsAsync as { readdir: (p: string) => Promise<string[]> }).readdir(
    '/home/u/p',
  );
  assert.equal(readdirLocal, true);
  assert.deepEqual(entries, ['a.txt']);
});