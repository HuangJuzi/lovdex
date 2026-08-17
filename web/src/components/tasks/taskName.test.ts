import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveTaskName } from './taskName';

test('deriveTaskName uses a single short line verbatim', () => {
  assert.equal(deriveTaskName('修复登录页的报错'), '修复登录页的报错');
});

test('deriveTaskName takes the first non-empty line and ignores the rest', () => {
  assert.equal(deriveTaskName('\n\n  给看板加筛选  \n更多细节在后面'), '给看板加筛选');
});

test('deriveTaskName collapses internal whitespace on the picked line', () => {
  assert.equal(deriveTaskName('fix    the\tlogin\t bug'), 'fix the login bug');
});

test('deriveTaskName truncates long lines to 50 chars with an ellipsis', () => {
  const long = 'a'.repeat(80);
  const out = deriveTaskName(long);
  assert.equal(out, `${'a'.repeat(50)}…`);
  // The ellipsis is one extra glyph on top of the 50-char cap.
  assert.equal([...out].length, 51);
});

test('deriveTaskName returns empty string for blank input', () => {
  assert.equal(deriveTaskName('   \n\t '), '');
  assert.equal(deriveTaskName(''), '');
});
