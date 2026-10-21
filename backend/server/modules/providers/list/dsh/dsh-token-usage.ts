import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appConfig } from '@/modules/config/config.js';

import {
  decodeDshSessionLog,
  findDshSessionLogFile,
  parseDshSessionRecords,
} from '@/modules/providers/list/dsh/dsh-session-log.js';

/**
 * The composer badge's token shape. Mirrors the claude branch of
 * `GET /api/projects/:projectId/sessions/:sessionId/token-usage`:
 * `used` is the CURRENT context (latest step's prompt + completion), not the
 * session's cumulative spend — the badge pairs it with the context window.
 */
export type DshSessionTokenUsage = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  breakdown: { input: number; output: number };
};

/** The default context window when neither dsh nor app config names one. */
const DEFAULT_CONTEXT_WINDOW = 160000;

/** Non-negative integer, or 0 — dsh writes numbers, but fixtures/older logs drift. */
function readNumber(value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : 0;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The dsh home directory: `providers.dsh.dshHome`, then `DSH_HOME`, then
 * `~/.dsh`. Same precedence the sessions provider and the runner use, so the
 * usage reader looks where the CLI actually persists.
 */
export function resolveDshHome(): string {
  const configured = appConfig().get().providers?.dsh?.dshHome?.trim();
  return configured || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

function configuredContextWindow(): number {
  const value = appConfig().get().server.contextWindow;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Normalizes one step's dsh usage buckets into the composer's shape.
 *
 * dsh reports `inputTokens` as the UNCACHED prompt and `cacheReadTokens` /
 * `cacheWriteTokens` separately, so the prompt is their sum (the same
 * "everything sent this step" accounting the claude branch uses). `used` adds
 * the completion on top.
 */
export function buildDshTokenUsage(
  buckets: unknown,
  contextWindow: number,
): DshSessionTokenUsage | null {
  const record = readObject(buckets);
  if (!record) {
    return null;
  }

  const cacheReadTokens = readNumber(record.cacheReadTokens);
  const cacheCreationTokens = readNumber(record.cacheWriteTokens);
  const cacheTokens = cacheReadTokens + cacheCreationTokens;
  // The projcache buckets call it `uncachedInputTokens`; the session log's
  // assistant/message usage calls the same fresh-prompt count `inputTokens`.
  const inputTokens = readNumber(record.uncachedInputTokens ?? record.inputTokens) + cacheTokens;
  const outputTokens = readNumber(record.outputTokens);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Reads the latest step from dsh's per-session project cache.
 *
 * `~/.dsh/storages/session_projcache/sessions/<id>.json` is a versioned
 * snapshot dsh rewrites as it runs, so it is both the cheapest and the
 * freshest source. `tokenUsage.last.buckets` is the current step and
 * `contextPressure.contextWindow` the model's real window (dsh knows the model
 * better than app config does). Returns null when the file/step is absent, so
 * the caller can fall back to the session log.
 */
export async function readDshTokenUsageFromProjCache(
  sessionId: string,
  options: { dshHome?: string; contextWindow?: number } = {},
): Promise<DshSessionTokenUsage | null> {
  if (!sessionId) {
    return null;
  }
  const home = options.dshHome?.trim() || resolveDshHome();
  const cachePath = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);

  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
  } catch {
    return null;
  }

  const rows = readObject(readObject(readObject(raw)?.record)?.rows);
  const tokenUsage = readObject(readObject(rows?.tokenUsage)?.val);
  const last = readObject(readObject(tokenUsage?.last)?.buckets);
  if (!last) {
    return null;
  }

  const nativeWindow = readNumber(readObject(readObject(rows?.contextPressure)?.val)?.contextWindow);
  // dsh knows the model's real window (e.g. 1M for a long-context route); the
  // caller/config value is only a fallback for snapshots without it.
  const contextWindow = nativeWindow
    || (options.contextWindow && options.contextWindow > 0 ? options.contextWindow : configuredContextWindow());

  return buildDshTokenUsage(last, contextWindow);
}

/**
 * Reads the newest `assistant/message` usage record out of a dsh session log.
 *
 * The log records one usage object per model step; the LAST one is the current
 * context. Records are decoded frame-by-frame and ordered by `seq`, so a torn
 * tail write cannot resurrect an older step. Returns null when the log has no
 * usage yet.
 */
export async function readDshTokenUsageFromLog(
  logPath: string | null | undefined,
  contextWindow: number,
): Promise<DshSessionTokenUsage | null> {
  if (!logPath) {
    return null;
  }

  let records: Array<Record<string, unknown>>;
  try {
    records = parseDshSessionRecords(decodeDshSessionLog(await fsp.readFile(logPath)));
  } catch {
    return null;
  }

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.type !== 'assistant/message') {
      continue;
    }
    const usage = readObject(readObject(record.data)?.usage);
    if (usage) {
      return buildDshTokenUsage(usage, contextWindow);
    }
  }
  return null;
}

/**
 * Resolves the current context usage for one dsh session.
 *
 * Sources in preference order: the projcache snapshot (fresh, carries the
 * model's own context window), the indexed session log path, then the log
 * located by scanning the sessions root. Returns null when nothing has been
 * written yet (a brand-new session before its first step).
 */
export async function resolveDshSessionTokenUsage(options: {
  sessionId: string;
  projectPath?: string | null;
  logPath?: string | null;
  dshHome?: string;
  contextWindow?: number;
}): Promise<DshSessionTokenUsage | null> {
  const home = options.dshHome?.trim() || resolveDshHome();
  const contextWindow = options.contextWindow && options.contextWindow > 0
    ? options.contextWindow
    : configuredContextWindow();

  const fromCache = await readDshTokenUsageFromProjCache(options.sessionId, {
    dshHome: home,
    contextWindow,
  });
  if (fromCache) {
    return fromCache;
  }

  if (options.logPath) {
    const fromIndexedLog = await readDshTokenUsageFromLog(options.logPath, contextWindow);
    if (fromIndexedLog) {
      return fromIndexedLog;
    }
  }

  if (!options.sessionId) {
    return null;
  }
  const located = await findDshSessionLogFile(
    path.join(home, 'sessions'),
    options.projectPath,
    options.sessionId,
  );
  return readDshTokenUsageFromLog(located, contextWindow);
}
