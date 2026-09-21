import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { InboxNotification } from '../../stores/inboxStore.pure';

import { InboxDetail } from './InboxDetail';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const mk = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1',
  severity: 'critical',
  title: '任务执行失败',
  body: 'line one\nline two',
  code: null,
  task_id: 't1',
  session_id: 's1',
  occurrence_count: 3,
  read_at: null,
  first_seen_at: '2026-09-21T09:00:00.000Z',
  last_seen_at: '2026-09-21T11:59:00.000Z',
  ...over,
});

const render = (item: InboxNotification | null) =>
  renderToStaticMarkup(
    <InboxDetail item={item} now={NOW} onMarkRead={() => {}} onNavigate={() => {}} />,
  );

test('未选中时显示空态', () => {
  const html = render(null);
  assert.ok(html.includes('从左侧选一条通知'), '应有空态文案');
});

test('正文保留换行（错误堆栈不被压成一行）', () => {
  const html = render(mk());
  assert.ok(html.includes('whitespace-pre-wrap'), '正文容器应保留换行');
  assert.ok(html.includes('line one'), '正文应渲染');
});

test('展示标题、来源标签与重复次数', () => {
  const html = render(mk());
  assert.ok(html.includes('任务执行失败'));
  assert.ok(html.includes('任务'), '来源标签应为「任务」');
  assert.ok(html.includes('×3'), '应展示重复次数');
});

test('按数据条件渲染操作按钮', () => {
  const html = render(mk());
  assert.ok(html.includes('打开会话'), '有 session_id 应出现打开会话');
  assert.ok(html.includes('查看任务'), '有 task_id 应出现查看任务');
  assert.ok(html.includes('标记已读'), '未读应出现标记已读');
});

test('skill_update 通知出现「去更新技能」，且不带任务/会话按钮', () => {
  const html = render(mk({ code: 'skill_update', task_id: null, session_id: null }));
  assert.ok(html.includes('去更新技能'));
  assert.ok(!html.includes('打开会话'));
  assert.ok(!html.includes('查看任务'));
});

test('已读通知不出现「标记已读」', () => {
  const html = render(mk({ read_at: '2026-09-21T11:00:00.000Z' }));
  assert.ok(!html.includes('标记已读'));
});

test('code 原样展示在元信息里（不做翻译）', () => {
  const html = render(mk({ code: 'disk_full' }));
  assert.ok(html.includes('disk_full'));
});
