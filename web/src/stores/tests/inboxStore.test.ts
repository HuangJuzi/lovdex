import assert from 'node:assert/strict';
import test from 'node:test';

import { inboxReducer, countUnread, selectUnannouncedImportant, type InboxState, type InboxNotification } from '../inboxStore.pure.js';

const n = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1', severity: 'warning', title: 'A', read_at: null,
  occurrence_count: 1, ...over,
});

test('countUnread 只数 read_at 为空的', () => {
  const rows = [n({ notification_id: 'a' }), n({ notification_id: 'b', read_at: 'now' })];
  assert.equal(countUnread(rows), 1);
});

test('countUnread 排除 info（spec §5）', () => {
  const rows = [n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })];
  assert.equal(countUnread(rows), 1);
});

test('created：新条插到最前', () => {
  const state: InboxState = { items: [n({ notification_id: 'a' })] };
  const next = inboxReducer(state, { type: 'created', row: n({ notification_id: 'b' }) });
  assert.equal(next.items[0].notification_id, 'b');
});

test('created：同 id 幂等（不重复插）', () => {
  const state: InboxState = { items: [n({ notification_id: 'a' })] };
  const next = inboxReducer(state, { type: 'created', row: n({ notification_id: 'a', title: 'A2' }) });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].title, 'A2');
});

test('updated：替换已存在条', () => {
  const state: InboxState = { items: [n({ notification_id: 'a', occurrence_count: 1 })] };
  const next = inboxReducer(state, { type: 'updated', row: n({ notification_id: 'a', occurrence_count: 5 }) });
  assert.equal(next.items[0].occurrence_count, 5);
});

test('replaceAll：整表替换（refetch / 重连）', () => {
  const state: InboxState = { items: [n({ notification_id: 'a' })] };
  const next = inboxReducer(state, { type: 'replaceAll', rows: [n({ notification_id: 'x' }), n({ notification_id: 'y' })] });
  assert.equal(next.items.length, 2);
});

test('markReadLocal：本地置已读', () => {
  const state: InboxState = { items: [n({ notification_id: 'a', read_at: null })] };
  const next = inboxReducer(state, { type: 'markReadLocal', id: 'a' });
  assert.equal(next.items[0].read_at !== null, true);
});

test('selectUnannouncedImportant：只挑未读、非 info、且没打扰过的', () => {
  const rows = [
    n({ notification_id: 'a' }),                     // 未读 warning → 命中
    n({ notification_id: 'b', severity: 'info' }),   // info 不进角标也不打扰 → 排除
    n({ notification_id: 'c', read_at: 'now' }),     // 已读 → 排除
    n({ notification_id: 'd' }),                     // 未读 warning 但已记账 → 排除
  ];
  const fresh = selectUnannouncedImportant(rows, new Set(['d']));
  assert.deepEqual(fresh.map((r) => r.notification_id), ['a']);
});

test('selectUnannouncedImportant：全空/全已读时返回空', () => {
  assert.deepEqual(selectUnannouncedImportant([], new Set()), []);
  const read = [n({ notification_id: 'a', read_at: 'now' })];
  assert.deepEqual(selectUnannouncedImportant(read, new Set()), []);
});
