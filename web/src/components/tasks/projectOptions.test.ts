import test from 'node:test';
import assert from 'node:assert/strict';

import type { Project } from '../../types/app';

import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects, taskProjectLabel, toProjectOption } from './projectOptions';

const mkProject = (over: Partial<Project> & { displayName: string; fullPath: string }): Project => ({
  projectId: over.fullPath,
  path: over.fullPath,
  isStarred: false,
  isMainAgentWorkspace: false,
  ...over,
});

test('taskFormProjects keeps the main agent workspace but excludes operator workspace, sorted starred first', () => {
  const main = mkProject({ displayName: 'lovdex', fullPath: '/root', isMainAgentWorkspace: true });
  const star = mkProject({ displayName: 'zeta', fullPath: '/z', isStarred: true });
  const plain = mkProject({ displayName: 'alpha', fullPath: '/a' });
  const out = taskFormProjects([plain, main, star]);
  // 主 Agent 工作目录（用户主项目）保留可选；星标优先于普通项目。
  assert.deepEqual(out.map((p) => p.fullPath), ['/z', '/a', '/root']);
});

test('taskFormProjects sorts same-starred by displayName and does not mutate input', () => {
  const zeta = mkProject({ displayName: 'zeta', fullPath: '/z' });
  const alpha = mkProject({ displayName: 'alpha', fullPath: '/a' });
  const input = [zeta, alpha];
  const out = taskFormProjects(input);
  assert.deepEqual(out.map((p) => p.fullPath), ['/a', '/z']);
  assert.deepEqual(input.map((p) => p.fullPath), ['/z', '/a']); // 原数组未变
});

test('projectPathOf falls back from fullPath to path', () => {
  assert.equal(projectPathOf({ fullPath: '/x' } as Project), '/x');
  assert.equal(projectPathOf({ path: '/y' } as Project), '/y');
});

test('assistant sentinel is a stable string', () => {
  assert.equal(typeof ASSISTANT_OPTION_VALUE, 'string');
});

test('taskFormProjects excludes operator workspace projects too', () => {
  const ws = mkProject({ displayName: 'operator-workspace', fullPath: '/ws', isOperatorWorkspace: true });
  const plain = mkProject({ displayName: 'alpha', fullPath: '/a' });
  const out = taskFormProjects([plain, ws]);
  assert.deepEqual(out.map((p) => p.fullPath), ['/a']);
});

test('taskProjectLabel prefixes the remote host name for remote projects', () => {
  const p = { projectId: 'p1', displayName: 'MyApp', fullPath: '/r/app', remoteHostName: 'dev-01' };
  assert.equal(taskProjectLabel(p as Project, new Set()), '🌐 dev-01 · MyApp');
});

test('taskProjectLabel leaves local projects untouched', () => {
  const p = { projectId: 'p1', displayName: 'MyApp', fullPath: '/local/app' };
  assert.equal(taskProjectLabel(p as Project, new Set()), 'MyApp');
});

test('toProjectOption carries remote fields for the scheduled-task dropdown', () => {
  const p = {
    projectId: 'p1',
    displayName: 'MyApp',
    fullPath: '/r/app',
    remoteHostId: 'h1',
    remoteHostName: 'dev-01',
  };
  assert.deepEqual(toProjectOption(p as Project, new Set()), {
    value: '/r/app',
    label: 'MyApp',
    remoteHostId: 'h1',
    remoteHostName: 'dev-01',
  });
});

test('toProjectOption keeps remote fields null for local projects', () => {
  const p = { projectId: 'p2', displayName: 'Local', fullPath: '/l/proj' };
  assert.deepEqual(toProjectOption(p as Project, new Set()), {
    value: '/l/proj',
    label: 'Local',
    remoteHostId: null,
    remoteHostName: null,
  });
});
