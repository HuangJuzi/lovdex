import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskEngineSelect } from './TaskEngineSelect';
import type { EngineAvailability } from './useTaskEngineAvailability';

function open() { /* no-op */ }

test('renders the installed engine options when ready', () => {
  const availability: EngineAvailability = { status: 'ready', options: ['claude', 'opencode'], source: 'remote' };
  const html = renderToStaticMarkup(<TaskEngineSelect availability={availability} value="claude" onChange={open} />);
  assert.ok(html.includes('Claude Code'));
  assert.ok(html.includes('OpenCode'));
  assert.ok(!html.includes('Codex'));
});

test('renders the hint and disables the select when unavailable', () => {
  const availability: EngineAvailability = { status: 'unavailable', hint: '该远程主机离线或无可用引擎' };
  const html = renderToStaticMarkup(<TaskEngineSelect availability={availability} value="" onChange={open} />);
  assert.ok(html.includes('该远程主机离线或无可用引擎'));
  assert.ok(html.includes('disabled'));
});

test('disables the select while loading', () => {
  const html = renderToStaticMarkup(<TaskEngineSelect availability={{ status: 'loading' }} value="claude" onChange={open} />);
  assert.ok(html.includes('disabled'));
});

test('locks to claude for the assistant project', () => {
  const html = renderToStaticMarkup(<TaskEngineSelect availability={{ status: 'assistant' }} value="claude" onChange={open} />);
  assert.ok(html.includes('Claude Code'));
  assert.ok(html.includes('disabled'));
});
