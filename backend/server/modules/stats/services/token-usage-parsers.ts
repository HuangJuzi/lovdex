import type { TokenUsageEvent } from '@/shared/types.js';

/**
 * 把 Anthropic 的 usage 字段收敛成非负整数。
 *
 * 真实 transcript 里同一字段可能是 number / string / null / 缺失，历史版本还出现过
 * `Number.NaN`，因此这里做一次性兜底，调用方不必再判类型。
 */
export function readUsageNumber(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : 0;
}

/** 解析 ISO 时间戳为 epoch 毫秒；无法解析返回 null。 */
export function parseIsoToMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 从对象里安全读取字符串字段，空串视为缺失。 */
function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 解析 Claude transcript 的一行。
 *
 * 返回 null 表示这行不产生用量事件：非 assistant 条目、无 usage、`<synthetic>` 模型
 * （非真实 API 调用）、或缺 `message.id` / `timestamp`（无法定位与去重）。
 *
 * `dedupeKey` 用 `message.id`——同一个 message 可能同时出现在主 transcript 与
 * `subagents/agent-*.jsonl` 里，用 id 去重可自动处理这种重叠，不必依赖文件布局假设。
 */
export function parseClaudeLine(raw: unknown): TokenUsageEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== 'assistant') {
    return null;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return null;
  }
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const model = readString(message, 'model');
  if (!model || model === '<synthetic>') {
    return null;
  }
  const messageId = readString(message, 'id');
  const tsMs = parseIsoToMs(entry.timestamp);
  if (!messageId || tsMs === null) {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  return {
    source: 'claude',
    sessionId: readString(entry, 'sessionId'),
    projectPath: readString(entry, 'cwd'),
    model,
    tsMs,
    inputTokens: readUsageNumber(usageRecord.input_tokens ?? usageRecord.inputTokens),
    outputTokens: readUsageNumber(usageRecord.output_tokens ?? usageRecord.outputTokens),
    cacheReadTokens: readUsageNumber(
      usageRecord.cache_read_input_tokens ?? usageRecord.cacheReadInputTokens,
    ),
    cacheCreationTokens: readUsageNumber(
      usageRecord.cache_creation_input_tokens ?? usageRecord.cacheCreationInputTokens,
    ),
    dedupeKey: `claude:${messageId}`,
  };
}

/** Codex 累计用量的三元组；`cached` 是 `input` 的子集。 */
type CodexCumulative = { input: number; output: number; cached: number };

const CODEX_ZERO: CodexCumulative = { input: 0, output: 0, cached: 0 };

/**
 * 解析整个 Codex session 文件（`.jsonl` 文本），返回按行序排列的区间增量事件。
 *
 * Codex 的 `payload.info.total_token_usage` 是**会话累计值**而非单次用量，因此必须差分。
 * 本函数刻意做成「输入整个文件文本」的纯函数：codex 文件总量只有 1MB 量级，每次全量重扫
 * 的成本可忽略，换来的是差分基准永远从文件头重新累积——不会出现 cursor 落在文件中途
 * 导致丢失上次累计值的问题。同一文件重复解析结果恒等，配合 `dedupe_key` 天然幂等。
 *
 * `dedupe_key` 用 `codex:<sessionId>:<行号>`（行号从 1 开始）；sessionId 缺失时用文件路径兜底。
 */
export function parseCodexFile(text: string, filePath: string): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  let sessionId: string | null = null;
  let projectPath: string | null = null;
  let model = 'unknown';
  let previous: CodexCumulative | null = null;

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const payloadRecord = payload as Record<string, unknown>;

    if (entry.type === 'session_meta') {
      sessionId = readString(payloadRecord, 'session_id') ?? sessionId;
      projectPath = readString(payloadRecord, 'cwd') ?? projectPath;
      continue;
    }

    // turn_context 是 model 的常规来源；后续事件也接受 payload.model。
    // 刻意不回落到 model_provider —— 那是 provider 名不是模型名，回落会污染模型维度。
    const payloadModel = readString(payloadRecord, 'model');
    if (payloadModel) {
      model = payloadModel;
    }

    if (payloadRecord.type !== 'token_count') {
      continue;
    }
    const info = payloadRecord.info;
    if (!info || typeof info !== 'object') {
      continue;
    }
    const total = (info as Record<string, unknown>).total_token_usage;
    if (!total || typeof total !== 'object') {
      continue;
    }
    const totalRecord = total as Record<string, unknown>;
    const current: CodexCumulative = {
      input: readUsageNumber(totalRecord.input_tokens),
      output: readUsageNumber(totalRecord.output_tokens),
      cached: readUsageNumber(totalRecord.cached_input_tokens),
    };
    const base = previous ?? CODEX_ZERO;
    const delta = {
      input: Math.max(0, current.input - base.input),
      output: Math.max(0, current.output - base.output),
      cached: Math.max(0, current.cached - base.cached),
    };
    // 基准必须无条件推进（包括下面要 continue 的情况），否则后续增量会算错。
    previous = current;

    const tsMs = parseIsoToMs(entry.timestamp);
    if (tsMs === null) {
      continue;
    }
    if (delta.input === 0 && delta.output === 0 && delta.cached === 0) {
      continue;
    }

    events.push({
      source: 'codex',
      sessionId,
      projectPath,
      model,
      tsMs,
      // codex 的 input_tokens 含 cached_input_tokens，扣除后才是「不含缓存的新增输入」。
      inputTokens: Math.max(0, delta.input - delta.cached),
      outputTokens: delta.output,
      cacheReadTokens: delta.cached,
      cacheCreationTokens: 0,
      dedupeKey: `codex:${sessionId ?? filePath}:${index + 1}`,
    });
  }

  return events;
}

/** `opencode.db` 的 `message` 表行（只取用得到的列）。 */
export type OpencodeMessageRow = {
  id: string;
  session_id: string;
  data: string;
};

/**
 * 解析 `opencode.db` 的一行 message。
 *
 * `data` 是 JSON 文本，assistant 行的 `tokens` 形状为
 * `{ total, input, output, reasoning, cache: { write, read } }`，其中
 * `input` 不含缓存（真实样本满足 `input + output + cache.read = total`），
 * `reasoning` 是 `output` 的子集因而不单独计数。
 *
 * `dedupeKey` 用 `message.id`（该表主键，稳定唯一）。
 */
export function parseOpencodeRow(
  row: OpencodeMessageRow,
  fallbackProjectPath: string | null,
): TokenUsageEvent | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || data.role !== 'assistant') {
    return null;
  }
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== 'object') {
    return null;
  }
  const time = data.time;
  const tsMs = time && typeof time === 'object' && typeof (time as Record<string, unknown>).created === 'number'
    ? ((time as Record<string, unknown>).created as number)
    : null;
  if (tsMs === null) {
    return null;
  }

  const tokensRecord = tokens as Record<string, unknown>;
  const cache = tokensRecord.cache && typeof tokensRecord.cache === 'object'
    ? (tokensRecord.cache as Record<string, unknown>)
    : {};

  return {
    source: 'opencode',
    sessionId: row.session_id,
    projectPath: readString(data.path, 'cwd') ?? fallbackProjectPath,
    model: readString(data, 'modelID') ?? 'unknown',
    tsMs,
    inputTokens: readUsageNumber(tokensRecord.input),
    outputTokens: readUsageNumber(tokensRecord.output),
    cacheReadTokens: readUsageNumber(cache.read),
    cacheCreationTokens: readUsageNumber(cache.write),
    dedupeKey: `opencode:${row.id}`,
  };
}
