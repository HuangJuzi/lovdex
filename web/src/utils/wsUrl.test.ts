import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWebSocketUrl } from './wsUrl';

// node:test has no browser window; the same-origin branch needs one.
(globalThis as { window?: unknown }).window = {
  location: { protocol: 'https:' as string, host: 'lovdex.example.com' },
};

test('same-origin URL with token appends ?token=', () => {
  assert.equal(buildWebSocketUrl('abc.def.ghi'), 'wss://lovdex.example.com/ws?token=abc.def.ghi');
});

test('same-origin URL without a token is bare', () => {
  assert.equal(buildWebSocketUrl(null), 'wss://lovdex.example.com/ws');
});

test('token is URL-encoded', () => {
  assert.equal(buildWebSocketUrl('a/b+c'), 'wss://lovdex.example.com/ws?token=a%2Fb%2Bc');
});

test('custom pathname is honored', () => {
  assert.equal(buildWebSocketUrl('abc', '/ws/terminal'), 'wss://lovdex.example.com/ws/terminal?token=abc');
});

test('pathname defaults to /ws', () => {
  assert.equal(buildWebSocketUrl('abc'), 'wss://lovdex.example.com/ws?token=abc');
});
