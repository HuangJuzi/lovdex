import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { ProjectMultiSelect, ProjectMultiSelectPanel } from './ProjectMultiSelect';

// 面板置于 portal（仅在 open 时渲染），SSR 关闭态只出触发器。
test('renders the trigger summary', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      value: [],
      onChange: () => {},
    }),
  );
  assert.match(html, /项目/);
  assert.match(html, /全部项目/);
});

test('shows a single selected label and the multi summary', () => {
  const one = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      value: ['/p'],
      onChange: () => {},
    }),
  );
  assert.match(one, /proj/);

  const many = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [
        { value: '/p', label: 'proj' },
        { value: '/q', label: 'qproj' },
      ],
      value: ['/p', '/q'],
      onChange: () => {},
    }),
  );
  assert.match(many, /2 个项目/);
});

test('panel lists the assistant sentinel, projects and the action buttons', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectMultiSelectPanel, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      value: [ASSISTANT_OPTION_VALUE],
      onChange: () => {},
    }),
  );
  assert.match(html, /Lovdex助手/);
  assert.match(html, /proj/);
  assert.match(html, /全选/);
  assert.match(html, /清空/);
});
