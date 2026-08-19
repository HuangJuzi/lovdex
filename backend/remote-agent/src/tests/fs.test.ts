import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAllowlistedFs } from '../fs.js';
import { handleRpc } from '../rpc-dispatch.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkroot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-fs-'));
  // realpath so the root itself matches the resolveWithin canonical form
  // (macOS /tmp → /private/tmp; also normalizes any symlinked tmpdir).
  return fsp.realpath(dir);
}

test('stat: existing dir reports isDirectory; missing path reports exists:false', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });

  const sub = path.join(root, 'sub');
  await fsp.mkdir(sub);
  const dirStat = await api.stat(sub);
  assert.equal(dirStat.exists, true);
  assert.equal(dirStat.isDirectory, true);
  assert.equal(dirStat.isFile, false);

  const missing = await api.stat(path.join(root, 'nope'));
  assert.equal(missing.exists, false);
  assert.equal(missing.isDirectory, false);
  assert.equal(missing.isFile, false);
  assert.equal(missing.size, 0);
  assert.equal(missing.mtimeMs, 0);
});

test('stat: file reports isFile and size', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  const file = path.join(root, 'f.txt');
  await fsp.writeFile(file, 'hello');
  const s = await api.stat(file);
  assert.equal(s.exists, true);
  assert.equal(s.isFile, true);
  assert.equal(s.isDirectory, false);
  assert.equal(s.size, 5);
  assert.ok(s.mtimeMs > 0);
});

test('list: returns entry names and types', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'adir'));
  await fsp.writeFile(path.join(root, 'bfile'), 'x');
  await fsp.symlink(path.join(root, 'bfile'), path.join(root, 'clink'));

  const result = await api.list(root);
  // The response carries the RESOLVED path (so UI joins cannot lose a '~'
  // expansion) together with the entries.
  assert.equal(result.path, root);
  const byName = new Map(result.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('adir')?.type, 'dir');
  assert.equal(byName.get('bfile')?.type, 'file');
  assert.equal(byName.get('clink')?.type, 'symlink');
  // size is null in Phase 1 (no per-entry stat).
  assert.equal(byName.get('bfile')?.size, null);
});

test('list: respects maxEntries', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  for (let i = 0; i < 5; i += 1) await fsp.writeFile(path.join(root, `f${i}`), '');
  const { path: resolved, entries } = await api.list(root, 3);
  assert.equal(entries.length, 3);
  assert.equal(resolved, root);
});

test('read: returns file content; truncated flag when file exceeds maxBytes', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  const file = path.join(root, 'r.txt');
  await fsp.writeFile(file, 'abcdefghij'); // 10 bytes

  const full = await api.read(file);
  assert.equal(full.content, 'abcdefghij');
  assert.equal(full.truncated, false);

  const partial = await api.read(file, 4);
  assert.equal(partial.content, 'abcd');
  assert.equal(partial.truncated, true);
});

test('whitelist: stat/list/read on a path outside the root throw', async () => {
  const root = await mkroot();
  const outside = await mkroot(); // a sibling temp dir NOT in roots
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'nope');
  const api = createAllowlistedFs({ roots: [root] });

  await assert.rejects(api.stat(path.join(outside, 'secret.txt')), /path outside allowed root/);
  await assert.rejects(api.list(outside), /path outside allowed root/);
  await assert.rejects(api.read(path.join(outside, 'secret.txt')), /path outside allowed root/);
});

test('whitelist: `..` escape is rejected', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await assert.rejects(api.stat(path.join(root, '..', 'escape')), /path outside allowed root/);
});

test('whitelist: symlink pointing outside the root is rejected', async () => {
  const root = await mkroot();
  const outside = await mkroot();
  await fsp.writeFile(path.join(outside, 'target.txt'), 'secret');
  // symlink lives inside root but points outside → realpath escapes the root.
  const link = path.join(root, 'escape-link');
  await fsp.symlink(path.join(outside, 'target.txt'), link);

  const api = createAllowlistedFs({ roots: [root] });
  await assert.rejects(api.read(link), /path outside allowed root/);
  await assert.rejects(api.stat(link), /path outside allowed root/);
});

test('whitelist: a symlinked directory inside root pointing outside rejects list', async () => {
  const root = await mkroot();
  const outside = await mkroot();
  await fsp.mkdir(path.join(outside, 'd'));
  const link = path.join(root, 'dirlink');
  await fsp.symlink(path.join(outside, 'd'), link);

  const api = createAllowlistedFs({ roots: [root] });
  await assert.rejects(api.list(link), /path outside allowed root/);
});

// --- rpc-dispatch wiring ---

test('handleRpc dispatches fs/stat, fs/list, fs/read to the allowlisted fs', async () => {
  const root = await mkroot();
  await fsp.writeFile(path.join(root, 'x.txt'), 'hi there');
  const cfg = { roots: [root] } as unknown as RemoteAgentConfig;

  const stat = (await handleRpc('fs/stat', { path: path.join(root, 'x.txt') }, cfg)) as {
    exists: boolean;
    isFile: boolean;
  };
  assert.equal(stat.exists, true);
  assert.equal(stat.isFile, true);

  const list = (await handleRpc('fs/list', { path: root }, cfg)) as {
    path: string;
    entries: { name: string }[];
  };
  assert.equal(list.path, root, 'fs/list returns the resolved absolute path');
  assert.ok(list.entries.some((e) => e.name === 'x.txt'));

  const read = (await handleRpc('fs/read', { path: path.join(root, 'x.txt') }, cfg)) as {
    content: string;
  };
  assert.equal(read.content, 'hi there');
});

test('handleRpc fs/* enforces the whitelist from cfg.roots', async () => {
  const root = await mkroot();
  const outside = await mkroot();
  await fsp.writeFile(path.join(outside, 's.txt'), 'x');
  const cfg = { roots: [root] } as unknown as RemoteAgentConfig;

  await assert.rejects(
    handleRpc('fs/read', { path: path.join(outside, 's.txt') }, cfg),
    /path outside allowed root/,
  );
});

test('handleRpc still rejects unknown fs subpaths / methods', async () => {
  const root = await mkroot();
  const cfg = { roots: [root] } as unknown as RemoteAgentConfig;
  await assert.rejects(handleRpc('fs/bogus', { path: root }, cfg), /unknown rpc method/);
});
