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
