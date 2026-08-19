import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

import { RemoteTerminalBadge } from './RemoteTerminalBadge';

test('renders the SSH host badge for a remote terminal', () => {
  const html = renderToStaticMarkup(<RemoteTerminalBadge hostName="dev-01" />);
  assert.ok(html.includes('ssh') || html.includes('SSH'));
  assert.ok(html.includes('dev-01'));
});

test('renders nothing without a host name', () => {
  assert.equal(renderToStaticMarkup(<RemoteTerminalBadge hostName={null} />), '');
});
