import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { FilePreviewBody } from './FilePreviewBody';

// ── Global i18next instance for useTranslation('chat') ────────────────────
// FilePreviewBody calls useTranslation('chat'). With react-i18next, when
// no I18nextProvider is in the tree, useTranslation falls back to the global
// i18n instance. We initialise a minimal one so SSR rendering works.
i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      chat: {
        'filePreview.unsupported': 'Unsupported file type',
        'filePreview.emptyFile': '(empty file)',
        'filePreview.truncated': 'Truncated notice',
        'filePreview.rendered': 'Rendered',
        'filePreview.source': 'Source',
      },
    },
  },
  interpolation: { escapeValue: false },
});

// ── Tests ────────────────────────────────────────────────────────────────

test('unsupported kind renders a cannot-preview message without throwing', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="unsupported"
      filePath="data.bin"
      content={null}
      blobUrl={null}
      truncated={false}
    />,
  );
  assert.match(html, /data\.bin/);
});

test('code kind renders the file content', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="code"
      language="python"
      filePath="a.py"
      content="print('hello world')"
      blobUrl={null}
      truncated={false}
    />,
  );
  assert.match(html, /hello world/);
});

test('image kind renders an img with the blob url', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="image"
      filePath="pic.png"
      content={null}
      blobUrl="blob:fake-url"
      truncated={false}
    />,
  );
  assert.match(html, /<img[^>]+blob:fake-url/);
});

test('empty text content renders an empty-file notice', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="text"
      language="text"
      filePath="empty.txt"
      content=""
      blobUrl={null}
      truncated={false}
    />,
  );
  assert.match(html, /empty/i);
});

test('truncated flag renders a truncation notice', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="code"
      language="python"
      filePath="big.py"
      content="x = 1"
      blobUrl={null}
      truncated={true}
    />,
  );
  assert.match(html, /truncated|too large|first/i);
});
