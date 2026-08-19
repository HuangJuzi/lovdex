import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTerminalSocketUrl } from './terminalSocketUrl';

// buildWebSocketUrl falls back to window.location when API_BASE_URL is '' (it
// is, in this repo) — stub a fake location so the pure function is testable
// without a DOM. API_BASE_URL is '' at import time, so the ws base here is
// derived from this stub deterministically.
(globalThis as { window?: unknown }).window = {
  location: { protocol: 'http:', host: 'lovdex:5187' },
};

test('builds a plain /ws/terminal url when no cwd or hostId', () => {
  assert.equal(buildTerminalSocketUrl('tok', null, null), 'ws://lovdex:5187/ws/terminal?token=tok');
});

test('appends cwd when present', () => {
  const url = buildTerminalSocketUrl(null, '/home/u/proj', null);
  assert.equal(url, 'ws://lovdex:5187/ws/terminal?cwd=%2Fhome%2Fu%2Fproj');
});

test('appends hostId when present', () => {
  const url = buildTerminalSocketUrl(null, '/r/proj', 'h1');
  assert.equal(url, 'ws://lovdex:5187/ws/terminal?cwd=%2Fr%2Fproj&hostId=h1');
});
