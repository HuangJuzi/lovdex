import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';

import { ClaudeProviderModels } from '../claude-models.provider.js';

const APP_SESSION_ID = 'app-session-123';
const CLI_SESSION_ID = 'cli-session-456';

test('getCurrentActiveModel matches transcript events by provider_session_id', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'lovdex-claude-models-'));
  const jsonlPath = path.join(tempDir, `${CLI_SESSION_ID}.jsonl`);
  // Real transcripts: the newest event is last; events carry the CLI/provider
  // session id, and trailing control events carry no model at all.
  writeFileSync(
    jsonlPath,
    [
      JSON.stringify({
        sessionId: CLI_SESSION_ID,
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }], model: 'DeepSeek-V4-Flash-0731' },
      }),
      JSON.stringify({ type: 'last-prompt' }),
      JSON.stringify({ type: 'mode' }),
    ].join('\n'),
    'utf8',
  );

  const originalGetSessionById = sessionsDb.getSessionById;
  sessionsDb.getSessionById = () =>
    ({
      session_id: APP_SESSION_ID,
      provider: 'claude',
      provider_session_id: CLI_SESSION_ID,
      project_path: '/tmp',
      jsonl_path: jsonlPath,
      custom_name: null,
      summary: null,
      isArchived: 0,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    }) as never;

  try {
    const provider = new ClaudeProviderModels();
    const result = await provider.getCurrentActiveModel(APP_SESSION_ID);
    assert.equal(result.model, 'DeepSeek-V4-Flash-0731');
  } finally {
    sessionsDb.getSessionById = originalGetSessionById;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getCurrentActiveModel falls back to default when transcript has no model', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'lovdex-claude-models-'));
  const jsonlPath = path.join(tempDir, `${CLI_SESSION_ID}.jsonl`);
  writeFileSync(
    jsonlPath,
    JSON.stringify({
      sessionId: CLI_SESSION_ID,
      type: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
    }),
    'utf8',
  );

  const originalGetSessionById = sessionsDb.getSessionById;
  sessionsDb.getSessionById = () =>
    ({
      session_id: APP_SESSION_ID,
      provider: 'claude',
      provider_session_id: CLI_SESSION_ID,
      project_path: '/tmp',
      jsonl_path: jsonlPath,
      custom_name: null,
      summary: null,
      isArchived: 0,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    }) as never;

  try {
    const provider = new ClaudeProviderModels();
    const result = await provider.getCurrentActiveModel(APP_SESSION_ID);
    assert.equal(result.model, 'default');
  } finally {
    sessionsDb.getSessionById = originalGetSessionById;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
