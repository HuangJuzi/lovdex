import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';

import type { Project } from '../../../../types/app';

import SidebarProjectSessions from './SidebarProjectSessions';

// 无 DOM 环境（见 Button.test.tsx）：只做静态渲染 + 类名断言。
const t = ((key: string) => key) as unknown as TFunction;

const project: Project = {
  projectId: 'p1',
  displayName: 'P1',
  fullPath: '/p1',
  sessions: [],
};

// 会话列表留空 + initialSessionsLoaded=true，走空态分支 —— 这样不必渲染
// SidebarSessionItem（它需要另外二十来个 props），但面板容器本身照样输出。
const baseProps = {
  project,
  sessions: [],
  selectedSession: null,
  initialSessionsLoaded: true,
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  activeSessions: new Map(),
  attentionSessionIds: new Set<string>(),
  currentTime: new Date('2026-09-18T12:00:00Z'),
  editingSession: null,
  editingSessionName: '',
  onEditingSessionNameChange: () => {},
  onStartEditingSession: () => {},
  onCancelEditingSession: () => {},
  onSaveEditingSession: () => {},
  onProjectSelect: () => {},
  onSessionSelect: () => {},
  onDeleteSession: () => {},
  onLoadMoreSessions: () => {},
  t,
};

test('renders nothing when the project is collapsed', () => {
  const html = renderToStaticMarkup(
    React.createElement(SidebarProjectSessions, { ...baseProps, isExpanded: false }),
  );
  assert.equal(html, '');
});

test('renders the session rail as a tinted panel when expanded', () => {
  const html = renderToStaticMarkup(
    React.createElement(SidebarProjectSessions, { ...baseProps, isExpanded: true }),
  );
  assert.match(html, /border-l-2/);
  assert.match(html, /bg-muted\/25/);
});
