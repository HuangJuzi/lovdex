import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskResultPanel } from './TaskResultPanel';

// MarkdownContent (used by the 'ready' state) pulls ThemeContext/i18n providers
// and cannot be SSR'd in isolation, so the ready state is verified by typecheck
// + manual run. These tests cover the non-markdown branches.

test('idle state renders the "not started" hint and no refresh button', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'idle', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /尚未开始执行/);
  assert.doesNotMatch(html, /刷新/);
});

test('loading state renders the loading hint', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'loading', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /加载中/);
});

test('empty state renders the "no conclusion yet" hint and a refresh button', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'empty', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /agent 还没产出结论/);
  assert.match(html, /刷新/);
});

test('error state renders the error hint and a retry button', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, { state: 'error', content: '', onRefresh: () => {} }),
  );
  assert.match(html, /加载结果失败/);
  assert.match(html, /重试/);
});
