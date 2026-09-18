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
  for (const [mode, { shortKey }] of Object.entries(LABEL_KEYS)) {
    const value = resolveKey(bundle, shortKey);
    assert.equal(typeof value, 'string', `${mode}: ${shortKey} is missing or not a string`);
    assert.ok(
      (value as string).length <= MAX_SHORT_LABEL_LENGTH,
      `${mode}: short label "${String(value)}" is ${(value as string).length} chars, over the ${MAX_SHORT_LABEL_LENGTH}-char budget`,
    );
  }
});

// Every short label is an abbreviation of its full label — each one is a
// substring of the other. That is what makes a short label recognisable as the
// same mode, and it catches an edit the other tests structurally cannot: swapping
// two modes' shortKeys in BOTH this repo's LABEL_KEYS and the sibling test's
// EXPECTED table keeps deepEqual green, keeps every key resolvable, and keeps
// every value inside the length budget — while the UI shows the wrong mode name.
test('each short label is a substring of its full label', () => {
  const bundle = JSON.parse(readFileSync(CHAT_BUNDLE, 'utf8')) as Record<string, unknown>;
  for (const [mode, { shortKey, fullKey }] of Object.entries(LABEL_KEYS)) {
    const short = resolveKey(bundle, shortKey);
    const full = resolveKey(bundle, fullKey);
    assert.equal(typeof short, 'string', `${mode}: ${shortKey} is missing or not a string`);
    assert.equal(typeof full, 'string', `${mode}: ${fullKey} is missing or not a string`);
    assert.ok(
      (full as string).includes(short as string),
      `${mode}: short label "${String(short)}" is not a substring of full label "${String(full)}"`,
    );
  }
});
