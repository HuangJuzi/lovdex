import { getConnection } from '@/modules/database/connection.js';
import type { TokenUsageEvent } from '@/shared/types.js';

export type TokenUsageCursor = { byteOffset: number; lastTsMs: number };

/** 一个 (时间桶, 模型) 的聚合结果。四类 token 分开返回，由前端按口径本地换算。 */
export type BucketAggregateRow = {
  bucket_ts: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

/** 一个模型的区间聚合结果。 */
export type ModelAggregateRow = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  sessions: number;
  last_used_at: number;
};

/** 一个模型在 1 分钟粒度上的峰值，按四种口径各给一个。 */
export type ModelPeakRow = {
  model: string;
  peak_all: number;
  peak_new: number;
  peak_input: number;
  peak_output: number;
};

type AggregateFilter = {
  from: number;
  to: number;
  projectPath?: string;
  models?: string[];
};

/**
 * 拼出 `token_usage_events` 查询的 WHERE 子句与绑定值。
 *
 * `models` 为空数组时视为「不过滤」（而不是「匹配空集合」）——调用方未传筛选条件时
 * 就是这种情况。占位符按传入模型数动态拼接，沿用 tasks.db.ts 的动态 WHERE 惯例。
 */
function buildFilter(filter: AggregateFilter): { where: string; values: unknown[] } {
  const clauses = ['ts_ms >= ?', 'ts_ms < ?'];
  const values: unknown[] = [filter.from, filter.to];
  if (filter.projectPath) {
    clauses.push('project_path = ?');
    values.push(filter.projectPath);
  }
  if (filter.models && filter.models.length > 0) {
    clauses.push(`model IN (${filter.models.map(() => '?').join(', ')})`);
    values.push(...filter.models);
  }
  return { where: clauses.join(' AND '), values };
}

export const tokenUsageDb = {
  /** 批量插入；返回真正新增的行数（`INSERT OR IGNORE` 会跳过重复 dedupeKey）。 */
  insertEvents(events: TokenUsageEvent[]): number {
    if (events.length === 0) {
      return 0;
    }
    const db = getConnection();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO token_usage_events
        (source, session_id, project_path, model, ts_ms,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const runAll = db.transaction((rows: TokenUsageEvent[]) => {
      for (const e of rows) {
        const info = stmt.run(
          e.source, e.sessionId, e.projectPath, e.model, e.tsMs,
          e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.dedupeKey,
        );
        inserted += info.changes;
      }
    });
    runAll(events);
    return inserted;
  },

  countEvents(): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM token_usage_events')
      .get() as { count: number };
    return row.count;
  },

  getCursor(source: string, filePath: string): TokenUsageCursor {
    const row = getConnection()
      .prepare('SELECT byte_offset, last_ts_ms FROM token_ingest_cursor WHERE source = ? AND file_path = ?')
      .get(source, filePath) as { byte_offset: number; last_ts_ms: number } | undefined;
    return { byteOffset: row?.byte_offset ?? 0, lastTsMs: row?.last_ts_ms ?? 0 };
  },

  /** 覆盖写 cursor。刻意不用 MAX()：文件被截断时需要允许 offset 回退到 0。 */
  setCursor(source: string, filePath: string, cursor: Partial<TokenUsageCursor>): void {
    const current = tokenUsageDb.getCursor(source, filePath);
    const byteOffset = cursor.byteOffset ?? current.byteOffset;
    const lastTsMs = cursor.lastTsMs ?? current.lastTsMs;
    getConnection()
      .prepare(`
        INSERT INTO token_ingest_cursor (source, file_path, byte_offset, last_ts_ms, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source, file_path) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          last_ts_ms = excluded.last_ts_ms,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(source, filePath, byteOffset, lastTsMs);
  },

  /**
   * 按 (时间桶, 模型) 聚合。分桶用整数除法，与 SQLite 时区无关。
   *
   * 四类 token 分开 SUM，不在这里合并成总量：实测 cache_read 占 74.2%、output 仅 0.3%，
   * 合并后「干了多少活」会被彻底淹没。口径换算交给前端，切换无需重新查询。
   *
   * bucketMs 必须显式 `CAST` 成 INTEGER：better-sqlite3 会把 JS number 绑定为
   * REAL，REAL 除法算出 28333333.333…，再乘回去正好等于原 ts_ms——分桶会静默失效
   * （每个事件各成一桶）。CAST 之后 SQLite 才走整数除法。
   */
  aggregateBuckets(filter: AggregateFilter & { bucketMs: number }): BucketAggregateRow[] {
    const { where, values } = buildFilter(filter);
    return getConnection()
      .prepare(`
        SELECT (ts_ms / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket_ts,
               model,
               SUM(input_tokens)          AS input_tokens,
               SUM(output_tokens)         AS output_tokens,
               SUM(cache_read_tokens)     AS cache_read_tokens,
               SUM(cache_creation_tokens) AS cache_creation_tokens
        FROM token_usage_events
        WHERE ${where}
        GROUP BY bucket_ts, model
        ORDER BY bucket_ts ASC
      `)
      .all(filter.bucketMs, filter.bucketMs, ...values) as BucketAggregateRow[];
  },

  /** 按模型聚合区间内的四类 token、去重会话数与最近使用时间。 */
  aggregateByModel(filter: AggregateFilter): ModelAggregateRow[] {
    const { where, values } = buildFilter(filter);
    return getConnection()
      .prepare(`
        SELECT model,
               SUM(input_tokens)          AS input_tokens,
               SUM(output_tokens)         AS output_tokens,
               SUM(cache_read_tokens)     AS cache_read_tokens,
               SUM(cache_creation_tokens) AS cache_creation_tokens,
               COUNT(DISTINCT session_id) AS sessions,
               MAX(ts_ms)                 AS last_used_at
        FROM token_usage_events
        WHERE ${where}
        GROUP BY model
        ORDER BY (SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)) DESC
      `)
      .all(...values) as ModelAggregateRow[];
  },

  /**
   * 每个模型在 1 分钟粒度上的四档峰值。必须独立于响应里的 bucketMs 计算
   * （桶越粗峰值越低，图上「峰值」会随缩放跳变）。
   */
  aggregateMinutePeaks(filter: AggregateFilter): ModelPeakRow[] {
    const { where, values } = buildFilter(filter);
    return getConnection()
      .prepare(`
        SELECT model,
               MAX(bucket_all)    AS peak_all,
               MAX(bucket_new)    AS peak_new,
               MAX(bucket_input)  AS peak_input,
               MAX(bucket_output) AS peak_output
        FROM (
          SELECT model,
                 (ts_ms / 60000) * 60000 AS bucket_ts,
                 SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS bucket_all,
                 SUM(input_tokens + output_tokens) AS bucket_new,
                 SUM(input_tokens) AS bucket_input,
                 SUM(output_tokens) AS bucket_output
          FROM token_usage_events
          WHERE ${where}
          GROUP BY bucket_ts, model
        )
        GROUP BY model
      `)
      .all(...values) as ModelPeakRow[];
  },

  /** 去重模型列表（供前端筛选器），按用量降序。 */
  listModels(filter: { from: number; to: number; projectPath?: string }): ModelAggregateRow[] {
    return tokenUsageDb.aggregateByModel(filter);
  },
};
