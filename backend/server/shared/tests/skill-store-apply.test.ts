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

test('apply rejects a bundle carrying an ignored path, and writes nothing', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  // `collectSkillDir` skips dot-entries, so such a bundle could never pass the
  // post-write verification — it must be refused up front with a real reason.
  const v = bundleOf([file('SKILL.md', 'hi'), file('.gitignore', 'node_modules')]);
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: v.contentHash, files: v.files,
      expectedTargetHash: null, force: false,
    }),
    /ignored path in bundle/,
  );
  await assert.rejects(() => fsp.stat(path.join(root, 'demo')), /ENOENT/);
});

test('apply refuses an empty bundle', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: computeSkillHash([]), files: [],
      expectedTargetHash: null, force: false,
    }),
    /refusing to apply an empty bundle/,
  );
  await assert.rejects(() => fsp.stat(path.join(root, 'demo')), /ENOENT/);
});

test('apply does not mistake a dot-prefixed name for an escape', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  // `..foo.md` used to trip `rel.startsWith('..')`, a false positive that
  // reported a plain dot-name as a path escape. It is still refused — dot
  // entries are skipped on read, so it could never verify — but the error must
  // now name the real reason instead of mislabelling it as an escape.
  const v = bundleOf([file('..foo.md', 'x')]);
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: v.contentHash, files: v.files,
      expectedTargetHash: null, force: false,
    }),
    /ignored path in bundle/,
  );
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: v.contentHash, files: v.files,
      expectedTargetHash: null, force: false,
    }),
    (err: Error) => !/unsafe relativePath/.test(err.message),
  );
});

test('concurrent applies for one skill settle without a bare fs error', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const contents = ['c1', 'c2', 'c3', 'c4'];
  const settled = await Promise.allSettled(contents.map((content) => {
    const v = bundleOf([file('SKILL.md', content)]);
    return store.apply({
      root, name: 'demo', contentHash: v.contentHash, files: v.files,
      expectedTargetHash: null, force: true,
    });
  }));

  for (const result of settled) {
    if (result.status === 'rejected') {
      // Serialized applies must not surface raw EEXIST/ENOTEMPTY/ENOENT — those
      // are the opaque failures a lost race used to produce.
      assert.doesNotMatch(
        result.reason.message,
        /EEXIST|ENOTEMPTY|ENOENT|EBUSY/,
        `bare fs error leaked: ${result.reason.message}`,
      );
    }
  }
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, contents.length);
  // The survivor is exactly one of the four inputs, never a torn mix.
  const final = await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8');
  assert.ok(contents.includes(final), `unexpected final content: ${final}`);
});

test('a failed post-write verification keeps a readable backup and restores the target', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('a/b.md', 'old')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });

  // `a//b.md` and `a/b.md` normalize onto the SAME file, so what a re-read
  // produces can never match the bundle hash — the reachable way to exercise
  // the post-write verification branch.
  const v2 = bundleOf([file('a/b.md', 'new'), file('a//b.md', 'other')]);
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: v2.contentHash, files: v2.files,
      expectedTargetHash: v1.contentHash, force: false,
    }),
    /post-write verification failed/,
  );

  const backupRoot = path.join(root, SKILL_BACKUP_DIR);
  const backups = (await fsp.readdir(backupRoot)).filter((e) => e.startsWith('demo.'));
  assert.equal(backups.length, 1, 'the pre-apply version must be preserved');
  assert.equal(await fsp.readFile(path.join(backupRoot, backups[0], 'a', 'b.md'), 'utf8'), 'old');
  // …and the target must be restored, not left as a hole.
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'a', 'b.md'), 'utf8'), 'old');
});

test('apply keeps at most 10 backups per skill', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const backupRoot = path.join(root, SKILL_BACKUP_DIR);

  const v0 = bundleOf([file('SKILL.md', 'v0')]);
  await store.apply({ root, name: 'demo', contentHash: v0.contentHash, files: v0.files, expectedTargetHash: null, force: false });
  let previous = v0.contentHash;
  for (let i = 1; i <= 12; i++) {
    const v = bundleOf([file('SKILL.md', `v${i}`)]);
    await store.apply({
      root, name: 'demo', contentHash: v.contentHash, files: v.files,
      expectedTargetHash: previous, force: false,
    });
    previous = v.contentHash;
  }

  const mine = (await fsp.readdir(backupRoot)).filter((e) => e.startsWith('demo.'));
  assert.equal(mine.length, 10);
  // The newest backup must be the version immediately before the last apply.
  const newest = mine.sort().at(-1)!;
  assert.equal(await fsp.readFile(path.join(backupRoot, newest, 'SKILL.md'), 'utf8'), 'v11');
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'v12');
});
