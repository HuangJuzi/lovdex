import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { tokenUsageDb } from '@/modules/database/repositories/token-usage.db.js';
import type { TokenUsageEvent } from '@/shared/types.js';

import { parseClaudeLine, parseCodexFile, parseOpencodeRow } from './token-usage-parsers.js';

/** 每处理完一个文件让出事件循环，避免长时间阻塞 express。 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 每批插入的行数；配合事务降低 SQLite 提交次数。 */
const INSERT_BATCH_SIZE = 500;

const SCAN_INTERVAL_MS = 60_000;
const INITIAL_SCAN_DELAY_MS = 5_000;
/** ingest-status 被访问时，距上次扫描超过这个时长就触发一次后台刷新。 */
const STALE_REFRESH_MS = 30_000;

export type TokenUsageIngestRoots = {
  claudeRoot: string | null;
  codexRoot: string | null;
  opencodeDbPath: string | null;
};

export type TokenUsageIngestStatus = {
  scanning: boolean;
  filesTotal: number;
  filesDone: number;
  eventsIndexed: number;
  startedAt: string | null;
  lastScanAt: string | null;
};

function defaultRoots(): TokenUsageIngestRoots {
  const home = os.homedir();
  return {
    claudeRoot: path.join(home, '.claude', 'projects'),
    codexRoot: path.join(home, '.codex', 'sessions'),
    opencodeDbPath: path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
}

/** 递归列出目录下所有 `.jsonl` 文件；目录不存在时返回空数组而不是抛错。 */
async function listJsonlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * 从 `fromOffset` 起读取新增的**完整行**。
 *
 * 返回的 `nextOffset` 只推进到最后一个换行符之后，因此正在被写入的半行会留到下次扫描；
 * offset 用 UTF-8 字节长度累加（不是字符长度），否则多字节内容会让 offset 漂移。
 */
async function readCompleteLines(
  filePath: string,
  fromOffset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const stats = await fsp.stat(filePath);
  // 文件被轮转/截断：从头重扫（dedupe_key 保证不会重复计数）
  const startOffset = stats.size < fromOffset ? 0 : fromOffset;
  if (stats.size === startOffset) {
    return { lines: [], nextOffset: startOffset };
  }

  const handle = await fsp.open(filePath, 'r');
  try {
    const length = stats.size - startOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, startOffset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      return { lines: [], nextOffset: startOffset };
    }
    const complete = text.slice(0, lastNewline);
    const nextOffset = startOffset + Buffer.byteLength(complete, 'utf8') + 1;
    return { lines: complete.split('\n'), nextOffset };
  } finally {
    await handle.close();
  }
}

function insertInBatches(events: TokenUsageEvent[]): number {
  let inserted = 0;
  for (let i = 0; i < events.length; i += INSERT_BATCH_SIZE) {
    inserted += tokenUsageDb.insertEvents(events.slice(i, i + INSERT_BATCH_SIZE));
  }
  return inserted;
}

export function createTokenUsageIngestService(overrides: Partial<TokenUsageIngestRoots> = {}) {
  const roots: TokenUsageIngestRoots = { ...defaultRoots(), ...overrides };
  const status: TokenUsageIngestStatus = {
    scanning: false,
    filesTotal: 0,
    filesDone: 0,
    eventsIndexed: 0,
    startedAt: null,
    lastScanAt: null,
  };
  let interval: NodeJS.Timeout | null = null;

  /** Claude：按 byte offset 增量读新增的完整行。 */
  async function scanClaude(): Promise<number> {
    if (!roots.claudeRoot) {
      return 0;
    }
    const files = await listJsonlFiles(roots.claudeRoot);
    status.filesTotal += files.length;
    let inserted = 0;

    for (const file of files) {
      const cursor = tokenUsageDb.getCursor('claude', file);
      const { lines, nextOffset } = await readCompleteLines(file, cursor.byteOffset);
      const events: TokenUsageEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const event = parseClaudeLine(JSON.parse(line));
          if (event) {
            events.push(event);
          }
        } catch {
          // 损坏行跳过，不影响同一文件后续行
        }
      }
      inserted += insertInBatches(events);
      tokenUsageDb.setCursor('claude', file, { byteOffset: nextOffset });
      status.filesDone += 1;
      await yieldToEventLoop();
    }
    return inserted;
  }

  /** Codex：文件极小，每次全量重扫 + 差分，靠 dedupe_key 幂等。 */
  async function scanCodex(): Promise<number> {
    if (!roots.codexRoot) {
      return 0;
    }
    const files = await listJsonlFiles(roots.codexRoot);
    status.filesTotal += files.length;
    let inserted = 0;

    for (const file of files) {
      let text: string;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        status.filesDone += 1;
        continue;
      }
      inserted += insertInBatches(parseCodexFile(text, file));
      status.filesDone += 1;
      await yieldToEventLoop();
    }
    return inserted;
  }

  /**
   * OpenCode：读它自己的 sqlite，按 `time_created` 增量。
   *
   * 该库是 WAL 模式且被 provider 进程同时写入，因此用普通连接（只读连接在 WAL 下
   * 需要写 -shm，会直接报错）并设置 busy_timeout。
   */
  async function scanOpencode(): Promise<number> {
    const dbPath = roots.opencodeDbPath;
    if (!dbPath || !fs.existsSync(dbPath)) {
      return 0;
    }
    const cursor = tokenUsageDb.getCursor('opencode', dbPath);
    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch {
      return 0;
    }

    let inserted = 0;
    try {
      db.pragma('busy_timeout = 2000');
      const rows = db
        .prepare(`
          SELECT m.id AS id, m.session_id AS session_id, m.data AS data, s.directory AS directory
          FROM message m
          LEFT JOIN session s ON s.id = m.session_id
          WHERE m.time_created > ?
            AND json_extract(m.data, '$.role') = 'assistant'
          ORDER BY m.time_created ASC
        `)
        .all(cursor.lastTsMs) as {
          id: string;
          session_id: string;
          data: string;
          directory: string | null;
        }[];

      const events: TokenUsageEvent[] = [];
      let maxTs = cursor.lastTsMs;
      for (const row of rows) {
        const event = parseOpencodeRow(row, row.directory ?? null);
        if (event) {
          events.push(event);
          maxTs = Math.max(maxTs, event.tsMs);
        }
      }
      inserted = insertInBatches(events);
      tokenUsageDb.setCursor('opencode', dbPath, { lastTsMs: maxTs });
    } catch {
      // provider 正在写入或表结构变化：本轮跳过，不影响其他来源
    } finally {
      db.close();
    }
    return inserted;
  }

  /** 跑一轮完整扫描；重入时直接返回，不排队。 */
  async function runScan(): Promise<void> {
    if (status.scanning) {
      return;
    }
    status.scanning = true;
    status.filesTotal = 0;
    status.filesDone = 0;
    status.eventsIndexed = 0;
    status.startedAt = new Date().toISOString();
    try {
      status.eventsIndexed += await scanClaude();
      status.eventsIndexed += await scanCodex();
      status.eventsIndexed += await scanOpencode();
    } finally {
      status.scanning = false;
      status.lastScanAt = new Date().toISOString();
    }
  }

  /** 启动定时采集。由 index.js 在 server.listen 回调里调用，不 await。 */
  function start(): void {
    if (interval) {
      return;
    }
    setTimeout(() => void runScan(), INITIAL_SCAN_DELAY_MS);
    interval = setInterval(() => void runScan(), SCAN_INTERVAL_MS);
    // 不要因为这个定时器而阻止进程退出
    interval.unref?.();
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function getStatus(): TokenUsageIngestStatus {
    return { ...status };
  }

  /** 页面请求时调用：数据够新就什么都不做，否则后台触发一次增量扫描（不 await）。 */
  function maybeTriggerRefresh(): void {
    if (status.scanning) {
      return;
    }
    const last = status.lastScanAt ? Date.parse(status.lastScanAt) : 0;
    if (Date.now() - last > STALE_REFRESH_MS) {
      void runScan();
    }
  }

  return { start, stop, runScan, getStatus, maybeTriggerRefresh };
}

export type TokenUsageIngestService = ReturnType<typeof createTokenUsageIngestService>;
