import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  buildDshTokenUsage,
  readDshTokenUsageFromLog,
  readDshTokenUsageFromProjCache,
  resolveDshSessionTokenUsage,
} from '@/modules/providers/list/dsh/dsh-token-usage.js';

const PROVIDER_SESSION_ID = '08b3ba7a-f884-4784-980c-7107355a1067';
const CONTEXT_WINDOW = 1000000;

/** One zstd frame per record, mirroring dsh's session.vN.jsonl.zstd layout. */
function compressLog(records: string[]): Buffer {
  return Buffer.concat(
    records.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))),
  );
}

function rec(type: string, seq: number, data: unknown, time = 1792551066773): string {
  return JSON.stringify({ type, seq, time, data });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-token-usage-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes the projcache shape a real dsh session stores (version 7). */
async function writeProjCache(
  dshHome: string,
  sessionId: string,
  tokenUsage: unknown,
  contextPressure: unknown = { surfaceTokens: 211227, contextWindow: CONTEXT_WINDOW, pressureTokens: 570803 },
): Promise<void> {
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      version: 7,
      record: {
        rows: {
          title: { ver: 1, seq: 2954, val: '使用DSH作为provider时' },
          tokenUsage: { ver: 2, seq: 2954, val: tokenUsage },
          ...(contextPressure ? { contextPressure: { ver: 5, seq: 2954, val: contextPressure } } : {}),
        },
      },
    }),
  );
}

test('buildDshTokenUsage sums the last step into a prompt+completion budget', () => {
  const usage = buildDshTokenUsage({
    uncachedInputTokens: 286131,
    outputTokens: 268,
    cacheReadTokens: 284672,
    cacheWriteTokens: 0,
  }, CONTEXT_WINDOW);

  assert.ok(usage);
  assert.equal(usage.used, 571071);
  assert.equal(usage.total, CONTEXT_WINDOW);
  // Mirrors the claude branch: `inputTokens` is the whole prompt (cache included).
  assert.equal(usage.inputTokens, 570803);
  assert.equal(usage.outputTokens, 268);
  assert.equal(usage.cacheReadTokens, 284672);
  assert.equal(usage.cacheCreationTokens, 0);
  assert.equal(usage.cacheTokens, 284672);
  assert.deepEqual(usage.breakdown, { input: 570803, output: 268 });
});

test('buildDshTokenUsage rejects a missing or non-object bucket set', () => {
  assert.equal(buildDshTokenUsage(null, CONTEXT_WINDOW), null);
  assert.equal(buildDshTokenUsage('nope', CONTEXT_WINDOW), null);
  // A zeroed bucket set is a real answer (the turn produced nothing yet).
  assert.equal(buildDshTokenUsage({}, CONTEXT_WINDOW)?.used, 0);
});

test('readDshTokenUsageFromProjCache reads the last-step buckets + native window', async () => {
  await withTempDir(async (dshHome) => {
    await writeProjCache(dshHome, PROVIDER_SESSION_ID, {
      totals: {
        uncachedInputTokens: 84189180,
        outputTokens: 85455,
        cacheReadTokens: 83430144,
        cacheWriteTokens: 0,
      },
      last: {
        turn: 2,
        step: 45,
        buckets: {
          uncachedInputTokens: 286131,
          outputTokens: 268,
          cacheReadTokens: 284672,
          cacheWriteTokens: 0,
        },
      },
    });

    const usage = await readDshTokenUsageFromProjCache(PROVIDER_SESSION_ID, { dshHome });

    assert.ok(usage);
    // The badge shows the CURRENT context, not the session's cumulative totals.
    assert.equal(usage.used, 571071);
    assert.equal(usage.total, CONTEXT_WINDOW);
  });
});

test('readDshTokenUsageFromProjCache falls back to the supplied window when absent', async () => {
  await withTempDir(async (dshHome) => {
    await writeProjCache(dshHome, PROVIDER_SESSION_ID, {
      last: { turn: 1, step: 2, buckets: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 } },
    }, null);

    const usage = await readDshTokenUsageFromProjCache(PROVIDER_SESSION_ID, {
      dshHome,
      contextWindow: 160000,
    });

    assert.equal(usage?.used, 1010);
    assert.equal(usage?.total, 160000);
  });
});

test('readDshTokenUsageFromProjCache returns null for a missing file or no last step', async () => {
  await withTempDir(async (dshHome) => {
    assert.equal(await readDshTokenUsageFromProjCache(PROVIDER_SESSION_ID, { dshHome }), null);

    await writeProjCache(dshHome, PROVIDER_SESSION_ID, { totals: { uncachedInputTokens: 42 } });
    assert.equal(await readDshTokenUsageFromProjCache(PROVIDER_SESSION_ID, { dshHome }), null);
  });
});

test('readDshTokenUsageFromLog returns the newest assistant/message usage', async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, 'session.v4.jsonl.zstd');
    await writeFile(logPath, compressLog([
      rec('session', 0, { version: 4, id: PROVIDER_SESSION_ID, cwd: '/work/lovdex' }),
      rec('assistant/message', 14, {
        turn: 1,
        step: 1,
        message: { id: 'msg-1', role: 'assistant', content: [] },
        usage: { inputTokens: 5512, outputTokens: 191, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5703 },
      }),
      rec('assistant/message', 2937, {
        turn: 2,
        step: 45,
        message: { id: 'msg-2', role: 'assistant', content: [] },
        usage: { inputTokens: 284583, outputTokens: 393, cacheReadTokens: 283904, cacheWriteTokens: 0, totalTokens: 568880 },
      }),
      // Records after the last assistant message must not be mistaken for usage.
      rec('turn/end', 2940, { turn: 2, reason: { kind: 'completed' } }),
    ]));

    const usage = await readDshTokenUsageFromLog(logPath, CONTEXT_WINDOW);

    assert.ok(usage);
    assert.equal(usage.used, 568880);
    assert.equal(usage.inputTokens, 568487);
    assert.equal(usage.outputTokens, 393);
  });
});

test('readDshTokenUsageFromLog returns null when the log has no usage', async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, 'session.v4.jsonl.zstd');
    await writeFile(logPath, compressLog([rec('session', 0, { version: 4 })]));

    assert.equal(await readDshTokenUsageFromLog(logPath, CONTEXT_WINDOW), null);
    assert.equal(await readDshTokenUsageFromLog(path.join(dir, 'missing.zstd'), CONTEXT_WINDOW), null);
  });
});

test('resolveDshSessionTokenUsage prefers projcache, then the indexed log path', async () => {
  await withTempDir(async (dshHome) => {
    const logPath = path.join(dshHome, 'indexed', 'session.v4.jsonl.zstd');
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, compressLog([
      rec('assistant/message', 1, {
        usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 3000, cacheWriteTokens: 0 },
      }),
    ]));

    // Log fallback when the projcache has no last step.
    const fromLog = await resolveDshSessionTokenUsage({
      sessionId: PROVIDER_SESSION_ID,
      logPath,
      dshHome,
      contextWindow: CONTEXT_WINDOW,
    });
    assert.equal(fromLog?.used, 4020);

    await writeProjCache(dshHome, PROVIDER_SESSION_ID, {
      last: { turn: 1, step: 1, buckets: { uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 20, cacheWriteTokens: 0 } },
    }, { contextWindow: CONTEXT_WINDOW });
    const fromCache = await resolveDshSessionTokenUsage({
      sessionId: PROVIDER_SESSION_ID,
      logPath,
      dshHome,
      contextWindow: CONTEXT_WINDOW,
    });
    assert.equal(fromCache?.used, 31);
  });
});

test('resolveDshSessionTokenUsage returns null when no source exists', async () => {
  await withTempDir(async (dshHome) => {
    assert.equal(
      await resolveDshSessionTokenUsage({
        sessionId: PROVIDER_SESSION_ID,
        dshHome,
        contextWindow: CONTEXT_WINDOW,
      }),
      null,
    );
  });
});
