import type { AnyRecord } from '@/shared/types.js';

/**
 * The composer badge's token shape. `used` is the CURRENT context — the latest
 * step's prompt (cached prefix included) plus its completion — not the
 * session's cumulative spend. The badge pairs it with the context window.
 */
export type ClaudeSessionTokenUsage = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  breakdown: { input: number; output: number };
};

/** Non-negative integer, or 0. Mirrors the pre-existing route behavior. */
function readNumber(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : 0;
}

function readObject(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null;
}

/**
 * Builds the budget from one SDK stream message.
 *
 * Only per-step assistant usage may move the badge. The terminal `result`
 * message's `usage` / `modelUsage` are the run's CUMULATIVE totals across every
 * tool round — feeding them to the badge made it jump from the current context
 * (~74K) to millions at the end of each turn, then fall back on reload.
 */
export function buildClaudeTokenBudget(
  sdkMessage: unknown,
  contextWindow: number,
): ClaudeSessionTokenUsage | null {
  const message = readObject(sdkMessage);
  if (!message || message.type === 'result') {
    return null;
  }

  const messageUsage = readObject(readObject(message.message)?.usage) ?? readObject(message.usage);
  if (!messageUsage) {
    return null;
  }

  return buildUsage(
    readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens),
    readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens),
    readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens),
    readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens),
    contextWindow,
  );
}

function buildUsage(
  directInputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
  contextWindow: number,
): ClaudeSessionTokenUsage {
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Reads the current context usage out of a claude transcript (JSONL text).
 *
 * Scans backwards for the newest real assistant usage entry. `<synthetic>`
 * entries are skipped: a failed turn's `API Error: ...` message carries an
 * all-zero usage object, and stopping there reported 0 tokens on a session
 * whose earlier turns were real. Returns a zeroed budget when no usable entry
 * exists (a brand-new session).
 */
export function parseClaudeTranscriptTokenUsage(
  text: string,
  contextWindow: number,
): ClaudeSessionTokenUsage {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }

    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') {
      continue;
    }

    const message = readObject(entry.message);
    const usage = readObject(message?.usage);
    if (!message || !usage) {
      continue;
    }
    // Synthetic entries are Lovdex/CLI-local notices, not model calls.
    if (message.model === '<synthetic>') {
      continue;
    }

    return buildUsage(
      readNumber(usage.input_tokens ?? usage.inputTokens),
      readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens),
      readNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens),
      readNumber(usage.output_tokens ?? usage.outputTokens),
      contextWindow,
    );
  }

  return buildUsage(0, 0, 0, 0, contextWindow);
}
