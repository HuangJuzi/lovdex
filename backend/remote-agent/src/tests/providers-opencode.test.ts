import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseOpenCodeJsonLine,
  probeOpenCodeInstalled,
  resolveOpenCodeBinary,
  resolveOpenCodeCwd,
  resolveOpenCodePermissionOptions,
  type OpenCodeParseState,
} from '../providers/opencode-runner.js';

function makeState(sessionId: string | null = null): OpenCodeParseState {
  return { sessionId, textByMessage: new Map() };
}

test('parses an opencode NDJSON text frame into a stream_delta', () => {
  const line = JSON.stringify({
    type: 'text',
    part: { type: 'text', id: 'm1', messageID: 'm1', text: 'hi' },
    sessionID: 's1',
  });
  const msgs = parseOpenCodeJsonLine(line, makeState());
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'stream_delta');
  assert.equal(msgs[0].content, 'hi');
  assert.equal(msgs[0].provider, 'opencode');
  assert.equal(msgs[0].sessionId, 's1');
});

test('delta streaming accumulates per-message text', () => {
  const state = makeState(null);
  const first = parseOpenCodeJsonLine(JSON.stringify({
    type: 'text',
    part: { type: 'text', id: 'm2', text: 'Hel' },
  }), state);
  assert.equal(first[0]?.content, 'Hel');

  const second = parseOpenCodeJsonLine(JSON.stringify({
    type: 'text',
    part: { type: 'text', id: 'm2', text: 'Hello' },
  }), state);
  assert.equal(second[0]?.content, 'lo');
  assert.equal(state.textByMessage.get('m2'), 'Hello');
});

test('step_finish emits stream_end and token_budget status', () => {
  const state = makeState('s1');
  state.textByMessage.set('m3', 'done');
  const msgs = parseOpenCodeJsonLine(JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', id: 'm3', tokens: { input: 10, output: 5, total: 15 } },
    sessionID: 's1',
  }), state);
  const kinds = msgs.map((m) => m.kind);
  assert.ok(kinds.includes('stream_end'));
  const status = msgs.find((m) => m.kind === 'status');
  assert.equal(status?.text, 'token_budget');
  assert.deepEqual(status?.tokenBudget, { used: 15, inputTokens: 10, outputTokens: 5, breakdown: { input: 10, output: 5 } });
  assert.equal(state.textByMessage.has('m3'), false);
});

test('malformed NDJSON line yields no messages', () => {
  assert.deepEqual(parseOpenCodeJsonLine('not json', makeState()), []);
});

test('permission-mode maps to opencode run flags', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), { args: ['--agent', 'plan'], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), { args: ['--auto'], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } });
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions(undefined), { args: [], env: {} });
});

test('resolveOpenCodeBinary honors explicit bin and OPENCODE_BIN over PATH probe', () => {
  assert.equal(resolveOpenCodeBinary({ bin: '/custom/opencode' }), '/custom/opencode');
  const prev = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = '/usr/local/bin/oc';
  try {
    assert.equal(resolveOpenCodeBinary(), '/usr/local/bin/oc');
    // explicit bin still wins over env
    assert.equal(resolveOpenCodeBinary({ bin: 'bin-flag' }), 'bin-flag');
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = prev;
  }
});

test('resolveOpenCodeBinary falls back to sophcode when opencode is unavailable', () => {
  assert.equal(resolveOpenCodeBinary({ opencodeAvailable: false }), 'sophcode');
  assert.equal(resolveOpenCodeBinary({ opencodeAvailable: true }), 'opencode');
});

test('probeOpenCodeInstalled detects a real binary without throwing', () => {
  // Never asserts the binary is there — just that probing never throws.
  assert.equal(typeof probeOpenCodeInstalled(), 'boolean');
});

test('resolveOpenCodeCwd uses the validated cwd as-is (no DB fallback in lite)', () => {
  assert.equal(resolveOpenCodeCwd('s1', '/tmp/work'), '/tmp/work');
  assert.equal(resolveOpenCodeCwd('s1', ''), process.cwd());
  assert.equal(resolveOpenCodeCwd(null, undefined), process.cwd());
});