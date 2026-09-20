import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { NOTIFICATIONS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { createNotificationsDb } from '@/modules/notifications/notifications.db.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(NOTIFICATIONS_TABLE_SCHEMA_SQL);
  return createNotificationsDb(db);
}

test('insert 新建一条未读通知', () => {
  const repo = makeDb();
  const row = repo.upsert({
    severity: 'warning', title: 'A', dedupeKey: 's1:disk_full',
    scheduleId: 's1', taskId: 't1', sessionId: 'sess1', projectPath: '/p', code: 'disk_full',
  });
  assert.equal(row.occurrence_count, 1);
  assert.equal(row.read_at, null);
  assert.equal(row.title, 'A');
});

test('同 dedupe_key 未读命中：计数++ 并刷新，不新建', () => {
  const repo = makeDb();
  const first = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 's1:disk_full' });
  const second = repo.upsert({ severity: 'warning', title: 'A2', dedupeKey: 's1:disk_full', body: '新详情' });
  assert.equal(first.notification_id, second.notification_id);
  assert.equal(second.occurrence_count, 2);
  assert.equal(second.title, 'A2');
  assert.equal(second.body, '新详情');
  assert.equal(repo.list({ limit: 50, offset: 0 }).length, 1);
});

test('同 dedupe_key 但已读：复活原条（read_at 清空、计数++）', () => {
  const repo = makeDb();
  const first = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 's1:disk_full' });
  repo.markRead(first.notification_id);
  const revived = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 's1:disk_full' });
  assert.equal(revived.notification_id, first.notification_id);
  assert.equal(revived.read_at, null);
  assert.equal(revived.occurrence_count, 2);
});

test('unreadCount 只数未读', () => {
  const repo = makeDb();
  const a = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 'k:a' });
  repo.upsert({ severity: 'critical', title: 'B', dedupeKey: 'k:b' });
  assert.equal(repo.unreadCount(), 2);
  repo.markRead(a.notification_id);
  assert.equal(repo.unreadCount(), 1);
});

test('markAllRead 全部置已读', () => {
  const repo = makeDb();
  repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 'k:a' });
  repo.upsert({ severity: 'warning', title: 'B', dedupeKey: 'k:b' });
  repo.markAllRead();
  assert.equal(repo.unreadCount(), 0);
});

test('list 按 created_at 倒序 + 分页', () => {
  const repo = makeDb();
  for (let i = 0; i < 5; i++) repo.upsert({ severity: 'info', title: `T${i}`, dedupeKey: `k:${i}` });
  const page = repo.list({ limit: 2, offset: 0 });
  assert.equal(page.length, 2);
});

test('pruneOldRead 只裁剪已读、保留未读', () => {
  const repo = makeDb();
  const a = repo.upsert({ severity: 'info', title: 'A', dedupeKey: 'k:a' });
  repo.upsert({ severity: 'warning', title: 'B', dedupeKey: 'k:b' });
  repo.markRead(a.notification_id);
  const removed = repo.pruneOldRead({ maxRows: 1 }); // 只留 1 条 → 裁掉已读的 A
  assert.equal(removed, 1);
  assert.equal(repo.list({ limit: 50, offset: 0 }).length, 1);
  assert.equal(repo.unreadCount(), 1); // 未读 B 还在
});
