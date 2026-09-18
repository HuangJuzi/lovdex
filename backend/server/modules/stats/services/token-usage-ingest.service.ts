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

/** 把 unknown 异常压成一行日志文本。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    // 短读（文件在 stat 与 read 之间被截断）是良性的：多出来的零字节不含换行，
    // 会被 lastNewline 切掉，offset 也不会越过最后一个完整行。
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
  /** 首次延迟扫描的句柄；stop() 必须能取消它，否则 stop 后还会再扫一轮。 */
  let initialScanTimer: NodeJS.Timeout | null = null;

  /**
   * Claude：按 byte offset 增量读新增的完整行。
   *
   * 入库数**逐文件**累加进 `status.eventsIndexed`（而不是扫完一次性返回总数）：
   * 全量回填要跑 ~30 秒，只在结束时更新会让前端整段时间都显示「已入库 0 条」。
   */
  async function scanClaude(): Promise<void> {
    if (!roots.claudeRoot) {
      return;
    }
    const files = await listJsonlFiles(roots.claudeRoot);
    status.filesTotal += files.length;

    for (const file of files) {
      // 单个文件坏掉（EACCES / 列目录后被删的 ENOENT / 插入失败）不能让整轮扫描中断，
      // 与 scanOpencode 的「失败即跳过」策略一致。cursor 只在插入成功之后推进，
      // 因此失败的文件下一轮会从同一个 offset 重试，不会丢数据。
      try {
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
        status.eventsIndexed += insertInBatches(events);
        tokenUsageDb.setCursor('claude', file, { byteOffset: nextOffset });
      } catch (error) {
        console.error('[token-usage-ingest] claude 文件扫描失败', file, describeError(error));
      } finally {
        status.filesDone += 1;
        await yieldToEventLoop();
      }
    }
  }

  /** Codex：文件极小，每次全量重扫 + 差分，靠 dedupe_key 幂等。 */
  async function scanCodex(): Promise<void> {
    if (!roots.codexRoot) {
      return;
    }
    const files = await listJsonlFiles(roots.codexRoot);
    status.filesTotal += files.length;

    for (const file of files) {
      // 与 scanClaude 同理：坏文件跳过，不中断整轮扫描。
      try {
        const text = await fsp.readFile(file, 'utf8');
        status.eventsIndexed += insertInBatches(parseCodexFile(text, file));
      } catch (error) {
        console.error('[token-usage-ingest] codex 文件扫描失败', file, describeError(error));
      } finally {
        status.filesDone += 1;
        await yieldToEventLoop();
      }
    }
  }

  /**
   * OpenCode：读它自己的 sqlite，按 `time_created` 增量。
   *
   * 该库是 WAL 模式且被 provider 进程同时写入，因此用普通连接（只读连接在 WAL 下
   * 需要写 -shm，会直接报错）并设置 busy_timeout。
   */
  async function scanOpencode(): Promise<void> {
    const dbPath = roots.opencodeDbPath;
    if (!dbPath || !fs.existsSync(dbPath)) {
      return;
    }
    const cursor = tokenUsageDb.getCursor('opencode', dbPath);
    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch {
      return;
    }

    // 该来源计入进度：否则 filesDone 会一直低于 filesTotal，进度条到不了 100%。
    status.filesTotal += 1;
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
      status.eventsIndexed += insertInBatches(events);
      tokenUsageDb.setCursor('opencode', dbPath, { lastTsMs: maxTs });
    } catch {
      // provider 正在写入或表结构变化：本轮跳过，不影响其他来源
    } finally {
      db.close();
      status.filesDone += 1;
    }
  }

  /**
   * 跑一轮完整扫描；重入时直接返回，不排队。
   *
   * **本函数永不 reject。** 三个调用点都是 `void runScan()`，而 server/index.js 没有
   * `unhandledRejection` 处理器 —— Node 默认 `--unhandled-rejections=throw`，
   * 一旦 reject 会直接终止后端进程（这个进程还服务着用户的其他项目）。
   */
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
      // 三个 scan 各自把入库数累加进 status.eventsIndexed（逐文件/逐来源），
      // 这里**不能**再 += 它们的返回值，否则计数翻倍。
      await scanClaude();
      await scanCodex();
      await scanOpencode();
    } catch (error) {
      // 兜底：各 scan 内部已逐文件/逐来源吞掉异常，这里只防御意料之外的失败
      // （例如 getCursor 抛错）。已累计的进度保留，下一轮自动重试。
      console.error('[token-usage-ingest] 扫描失败', describeError(error));
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
    initialScanTimer = setTimeout(() => void runScan(), INITIAL_SCAN_DELAY_MS);
    interval = setInterval(() => void runScan(), SCAN_INTERVAL_MS);
    // 不要因为这些定时器而阻止进程退出
    initialScanTimer.unref?.();
    interval.unref?.();
  }

  function stop(): void {
    if (initialScanTimer) {
      clearTimeout(initialScanTimer);
      initialScanTimer = null;
    }
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
