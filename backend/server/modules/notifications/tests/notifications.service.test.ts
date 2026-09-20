import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotificationsService } from '@/modules/notifications/notifications.service.js';
import type { NotificationRow } from '@/modules/notifications/notifications.db.js';

function fakeRow(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    notification_id: 'n1', severity: 'warning', code: null, title: 'A', body: null,
    schedule_id: null, task_id: null, session_id: null, project_path: null,
    dedupe_key: 'k', occurrence_count: 1,
    first_seen_at: 't', last_seen_at: 't', read_at: null, created_at: 't',
    ...over,
  };
}

function makeHarness(existingByKey = new Map<string, NotificationRow>()) {
  const broadcasts: Array<{ kind: string; payload: unknown }> = [];
  let pruneCalls = 0;
  const db = {
    upsert: (input: { dedupeKey: string; title: string }) => {
      const prev = existingByKey.get(input.dedupeKey);
      const row = fakeRow({ notification_id: prev?.notification_id ?? `n${existingByKey.size + 1}`, title: input.title, dedupe_key: input.dedupeKey, occurrence_count: (prev?.occurrence_count ?? 0) + 1 });
      existingByKey.set(input.dedupeKey, row);
      return row;
    },
    list: () => [...existingByKey.values()],
    get: (id: string) => [...existingByKey.values()].find(r => r.notification_id === id) ?? null,
    markRead: (id: string) => { const r = [...existingByKey.values()].find(x => x.notification_id === id); if (r) r.read_at = 'now'; return r ?? null; },
    markAllRead: () => { for (const r of existingByKey.values()) r.read_at = 'now'; },
    unreadCount: () => [...existingByKey.values()].filter(r => !r.read_at).length,
    pruneOldRead: () => { pruneCalls++; return 0; },
  };
  const svc = createNotificationsService(db as never, {
    broadcast: (event) => broadcasts.push(event as { kind: string; payload: unknown }),
    maxRows: 500,
  });
  return { svc, broadcasts, getPruneCalls: () => pruneCalls };
}

test('emit 新建 → 广播 notification_created', () => {
  const { svc, broadcasts } = makeHarness();
  svc.emit({ severity: 'warning', title: 'A', scheduleId: 's1', code: 'disk_full' });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].kind, 'notification_created');
});

test('emit 同 schedule+code 再次 → 广播 notification_updated', () => {
  const { svc, broadcasts } = makeHarness();
  svc.emit({ severity: 'warning', title: 'A', scheduleId: 's1', code: 'disk_full' });
  svc.emit({ severity: 'warning', title: 'A2', scheduleId: 's1', code: 'disk_full' });
  assert.equal(broadcasts[1].kind, 'notification_updated');
});

test('dedupeKey：有 schedule 用 schedule+code', () => {
  const seen = new Map<string, NotificationRow>();
  const { svc } = makeHarness(seen);
  svc.emit({ severity: 'warning', title: 'A', scheduleId: 's1', code: 'disk_full' });
  assert.ok(seen.has('s1:disk_full'));
});

test('dedupeKey：无 code 用 title 兜底', () => {
  const seen = new Map<string, NotificationRow>();
  const { svc } = makeHarness(seen);
  svc.emit({ severity: 'warning', title: '磁盘满', taskId: 't1' });
  assert.ok(seen.has('t1:磁盘满'));
});

test('emit 落库后调用 pruneOldRead', () => {
  const { svc, getPruneCalls } = makeHarness();
  svc.emit({ severity: 'info', title: 'A', taskId: 't1' });
  assert.equal(getPruneCalls(), 1);
});

test('markAllRead 广播 notification_updated', () => {
  const { svc, broadcasts } = makeHarness();
  svc.emit({ severity: 'warning', title: 'A', taskId: 't1' });
  svc.markAllRead();
  assert.equal(broadcasts.at(-1)!.kind, 'notification_updated');
});
