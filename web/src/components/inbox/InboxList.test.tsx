import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { InboxNotification } from '../../stores/inboxStore.pure';

import { InboxList } from './InboxList';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const mk = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1',
  severity: 'critical',
  title: '任务执行失败',
  body: 'backend typecheck 新增 3 个错误',
  code: null,
  task_id: 't1',
  session_id: null,
  occurrence_count: 1,
  read_at: null,
  first_seen_at: '2026-09-21T11:58:00.000Z',
  last_seen_at: '2026-09-21T11:58:00.000Z',
  ...over,
});

const render = (items: InboxNotification[], selectedId: string | null = null) =>
  renderToStaticMarkup(
    <InboxList items={items} selectedId={selectedId} now={NOW} onSelect={() => {}} />,
  );

test('空列表显示空态', () => {
  assert.ok(render([]).includes('暂无通知'));
});

test('渲染标题与相对时间', () => {
  const html = render([mk()]);
  assert.ok(html.includes('任务执行失败'));
  assert.ok(html.includes('2 分钟前'), '应渲染相对时间');
});

test('未读行带未读圆点，已读行不带', () => {
  const unread = render([mk()]);
  const read = render([mk({ read_at: '2026-09-21T11:59:00.000Z' })]);
  assert.ok(unread.includes('data-unread="true"'), '未读行应标记 data-unread');
  assert.ok(read.includes('data-unread="false"'), '已读行应标记 data-unread=false');
});

test('选中行标记 data-selected', () => {
  assert.ok(render([mk()], 'n1').includes('data-selected="true"'));
  assert.ok(render([mk()]).includes('data-selected="false"'));
});

test('occurrence_count > 1 时展示 ×N', () => {
  assert.ok(render([mk({ occurrence_count: 3 })]).includes('×3'));
  assert.ok(!render([mk()]).includes('×1'), 'count 为 1 时不展示');
});

test('已读行整行降透明度', () => {
  assert.ok(render([mk({ read_at: '2026-09-21T11:59:00.000Z' })]).includes('opacity-55'));
});
