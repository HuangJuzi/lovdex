import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import type { InboxNotification } from '../../../../stores/inboxStore.pure';

import { InboxEntryView } from './SidebarInboxEntry';

const n = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1', severity: 'info', title: 'A', read_at: null,
  occurrence_count: 1, ...over,
});

// 显式注入快照：renderToStaticMarkup 走的是 useSyncExternalStore 的
// getServerSnapshot，读不到模块级 store 的真实状态（见组件内的注释）。
const render = (
  path: string,
  items: InboxNotification[] = [],
) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <InboxEntryView unread={unreadOf(items)} tone={toneOf(items)} />
    </MemoryRouter>,
  );

/** 与 store 同口径的本地复刻，只用于构造测试输入。 */
const unreadOf = (items: InboxNotification[]) => items.filter((it) => !it.read_at).length;
const toneOf = (items: InboxNotification[]): 'critical' | 'warning' | 'info' | null => {
  const un = items.filter((it) => !it.read_at);
  if (un.some((it) => it.severity === 'critical')) return 'critical';
  if (un.some((it) => it.severity === 'warning')) return 'warning';
  return un.length > 0 ? 'info' : null;
};

test('停在 /inbox 时入口高亮', () => {
  assert.ok(render('/inbox').includes('data-active="true"'));
});

test('其他路由下不高亮', () => {
  assert.ok(render('/').includes('data-active="false"'));
});

test('尾斜杠 /inbox/ 也高亮', () => {
  assert.ok(render('/inbox/').includes('data-active="true"'));
});

/** 取出角标那个 span 的 class 属性；没有角标时返回 null。 */
function badgeClass(html: string): string | null {
  const m = /<span data-tone="([^"]+)" class="([^"]*)"/.exec(html);
  return m ? m[2] : null;
}

test('未读全是 info 时也渲染数字角标，且用中性灰', () => {
  const html = render('/', [n({ severity: 'info' })]);
  assert.ok(html.includes('>1<'), '应渲染未读数 1');
  assert.match(badgeClass(html) ?? '', /\bbg-muted\b/, 'info 色调应中性灰');
  assert.doesNotMatch(badgeClass(html) ?? '', /bg-destructive/, 'info 不应是红底');
  assert.doesNotMatch(badgeClass(html) ?? '', /bg-warning/, 'info 不应是琥珀底');
});

test('未读含 warning 时角标用琥珀色', () => {
  const html = render('/', [n({ severity: 'warning' })]);
  assert.equal(badgeClass(html) !== null && /bg-warning/.test(badgeClass(html)!), true);
  assert.doesNotMatch(badgeClass(html) ?? '', /bg-destructive/, '没有 critical 时不应是红底');
});

test('未读含 critical 时角标用红色，红色优先于其它未读', () => {
  const html = render('/', [
    n({ notification_id: 'i1', severity: 'info' }),
    n({ notification_id: 'c1', severity: 'critical' }),
  ]);
  assert.ok(html.includes('>2<'), '应数到 2 条未读');
  assert.match(html, /data-tone="critical"/);
  assert.match(badgeClass(html) ?? '', /\bbg-destructive\b/);
});

test('没有未读时不渲染角标', () => {
  const html = render('/', []);
  assert.equal(badgeClass(html), null, '未读为 0 时不应有角标');
  assert.ok(!html.includes('>99<'));
});

test('超过 99 显示 99+', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    n({ notification_id: `m${i}`, severity: 'warning' }),
  );
  assert.ok(render('/', many).includes('99+'));
});
