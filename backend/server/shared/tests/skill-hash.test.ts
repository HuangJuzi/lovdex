import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectSkillDir,
  computeSkillHash,
  detectEncoding,
  isIgnoredSkillEntry,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  type SkillFileEntry,
} from '../skill-hash.js';

/** The two NUL-free, non-UTF-8 byte sequences that used to collapse onto the
 * same string (and therefore the same fingerprint) under a NUL-scan heuristic. */
const NON_UTF8_A = Buffer.from('636166e9206e61ef76650a', 'hex');
const NON_UTF8_B = Buffer.from('636166ee206e61f576650a', 'hex');

const f = (relativePath: string, content: string, executable = false): SkillFileEntry => ({
  relativePath,
  content,
  encoding: 'utf8',
  executable,
});

async function mkSkillDir(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-hash-'));
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('computeSkillHash is order-independent', () => {
  const a = computeSkillHash([f('SKILL.md', 'a'), f('run.sh', 'b')]);
  const b = computeSkillHash([f('run.sh', 'b'), f('SKILL.md', 'a')]);
  assert.equal(a, b);
});

test('computeSkillHash changes with content, path and exec bit', () => {
  const base = computeSkillHash([f('SKILL.md', 'a')]);
  assert.notEqual(base, computeSkillHash([f('SKILL.md', 'b')]));
  assert.notEqual(base, computeSkillHash([f('OTHER.md', 'a')]));
  assert.notEqual(base, computeSkillHash([f('SKILL.md', 'a', true)]));
});

test('computeSkillHash of an empty skill is stable', () => {
  assert.equal(computeSkillHash([]), computeSkillHash([]));
});

test('computeSkillHash ignores mtimeMs (cross-host clocks are unreliable)', () => {
  const a: SkillFileEntry = { ...f('SKILL.md', 'a'), mtimeMs: 1 };
  const b: SkillFileEntry = { ...f('SKILL.md', 'a'), mtimeMs: 999999999 };
  assert.equal(computeSkillHash([a]), computeSkillHash([b]));
});

test('computeSkillHash round-trips base64 content', () => {
  const bytes = Buffer.from([0x00, 0x01, 0xff]);
  const entry: SkillFileEntry = {
    relativePath: 'logo.png',
    content: bytes.toString('base64'),
    encoding: 'base64',
    executable: false,
  };
  assert.equal(computeSkillHash([entry]), computeSkillHash([{ ...entry }]));
  // 同一份字节，用 utf8 编码声明会算出不同指纹 —— 编码是内容的一部分
  assert.notEqual(computeSkillHash([entry]), computeSkillHash([f('logo.png', bytes.toString('base64'))]));
});

test('isIgnoredSkillEntry skips dotfiles, dot-dirs and node_modules', () => {
  assert.equal(isIgnoredSkillEntry('.git'), true);
  assert.equal(isIgnoredSkillEntry('.skill-sync-backup'), true);
  assert.equal(isIgnoredSkillEntry('.DS_Store'), true);
  assert.equal(isIgnoredSkillEntry('node_modules'), true);
  assert.equal(isIgnoredSkillEntry('SKILL.md'), false);
  assert.equal(isIgnoredSkillEntry('scripts'), false);
});

test('detectEncoding picks base64 for binary content', () => {
  assert.equal(detectEncoding(Buffer.from('hello', 'utf8')), 'utf8');
  assert.equal(detectEncoding(Buffer.from([0x00, 0x01, 0x02])), 'base64');
});

test('detectEncoding is round-trip based, not NUL based', () => {
  assert.equal(detectEncoding(Buffer.from([0x00, 0x01])), 'base64');
  assert.equal(detectEncoding(Buffer.from('hi', 'utf8')), 'utf8');
  // UTF-8 permits U+0000, so a NUL is not proof of non-text; such a file is
  // carried as base64 anyway (lossless either way, and it is the binary fast
  // path). What matters is that it never round-trips lossily.
  assert.equal(detectEncoding(Buffer.from([0x61, 0x00, 0x62])), 'base64');
  // NUL-free but NOT valid UTF-8 — the case a NUL scan got wrong.
  assert.equal(detectEncoding(NON_UTF8_A), 'base64');
  assert.equal(detectEncoding(NON_UTF8_B), 'base64');
});

test('non-UTF-8 NUL-free bytes survive collection losslessly', async () => {
  const dir = await mkSkillDir();
  await fsp.writeFile(path.join(dir, 'notes.txt'), NON_UTF8_A);

  const files = await collectSkillDir(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].encoding, 'base64');
  assert.deepEqual(Buffer.from(files[0].content, 'base64'), NON_UTF8_A);
});

test('two different NUL-free non-UTF-8 byte sequences do NOT collide', async () => {
  // Under the old NUL heuristic both decoded to 'caf� na�ve\n', so
  // both hashed the same and a real update would have been skipped as
  // "already in sync".
  assert.notDeepEqual(NON_UTF8_A, NON_UTF8_B);
  const mangled = (buf: Buffer): string => Buffer.from(buf.toString('utf8'), 'utf8').toString('hex');
  assert.equal(mangled(NON_UTF8_A), mangled(NON_UTF8_B)); // the old lossy path

  const dirA = await mkSkillDir();
  const dirB = await mkSkillDir();
  await fsp.writeFile(path.join(dirA, 'notes.txt'), NON_UTF8_A);
  await fsp.writeFile(path.join(dirB, 'notes.txt'), NON_UTF8_B);

  assert.notEqual(
    computeSkillHash(await collectSkillDir(dirA)),
    computeSkillHash(await collectSkillDir(dirB)),
  );
});

test('computeSkillHash rejects a duplicate relativePath', () => {
  assert.throws(
    () => computeSkillHash([f('SKILL.md', 'a'), f('SKILL.md', 'b')]),
    /duplicate relativePath: SKILL\.md/,
  );
  // Same path AND same content is still a malformed manifest.
  assert.throws(
    () => computeSkillHash([f('SKILL.md', 'a'), f('SKILL.md', 'a')]),
    /duplicate relativePath/,
  );
});

test('collectSkillDir output is stable across a JSON wire round-trip', async () => {
  const dir = await mkSkillDir();
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi');
  await fsp.writeFile(path.join(dir, 'notes.txt'), NON_UTF8_A);

  const files = await collectSkillDir(dir);
  const overWire = JSON.parse(JSON.stringify(files)) as SkillFileEntry[];
  assert.equal(computeSkillHash(overWire), computeSkillHash(files));
});

test('collectSkillDir enforces MAX_SKILL_TOTAL_BYTES', async () => {
  const dir = await mkSkillDir();
  // Each file sits just under the per-file cap, so only the running total can
  // trip: the largest number of such files that still fits, plus one.
  const perFile = MAX_SKILL_FILE_BYTES - 1;
  const count = Math.floor(MAX_SKILL_TOTAL_BYTES / perFile) + 1;
  const chunk = Buffer.alloc(perFile, 0x61);
  for (let i = 0; i < count; i++) {
    await fsp.writeFile(path.join(dir, `chunk-${i}.bin`), chunk);
  }
  await assert.rejects(() => collectSkillDir(dir), /skill too large/);
});

test('collectSkillDir never follows a symlink out of the skill root', async () => {
  const dir = await mkSkillDir();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-hash-outside-'));
  const secret = 'PRIVATE-KEY-MATERIAL-DO-NOT-LEAK';
  await fsp.writeFile(path.join(outside, 'id_rsa'), secret);
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.symlink(path.join(outside, 'id_rsa'), path.join(dir, 'leak.txt'));
  await fsp.symlink(outside, path.join(dir, 'leakdir'));

  const files = await collectSkillDir(dir);
  assert.deepEqual(files.map((x) => x.relativePath), ['SKILL.md']);
  assert.equal(JSON.stringify(files).includes(secret), false);
});

test('collectSkillDir walks recursively, skips ignored entries, POSIX-joins paths', async () => {
  const dir = await mkSkillDir();
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi');
  await fsp.writeFile(path.join(dir, '.git', 'config'), 'ignored');
  await fsp.writeFile(path.join(dir, '.DS_Store'), 'ignored');

  const files = await collectSkillDir(dir);
  assert.deepEqual(files.map((x) => x.relativePath), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(files[0].content, 'hello');
  assert.equal(files[0].encoding, 'utf8');
});

test('collectSkillDir reports the exec bit', async () => {
  const dir = await mkSkillDir();
  await fsp.writeFile(path.join(dir, 'run.sh'), 'echo hi', { mode: 0o755 });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hi', { mode: 0o644 });
  const files = await collectSkillDir(dir);
  assert.equal(files.find((x) => x.relativePath === 'run.sh')?.executable, true);
  assert.equal(files.find((x) => x.relativePath === 'SKILL.md')?.executable, false);
});

test('collectSkillDir skips symlinks', async () => {
  const dir = await mkSkillDir();
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.symlink(path.join(dir, 'SKILL.md'), path.join(dir, 'link.md'));
  const files = await collectSkillDir(dir);
  assert.deepEqual(files.map((x) => x.relativePath), ['SKILL.md']);
});

test('collectSkillDir rejects an oversized single file', async () => {
  const dir = await mkSkillDir();
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
  await fsp.writeFile(path.join(dir, 'big.bin'), big);
  await assert.rejects(() => collectSkillDir(dir), /skill file too large/);
});

test('collectSkillDir output hashes deterministically across calls', async () => {
  const dir = await mkSkillDir();
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi');
  assert.equal(
    computeSkillHash(await collectSkillDir(dir)),
    computeSkillHash(await collectSkillDir(dir)),
  );
});

test('golden fingerprint is frozen across main and lite', () => {
  // Must match backend/remote-agent/src/tests/skill-hash-parity.test.ts
  const GOLDEN = '67235fa7090160e8df19fa7052a0f40e01bb127f0b38991880eee38da70b24f4';
  assert.equal(
    computeSkillHash([
      { relativePath: 'SKILL.md', content: 'hello', encoding: 'utf8', executable: false },
      { relativePath: 'scripts/run.sh', content: 'echo hi', encoding: 'utf8', executable: true },
    ]),
    GOLDEN,
  );
});
