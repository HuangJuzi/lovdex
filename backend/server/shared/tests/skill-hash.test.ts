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
  type SkillFileEntry,
} from '../skill-hash.js';

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
