import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TerminalPanel } from './TerminalPanel';

test('renders the injected pane without a header bar', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalPanel, { pane: React.createElement('div', null, 'pane-stub') }),
  );
  assert.match(html, /pane-stub/);
  assert.doesNotMatch(html, /关闭即退出会话/);
});

test('renders a bordered container', () => {
  const html = renderToStaticMarkup(
    React.createElement(TerminalPanel, { pane: React.createElement('div', null, 'pane-stub') }),
  );
  assert.match(html, /border-t/);
});
