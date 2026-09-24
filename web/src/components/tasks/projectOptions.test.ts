import test from 'node:test';
import assert from 'node:assert/strict';

import type { Project } from '../../types/app';

import { ASSISTANT_OPTION_VALUE, isAssistantTarget, projectPathOf, taskFormProjectChipOptions, taskFormProjects, taskProjectLabel, toProjectOption } from './projectOptions';

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

test('isAssistantTarget: the sentinel and an empty path both mean the assistant', () => {
  // 与 CreateTaskDialog.tsx:64 的 isAssistant 判据逐字一致：哨兵值或空串。
  // 空串这一支不是多余的 —— 后端把助手目标的 project_path 存成 NULL，
  // toDraft 回填哨兵值，但任何一条漏了回填的路径传进来都是空串。
  assert.equal(isAssistantTarget(ASSISTANT_OPTION_VALUE), true);
  assert.equal(isAssistantTarget(''), true);
  assert.equal(isAssistantTarget('/p/app'), false);
});

test('taskFormProjectChipOptions: the assistant option comes first and is always present', () => {
  // 这是用户报告的那个 bug 的回归点：定时任务表单的项目 chip 里没有助手那一项，
  // 而 EMPTY_DRAFT.projectPath 默认就是助手哨兵值 —— chip 找不到匹配项，
  // 回退显示裸的「项目」二字，用户既看不出来、也切不回来。
  const options = taskFormProjectChipOptions([]);
  assert.deepEqual(options, [{ value: ASSISTANT_OPTION_VALUE, label: '🤖 Lovdex助手' }]);
});

test('taskFormProjectChipOptions: projects follow, with the remote host as a hint', () => {
  const options = taskFormProjectChipOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
    { value: '/l/app', label: 'LocalApp' },
  ]);
  assert.equal(options[0].value, ASSISTANT_OPTION_VALUE);
  assert.deepEqual(options[1], { value: '/r/app', label: 'MyApp', hint: 'dev-01' });
  assert.deepEqual(options[2], { value: '/l/app', label: 'LocalApp', hint: undefined });
});

test('taskFormProjectChipOptions: the assistant value never collides with a real project path', () => {
  // 哨兵值一旦撞上真实路径，ChipSelect 的 current?.label 会选中错误项。
  // 断言它是「不像路径」的形态，而不是硬编码字面量（字面量在别处改过名字）。
  assert.ok(!ASSISTANT_OPTION_VALUE.startsWith('/'));
});
