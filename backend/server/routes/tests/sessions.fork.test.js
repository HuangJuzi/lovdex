import assert from 'node:assert/strict';
import test from 'node:test';
import { forkAppSession } from '../sessions.js';

const baseRow = {
  session_id: 'app1', provider: 'claude', provider_session_id: 'prov1',
  project_path: '/p', custom_name: 'Orig', summary: 's',
};

function deps(overrides = {}) {
  return {
    sessionsDb: {
      getSessionById: () => baseRow,
      createAppSession: () => 'app2',
      updateSessionCustomName: () => {},
      assignProviderSessionId: () => {},
    },
    chatRunRegistry: { isProcessing: () => false },
    forkSession: async () => ({ sessionId: 'prov2' }),
    ...overrides,
  };
}

test('fork creates a new app session and returns its id', async () => {
  const names = [];
  const d = deps({
    sessionsDb: {
      getSessionById: () => baseRow,
      createAppSession: () => 'app2',
      updateSessionCustomName: (_id, name) => { names.push(name); },
      assignProviderSessionId: () => {},
    },
  });
  const { status, body } = await forkAppSession(d, 'app1', { upToMessageId: 'm3', suffix: 'fork' });
  assert.equal(status, 200);
  assert.equal(body.newSessionId, 'app2');
  assert.equal(body.providerSessionId, 'prov2');
  assert.match(names[0], /fork/);
});

test('fork 409 when session has no provider_session_id yet', async () => {
  const d = deps({
    sessionsDb: {
      getSessionById: () => ({ ...baseRow, provider_session_id: null }),
      createAppSession: () => 'x', updateSessionCustomName: () => {}, assignProviderSessionId: () => {},
    },
  });
  const { status, body } = await forkAppSession(d, 'app1', { suffix: 'fork' });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'SESSION_NOT_STARTED');
});

test('fork 409 for unsupported provider (codex)', async () => {
  const d = deps({
    sessionsDb: {
      getSessionById: () => ({ ...baseRow, provider: 'codex' }),
      createAppSession: () => 'x', updateSessionCustomName: () => {}, assignProviderSessionId: () => {},
    },
  });
  const { status, body } = await forkAppSession(d, 'app1', { suffix: 'fork' });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'UNSUPPORTED_PROVIDER');
});

test('fork 409 when a run is in progress', async () => {
  const d = deps({ chatRunRegistry: { isProcessing: () => true } });
  const { status, body } = await forkAppSession(d, 'app1', { suffix: 'fork' });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'RUN_IN_PROGRESS');
});

test('fork propagates is_operator to the forked app session', async () => {
  const seen = [];
  const d = deps({
    sessionsDb: {
      getSessionById: () => ({ ...baseRow, is_operator: 1 }),
      createAppSession: (...args) => { seen.push(args); return 'app2'; },
      updateSessionCustomName: () => {},
      assignProviderSessionId: () => {},
    },
  });
  const { status } = await forkAppSession(d, 'app1', { suffix: 'fork' });
  assert.equal(status, 200);
  assert.deepEqual(seen, [['claude', '/p', true]]);
});

test('fork passes false is_operator for a regular session', async () => {
  const seen = [];
  const d = deps({
    sessionsDb: {
      getSessionById: () => ({ ...baseRow, is_operator: 0 }),
      createAppSession: (...args) => { seen.push(args); return 'app2'; },
      updateSessionCustomName: () => {},
      assignProviderSessionId: () => {},
    },
  });
  const { status } = await forkAppSession(d, 'app1', { suffix: 'fork' });
  assert.equal(status, 200);
  assert.deepEqual(seen, [['claude', '/p', false]]);
});
