import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';

import { createProviderModelsService } from '../provider-models.service.js';

const APP_SESSION_ID = 'app-session-123';
const PROVIDER_SESSION_ID = 'cli-session-456';

const writePendingChangeFile = (filePath: string, model: string): void => {
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        entries: {
          [`claude:${APP_SESSION_ID}`]: {
            provider: 'claude',
            sessionId: APP_SESSION_ID,
            supported: true,
            changed: true,
            model,
            updatedAt: '2026-08-10T03:01:03.191Z',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
};

test('resolveResumeModel applies a pending model change keyed by app session id', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'lovdex-resume-model-'));
  const changesPath = path.join(tempDir, 'provider-session-active-model-changes.json');
  writePendingChangeFile(changesPath, 'opus');

  const originalGetSessionByProviderSessionId = sessionsDb.getSessionByProviderSessionId;
  // The runtime passes the provider-native id; the app row links it back to the
  // app session id that the pending change is keyed by.
  sessionsDb.getSessionByProviderSessionId = () =>
    ({
      session_id: APP_SESSION_ID,
      provider: 'claude',
      provider_session_id: PROVIDER_SESSION_ID,
      project_path: '/tmp',
      jsonl_path: '/tmp/none.jsonl',
      custom_name: null,
      summary: null,
      isArchived: 0,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    }) as never;

  try {
    const service = createProviderModelsService({ activeModelChangesPath: changesPath });
    const resolved = await service.resolveResumeModel('claude', PROVIDER_SESSION_ID, 'default');
    assert.equal(resolved, 'opus');
  } finally {
    sessionsDb.getSessionByProviderSessionId = originalGetSessionByProviderSessionId;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveResumeModel falls back to requested model when no pending change exists', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'lovdex-resume-model-'));
  const changesPath = path.join(tempDir, 'provider-session-active-model-changes.json');
  writeFileSync(changesPath, JSON.stringify({ version: 1, entries: {} }), 'utf8');

  const originalGetSessionByProviderSessionId = sessionsDb.getSessionByProviderSessionId;
  sessionsDb.getSessionByProviderSessionId = () => null;

  try {
    const service = createProviderModelsService({ activeModelChangesPath: changesPath });
    const resolved = await service.resolveResumeModel('claude', PROVIDER_SESSION_ID, 'sonnet');
    assert.equal(resolved, 'sonnet');
  } finally {
    sessionsDb.getSessionByProviderSessionId = originalGetSessionByProviderSessionId;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
