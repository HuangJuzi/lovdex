import { AppError } from '@/shared/utils.js';
import type { QuickRepliesDb, QuickReplyRow } from './quick-replies.db.js';

/**
 * 业务规则：正文 trim 后不能为空；trim 后不能与已有条目完全相同。
 * 拒绝重复的理由——条目没有标题，两条一模一样的正文在列表里完全无法区分。
 */
export function createQuickRepliesService(db: QuickRepliesDb) {
  const assertContentUsable = (content: string, excludeId?: string): string => {
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
      return db.create(assertContentUsable(content));
    },

    update(id: string, content: string): QuickReplyRow {
      const trimmed = assertContentUsable(content, id);
      const row = db.update(id, trimmed);
      if (!row) {
        throw new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });
      }
      return row;
    },

    remove(id: string): void {
      if (!db.remove(id)) {
        throw new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });
      }
    },

    use(id: string): QuickReplyRow {
      const row = db.touch(id);
      if (!row) {
        throw new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });
      }
      return row;
    },
  };
}

export type QuickRepliesService = ReturnType<typeof createQuickRepliesService>;
