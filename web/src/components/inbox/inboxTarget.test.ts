import test from 'node:test';
import assert from 'node:assert/strict';

import type { InboxNotification } from '../../stores/inboxStore.pure';

import { inboxTargetPath, severityLabel, sourceLabel } from './inboxTarget';

const mk = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1',
  severity: 'warning',
  title: '测试通知',
  body: null,
  code: null,
  task_id: null,
  session_id: null,
  occurrence_count: 1,
  read_at: null,
  first_seen_at: '2026-09-21T00:00:00.000Z',
  last_seen_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

test('有 task_id 时跳任务页（优先级高于 session_id）', () => {
  assert.equal(inboxTargetPath(mk({ task_id: 't1', session_id: 's1' })), '/task/t1');
});

test('只有 session_id 时跳会话页', () => {
  assert.equal(inboxTargetPath(mk({ session_id: 's1' })), '/session/s1');
});

test('skill_update 且无关联时跳技能设置页', () => {
  assert.equal(inboxTargetPath(mk({ code: 'skill_update' })), '/settings?tab=skills');
});

test('无任何关联时返回 null（行不可点）', () => {
  assert.equal(inboxTargetPath(mk()), null);
});

test('来源标签：skill_update 优先于关联关系', () => {
  assert.equal(sourceLabel(mk({ code: 'skill_update', task_id: 't1' })), '技能');
});

test('来源标签：按关联关系兜底，不看 code 字面量', () => {
  // code 是用户自由文本（如 disk_full），不能据此建分类表
  assert.equal(sourceLabel(mk({ task_id: 't1', code: 'disk_full' })), '任务');
  assert.equal(sourceLabel(mk({ session_id: 's1' })), '会话');
  assert.equal(sourceLabel(mk({ code: 'disk_full' })), '系统');
});

test('严重度中文名', () => {
  assert.equal(severityLabel('critical'), '严重');
  assert.equal(severityLabel('warning'), '警告');
  assert.equal(severityLabel('info'), '信息');
});
