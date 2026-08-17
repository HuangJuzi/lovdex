import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  parseOpenCodeJsonLine,
  probeOpenCodeInstalled,
  resolveOpenCodeBinary,
  resolveOpenCodeCwd,
  resolveOpenCodePermissionOptions,
} from '@/opencode-runner.js';

test('opencode runner maps permission modes to CLI flags', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), { args: ['--agent', 'plan'], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), { args: ['--auto'], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) },
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
});

test('opencode runner parses a text event into a stream delta', () => {
  const state = { textByMessage: new Map(), sessionId: null };
  const line = JSON.stringify({
    type: 'text',
    sessionID: 'ses1',
    part: { type: 'text', text: 'hello', messageID: 'msg1' },
  });
  const events = parseOpenCodeJsonLine(line, state);
  assert.ok(events.length >= 1);
  assert.equal(events[0].kind, 'stream_delta');
  assert.equal(events[0].content, 'hello');
  assert.equal(events[0].provider, 'opencode');
});

test('opencode runner emits token budget and stream_end on step_finish', () => {
  const state = { textByMessage: new Map([['msg1', 'hello']]), sessionId: 'ses1' };
  const line = JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses1',
    part: {
      type: 'step-finish',
      messageID: 'msg1',
      reason: 'stop',
      tokens: { total: 100, input: 80, output: 20 },
    },
  });
  const events = parseOpenCodeJsonLine(line, state);
  assert.equal(events[0].kind, 'stream_end');
  const budget = events[1];
  assert.equal(budget.kind, 'status');
  assert.equal(budget.text, 'token_budget');
  assert.equal(budget.tokenBudget.used, 100);
  assert.equal(budget.tokenBudget.inputTokens, 80);
  assert.equal(budget.tokenBudget.outputTokens, 20);
});

test('opencode runner ignores malformed json lines', () => {
  const state = { textByMessage: new Map(), sessionId: null };
  const events = parseOpenCodeJsonLine('not-json', state);
  assert.deepEqual(events, []);
});

test('opencode runner resolves cwd from the session directory when cwd is empty', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runner-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT);
    INSERT INTO session (id, directory, path) VALUES
      ('ses_1', '/mnt/b/workdir/gitlab/moltbot', ''),
      ('ses_2', '/mnt/b/workdir/gitlab/backend', 'apps/api');
  `);
  db.close();

  const originalHome = os.homedir;
  os.homedir = () => tempRoot;
  try {
    // Empty cwd falls back to the session's stored directory (repo-root case).
    assert.equal(resolveOpenCodeCwd('ses_1', ''), '/mnt/b/workdir/gitlab/moltbot');
    // Empty path column still falls back to directory.
    assert.equal(resolveOpenCodeCwd('ses_2', undefined), '/mnt/b/workdir/gitlab/backend');
    // An explicit non-empty cwd always wins.
    assert.equal(resolveOpenCodeCwd('ses_1', '/explicit'), '/explicit');
    // No session id: fall back to process.cwd().
    assert.equal(resolveOpenCodeCwd(null, ''), process.cwd());
  } finally {
    os.homedir = originalHome;
  }
});

test('resolveOpenCodeBinary: env bin > opencode probe > sophcode fallback', () => {
  assert.equal(resolveOpenCodeBinary({ bin: '/opt/opencode/bin/opencode' }), '/opt/opencode/bin/opencode');
  assert.equal(resolveOpenCodeBinary({ bin: undefined, opencodeAvailable: true }), 'opencode');
  assert.equal(resolveOpenCodeBinary({ bin: undefined, opencodeAvailable: false }), 'sophcode');
});

test('resolveOpenCodeBinary trims an explicit bin path with surrounding whitespace', () => {
  assert.equal(resolveOpenCodeBinary({ bin: '  /usr/local/bin/opencode  ' }), '/usr/local/bin/opencode');
});

test('probeOpenCodeInstalled returns a boolean (real PATH probe)', () => {
  // Without OPENCODE_BIN this performs a real `opencode --version` sync probe;
  // this host has no `opencode` binary, so it is expected to be false, but we
  // only assert the type so the test is not host-dependent.
  assert.equal(typeof probeOpenCodeInstalled(), 'boolean');
});
