import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import SidebarResizeHandle from './SidebarResizeHandle';

test('renders a vertical separator with the current width as aria-valuenow', () => {
  const html = renderToStaticMarkup(
    <SidebarResizeHandle width={350} onWidthChange={() => {}} onReset={() => {}} />,
  );

  assert.ok(html.includes('role="separator"'));
  assert.ok(html.includes('aria-orientation="vertical"'));
  assert.ok(html.includes('aria-valuemin="200"'));
  assert.ok(html.includes('aria-valuemax="480"'));
  assert.ok(html.includes('aria-valuenow="350"'));
  assert.ok(html.includes('tabindex="0"'));
});
