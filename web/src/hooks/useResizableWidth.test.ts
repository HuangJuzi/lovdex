import test from 'node:test';
import assert from 'node:assert/strict';

import { clampToRange, readStoredNumber } from './useResizableWidth';

const OPTS = { storageKey: 'someWidth', defaultWidth: 300, min: 200, max: 500 };

test('clampToRange 夹取到 [min, max]', () => {
  assert.equal(clampToRange(100, 200, 500, 300), 200);
  assert.equal(clampToRange(900, 200, 500, 300), 500);
  assert.equal(clampToRange(350, 200, 500, 300), 350);
});

test('clampToRange 取整并拒绝非有限值', () => {
  assert.equal(clampToRange(300.4, 200, 500, 300), 300);
  assert.equal(clampToRange(300.6, 200, 500, 300), 301);
  assert.equal(clampToRange(Number.NaN, 200, 500, 300), 300);
  assert.equal(clampToRange(Number.POSITIVE_INFINITY, 200, 500, 300), 300);
});

test('readStoredNumber 读值并夹取', () => {
  assert.equal(readStoredNumber({ getItem: () => '350' }, OPTS), 350);
  assert.equal(readStoredNumber({ getItem: () => '9999' }, OPTS), 500);
});

test('readStoredNumber 对缺失/垃圾值回落默认', () => {
  assert.equal(readStoredNumber({ getItem: () => null }, OPTS), 300);
  assert.equal(readStoredNumber({ getItem: () => 'abc' }, OPTS), 300);
});

test('storage 抛错时回落默认值', () => {
  const throwing = { getItem: () => { throw new Error('SecurityError'); } };
  assert.equal(readStoredNumber(throwing, OPTS), 300);
});

test('不同 storageKey 互不影响（侧边栏与收件箱列表各存各的）', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };

  const sidebar = { storageKey: 'sidebarWidth', defaultWidth: 288, min: 200, max: 480 };
  const inboxList = { storageKey: 'inboxListWidth', defaultWidth: 288, min: 200, max: 480 };

  storage.setItem(sidebar.storageKey, '420');

  assert.equal(readStoredNumber(storage, sidebar), 420);
  assert.equal(readStoredNumber(storage, inboxList), 288, '改侧边栏不该影响收件箱列表');
});
