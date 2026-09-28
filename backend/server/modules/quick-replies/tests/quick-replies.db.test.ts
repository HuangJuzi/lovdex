import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { QUICK_REPLIES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { createQuickRepliesDb } from '@/modules/quick-replies/quick-replies.db.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
  return { db, repo: createQuickRepliesDb(db) };
}

/**
 * created_at / last_used_at 都是 CURRENT_TIMESTAMP，只有秒级精度，同一个测试里
 * 连续调用分不出先后。需要可区分的顺序时直接写死时间戳，不要 sleep。
 */
function setLastUsed(db: Database.Database, id: string, value: string | null) {
  db.prepare('UPDATE quick_replies SET last_used_at = ? WHERE quick_reply_id = ?').run(value, id);
}

test('create 新建一条，last_used_at 为空', () => {
  const { repo } = makeDb();
  const row = repo.create('继续');
  assert.equal(row.content, '继续');
  assert.equal(row.last_used_at, null);
  assert.ok(row.quick_reply_id);
  assert.ok(row.created_at);
});

test('list 按最后使用时间倒序', () => {
  const { db, repo } = makeDb();
  const a = repo.create('A');
  const b = repo.create('B');
  const c = repo.create('C');
  setLastUsed(db, a.quick_reply_id, '2026-01-01 00:00:00');
  setLastUsed(db, b.quick_reply_id, '2026-02-01 00:00:00');
  setLastUsed(db, c.quick_reply_id, '2026-03-01 00:00:00');
  assert.deepEqual(repo.list().map((r) => r.content), ['C', 'B', 'A']);
});

test('list 把从未使用过的条目排在最后', () => {
  const { db, repo } = makeDb();
  const unused = repo.create('没用过');
  const used = repo.create('用过');
  setLastUsed(db, used.quick_reply_id, '2026-01-01 00:00:00');
  assert.deepEqual(repo.list().map((r) => r.content), ['用过', '没用过']);
});

test('update 改正文并刷新 updated_at', () => {
  const { db, repo } = makeDb();
  const row = repo.create('旧正文');
  db.prepare(
    "UPDATE quick_replies SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00' WHERE quick_reply_id = ?",
  ).run(row.quick_reply_id);

  const updated = repo.update(row.quick_reply_id, '新正文');
  assert.equal(updated?.content, '新正文');
  assert.notEqual(updated?.updated_at, '2020-01-01 00:00:00');
});

test('update 不存在的 id 返回 null', () => {
  const { repo } = makeDb();
  assert.equal(repo.update('nope', 'x'), null);
});

test('remove 删掉后 list 不再包含它', () => {
  const { repo } = makeDb();
  const row = repo.create('待删');
  assert.equal(repo.remove(row.quick_reply_id), true);
  assert.deepEqual(repo.list(), []);
});

test('remove 不存在的 id 返回 false', () => {
  const { repo } = makeDb();
  assert.equal(repo.remove('nope'), false);
});

test('touch 刷新 last_used_at', () => {
  const { repo } = makeDb();
  const row = repo.create('继续');
  assert.equal(row.last_used_at, null);
  const touched = repo.touch(row.quick_reply_id);
  assert.notEqual(touched?.last_used_at, null);
});

test('touch 不存在的 id 返回 null', () => {
  const { repo } = makeDb();
  assert.equal(repo.touch('nope'), null);
});

test('findByContent 命中已存在的正文，未命中返回 null', () => {
  const { repo } = makeDb();
  const row = repo.create('继续');
  assert.equal(repo.findByContent('继续')?.quick_reply_id, row.quick_reply_id);
  assert.equal(repo.findByContent('没这条'), null);
});
