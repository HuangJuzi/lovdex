import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SessionProviderLogo from './SessionProviderLogo';

// Claude's mark is the only one with this viewBox, so it doubles as the
// "fell through to the Claude default" fingerprint.
const CLAUDE_VIEWBOX = 'viewBox="0 0 512 509.64"';

test('renders the DSH mark for provider="dsh"', () => {
  const html = renderToStaticMarkup(<SessionProviderLogo provider="dsh" />);
  assert.match(html, /aria-label="DeepSeek"/i);
  assert.doesNotMatch(html, new RegExp(CLAUDE_VIEWBOX));
});

test('keeps the Claude fallback for unknown providers', () => {
  const html = renderToStaticMarkup(<SessionProviderLogo provider="someone-else" />);
  assert.match(html, new RegExp(CLAUDE_VIEWBOX));
});
