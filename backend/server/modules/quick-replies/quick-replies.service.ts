import { AppError } from '@/shared/utils.js';
import type { QuickRepliesDb, QuickReplyRow } from './quick-replies.db.js';

/**
 * 业务规则：正文 trim 后不能为空；trim 后不能与已有条目完全相同。
 * 拒绝重复的理由——条目没有标题，两条一模一样的正文在列表里完全无法区分。
 */
export function createQuickRepliesService(db: QuickRepliesDb) {
  const notFound = () => new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });

  const normalizeContent = (content: string, excludeId?: string): string => {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new AppError('常用语内容不能为空', { code: 'QUICK_REPLY_EMPTY', statusCode: 400 });
    }
    const existing = db.findByContent(trimmed);
    if (existing && existing.quick_reply_id !== excludeId) {
      throw new AppError('该常用语已存在', { code: 'QUICK_REPLY_DUPLICATE', statusCode: 409 });
    }
    return trimmed;
  };

  return {
    list(): QuickReplyRow[] {
      return db.list();
    },

    create(content: string): QuickReplyRow {
      return db.create(normalizeContent(content));
    },

    update(id: string, content: string): QuickReplyRow {
      // 先查存在再校验内容：重复检查拿 excludeId 比对，对不存在的 id 恒为不等，
      // 顺序反过来会把「改一个不存在的 id」误报成 409，而规则要求 404 优先。
      if (!db.get(id)) {
        throw notFound();
      }
      const row = db.update(id, normalizeContent(content, id));
      if (!row) {
        throw notFound();
      }
      return row;
    },

    remove(id: string): void {
      if (!db.remove(id)) {
        throw notFound();
      }
    },

    use(id: string): QuickReplyRow {
      const row = db.touch(id);
      if (!row) {
        throw notFound();
      }
      return row;
    },
  };
}

export type QuickRepliesService = ReturnType<typeof createQuickRepliesService>;
