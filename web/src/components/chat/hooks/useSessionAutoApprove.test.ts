import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoApproveOverrideKey,
  readAutoApproveOverride,
  resolveEffectiveAutoApprove,
  writeAutoApproveOverride,
  type AutoApproveStorage,
} from './useSessionAutoApprove';

function fakeStorage(
  seed: Record<string, string> = {},
): AutoApproveStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

test('effective auto-approval is the task flag minus the session override', () => {
  assert.equal(resolveEffectiveAutoApprove(true, false), true);
  assert.equal(resolveEffectiveAutoApprove(true, true), false);
  assert.equal(resolveEffectiveAutoApprove(false, false), false);
  assert.equal(resolveEffectiveAutoApprove(false, true), false);
});

test('the override round-trips through storage, keyed by session', () => {
  const storage = fakeStorage();
  writeAutoApproveOverride('s1', true, storage);
  assert.equal(storage.data[autoApproveOverrideKey('s1')], '1');
  assert.equal(readAutoApproveOverride('s1', storage), true);
  // 另一个会话不受影响 —— 键必须是 per-session 的。
  assert.equal(readAutoApproveOverride('s2', storage), false);

  writeAutoApproveOverride('s1', false, storage);
  assert.equal(readAutoApproveOverride('s1', storage), false);
});

test('a missing or malformed stored value reads as "not overridden"', () => {
  const storage = fakeStorage({ [autoApproveOverrideKey('s1')]: 'garbage' });
  assert.equal(readAutoApproveOverride('s1', storage), false);
  assert.equal(readAutoApproveOverride('s2', storage), false);
});

test('a null session id neither reads nor writes', () => {
  const storage = fakeStorage();
  assert.equal(readAutoApproveOverride(null, storage), false);
  assert.equal(readAutoApproveOverride(undefined, storage), false);
  assert.equal(readAutoApproveOverride('', storage), false);
  writeAutoApproveOverride(null, true, storage);
  assert.deepEqual(storage.data, {});
});
