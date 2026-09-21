import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Switch from './Switch';

test('renders role=switch with aria-checked=true and success track when checked', () => {
  const html = renderToStaticMarkup(<Switch checked onToggle={() => {}} ariaLabel="示例开关" />);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-label="示例开关"/);
  assert.match(html, /bg-success/);
  assert.doesNotMatch(html, /bg-muted/);
  assert.match(html, /translate-x-\[18px\]/);
  assert.match(html, /type="button"/);
});

test('renders aria-checked=false and muted track when unchecked', () => {
  const html = renderToStaticMarkup(<Switch checked={false} onToggle={() => {}} ariaLabel="示例开关" />);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /bg-muted/);
  assert.doesNotMatch(html, /bg-success/);
  assert.match(html, /translate-x-\[2px\]/);
  assert.doesNotMatch(html, /translate-x-\[18px\]/);
});
