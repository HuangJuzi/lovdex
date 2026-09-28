import assert from 'node:assert/strict';
import test from 'node:test';

import { inboxReducer, countUnread, selectUnreadTone, selectUnannouncedImportant, type InboxState, type InboxNotification } from '../inboxStore.pure.js';

const n = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1', severity: 'warning', title: 'A', read_at: null,
  occurrence_count: 1, ...over,
});

test('countUnread 只数 read_at 为空的', () => {
  const rows = [n({ notification_id: 'a' }), n({ notification_id: 'b', read_at: 'now' })];
  assert.equal(countUnread(rows), 1);
});

test('countUnread 计入 info（2026-09-28 口径对齐，与后端 unread-count 一致）', () => {
  const rows = [n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })];
  assert.equal(countUnread(rows), 2);
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

test('selectUnreadTone：无未读时返回 null', () => {
  assert.equal(selectUnreadTone([]), null);
  assert.equal(selectUnreadTone([n({ read_at: 'now' })]), null);
});

test('selectUnreadTone：未读里的最高严重度决定色调', () => {
  assert.equal(selectUnreadTone([n({ severity: 'info' })]), 'info');
  assert.equal(
    selectUnreadTone([n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })]),
    'warning',
  );
  assert.equal(
    selectUnreadTone([
      n({ notification_id: 'a', severity: 'info' }),
      n({ notification_id: 'b', severity: 'warning' }),
      n({ notification_id: 'c', severity: 'critical' }),
    ]),
    'critical',
  );
  // 降序输入：last-wins 的实现会在这里返回 'info'
  assert.equal(
    selectUnreadTone([
      n({ notification_id: 'a', severity: 'critical' }),
      n({ notification_id: 'b', severity: 'warning' }),
      n({ notification_id: 'c', severity: 'info' }),
    ]),
    'critical',
  );
  // 单条 warning 在 info 之前，同样堵 last-wins
  assert.equal(
    selectUnreadTone([
      n({ notification_id: 'd', severity: 'warning' }),
      n({ notification_id: 'e', severity: 'info' }),
    ]),
    'warning',
  );
});

test('selectUnreadTone：已读的严重项不抬升色调', () => {
  const rows = [
    n({ notification_id: 'a', severity: 'info' }),
    n({ notification_id: 'b', severity: 'critical', read_at: 'now' }),
  ];
  assert.equal(selectUnreadTone(rows), 'info');
});
