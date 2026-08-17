import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeProjectPath } from '@/shared/utils.js';

test('canonicalizeProjectPath resolves symlinks to the real absolute path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'canon-'));
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  await mkdir(real, { recursive: true });
  await symlink(real, link);

  try {
    assert.equal(canonicalizeProjectPath(link), real);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('canonicalizeProjectPath falls back to lexical normalization when path does not exist', () => {
  assert.equal(canonicalizeProjectPath('/no/such/path/../dir'), '/no/such/dir');
});

test('canonicalizeProjectPath returns empty string for empty input', () => {
  assert.equal(canonicalizeProjectPath(''), '');
  assert.equal(canonicalizeProjectPath('   '), '');
});
