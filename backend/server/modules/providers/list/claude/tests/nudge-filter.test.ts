import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * The Claude Code CLI injects a synthetic user turn
 *   "[Your previous response had no visible output. Please continue ...]"
 * whenever an assistant turn produces only a thinking block. Third-party
 * reasoning models (DeepSeek/Kimi/GLM via the proxy) trigger this constantly.
 * It is an internal control prompt, never a real user message, so it must not
 * surface in the chat transcript — on either the live SDK stream (tagged
 * isSynthetic, NOT isMeta) or the replayed history (tagged isMeta).
 */
const provider = new ClaudeSessionsProvider();
const SID = 'sess-nudge';
const NUDGE = '[Your previous response had no visible output. Please continue and produce a user-visible response.]';

test('live SDK stream: string-content nudge (isSynthetic) is filtered', () => {
  const raw = {
    type: 'user',
    isSynthetic: true,
    message: { role: 'user', content: NUDGE },
    session_id: SID,
    timestamp: '2026-08-19T09:00:00.000Z',
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('history replay: string-content nudge (isMeta) is filtered', () => {
  const raw = {
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: NUDGE },
    uuid: 'u1',
    session_id: SID,
    timestamp: '2026-08-19T09:00:01.000Z',
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('nudge with no meta flag at all is still filtered by content prefix', () => {
  const raw = {
    type: 'user',
    message: { role: 'user', content: NUDGE },
    uuid: 'u2',
    session_id: SID,
    timestamp: '2026-08-19T09:00:02.000Z',
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('nudge delivered as a text content block is filtered', () => {
  const raw = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: NUDGE }] },
    uuid: 'u3',
    session_id: SID,
    timestamp: '2026-08-19T09:00:03.000Z',
  };
  assert.deepEqual(provider.normalizeMessage(raw, SID), []);
});

test('a genuine user message that merely mentions the phrase is NOT filtered', () => {
  const raw = {
    type: 'user',
    message: { role: 'user', content: '为什么老是出现 no visible output 这句话？' },
    uuid: 'u4',
    session_id: SID,
    timestamp: '2026-08-19T09:00:04.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].role, 'user');
});

test('an ordinary user message is unaffected', () => {
  const raw = {
    type: 'user',
    message: { role: 'user', content: '帮我修一下这个 bug' },
    uuid: 'u5',
    session_id: SID,
    timestamp: '2026-08-19T09:00:05.000Z',
  };
  const out = provider.normalizeMessage(raw, SID);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '帮我修一下这个 bug');
});