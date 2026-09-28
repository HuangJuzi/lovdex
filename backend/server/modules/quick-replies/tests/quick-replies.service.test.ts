import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { QUICK_REPLIES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { AppError } from '@/shared/utils.js';
import { createQuickRepliesDb } from '@/modules/quick-replies/quick-replies.db.js';
import { createQuickRepliesService } from '@/modules/quick-replies/quick-replies.service.js';

function makeService() {
  const db = new Database(':memory:');
  db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
  return createQuickRepliesService(createQuickRepliesDb(db));
}

/** 断言抛出的 AppError 带指定 code 与 HTTP 状态。 */
function throwsWith(code: string, statusCode: number) {
  return (error: unknown) =>
    error instanceof AppError && error.code === code && error.statusCode === statusCode;
}

test('create 保存 trim 后的正文', () => {
  const svc = makeService();
  assert.equal(svc.create('  继续  ').content, '继续');
});

test('create 拒绝空白正文', () => {
  const svc = makeService();
  assert.throws(() => svc.create('   '), throwsWith('QUICK_REPLY_EMPTY', 400));
});

test('create 拒绝重复正文（trim 后比较）', () => {
  const svc = makeService();
  svc.create('继续');
  assert.throws(() => svc.create('  继续  '), throwsWith('QUICK_REPLY_DUPLICATE', 409));
});

test('update 改正文', () => {
  const svc = makeService();
  const row = svc.create('旧');
  assert.equal(svc.update(row.quick_reply_id, ' 新 ').content, '新');
});

test('update 拒绝空白正文', () => {
  const svc = makeService();
  const row = svc.create('继续');
  assert.throws(() => svc.update(row.quick_reply_id, ''), throwsWith('QUICK_REPLY_EMPTY', 400));
});

test('update 拒绝与别的条目重复', () => {
  const svc = makeService();
  svc.create('A');
  const b = svc.create('B');
  assert.throws(() => svc.update(b.quick_reply_id, 'A'), throwsWith('QUICK_REPLY_DUPLICATE', 409));
});

test('update 允许保存自己原来的正文', () => {
  const svc = makeService();
  const row = svc.create('A');
  assert.equal(svc.update(row.quick_reply_id, 'A').content, 'A');
});

test('update 目标不存在抛 404', () => {
  const svc = makeService();
  assert.throws(() => svc.update('nope', 'A'), throwsWith('QUICK_REPLY_NOT_FOUND', 404));
});

test('use 刷新 last_used_at，目标不存在抛 404', () => {
  const svc = makeService();
  const row = svc.create('继续');
  assert.notEqual(svc.use(row.quick_reply_id).last_used_at, null);
  assert.throws(() => svc.use('nope'), throwsWith('QUICK_REPLY_NOT_FOUND', 404));
});

test('remove 删掉，目标不存在抛 404', () => {
  const svc = makeService();
  const row = svc.create('待删');
  svc.remove(row.quick_reply_id);
  assert.throws(() => svc.remove(row.quick_reply_id), throwsWith('QUICK_REPLY_NOT_FOUND', 404));
});
