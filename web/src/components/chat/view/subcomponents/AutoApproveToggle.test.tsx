import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoApproveToggle } from './AutoApproveToggle';

const noop = () => {};

test('renders the on state as pressed', () => {
  const html = renderToStaticMarkup(<AutoApproveToggle enabled onToggle={noop} />);
  assert.match(html, /自动审批/);
  assert.match(html, /aria-pressed="true"/);
});

test('renders the overridden (off) state as not pressed, with the same label', () => {
  const html = renderToStaticMarkup(<AutoApproveToggle enabled={false} onToggle={noop} />);
  // 标签不随状态变：按钮一直在，只有外观变 —— 否则关掉后无从再打开。
  assert.match(html, /自动审批/);
  assert.match(html, /aria-pressed="false"/);
});

test('the tooltip states the blast radius', () => {
  const html = renderToStaticMarkup(<AutoApproveToggle enabled onToggle={noop} />);
  // 只说开关名会让人以为改的是任务；作用范围必须写在 title 里。
  assert.match(html, /定时执行/);
});
