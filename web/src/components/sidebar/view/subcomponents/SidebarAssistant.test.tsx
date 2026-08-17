import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarAssistant from './SidebarAssistant';

test('SidebarAssistant renders the Lovdex助手 label', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarAssistant />
    </MemoryRouter>,
  );
  assert.ok(html.includes('Lovdex助手'));
  assert.ok(html.includes('新建 Lovdex助手 会话'));
});
