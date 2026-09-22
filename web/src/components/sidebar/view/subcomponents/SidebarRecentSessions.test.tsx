import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Project, ProjectSession } from '../../../../types/app';

import SidebarRecentSessions from './SidebarRecentSessions';

const mkSession = (id: string, lastActivity?: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  summary: `摘要${id}`,
  lastActivity,
  ...extra,
});

const mkProject = (
  projectId: string,
  displayName: string,
  sessions: ProjectSession[] = [],
): Project => ({
  projectId,
  displayName,
  fullPath: `/${projectId}`,
  sessions,
});

const noop = () => {};

test('renders 最近会话 header and session rows', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('最近会话'));
  assert.ok(html.includes('摘要s1'));
  assert.ok(html.includes('项目一'));
});

test('renders non-claude provider badge', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z', { provider: 'codex' })])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('codex'));
});

test('renders empty state when no sessions', () => {
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={[mkProject('p1', '项目一')]} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('暂无最近会话'));
});

test('renders all rows when under the limit with default expanded state', () => {
  const projects = [
    mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z'), mkSession('s2', '2026-08-18T02:00:00Z')]),
  ];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  // 默认展开且未到 limit，两行都在
  assert.ok(html.includes('摘要s1'));
  assert.ok(html.includes('摘要s2'));
});

test('stays collapsed on remount when the stored flag is set (survives navigation away)', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    // 模拟用户在 tasks 面板之间切换前手动收起过最近会话列表
    store.set('lovdex:sidebar:recent-sessions-collapsed', '1');
    const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
    const html = renderToStaticMarkup(
      <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
    );
    // 头部仍在，但列表行被折叠
    assert.ok(html.includes('最近会话'));
    assert.ok(!html.includes('摘要s1'));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
});

test('箭头渲染在标题之后（在右）', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('>最近会话</span>'));
  assert.ok(html.indexOf('lucide-chevron-down') > html.indexOf('>最近会话</span>'));
});

test('分隔线通过 className 透传到行 wrapper，列表保留原有内缩', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  // 删掉 consumer 传的 className，border-t 会静默消失 —— 组件自己的测试证明不了这一点。
  assert.ok(html.includes('border-t border-border/60 pb-2'));
  // wrapper 自带的那圈水平内边距必须仍在（列表靠它对齐标题行）。
  assert.ok(html.includes('group flex-shrink-0 px-2 pt-1.5 md:px-1.5'));
  // 列表内缩改由 wrapper 统一提供，不能再出现补偿性的重复内边距兄弟节点。
  assert.ok(!html.includes('class="px-2 md:px-1.5"'));
  assert.ok(html.includes('class="ml-3 max-h-[28vh] overflow-y-auto border-l border-border pl-3"'));
});
