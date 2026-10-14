import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDescendantOfAny,
  topMostSelectedPaths,
  rangeBetween,
} from './fileTreeSelection';

test('isDescendantOfAny: segment-aware prefix match', () => {
  assert.equal(isDescendantOfAny('docs/sub/a.ts', ['docs']), true);
  assert.equal(isDescendantOfAny('docs-old/a.ts', ['docs']), false);
  assert.equal(isDescendantOfAny('docs', ['docs']), false); // self is not a descendant
  assert.equal(isDescendantOfAny('a.ts', []), false);
});

test('topMostSelectedPaths: drops paths covered by selected ancestors', () => {
  assert.deepEqual(
    topMostSelectedPaths(['docs', 'docs/sub/a.ts', 'other.txt']),
    ['docs', 'other.txt'],
  );
  assert.deepEqual(topMostSelectedPaths(['b.ts', 'a.ts']), ['b.ts', 'a.ts']);
});

test('rangeBetween: inclusive slice by visible order', () => {
  const order = ['a.ts', 'docs', 'docs/x.ts', 'b.ts', 'c.ts'];
  assert.deepEqual(rangeBetween(order, 'a.ts', 'b.ts'), ['a.ts', 'docs', 'docs/x.ts', 'b.ts']);
  assert.deepEqual(rangeBetween(order, 'c.ts', 'docs'), ['docs', 'docs/x.ts', 'b.ts', 'c.ts']); // reversed works
  assert.deepEqual(rangeBetween(order, 'a.ts', 'missing.ts'), []); // unknown endpoint -> empty
});
