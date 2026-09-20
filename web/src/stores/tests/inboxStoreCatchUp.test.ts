import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../utils/api.js';
import {
  applyInboxEvent,
  claimUnannouncedImportant,
  refreshInbox,
  getInboxSnapshot,
} from '../inboxStore.js';
import type { InboxNotification } from '../inboxStore.pure.js';

const n = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1', severity: 'warning', title: 'A', read_at: null,
  occurrence_count: 1, ...over,
});

/** 替换 REST 全量拉取，模拟"重连后 refetch 到的服务端状态"。 */
function stubList(rows: InboxNotification[]) {
  api.notifications.list = (async () => ({ ok: true, json: async () => rows })) as never;
}

test('断线期间产生的通知：refetch 后会被补推，且只补一次', async () => {
  // 手机切后台 → WS 断开 → 这期间后端发了这两条 → 重连后只有全量拉取能发现。
  stubList([n({ notification_id: 'missed-warn' }), n({ notification_id: 'missed-info', severity: 'info' })]);
  await refreshInbox();

  const fresh = claimUnannouncedImportant();
  assert.deepEqual(fresh.map((r) => r.notification_id), ['missed-warn']);

  // 第二次（例如又抖了一次重连）不能再弹 —— 本次会话已经打扰过了。
  assert.deepEqual(claimUnannouncedImportant(), []);
});

test('实时 toast 过的那条，重连时不会被汇总再弹一次', () => {
  const row = n({ notification_id: 'live-warn' });
  assert.notEqual(applyInboxEvent({ kind: 'notification_created', payload: row }), null);

  assert.equal(
    claimUnannouncedImportant().some((r) => r.notification_id === 'live-warn'),
    false,
  );
});

test('实时到达的 info 不进补推（它本来就不弹窗）', () => {
  applyInboxEvent({ kind: 'notification_created', payload: n({ notification_id: 'live-info', severity: 'info' }) });

  assert.equal(
    claimUnannouncedImportant().some((r) => r.notification_id === 'live-info'),
    false,
  );
});

test('已在收件箱读过的条不会被补推', async () => {
  stubList([n({ notification_id: 'already-read', read_at: '2026-09-21 00:00:00' })]);
  await refreshInbox();

  assert.deepEqual(claimUnannouncedImportant(), []);
});

test('refetch 后 store 快照同步（角标与列表拿到的是同一份数据）', async () => {
  stubList([n({ notification_id: 'snap-1' })]);
  await refreshInbox();
  assert.equal(getInboxSnapshot().items[0].notification_id, 'snap-1');
});
