import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionAlertScanner } from '@/modules/notifications/session-alert-scanner.js';

const text = (content: string) => ({ kind: 'text', role: 'assistant', content });
const ALERT_BLOCK = '```lovdex-alert\n{"severity":"warning","title":"磁盘满","code":"disk_full"}\n```';

function harness(opts: { isOperator?: boolean; task?: unknown } = {}) {
  const emitted: Array<Record<string, unknown>> = [];
  const scanner = createSessionAlertScanner({
    getSessionById: () => ({ is_operator: opts.isOperator ? 1 : 0 }),
    getTaskBySession: () => (opts.task ?? null) as never,
    notifications: { emit: (i: Record<string, unknown>) => { emitted.push(i); return {} as never; } } as never,
  });
  return { scanner, emitted };
}

test('从 run.events 提取标记并 emit', () => {
  const { scanner, emitted } = harness();
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(`巡检完成\n${ALERT_BLOCK}`)] });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].severity, 'warning');
  assert.equal(emitted[0].title, '磁盘满');
  assert.equal(emitted[0].code, 'disk_full');
  assert.equal(emitted[0].sessionId, 's1');
});

test('无标记时不 emit', () => {
  const { scanner, emitted } = harness();
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text('一切正常，无需通知')] });
  assert.equal(emitted.length, 0);
});

test('operator 会话被跳过（助手走 send_notification 工具）', () => {
  const { scanner, emitted } = harness({ isOperator: true });
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] });
  assert.equal(emitted.length, 0);
});

test('关联 task 时带上 task_id / schedule_id / project_path', () => {
  const { scanner, emitted } = harness({
    task: { task_id: 't1', source_schedule_id: 'sch1', project_path: '/p' },
  });
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] });
  assert.equal(emitted[0].taskId, 't1');
  assert.equal(emitted[0].scheduleId, 'sch1');
  assert.equal(emitted[0].projectPath, '/p');
});

test('无关联 task 时 taskId/scheduleId 为 null，但 sessionId 仍在（通知可点击）', () => {
  const { scanner, emitted } = harness();
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] });
  assert.equal(emitted[0].taskId, null);
  assert.equal(emitted[0].scheduleId, null);
  assert.equal(emitted[0].sessionId, 's1');
});

test('多个标记逐个 emit', () => {
  const { scanner, emitted } = harness();
  const two = '```lovdex-alert\n{"severity":"critical","title":"A"}\n```\n```lovdex-alert\n{"severity":"info","title":"B"}\n```';
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(two)] });
  assert.equal(emitted.length, 2);
});

test('依赖抛错时吞掉不外抛（不影响会话生命周期）', () => {
  const scanner = createSessionAlertScanner({
    getSessionById: () => { throw new Error('boom'); },
    getTaskBySession: () => null,
    notifications: { emit: () => ({}) as never } as never,
  });
  assert.doesNotThrow(() => scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] }));
});
