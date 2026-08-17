import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ASSISTANT_OPTION_VALUE } from './projectOptions';
import { ProjectMultiSelect } from './ProjectMultiSelect';

test('renders the trigger summary and all option labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [{ value: '/p', label: 'proj' }],
      value: [],
      onChange: () => {},
    }),
  );
  assert.match(html, /项目/);
  assert.match(html, /全部项目/);
  assert.match(html, /Lovdex助手/);
  assert.match(html, /proj/);
  assert.match(html, /全选/);
  assert.match(html, /清空/);
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

test('renders the assistant sentinel as an option', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectMultiSelect, {
      projectOptions: [],
      value: [ASSISTANT_OPTION_VALUE],
      onChange: () => {},
    }),
  );
  assert.match(html, /Lovdex助手/);
});
