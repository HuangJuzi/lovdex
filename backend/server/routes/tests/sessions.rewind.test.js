import assert from 'node:assert/strict';
import test from 'node:test';
import { rewindAppSession } from '../sessions.js';

const baseRow = { session_id: 'app1', provider: 'claude', provider_session_id: 'prov1', project_path: '/p', custom_name: 'Orig', summary: 's' };

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
    gitRewind: { isGitRepo: async () => false, findCommitAtOrBefore: async () => null, rewindFilesToCommit: async () => true },
    ...overrides,
  };
}

test('rewind on non-git project warns and still forks', async () => {
  const { status, body } = await rewindAppSession(deps(), 'app1', { upToMessageId: 'm1', turnTimestamp: '2026-07-24T00:00:00Z' });
  assert.equal(status, 200);
  assert.equal(body.newSessionId, 'app2');
  assert.ok(body.warnings?.includes('file-rewind:not-a-git-repo'));
});

test('rewind on git repo with covering commit rewinds files', async () => {
  const rewound = [];
  const d = deps({
    gitRewind: {
      isGitRepo: async () => true,
      findCommitAtOrBefore: async () => 'c1',
      rewindFilesToCommit: async (_p, c) => { rewound.push(c); return true; },
    },
  });
  const { status, body } = await rewindAppSession(d, 'app1', { upToMessageId: 'm1', turnTimestamp: '2026-07-24T00:00:00Z' });
  assert.equal(status, 200);
  assert.deepEqual(rewound, ['c1']);
  assert.ok(!body.warnings?.length);
});

test('rewind on git repo without covering commit warns', async () => {
  const d = deps({ gitRewind: { isGitRepo: async () => true, findCommitAtOrBefore: async () => null, rewindFilesToCommit: async () => true } });
  const { status, body } = await rewindAppSession(d, 'app1', { upToMessageId: 'm1', turnTimestamp: '2026-07-24T00:00:00Z' });
  assert.equal(status, 200);
  assert.ok(body.warnings?.includes('file-rewind:no-covering-commit'));
});
