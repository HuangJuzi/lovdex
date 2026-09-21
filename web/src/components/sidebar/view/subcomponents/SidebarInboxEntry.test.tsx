import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import SidebarInboxEntry from './SidebarInboxEntry';

const render = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <SidebarInboxEntry />
    </MemoryRouter>,
  );

test('停在 /inbox 时入口高亮', () => {
  assert.ok(render('/inbox').includes('data-active="true"'));
});

test('其他路由下不高亮', () => {
  assert.ok(render('/').includes('data-active="false"'));
});

test('尾斜杠 /inbox/ 也高亮', () => {
  assert.ok(render('/inbox/').includes('data-active="true"'));
});
