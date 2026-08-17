import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Button } from './Button';

function renderButton(props: React.ComponentProps<typeof Button>, label = 'x') {
  return renderToStaticMarkup(React.createElement(Button, props, label));
}

test('chunky variant renders white-card gradient + hard bottom edge', () => {
  const html = renderButton({ variant: 'chunky' });
  assert.match(html, /shadow-\[0_4px_0_#d8d5df/);
  assert.match(html, /bg-gradient-to-b/);
  assert.match(html, /hover:shadow-\[0_6px_0_#d8d5df/);
  assert.match(html, /active:translate-y-\[3px\]/);
});

test('chunkyPrimary variant renders primary gradient', () => {
  const html = renderButton({ variant: 'chunkyPrimary' });
  assert.match(html, /from-\[#5b8cff\]/);
  assert.match(html, /to-\[#2f5fe0\]/);
});

test('toolbar size renders 34px height', () => {
  const html = renderButton({ size: 'toolbar' });
  assert.match(html, /h-\[34px\]/);
});
