import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireModal,
  getOpenModalCount,
  resetOpenModalCountForTests,
  subscribeModalPresence,
} from './modalPresence';

test('acquire/release keeps a live count of open dialogs', () => {
  resetOpenModalCountForTests();
  assert.equal(getOpenModalCount(), 0);

  const releaseA = acquireModal();
  const releaseB = acquireModal();
  assert.equal(getOpenModalCount(), 2);

  releaseA();
  assert.equal(getOpenModalCount(), 1);
  releaseB();
  assert.equal(getOpenModalCount(), 0);
});

test('releasing twice cannot under-count (StrictMode/effect cleanup safety)', () => {
  resetOpenModalCountForTests();
  const release = acquireModal();

  release();
  release();

  assert.equal(getOpenModalCount(), 0);
});

test('subscribers run on every change', () => {
  resetOpenModalCountForTests();
  let changes = 0;
  const unsubscribe = subscribeModalPresence(() => { changes++; });

  const release = acquireModal();
  release();
  unsubscribe();
  acquireModal()();

  assert.equal(changes, 2, 'two changes while subscribed, none after unsubscribe');
});
