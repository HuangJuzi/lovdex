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
import { QoderSessionsProvider } from '@/modules/providers/list/qoder/qoder-sessions.provider.js';

/** Qoder remote history branch: same routing + shared decode as claude. */
const REMOTE_PATH = '/home/sophgo/qoder-project';
const REMOTE_SID = 'qoder-b6ae0b4b-dcee-430a-aae0-43166ca8ff5c';

const transcriptRecords = [
  {
    type: 'user',
    sessionId: REMOTE_SID,
    cwd: REMOTE_PATH,
    timestamp: '2026-08-19T10:17:37.000Z',
    message: { role: 'user', content: '帮我改 qoder 配置' },
  },
  {
    type: 'assistant',
    sessionId: REMOTE_SID,
    timestamp: '2026-08-19T10:17:38.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '好的，我看一下。' }] },
  },
];

test('qoder fetchHistory routes to session/messages and normalizes the remote transcript', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'qoder-remote-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const APP_SESSION_ID = 'app-qoder-remote-1';
    sessionsDb.createAppSession(APP_SESSION_ID, 'qoder', REMOTE_PATH, false);
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, REMOTE_SID);

    refreshRemoteProjectsIndex([{ project_path: REMOTE_PATH, remote_host_id: 'host-2' }]);
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
      const provider = new QoderSessionsProvider();
      const result = await provider.fetchHistory(APP_SESSION_ID, {
        providerSessionId: REMOTE_SID,
        projectPath: REMOTE_PATH,
        limit: null,
        offset: 0,
      });

      assert.ok(result.messages.length > 0, 'remote qoder transcript is decoded');
      assert.equal(result.messages.filter((m) => m.kind === 'text').length, 2);
      assert.deepEqual(rpcCall, {
        hostId: 'host-2',
        provider: 'qoder',
        providerSessionId: REMOTE_SID,
        projectPath: REMOTE_PATH,
      });
    } finally {
      refreshRemoteProjectsIndex([]);
    }
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
  }
});