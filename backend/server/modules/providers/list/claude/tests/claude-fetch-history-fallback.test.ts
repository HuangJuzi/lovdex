import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import {
  ClaudeSessionsProvider,
  resolveClaudeTranscriptPath,
} from '@/modules/providers/list/claude/claude-sessions.provider.js';

// ── Path encoding: project cwd → ~/.claude/projects directory name ──────
test('resolveClaudeTranscriptPath encodes the project path like Claude Code', async () => {
  const claudeHome = await mkdtemp(path.join(tmpdir(), 'claude-home-'));
  try {
    const projectDir = path.join(claudeHome, 'projects', '-mnt-b-workdir-gitlab-demo');
    await mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'provider-1.jsonl');
    await writeFile(jsonlPath, '{}\n', 'utf8');

    const resolved = resolveClaudeTranscriptPath(
      '/mnt/b/workdir/gitlab.demo',
      'provider-1',
      claudeHome,
    );
    assert.equal(resolved, jsonlPath);
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test('resolveClaudeTranscriptPath returns null for a missing transcript', async () => {
  const claudeHome = await mkdtemp(path.join(tmpdir(), 'claude-home-'));
  try {
    assert.equal(
      resolveClaudeTranscriptPath('/mnt/b/workdir/gitlab/demo', 'provider-404', claudeHome),
      null,
    );
    assert.equal(resolveClaudeTranscriptPath('', 'provider-1', claudeHome), null);
    assert.equal(resolveClaudeTranscriptPath('/p', '', claudeHome), null);
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
});

// ── fetchHistory fallback: jsonl_path NULL on the app row ───────────────
// Regression for "创建任务 → 开始执行 → 打开会话是空的": app-created session
// rows only get jsonl_path through the disk-watcher index. A run whose
// transcript was never indexed left it NULL and fetchHistory returned an
// empty conversation even though the provider session existed on disk.
test('fetchHistory derives the transcript path when jsonl_path is NULL and backfills the row', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'claude-fallback-db-'));
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'claude-fallback-home-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  const APP_SESSION_ID = 'app-sess-1';
  const PROVIDER_SESSION_ID = 'provider-sess-1';
  const PROJECT_PATH = '/mnt/b/workdir/gitlab/sophclaw-client';

  const transcriptRecords = [
    {
      type: 'user',
      message: { role: 'user', content: '执行以下任务：/help 里面没有弹出所有的命令和skill' },
      sessionId: PROVIDER_SESSION_ID,
      cwd: PROJECT_PATH,
      timestamp: '2026-08-15T03:15:25.000Z',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来排查。' }] },
      sessionId: PROVIDER_SESSION_ID,
      timestamp: '2026-08-15T03:15:26.000Z',
    },
  ];

  try {
    // App row as startExecution creates it: provider_session_id recorded
    // mid-run, jsonl_path never backfilled by the watcher.
    sessionsDb.createAppSession(APP_SESSION_ID, 'claude', PROJECT_PATH, false);
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, PROVIDER_SESSION_ID);
    assert.equal(sessionsDb.getSessionById(APP_SESSION_ID)?.jsonl_path, null);

    const projectDir = path.join(
      fakeHome,
      '.claude',
      'projects',
      '-mnt-b-workdir-gitlab-sophclaw-client',
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`),
      transcriptRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    process.env.HOME = fakeHome;
    const provider = new ClaudeSessionsProvider();
    const result = await provider.fetchHistory(APP_SESSION_ID, {
      providerSessionId: PROVIDER_SESSION_ID,
      projectPath: PROJECT_PATH,
      limit: null,
      offset: 0,
    });

    assert.ok(result.messages.length > 0, 'fallback loads the on-disk transcript');
    assert.ok(result.messages.some((m) => m.kind === 'text'));
    assert.equal(
      sessionsDb.getSessionById(APP_SESSION_ID)?.jsonl_path,
      path.join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`),
      'the resolved path is persisted back onto the row',
    );
  } finally {
    process.env.HOME = previousHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

// Sanity: without a derivable transcript the result stays empty (no crash),
// matching the pre-fallback behavior for genuinely transcript-less sessions.
test('fetchHistory still returns empty when no transcript exists anywhere', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'claude-empty-db-'));
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'claude-empty-home-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession('app-sess-2', 'claude', '/mnt/b/workdir/gitlab/nope', false);
    sessionsDb.assignProviderSessionId('app-sess-2', 'provider-sess-2');

    process.env.HOME = fakeHome;
    const provider = new ClaudeSessionsProvider();
    const result = await provider.fetchHistory('app-sess-2', {
      providerSessionId: 'provider-sess-2',
      projectPath: '/mnt/b/workdir/gitlab/nope',
      limit: null,
      offset: 0,
    });

    assert.deepEqual(result.messages, []);
    assert.equal(result.total, 0);
    assert.equal(os.homedir(), fakeHome);
  } finally {
    process.env.HOME = previousHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
