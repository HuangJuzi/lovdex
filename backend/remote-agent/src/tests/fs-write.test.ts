import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createAllowlistedFs } from '../fs.js';

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'lovdex-fs-'));
}

test('write + read round-trip with base64', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  const target = path.join(root, 'a.bin');
  const data = Buffer.from([0, 1, 2, 250]);
  const w = await fsApi.write(target, data.toString('base64'), 'base64');
  assert.equal(w.size, data.length);
  const r = await fsApi.read(target, 1000, 'base64');
  assert.equal(Buffer.from(r.content, 'base64').equals(data), true);
  rmSync(root, { recursive: true, force: true });
});

test('create conflict rejects with EEXIST-like error', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  await fsApi.create(root, 'file', 'x.txt');
  await assert.rejects(() => fsApi.create(root, 'file', 'x.txt'), /already exists/);
  rmSync(root, { recursive: true, force: true });
});

test('tree skips node_modules and reports directory/file types', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'a.ts'), 'x');
  const { nodes } = await fsApi.tree(root, 1, true);
  const first = nodes[0] as { name: string; type: string };
  assert.equal(nodes.length, 1);
  assert.equal(first.name, 'a.ts');
  assert.equal(first.type, 'file');
  rmSync(root, { recursive: true, force: true });
});

test('path escape outside roots rejected on write', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  await assert.rejects(() => fsApi.write('/etc/passwd', 'x'), /path outside allowed root/);
  rmSync(root, { recursive: true, force: true });
});

test('write rejects a dangling symlink leaf (no write-through)', async () => {
  const root = makeRoot();
  const outsideRoot = makeRoot();
  const victim = path.join(outsideRoot, 'victim.txt');
  symlinkSync(victim, path.join(root, 'evillink'));
  const fsApi = createAllowlistedFs({ roots: [root] });
  await assert.rejects(
    () => fsApi.write(path.join(root, 'evillink'), 'pwned'),
    /allowed root/,
  );
  assert.equal(existsSync(victim), false, 'victim outside the root must not be written');
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

test('create file rejects a dangling symlink leaf (no truncate-through)', async () => {
  const root = makeRoot();
  const outsideRoot = makeRoot();
  const victim = path.join(outsideRoot, 'victim.txt');
  symlinkSync(victim, path.join(root, 'evillink'));
  const fsApi = createAllowlistedFs({ roots: [root] });
  await assert.rejects(
    () => fsApi.create(root, 'file', 'evillink'),
    /EEXIST|already exists|allowed root/,
  );
  assert.equal(existsSync(victim), false, 'victim outside the root must not be created');
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});