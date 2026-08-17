import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import type { Task } from '../../types/app';

import { TaskCard, type TaskProjectOption } from './TaskCard';

const baseTask: Task = {
  task_id: 't1',
  project_path: '/home/user/proj',
  title: '测试任务',
  description: null,
  status: 'todo',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: null,
  started_at: null,
  completed_at: null,
  ai_summary: null,
  sub_status: null,
  verdict_reason: null,
  verdict_at: null,
  priority: 'P2',
  deadline: null,
  is_operator: 0,
  label: 'other',
  remark: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
};

const options: TaskProjectOption[] = [
  { value: '/home/user/proj', label: 'proj' },
  { value: '/home/user/other', label: 'other' },
];

function render(
  task: Task,
  props: {
    projectOptions?: TaskProjectOption[];
    onProjectChange?: (nextPath: string) => void;
    onOpenSession?: () => void;
    onStart?: () => void;
    onStatusChange?: (status: Task['status']) => void;
  } = {},
) {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: '/' },
      React.createElement(TaskCard, { task, ...props }),
    ),
  );
}

test('todo task renders a project selector listing the candidate projects', () => {
  const html = render(baseTask, { projectOptions: options, onProjectChange: () => {} });
  assert.match(html, /<select/);
  assert.match(html, /\/home\/user\/other/);
});

test('todo task keeps a disabled current option when its project is not a candidate', () => {
  const task = { ...baseTask, project_path: '/workspace/main' };
  const html = render(task, { projectOptions: options, onProjectChange: () => {} });
  assert.match(html, /\/workspace\/main/);
  assert.match(html, /disabled/);
});

test('non-todo task renders a plain project badge instead of a select', () => {
  const html = render({ ...baseTask, status: 'in_progress' }, {
    projectOptions: options,
    onProjectChange: () => {},
  });
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /\/home\/user\/proj/);
});

test('assistant todo task renders a plain project badge instead of a select', () => {
  const html = render({ ...baseTask, is_operator: 1 }, {
    projectOptions: options,
    onProjectChange: () => {},
  });
  assert.doesNotMatch(html, /<select/);
});

test('card without projectOptions falls back to the plain project badge', () => {
  const html = render(baseTask);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /\/home\/user\/proj/);
});

// 「打开会话」去重回归：in_review/only_plan/needs_review/blocked 这些状态会同时
// 命中旧的 in_review + sub_status 两个按钮分支，必须恰好渲染一个「打开会话」。
test('board card renders exactly one open-session button for in_review with needs_review + session', () => {
  const html = render(
    { ...baseTask, status: 'in_review', sub_status: 'needs_review', session_id: 's1' },
    { onOpenSession: () => {}, onStart: () => {}, onStatusChange: () => {} },
  );
  assert.match(html, /标记完成/);
  assert.equal((html.match(/打开会话/g) || []).length, 1);
});

test('board card renders exactly one open-session button for in_progress with only_plan + session', () => {
  const html = render(
    { ...baseTask, status: 'in_progress', sub_status: 'only_plan', session_id: 's1' },
    { onOpenSession: () => {}, onStart: () => {}, onStatusChange: () => {} },
  );
  assert.equal((html.match(/打开会话/g) || []).length, 1);
});
