import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DatabaseSettingsForm } from './DatabaseSettingsForm';

// renderToStaticMarkup does not run effects, so the form renders its initial
// "loading" state without touching fetch.
test('renders loading state before config loads', () => {
  const html = renderToStaticMarkup(<DatabaseSettingsForm />);
  assert.match(html, /加载中/);
});
