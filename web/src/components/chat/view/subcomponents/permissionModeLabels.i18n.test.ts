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
      assert.equal(typeof value, 'string', `${mode}: ${key} is missing from en/chat.json`);
      assert.ok((value as string).trim().length > 0, `${mode}: ${key} resolves to an empty string`);
    }
  }
});
