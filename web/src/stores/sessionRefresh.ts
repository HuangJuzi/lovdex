import type { NormalizedMessage } from './useSessionStore';

/** 有界刷新下限：至少覆盖初始加载页。 */
export const REFRESH_LIMIT_FLOOR = 20;
/** 有界刷新上限：防止拉全量刷屏。 */
export const MAX_REFRESH_LIMIT = 200;

/**
 * 计算 refreshFromServer 的 limit。
 * - 显式 opts.limit 优先（归一化到 ≥1）。
 * - 默认 = max(当前已加载条数, 下限)，封顶上限。
 */
export function computeRefreshLimit(currentLength: number, opts?: { limit?: number }): number {
  if (opts?.limit !== undefined) {
    return Math.max(1, Math.floor(opts.limit));
  }
  return Math.min(Math.max(currentLength, REFRESH_LIMIT_FLOOR), MAX_REFRESH_LIMIT);
}

/**
 * 合并刷新结果与已加载消息（两者都按时间正序）。
 * - fetched 为空 → 原样返回 existing。
 * - 否则始终按 id 并集：保留不在 fetched 里的旧前缀（避免尾部因新消息右移时丢已加载行），
 *   fetched 覆盖重叠 id（新版本优先）。
 */
export function mergeRefreshedTail(
  existing: NormalizedMessage[],
  fetched: NormalizedMessage[],
): NormalizedMessage[] {
  if (fetched.length === 0) return existing;
  const fetchedIds = new Set(fetched.map((m) => m.id));
  const prefix = existing.filter((m) => !fetchedIds.has(m.id));
  return [...prefix, ...fetched];
}
