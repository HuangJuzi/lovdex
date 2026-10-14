import type { MentionableFile } from '../hooks/useFileMentions';

/**
 * @ 文件下拉框的截断上限。旧值 10 在空查询时只露出字典序前 10 条，
 * 用户体感就是「列不出文件」；50 条配合下拉框自身的 max-h 滚动足够浏览。
 */
export const FILE_MENTION_LIMIT = 50;

type MatchTier = 0 | 1 | 2;

// 相关性分档：name 前缀 > name 包含 > path 包含。同档保持树的字典序。
function matchTier(file: MentionableFile, query: string): MatchTier | null {
  const name = file.name.toLowerCase();
  const path = file.path.toLowerCase();
  if (name.startsWith(query)) {
    return 0;
  }
  if (name.includes(query)) {
    return 1;
  }
  if (path.includes(query)) {
    return 2;
  }
  return null;
}

export function matchFiles(
  files: MentionableFile[],
  query: string,
  limit = FILE_MENTION_LIMIT,
): MentionableFile[] {
  const normalizedQuery = query.toLowerCase();
  return files
    .map((file) => ({ file, tier: matchTier(file, normalizedQuery) }))
    .filter((entry): entry is { file: MentionableFile; tier: MatchTier } => entry.tier !== null)
    .sort((a, b) => a.tier - b.tier)
    .map((entry) => entry.file)
    .slice(0, limit);
}
