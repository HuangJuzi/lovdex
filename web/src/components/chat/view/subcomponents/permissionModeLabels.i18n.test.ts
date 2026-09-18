import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LABEL_KEYS } from './permissionModeLabels';

// LABEL_KEYS and its sibling test's EXPECTED table are both hand-written copies
// of the same strings, so a typo present in both would pass those tests while the
// UI renders the raw key. Resolving every key against the bundle the app actually
// loads is what closes that hole.
const CHAT_BUNDLE = fileURLToPath(new URL('../../../../i18n/locales/en/chat.json', import.meta.url));

const resolveKey = (root: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>(
    (node, part) => (node as Record<string, unknown> | undefined)?.[part],
    root,
  );

test('every permission-mode label key exists in the en chat bundle', () => {
  const bundle = JSON.parse(readFileSync(CHAT_BUNDLE, 'utf8')) as Record<string, unknown>;
  for (const [mode, { shortKey, fullKey }] of Object.entries(LABEL_KEYS)) {
    for (const key of [shortKey, fullKey]) {
      const value = resolveKey(bundle, key);
      assert.equal(typeof value, 'string', `${mode}: ${key} is missing or not a string`);
      assert.ok((value as string).trim().length > 0, `${mode}: ${key} resolves to an empty string`);
    }
  }
});

// The whole point of the short labels is that the composer footer does not wrap
// at 375px. Nothing else asserts that property — the sibling test pins key
// strings, not values — so without this a future edit could set
// modesShort.bypassPermissions back to "Bypass Permissions" and every other
// check would stay green while the phone UI regressed.
const MAX_SHORT_LABEL_LENGTH = 7;

test('short labels stay short enough not to wrap the composer footer', () => {
  const bundle = JSON.parse(readFileSync(CHAT_BUNDLE, 'utf8')) as Record<string, unknown>;
  for (const mode of Object.keys(LABEL_KEYS)) {
    const value = resolveKey(bundle, `codex.modesShort.${mode}`);
    assert.equal(typeof value, 'string', `${mode}: codex.modesShort.${mode} is missing or not a string`);
    assert.ok(
      (value as string).length <= MAX_SHORT_LABEL_LENGTH,
      `${mode}: short label "${String(value)}" is ${(value as string).length} chars, over the ${MAX_SHORT_LABEL_LENGTH}-char budget`,
    );
  }
});
