import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { refreshRemoteProjectsIndex } from '@/modules/remote-agents/remote-projects.index.js';
import { setRemoteAgentsRuntime } from '@/modules/remote-agents/runtime.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Remote history branch: fetchHistory for a session whose project path resolves
 * to a remote host must pull the transcript via the `session/messages` RPC and
 * run it through the SAME normalization pipeline the local file path uses.
 * Regression for "远程机器上的 session 历史消息加载不出来" — Phase 1 shipped
 * without a lite `session/messages` handler, so remote sessions rendered empty.
 */

const REMOTE_PATH = '/home/sophgo/workpath/dockerfile_2204';
const REMOTE_SID = '484297d7-56b4-45c1-84ae-ef3bcc876602';

const transcriptRecords = [
  {
    type: 'user',
    sessionId: REMOTE_SID,
    cwd: REMOTE_PATH,
    timestamp: '2026-08-19T22:26:24.000Z',
    message: { role: 'user', content: '构建这个 dockerfile' },
  },
  {
    type: 'assistant',
    sessionId: REMOTE_SID,
    timestamp: '2026-08-19T22:26:25.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '好的，开始构建。' }] },
  },
];

function setupDb(work: () => Promise<void>): Promise<void> {
  return (async () => {
    const previousDatabasePath = process.env.DATABASE_PATH;
    const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'claude-remote-db-'));
    closeConnection();
    process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
    await initializeDatabase();
    try {
      await work();
    } finally {
      closeConnection();
      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  })();
}

test('fetchHistory routes to session/messages and normalizes the remote transcript', async () => {
  await setupDb(async () => {
    const APP_SESSION_ID = 'app-remote-1';
    sessionsDb.createAppSession(APP_SESSION_ID, 'claude', REMOTE_PATH, false);
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, REMOTE_SID);

    refreshRemoteProjectsIndex([{ project_path: REMOTE_PATH, remote_host_id: 'host-1' }]);
    let rpcCall: Record<string, unknown> | null = null;
    const historyClient = {
      fetchMessages: async (hostId: string, params: Record<string, unknown>) => {
        rpcCall = { hostId, ...params };
        return {
          transcript: transcriptRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
          agentFiles: {},
        };
      },
    };
    setRemoteAgentsRuntime({
      registry: {} as never,
      fsClient: {} as never,
      historyClient: historyClient as never,
    });

    try {
      const provider = new ClaudeSessionsProvider();
      const result = await provider.fetchHistory(APP_SESSION_ID, {
        providerSessionId: REMOTE_SID,
        projectPath: REMOTE_PATH,
        limit: null,
        offset: 0,
      });

      assert.ok(result.messages.length > 0, 'remote transcript is decoded');
      assert.equal(result.messages.filter((m) => m.kind === 'text').length, 2);
      assert.deepEqual(rpcCall, {
        hostId: 'host-1',
        provider: 'claude',
        providerSessionId: REMOTE_SID,
        projectPath: REMOTE_PATH,
      });
    } finally {
      refreshRemoteProjectsIndex([]);
    }
  });
});

test('fetchHistory returns empty without crashing when the remote rpc fails', async () => {
  await setupDb(async () => {
    const APP_SESSION_ID = 'app-remote-2';
    sessionsDb.createAppSession(APP_SESSION_ID, 'claude', REMOTE_PATH, false);
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, REMOTE_SID);

    refreshRemoteProjectsIndex([{ project_path: REMOTE_PATH, remote_host_id: 'host-1' }]);
    const historyClient = {
      fetchMessages: async () => {
        throw new Error('remote host offline: host-1');
      },
    };
    setRemoteAgentsRuntime({
      registry: {} as never,
      fsClient: {} as never,
      historyClient: historyClient as never,
    });

    try {
      const provider = new ClaudeSessionsProvider();
      const result = await provider.fetchHistory(APP_SESSION_ID, {
        providerSessionId: REMOTE_SID,
        projectPath: REMOTE_PATH,
        limit: null,
        offset: 0,
      });

      assert.equal(result.messages.length, 0);
      assert.equal(result.total, 0);
    } finally {
      refreshRemoteProjectsIndex([]);
    }
  });
});