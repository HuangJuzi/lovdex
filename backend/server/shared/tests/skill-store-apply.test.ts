import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillStore, SKILL_BACKUP_DIR } from '../skill-store.js';
import { collectSkillDir, computeSkillHash, type SkillFileEntry } from '../skill-hash.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-store-apply-'));
  return fsp.realpath(dir);
}

function file(relativePath: string, content: string, executable = false): SkillFileEntry {
  return { relativePath, content, encoding: 'utf8', executable };
}

/** 把 files 打包成 apply 需要的形状（contentHash 由真实算法算出）。 */
function bundleOf(files: SkillFileEntry[]) {
  return { files, contentHash: computeSkillHash(files) };
}

async function readSkill(root: string, name: string): Promise<string> {
  const files = await collectSkillDir(path.join(root, name));
  return JSON.stringify(files.map((f) => [f.relativePath, f.content]));
}

test('apply creates a new skill and reports created', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const { files, contentHash } = bundleOf([file('SKILL.md', 'hello')]);

  const result = await store.apply({
    root, name: 'demo', contentHash, files, expectedTargetHash: null, force: false,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.backupPath, undefined);
  assert.equal(result.contentHash, contentHash);
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'hello');
});

test('apply updates an existing skill and backs the old version up', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });

  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  const result = await store.apply({
    root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false,
  });

  assert.equal(result.action, 'updated');
  assert.ok(result.backupPath);
  assert.equal(await fsp.readFile(path.join(result.backupPath!, 'SKILL.md'), 'utf8'), 'v1');
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'v2');
});

test('apply skips when the target already matches', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });

  const again = await store.apply({
    root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: v1.contentHash, force: false,
  });
  assert.equal(again.action, 'skipped');
  assert.equal(again.backupPath, undefined);
});

test('apply refuses when the target drifted from the previewed hash', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  // 目标在预览之后被改了
  await fsp.writeFile(path.join(root, 'demo', 'SKILL.md'), 'edited-locally');

  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  await assert.rejects(
    () => store.apply({ root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false }),
    /target changed/,
  );
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'edited-locally');
});

test('apply with force overwrites a drifted target', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  await fsp.writeFile(path.join(root, 'demo', 'SKILL.md'), 'edited-locally');

  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  const result = await store.apply({
    root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: true,
  });
  assert.equal(result.action, 'updated');
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'v2');
});

test('apply rejects a declared contentHash that the files do not produce', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: 'f'.repeat(64), files: [file('SKILL.md', 'hello')],
      expectedTargetHash: null, force: false,
    }),
    /bundle hash mismatch/,
  );
  await assert.rejects(() => fsp.stat(path.join(root, 'demo')), /ENOENT/);
});

test('apply preserves the executable bit', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const { files, contentHash } = bundleOf([file('SKILL.md', 'hi'), file('scripts/run.sh', 'echo hi', true)]);
  await store.apply({ root, name: 'demo', contentHash, files, expectedTargetHash: null, force: false });

  const stat = await fsp.stat(path.join(root, 'demo', 'scripts', 'run.sh'));
  assert.ok((stat.mode & 0o111) !== 0, 'exec bit must survive the round trip');
  const round = await store.bundle(root, 'demo');
  assert.equal(round.contentHash, contentHash);
});

test('apply rejects an unsafe relativePath', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: computeSkillHash([file('../evil.md', 'x')]),
      files: [file('../evil.md', 'x')], expectedTargetHash: null, force: false,
    }),
    /unsafe relativePath/,
  );
});

test('apply bounds the payload by DECODED size before writing anything', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: computeSkillHash([file('big.bin', big)]),
      files: [file('big.bin', big)], expectedTargetHash: null, force: false,
    }),
    /skill file too large/,
  );
  await assert.rejects(() => fsp.stat(path.join(root, 'demo')), /ENOENT/);
});

test('a failed apply leaves the existing skill untouched', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — permission bits do not apply');
    return;
  }
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  const before = await readSkill(root, 'demo');

  // 只读根目录：staging 目录建不出来，写入必须在碰到原目录之前就失败
  await fsp.chmod(root, 0o500);
  try {
    const v2 = bundleOf([file('SKILL.md', 'v2')]);
    await assert.rejects(() =>
      store.apply({ root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false }),
    );
  } finally {
    await fsp.chmod(root, 0o700);
  }

  assert.equal(await readSkill(root, 'demo'), before);
});

test('the backup directory is never listed as a skill', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  await store.apply({ root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false });

  assert.equal((await fsp.stat(path.join(root, SKILL_BACKUP_DIR))).isDirectory(), true);
  const manifest = await store.manifest(root);
  assert.deepEqual(manifest.entries.map((e) => e.name), ['demo']);
});
