import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampWidth,
  readStoredWidth,
} from './useSidebarWidth';

test('clampWidth bounds values to [200, 480]', () => {
  assert.equal(clampWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampWidth(600), SIDEBAR_WIDTH_MAX);
  assert.equal(clampWidth(300), 300);
});

test('clampWidth rounds to whole pixels and rejects non-finite values', () => {
  assert.equal(clampWidth(300.4), 300);
  assert.equal(clampWidth(300.6), 301);
  assert.equal(clampWidth(Number.NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_DEFAULT);
});

test('readStoredWidth reads and clamps stored value', () => {
  const storage = { getItem: () => '350' };
  assert.equal(readStoredWidth(storage), 350);

  const outOfRange = { getItem: () => '9999' };
  assert.equal(readStoredWidth(outOfRange), SIDEBAR_WIDTH_MAX);
});

test('readStoredWidth falls back to default for missing or garbage values', () => {
  const missing = { getItem: () => null };
  assert.equal(readStoredWidth(missing), SIDEBAR_WIDTH_DEFAULT);

  const garbage = { getItem: () => 'abc' };
  assert.equal(readStoredWidth(garbage), SIDEBAR_WIDTH_DEFAULT);
});

test('SIDEBAR_WIDTH_STORAGE_KEY matches the localStorage key used', () => {
  assert.equal(SIDEBAR_WIDTH_STORAGE_KEY, 'sidebarWidth');
});
