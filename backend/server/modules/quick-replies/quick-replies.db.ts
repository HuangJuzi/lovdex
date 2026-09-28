import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type QuickReplyRow = {
  quick_reply_id: string;
  content: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

/**
 * DI 工厂：默认用生产共享连接（getConnection），测试传入内存库。
 * 调用方必须保证 quick_replies 表已建表——生产路径是在 startServer() 里
 * `await initializeDatabase()` 之后才 new，否则下面的 prepare 会抛 no such table。
 */
export function createQuickRepliesDb(connection?: BetterSqlite3.Database) {
  const db = connection ?? getConnection();

  const getById = db.prepare<[string]>('SELECT * FROM quick_replies WHERE quick_reply_id = ?');

  const repo = {
    /**
     * 排序第一键 `last_used_at IS NULL` 不能省：SQLite 的 DESC 虽然默认把 NULL
     * 放最后，但依赖这个隐式行为太脆。显式写出来，并由测试守住「没用过的沉底」。
     */
    list(): QuickReplyRow[] {
      return db.prepare(
        'SELECT * FROM quick_replies ORDER BY last_used_at IS NULL, last_used_at DESC, created_at DESC',
      ).all() as QuickReplyRow[];
    },

    get(id: string): QuickReplyRow | null {
      return (getById.get(id) as QuickReplyRow | undefined) ?? null;
    },

    create(content: string): QuickReplyRow {
      const id = randomUUID();
      db.prepare('INSERT INTO quick_replies (quick_reply_id, content) VALUES (?, ?)').run(id, content);
      // 主键是应用层生成的 UUID，插入后直接按 id 读回即可，不需要 RETURNING。
      return repo.get(id) as QuickReplyRow;
    },

    update(id: string, content: string): QuickReplyRow | null {
      const info = db.prepare(
        'UPDATE quick_replies SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE quick_reply_id = ?',
      ).run(content, id);
      if (info.changes === 0) return null;
      return repo.get(id);
    },

    remove(id: string): boolean {
      return db.prepare('DELETE FROM quick_replies WHERE quick_reply_id = ?').run(id).changes > 0;
    },

    touch(id: string): QuickReplyRow | null {
      const info = db.prepare(
        'UPDATE quick_replies SET last_used_at = CURRENT_TIMESTAMP WHERE quick_reply_id = ?',
      ).run(id);
      if (info.changes === 0) return null;
      return repo.get(id);
    },

    findByContent(content: string): QuickReplyRow | null {
      return (db.prepare('SELECT * FROM quick_replies WHERE content = ? LIMIT 1').get(content) as
        | QuickReplyRow
        | undefined) ?? null;
    },
  };

  return repo;
}

export type QuickRepliesDb = ReturnType<typeof createQuickRepliesDb>;
