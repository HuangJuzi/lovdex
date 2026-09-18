import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { tokenUsageDb } from '@/modules/database/repositories/token-usage.db.js';

import { createTokenUsageIngestService } from '../services/token-usage-ingest.service.js';

/**
 * 在一次性临时库上跑测试体。
 *
 * `connection.ts` 只在 `NODE_TEST_CONTEXT && DATABASE_PATH` 同时成立时才认 env 覆盖，
 * 而 `node --test` 只设置前者；不显式设 DATABASE_PATH 就会落到 app.config.json 指向的
 * **生产库**。所以每个碰库的测试都必须包在这里面。
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'lovdex-test-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function claudeLine(id: string, ts: string, input: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    cwd: '/proj/alpha',
    sessionId: 'sess-1',
    timestamp: ts,
    message: { id, model: 'm-x', usage: { input_tokens: input, output_tokens: output } },
  });
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-token-ingest-'));
}

test('扫描 Claude transcript 目录，入库并可增量追加', async () => {
  await withIsolatedDatabase(async () => {
    const root = makeTempRoot();
    const file = path.join(root, 'sess-1.jsonl');
    fs.writeFileSync(file, `${claudeLine('m1', '2026-08-18T11:00:00.000Z', 100, 10)}\n`);

    const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 1);

    // 追加一行后再扫：只应新增 1 行（offset 增量生效）
    fs.appendFileSync(file, `${claudeLine('m2', '2026-08-18T11:01:00.000Z', 200, 20)}\n`);
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2);

    // 再扫一次不追加：不应新增（cursor 已到文件尾 + dedupe 兜底）
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2);
  });
});

test('文件末尾的半行留到下次扫描，不会被吞掉', async () => {
  await withIsolatedDatabase(async () => {
    const root = makeTempRoot();
    const file = path.join(root, 'sess-half.jsonl');
    const complete = `${claudeLine('h1', '2026-08-18T11:00:00.000Z', 5, 1)}\n`;
    const partial = claudeLine('h2', '2026-08-18T11:01:00.000Z', 7, 2);
    // 写入完整行 + 半行（无换行结尾）
    fs.writeFileSync(file, complete + partial);

    const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 1, '半行不应入库');

    // 补齐换行后，半行应被解析出来
    fs.appendFileSync(file, '\n');
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2, '补齐后应入库');
  });
});

test('文件被截断（size < cursor offset）时重扫且不重复计数', async () => {
  await withIsolatedDatabase(async () => {
    const root = makeTempRoot();
    const file = path.join(root, 'sess-trunc.jsonl');
    fs.writeFileSync(file, `${claudeLine('t1', '2026-08-18T11:00:00.000Z', 1, 1)}\n`);

    const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 1);

    // 截断成**确实更短**的内容（模拟轮转），offset 应归零重扫。
    // 注意：轮转检测条件是 `size < offset`，所以新内容必须真的比旧内容短；
    // 等长的「换一条内容」不会被识别成轮转（也不该被识别）。
    const rotated = `${claudeLine('t2', '2026-08-18T11:05:00Z', 2, 2)}\n`;
    assert.ok(rotated.length < fs.statSync(file).size, '轮转后的内容必须更短');
    fs.writeFileSync(file, rotated);

    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 2);
    assert.equal(tokenUsageDb.getCursor('claude', file).byteOffset, fs.statSync(file).size);
  });
});

test('同一 message.id 出现在主 transcript 与 subagents 子目录时只入库一次', async () => {
  await withIsolatedDatabase(async () => {
    const root = makeTempRoot();
    const nested = path.join(root, 'sess-1', 'subagents');
    fs.mkdirSync(nested, { recursive: true });
    const line = claudeLine('dup-1', '2026-08-18T11:00:00.000Z', 9, 9);
    fs.writeFileSync(path.join(root, 'sess-1.jsonl'), `${line}\n`);
    fs.writeFileSync(path.join(nested, 'agent-a.jsonl'), `${line}\n`);

    const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
    await ingest.runScan();
    assert.equal(tokenUsageDb.countEvents(), 1);
  });
});

test('单个 transcript 不可读时跳过它，其余文件仍被扫描且 runScan 不 reject', async () => {
  await withIsolatedDatabase(async () => {
    const root = makeTempRoot();
    const readable = path.join(root, 'a-readable.jsonl');
    const unreadable = path.join(root, 'b-unreadable.jsonl');
    fs.writeFileSync(readable, `${claudeLine('ok-1', '2026-08-18T11:00:00.000Z', 3, 3)}\n`);
    fs.writeFileSync(unreadable, `${claudeLine('bad-1', '2026-08-18T11:00:00.000Z', 4, 4)}\n`);
    // chmod 000 让 fsp.open 抛 EACCES（uid 1000，非 root）。
    fs.chmodSync(unreadable, 0o000);
    try {
      const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });
      // 三个调用点都是 `void runScan()`（setTimeout / setInterval / maybeTriggerRefresh），
      // 而 server/index.js 没有 unhandledRejection 处理器 —— runScan reject 会直接杀掉进程。
      await ingest.runScan();
      const status = ingest.getStatus();
      // 坏文件也必须计入「已处理」：否则说明扫描在它那里提前中断（filesDone 必然 < 2）。
      assert.equal(status.filesDone, 2, '坏文件应被跳过而不是中断整轮扫描');
      assert.equal(tokenUsageDb.countEvents(), 1, '可读文件的用量仍应入库');
      assert.equal(status.scanning, false);
      assert.ok(status.lastScanAt);
    } finally {
      // 恢复权限，否则临时目录无法清理。
      fs.chmodSync(unreadable, 0o644);
    }
  });
});

test('扫描进行中 eventsIndexed 就逐文件增长，而不是全部扫完才一次性出现', async () => {
  await withIsolatedDatabase(async () => {
    const root = makeTempRoot();
    // 文件足够多，保证「扫到一半」这个窗口能被观察到。
    const fileCount = 200;
    for (let i = 0; i < fileCount; i += 1) {
      const index = String(i).padStart(4, '0');
      fs.writeFileSync(
        path.join(root, `sess-${index}.jsonl`),
        `${claudeLine(`m-${index}`, '2026-08-18T11:00:00.000Z', 1, 1)}\n`,
      );
    }

    const ingest = createTokenUsageIngestService({ claudeRoot: root, codexRoot: null, opencodeDbPath: null });

    // 不 await：在扫描进行中轮询 getStatus()。scanClaude 每个文件都会让出事件循环
    // （yieldToEventLoop），所以这个循环能稳定观察到中间状态。
    const scan = ingest.runScan();
    let settled = false;
    void scan.then(() => {
      settled = true;
    });

    const snapshots: { filesDone: number; filesTotal: number; eventsIndexed: number }[] = [];
    while (!settled) {
      const s = ingest.getStatus();
      snapshots.push({ filesDone: s.filesDone, filesTotal: s.filesTotal, eventsIndexed: s.eventsIndexed });
      await new Promise((resolve) => setImmediate(resolve));
    }
    await scan;

    // 「扫到一半」= 还没处理完所有文件，但已经能看到入库数。
    const midScan = snapshots.filter(
      (s) => s.filesDone > 0 && s.filesDone < s.filesTotal && s.eventsIndexed > 0,
    );
    assert.ok(
      midScan.length > 0,
      `扫描途中应能看到 eventsIndexed 增长，实际快照数=${snapshots.length}，前几个=${JSON.stringify(snapshots.slice(0, 3))}`,
    );

    // 逐文件累加不能把计数加重复：任何时刻都不该超过最终值。
    for (const s of snapshots) {
      assert.ok(s.eventsIndexed <= fileCount, `eventsIndexed 超过总数：${s.eventsIndexed}`);
    }
    const final = ingest.getStatus();
    assert.equal(final.eventsIndexed, fileCount, '结束后 eventsIndexed 应等于入库条数');
    assert.equal(tokenUsageDb.countEvents(), fileCount);
  });
});

test('扫描根不存在时不抛错，getStatus 反映已完成', async () => {
  await withIsolatedDatabase(async () => {
    const ingest = createTokenUsageIngestService({
      claudeRoot: path.join(os.tmpdir(), 'lovdex-does-not-exist-xyz'),
      codexRoot: null,
      opencodeDbPath: null,
    });
    await ingest.runScan();
    const status = ingest.getStatus();
    assert.equal(status.scanning, false);
    assert.ok(status.lastScanAt);
  });
});
