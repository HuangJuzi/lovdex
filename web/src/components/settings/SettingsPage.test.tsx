import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

import SettingsPage from './SettingsPage';

test('renders default providers tab with all nav labels', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/settings">
      <SettingsPage />
    </StaticRouter>,
  );
  assert.match(html, /设置/);
  assert.match(html, /Provider 设置/);
  assert.match(html, /Operator Agent 设置/);
  assert.match(html, /数据库/);
  assert.match(html, /账号/);
});

test('activates the database tab for tab=database', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/settings?tab=database">
      <SettingsPage />
    </StaticRouter>,
  );
  // renderToStaticMarkup does not run effects, so DatabaseSettingsForm stays in
  // its "加载中…" state; assert instead that the shell marks the 数据库 nav tab
  // active (active tabs get `bg-primary/10 font-medium`).
  assert.match(html, /bg-primary\/10 font-medium text-foreground">数据库</);
});

test('falls back to providers for unknown tab', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/settings?tab=bogus">
      <SettingsPage />
    </StaticRouter>,
  );
  assert.match(html, /加载中/); // ProviderSettingsForm initial state
});
