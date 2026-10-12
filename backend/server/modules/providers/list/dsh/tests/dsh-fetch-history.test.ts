import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  decodeDshSessionLog,
  findDshSessionLogFile,
  mungeDshProjectDir,
} from '@/modules/providers/list/dsh/dsh-session-log.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';

const PROJECT_PATH = '/work/delivery-skills-hub';
const PROVIDER_SESSION_ID = '82688579-fb02-42f1-9e09-9554f8725974';
const APP_SESSION_ID = '4cb815b0-17bc-48e1-ac4d-febd69e5113a';

/** One zstd frame per record, mirroring dsh's session.vN.jsonl.zstd layout. */
function compressLog(records: string[]): Buffer {
  return Buffer.concat(
    records.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))),
  );
}

function rec(type: string, seq: number, data: unknown, time = 1791774047000): string {
  return JSON.stringify({ type, seq, time, data });
}

/** The record shapes below mirror a real session.v4.jsonl.zstd dump. */
function sampleRecords(): string[] {
  return [
    rec('session', 0, { version: 4, id: PROVIDER_SESSION_ID, cwd: PROJECT_PATH }),
    rec('permission/preset', 1, { preset: 'workspace-write' }),
    rec('system/message', 2, {
      message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent...' }] },
    }),
    rec('user/message', 3, {
      content: [{ type: 'text', text: '统计一下9月份新增的skill' }],
      source: { kind: 'user' },
      role: 'user',
    }),
    // runtime-context snapshots are injected env text, not a human turn.
    rec('user/message', 4, {
      content: [{ type: 'text', text: 'Current runtime context snapshot' }],
      source: { kind: 'runtime-context' },
      role: 'user',
    }),
    rec('session/title', 5, { title: '统计一下9月份新增的skill', source: { kind: 'fallback' } }),
    rec('assistant/message', 6, {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Let me inspect the repo first.' },
          { type: 'tool-call', id: 'call_he3s', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
    }),
    // The standalone tool/call duplicates the embedded tool-call block above.
    rec('tool/call', 7, {
      turn: 1,
      step: 1,
      callId: 'call_he3s',
      name: 'bash',
      arguments: '{"command":"ls"}',
    }),
    rec('tool/result', 8, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call_he3s' },
        toolCallId: 'call_he3s',
        content: [{ type: 'text', text: 'file-a\nfile-b' }],
        isError: false,
      },
    }),
    rec('assistant/message', 9, {
      turn: 1,
      step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }),
    rec('turn/end', 10, { turn: 1, reason: { kind: 'completed' } }),
  ];
}

async function writeSessionLog(
  root: string,
  projectPath: string,
  sessionId: string,
  records: string[],
  fileName = 'session.v4.jsonl.zstd',
): Promise<string> {
  const dir = path.join(root, mungeDshProjectDir(projectPath), sessionId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  const payload = fileName.endsWith('.zstd')
    ? compressLog(records)
    : Buffer.from(records.map((line) => `${line}\n`).join(''), 'utf8');
  await writeFile(filePath, payload);
  return filePath;
}

/** Isolated temp DB + temp dsh sessions root, torn down after each run. */
async function withDshHistoryEnv(
  records: string[],
  run: (provider: DshSessionsProvider, root: string) => Promise<void>,
  options: { fileName?: string } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-fetch-history-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  const root = path.join(tempDirectory, 'sessions');
  const filePath = await writeSessionLog(
    root,
    PROJECT_PATH,
    PROVIDER_SESSION_ID,
    records,
    options.fileName,
  );

  try {
    await initializeDatabase();
    sessionsDb.createAppSession(APP_SESSION_ID, 'dsh', PROJECT_PATH);
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, PROVIDER_SESSION_ID);

    const provider = new DshSessionsProvider({ sessionsRoot: root });
    await run(provider, root);

    void filePath;
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// dsh-session-log helpers
// ---------------------------------------------------------------------------

test('mungeDshProjectDir encodes a cwd the way dsh names its session dirs', () => {
  assert.equal(
    mungeDshProjectDir('/mnt/b/workdir/gitlab/delivery-skills-hub'),
    '--mnt-b-workdir-gitlab-delivery-skills-hub--',
  );
  assert.equal(mungeDshProjectDir('/home/zhijuhuang/KYC'), '--home-zhijuhuang-KYC--');
  // A trailing slash must not add a phantom dash.
  assert.equal(mungeDshProjectDir('/home/zhijuhuang/KYC/'), '--home-zhijuhuang-KYC--');
});

test('decodeDshSessionLog reads one-record frames, multi-record frames, and skips corrupt frames', () => {
  const good = compressLog([
    rec('session', 0, { id: 'x' }),
    rec('user/message', 1, { content: [], role: 'user' }),
  ]);
  // Frame carrying TWO records in one payload (real files do this: 109 frames
  // decoding to 180 lines).
  const multi = zlib.zstdCompressSync(
    Buffer.from(`${rec('turn/start', 2, {})}\n${rec('step/start', 3, {})}\n`, 'utf8'),
  );
  const garbage = Buffer.from('this is not zstd at all, just noise');
  const tail = compressLog([rec('turn/end', 4, {})]);

  const lines = decodeDshSessionLog(Buffer.concat([good, multi, garbage, tail]));

  const seqs = lines.map((line) => (JSON.parse(line) as { seq: number }).seq);
  assert.deepEqual(seqs, [0, 1, 2, 3, 4]);
});

test('decodeDshSessionLog passes a plain (compression:none) JSONL buffer through', () => {
  const plain = Buffer.from(`${rec('session', 0, {})}\n${rec('turn/end', 1, {})}\n`, 'utf8');
  const lines = decodeDshSessionLog(plain);
  assert.equal(lines.length, 2);
});

test('findDshSessionLogFile resolves the exact project dir, prefers the highest version', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-find-log-'));
  try {
    const root = path.join(tempDirectory, 'sessions');
    const dir = path.join(root, mungeDshProjectDir(PROJECT_PATH), PROVIDER_SESSION_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.lock'), '');
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), compressLog([rec('session', 0, {})]));

    const found = await findDshSessionLogFile(root, PROJECT_PATH, PROVIDER_SESSION_ID);
    assert.equal(found, path.join(dir, 'session.v4.jsonl.zstd'));

    // A newer version wins; session.lock is never a candidate.
    await writeFile(path.join(dir, 'session.v5.jsonl.zstd'), compressLog([rec('session', 0, {})]));
    const foundV5 = await findDshSessionLogFile(root, PROJECT_PATH, PROVIDER_SESSION_ID);
    assert.equal(foundV5, path.join(dir, 'session.v5.jsonl.zstd'));

    // A plain session.vN.jsonl (compression: none deployments) is also valid.
    await writeFile(path.join(dir, 'session.v6.jsonl'), Buffer.from('{}\n', 'utf8'));
    const foundV6 = await findDshSessionLogFile(root, PROJECT_PATH, PROVIDER_SESSION_ID);
    assert.equal(foundV6, path.join(dir, 'session.v6.jsonl'));

    // Unknown session id resolves to null, not a throw.
    assert.equal(await findDshSessionLogFile(root, PROJECT_PATH, 'no-such-id'), null);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('findDshSessionLogFile falls back to scanning all project dirs when projectPath misses', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-find-scan-'));
  try {
    const root = path.join(tempDirectory, 'sessions');
    await writeSessionLog(root, '/somewhere/else', PROVIDER_SESSION_ID, [rec('session', 0, {})]);

    // Wrong project path (e.g. DB row drifted from the real cwd) still finds
    // the session by its provider-native id.
    const found = await findDshSessionLogFile(root, '/a/different/path', PROVIDER_SESSION_ID);
    assert.equal(
      found,
      path.join(root, mungeDshProjectDir('/somewhere/else'), PROVIDER_SESSION_ID, 'session.v4.jsonl.zstd'),
    );

    // And a null projectPath takes the scan path directly.
    const foundNull = await findDshSessionLogFile(root, null, PROVIDER_SESSION_ID);
    assert.equal(foundNull, found);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DshSessionsProvider.fetchHistory
// ---------------------------------------------------------------------------

test('fetchHistory replays the full conversation from the zstd session log', async () => {
  await withDshHistoryEnv(sampleRecords(), async (provider) => {
    const result = await provider.fetchHistory(APP_SESSION_ID, {
      projectPath: PROJECT_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
    });

    const kinds = result.messages.map((m) => `${m.kind}:${m.role ?? ''}`);
    assert.deepEqual(kinds, [
      'text:user',
      'thinking:',
      'tool_use:',
      'tool_result:',
      'text:assistant',
    ]);

    const [user, thinking, toolUse, toolResult, assistantText] = result.messages;

    assert.equal(user.content, '统计一下9月份新增的skill');
    assert.equal(user.provider, 'dsh');
    assert.equal(user.sessionId, APP_SESSION_ID);

    assert.equal(thinking.content, 'Let me inspect the repo first.');

    assert.equal(toolUse.toolName, 'bash');
    assert.deepEqual(toolUse.toolInput, { command: 'ls' });
    assert.equal(toolUse.toolId, 'call_he3s');
    // The tool/result record is attached onto the paired tool_use as well.
    assert.deepEqual(toolUse.toolResult, { content: 'file-a\nfile-b', isError: false });

    assert.equal(toolResult.toolId, 'call_he3s');
    assert.equal(toolResult.content, 'file-a\nfile-b');
    assert.equal(toolResult.isError, false);

    assert.equal(assistantText.content, 'done');

    // tool_result rows do not count towards the page total (qoder contract).
    assert.equal(result.total, 4);
    assert.equal(result.hasMore, false);
    assert.equal(result.limit, null);
  });
});

test('fetchHistory reports an errored tool result and keeps unparsable tool arguments as strings', async () => {
  const records = [
    rec('assistant/message', 1, {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_err', name: 'read', arguments: 'not-json' }],
      },
    }),
    rec('tool/result', 2, {
      message: {
        role: 'tool',
        toolCallId: 'call_err',
        content: [{ type: 'text', text: 'Error: file missing' }],
        isError: true,
      },
    }),
  ];

  await withDshHistoryEnv(records, async (provider) => {
    const result = await provider.fetchHistory(APP_SESSION_ID, {
      projectPath: PROJECT_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
    });

    const toolUse = result.messages.find((m) => m.kind === 'tool_use');
    const toolResult = result.messages.find((m) => m.kind === 'tool_result');
    assert.ok(toolUse);
    assert.ok(toolResult);
    assert.equal(toolUse.toolInput, 'not-json');
    assert.equal(toolResult.isError, true);
    assert.deepEqual(toolUse.toolResult, { content: 'Error: file missing', isError: true });
  });
});

test('fetchHistory backfills the session summary and jsonl_path on first read', async () => {
  await withDshHistoryEnv(sampleRecords(), async (provider) => {
    await provider.fetchHistory(APP_SESSION_ID, {
      projectPath: PROJECT_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
    });

    const row = sessionsDb.getSessionById(APP_SESSION_ID);
    assert.ok(row);
    assert.equal(row.summary, '统计一下9月份新增的skill');
    assert.match(row.jsonl_path ?? '', /session\.v4\.jsonl\.zstd$/);

    // A user rename must never be overwritten by the title backfill.
    sessionsDb.updateSessionCustomName(APP_SESSION_ID, '我的重命名');
    sessionsDb.updateSessionSummary(APP_SESSION_ID, '');
    await provider.fetchHistory(APP_SESSION_ID, {
      projectPath: PROJECT_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
    });
    const after = sessionsDb.getSessionById(APP_SESSION_ID);
    assert.ok(after);
    assert.equal(after.custom_name, '我的重命名');
  });
});

test('fetchHistory paginates from the tail like the other providers', async () => {
  await withDshHistoryEnv(sampleRecords(), async (provider) => {
    const result = await provider.fetchHistory(APP_SESSION_ID, {
      projectPath: PROJECT_PATH,
      providerSessionId: PROVIDER_SESSION_ID,
      limit: 1,
      offset: 0,
    });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'done');
    assert.equal(result.total, 4);
    assert.equal(result.hasMore, true);
  });
});

test('fetchHistory returns the shared empty shape when the log file is missing', async () => {
  await withDshHistoryEnv(sampleRecords(), async (provider, root) => {
    const result = await provider.fetchHistory(APP_SESSION_ID, {
      projectPath: PROJECT_PATH,
      providerSessionId: 'never-spawned-session',
    });

    assert.deepEqual(result, {
      messages: [],
      total: 0,
      hasMore: false,
      offset: 0,
      limit: null,
    });
    void root;
  });
});

test('fetchHistory reads plain jsonl logs from compression:none deployments', async () => {
  await withDshHistoryEnv(
    sampleRecords(),
    async (provider) => {
      const result = await provider.fetchHistory(APP_SESSION_ID, {
        projectPath: PROJECT_PATH,
        providerSessionId: PROVIDER_SESSION_ID,
      });
      assert.equal(result.total, 4);
    },
    { fileName: 'session.v4.jsonl' },
  );
});
