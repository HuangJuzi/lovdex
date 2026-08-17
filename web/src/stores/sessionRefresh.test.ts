import assert from 'node:assert/strict';
import test from 'node:test';

import { computeRefreshLimit, mergeRefreshedTail } from './sessionRefresh';
import type { NormalizedMessage } from './useSessionStore';

test('computeRefreshLimit defaults to max(current,20) capped at 200', () => {
  assert.equal(computeRefreshLimit(0), 20);
  assert.equal(computeRefreshLimit(20), 20);
  assert.equal(computeRefreshLimit(60), 60);
  assert.equal(computeRefreshLimit(500), 200); // capped
  assert.equal(computeRefreshLimit(50, { limit: 80 }), 80); // explicit opts wins
  assert.equal(computeRefreshLimit(50, { limit: 0 }), 1); // floor at 1
});

test('mergeRefreshedTail replaces when fetched covers existing', () => {
  const existing = [{ id: 'm1' }, { id: 'm2' }] as NormalizedMessage[];
  const fetched = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as NormalizedMessage[];
  assert.deepEqual(mergeRefreshedTail(existing, fetched), fetched);
});

test('mergeRefreshedTail keeps older prefix when fetched is a bounded tail', () => {
  const existing = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) as NormalizedMessage[];
  const fetched = ['d', 'e', 'f'].map((id) => ({ id })) as NormalizedMessage[];
  const merged = mergeRefreshedTail(existing, fetched);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('mergeRefreshedTail returns existing unchanged when fetched is empty', () => {
  const existing = [{ id: 'm1' }] as NormalizedMessage[];
  assert.equal(mergeRefreshedTail(existing, []), existing);
});

test('mergeRefreshedTail keeps older rows when the tail shifts (new messages arrived)', () => {
  const existing = ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id })) as NormalizedMessage[];
  const fetched = ['m3', 'm4', 'm5'].map((id) => ({ id })) as NormalizedMessage[];
  const merged = mergeRefreshedTail(existing, fetched);
  assert.deepEqual(merged.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
});
