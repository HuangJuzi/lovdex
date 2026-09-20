import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAlertsFromMessages } from '@/modules/notifications/alert-parser.js';

const msg = (content: string, role: 'assistant' | 'user' = 'assistant') => ({ kind: 'text', role, content });

test('提取单个合法标记', () => {
  const alerts = parseAlertsFromMessages([
    msg('巡检完成。\n```lovdex-alert\n{"severity":"warning","title":"/var 剩余 3%"}\n```'),
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.equal(alerts[0].title, '/var 剩余 3%');
});

test('提取同一条消息里的多个标记', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"severity":"critical","title":"A"}\n```\n中间\n```lovdex-alert\n{"severity":"info","title":"B","code":"ok"}\n```'),
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map(a => a.title), ['A', 'B']);
});

test('扫描全部 assistant 文本，不止最后一条', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"severity":"warning","title":"早期告警"}\n```'),
    msg('后续一大段无关的收尾说明……'),
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, '早期告警');
});

test('非法 JSON 被丢弃', () => {
  const alerts = parseAlertsFromMessages([msg('```lovdex-alert\n{不是 json}\n```')]);
  assert.equal(alerts.length, 0);
});

test('缺 severity 或 title 被丢弃', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"title":"没有 severity"}\n```'),
    msg('```lovdex-alert\n{"severity":"warning"}\n```'),
  ]);
  assert.equal(alerts.length, 0);
});

test('非法 severity 被丢弃', () => {
  const alerts = parseAlertsFromMessages([msg('```lovdex-alert\n{"severity":"fatal","title":"x"}\n```')]);
  assert.equal(alerts.length, 0);
});

test('忽略非 text / 非 assistant 消息', () => {
  const alerts = parseAlertsFromMessages([
    { kind: 'tool_use', role: 'assistant', content: '```lovdex-alert\n{"severity":"warning","title":"工具里的不算"}\n```' },
    msg('```lovdex-alert\n{"severity":"warning","title":"用户消息里的不算"}\n```', 'user'),
  ]);
  assert.equal(alerts.length, 0);
});

test('保留可选字段 body / code', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"severity":"critical","title":"磁盘满","body":"97%","code":"disk_full"}\n```'),
  ]);
  assert.equal(alerts[0].body, '97%');
  assert.equal(alerts[0].code, 'disk_full');
});
