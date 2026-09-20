import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillStore } from '../skill-store.js';
import { computeSkillHash } from '../skill-hash.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-store-bundle-'));
  return fsp.realpath(dir);
}

test('bundle returns every file plus a matching fingerprint', async () => {
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi', { mode: 0o755 });

  const store = createSkillStore({ roots: [root] });
  const bundle = await store.bundle(root, 'demo');

  assert.equal(bundle.name, 'demo');
  assert.deepEqual(bundle.files.map((f) => f.relativePath), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(bundle.files.find((f) => f.relativePath === 'scripts/run.sh')?.executable, true);
  assert.equal(bundle.contentHash, computeSkillHash(bundle.files));
});

test('bundle base64-encodes binary files', async () => {
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x00, 0x01, 0xff]));
  const store = createSkillStore({ roots: [root] });
  const bundle = await store.bundle(root, 'demo');
  assert.equal(bundle.files[0].encoding, 'base64');
  assert.equal(Buffer.from(bundle.files[0].content, 'base64').toString('hex'), '0001ff');
});

test('bundle rejects a missing skill', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(() => store.bundle(root, 'ghost'), /skill not found: ghost/);
});

test('bundle rejects path-traversal names', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  for (const bad of ['..', '.', 'a/b', '../demo', 'demo/../other']) {
    await assert.rejects(() => store.bundle(root, bad), /invalid skill name/);
  }
});

test('bundle rejects a root outside the allowlist', async () => {
  const root = await mkRoot();
  const outside = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(() => store.bundle(outside, 'demo'), /path outside allowed root/);
});
