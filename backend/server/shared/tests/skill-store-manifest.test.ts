import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillStore } from '../skill-store.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-store-'));
  return fsp.realpath(dir);
}

async function writeSkill(root: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

test('manifest returns exists:false for a root that has never been created', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(path.join(root, 'nope'));
  assert.equal(result.exists, false);
  assert.deepEqual(result.entries, []);
});

test('manifest lists skill directories with hash, size and frontmatter', async () => {
  const root = await mkRoot();
  const body = '---\nname: demo\ndescription: A demo skill\nversion: 1.2.0\n---\n\nBody\n';
  await writeSkill(root, 'demo', { 'SKILL.md': body, 'scripts/run.sh': 'echo hi' });
  const store = createSkillStore({ roots: [root] });

  const result = await store.manifest(root);
  assert.equal(result.exists, true);
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.name, 'demo');
  assert.equal(entry.fileCount, 2);
  assert.equal(entry.totalBytes, Buffer.byteLength(body) + Buffer.byteLength('echo hi'));
  assert.equal(entry.description, 'A demo skill');
  assert.equal(entry.version, '1.2.0');
  assert.match(entry.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(entry.mtime > 0);
});

test('manifest skips dot-entries, node_modules, plain files and symlinks', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'demo', { 'SKILL.md': 'hi' });
  await writeSkill(root, '.skill-sync-backup', { 'SKILL.md': 'backup' });
  await writeSkill(root, 'node_modules', { 'SKILL.md': 'dep' });
  await fsp.writeFile(path.join(root, 'loose.md'), 'not a skill');
  await fsp.symlink(path.join(root, 'demo'), path.join(root, 'linked'));

  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);
  assert.deepEqual(result.entries.map((e) => e.name), ['demo']);
});

test('manifest sorts entries by name', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'zeta', { 'SKILL.md': 'z' });
  await writeSkill(root, 'alpha', { 'SKILL.md': 'a' });
  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);
  assert.deepEqual(result.entries.map((e) => e.name), ['alpha', 'zeta']);
});

test('manifest tolerates malformed frontmatter', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'demo', { 'SKILL.md': '---\n: : bad yaml [\n---\nbody' });
  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].description, undefined);
  assert.match(result.entries[0].contentHash, /^[0-9a-f]{64}$/);
});

test('manifest marks an oversized skill as inert instead of failing the listing', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'good', { 'SKILL.md': 'hi' });
  await writeSkill(root, 'huge', { 'big.bin': 'x' });
  await fsp.writeFile(path.join(root, 'huge', 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);

  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName.good.error, undefined);
  assert.match(byName.good.contentHash, /^[0-9a-f]{64}$/);
  assert.match(byName.huge.error ?? '', /skill file too large/);
  assert.equal(byName.huge.contentHash, '');
});

test('manifest rejects a root outside the allowlist', async () => {
  const root = await mkRoot();
  const outside = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(() => store.manifest(outside), /path outside allowed root/);
});
