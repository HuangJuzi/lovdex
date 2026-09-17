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
