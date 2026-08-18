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

test('renders 最近任务 header and session rows', () => {
  const projects = [mkProject('p1', '项目一', [mkSession('s1', '2026-08-18T01:00:00Z')])];
  const html = renderToStaticMarkup(
    <SidebarRecentSessions projects={projects} onRecentSessionSelect={noop} />,
  );
  assert.ok(html.includes('最近任务'));
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
  assert.ok(html.includes('暂无最近任务'));
});

test('does not render list when initial collapsed state is false (default expanded shows rows)', () => {
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