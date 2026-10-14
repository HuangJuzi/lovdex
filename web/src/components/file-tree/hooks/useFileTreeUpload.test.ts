import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkFilesForUpload } from './useFileTreeUpload';

const file = (name: string, kb = 1) =>
  new File([new ArrayBuffer(kb * 1024)], name, { type: 'text/plain' });

test('chunkFilesForUpload: <= limit returns a single batch', () => {
  const batches = chunkFilesForUpload([file('a'), file('b')], 20);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test('chunkFilesForUpload: exactly limit is one batch, limit+1 splits', () => {
  const files = Array.from({ length: 20 }, (_, i) => file(`f${i}`));
  assert.equal(chunkFilesForUpload(files, 20).length, 1);
  const batches = chunkFilesForUpload([...files, file('f20')], 20);
  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches.map((b) => b.length),
    [20, 1],
  );
});

test('chunkFilesForUpload: 1000 files at limit 20 -> 50 batches', () => {
  const files = Array.from({ length: 1000 }, (_, i) => file(`f${i}`));
  const batches = chunkFilesForUpload(files, 20);
  assert.equal(batches.length, 50);
  assert.ok(batches.every((b) => b.length === 20));
});

test('chunkFilesForUpload: empty input -> no batches', () => {
  assert.deepEqual(chunkFilesForUpload([], 20), []);
});
