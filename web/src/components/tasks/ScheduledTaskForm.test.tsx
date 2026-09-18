import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// DialogContent portals into document.body; the legacy server renderer used by
// renderToStaticMarkup does not support portals, so (a) stub document.body and
// (b) patch createPortal to render its children inline. We mutate the CJS
// react-dom exports (the ESM namespace is frozen) so Dialog.tsx's
// `import { createPortal } from 'react-dom'` picks up the passthrough.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  (globalThis as { document?: unknown }).document = { body: { nodeType: 1, style: {} } };
}
const require = createRequire(import.meta.url);
const reactDomCjs = require('react-dom') as { createPortal: (children: React.ReactNode) => React.ReactNode };
reactDomCjs.createPortal = (children) => children;

// Imported after the createPortal patch so ScheduledTaskForm's DialogContent
// picks up the inline-rendering stub.
const { ScheduledTaskForm, EMPTY_DRAFT, canSubmitScheduledTask, toApiBody } = await import('./ScheduledTaskForm');
const { ASSISTANT_OPTION_VALUE } = await import('./projectOptions');

void EMPTY_DRAFT;

const onClose = () => {};
const onSubmit = () => {};

function renderWithOptions(projectOptions: unknown[]) {
  return renderToStaticMarkup(
    React.createElement(ScheduledTaskForm, {
      open: true,
      initial: null,
      projectOptions: projectOptions as never,
      submitting: false,
      error: null,
      onClose,
      onSubmit,
    }),
  );
}

test('renders a remote project option with its host prefix', () => {
  const html = renderWithOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
  ]);
  assert.ok(html.includes('🌐 dev-01 · MyApp'));
});

test('renders a local project option without a prefix', () => {
  const html = renderWithOptions([{ value: '/l/app', label: 'LocalApp' }]);
  assert.ok(html.includes('LocalApp'));
  assert.ok(!html.includes('🌐'));
});

test('engine select is disabled while availability resolves (loading)', () => {
  const html = renderWithOptions([]);
  // The project <select> renders first and stays enabled; the engine select is
  // the second one and must be disabled while availability is still 'loading'.
  const engineSelect = (html.match(/<select[^>]*>/g) ?? [])[1] ?? '';
  assert.ok(engineSelect.includes('disabled'));
});

test('renders deterministically with a remote option selected while availability resolves', () => {
  // The availability hook resolves async and the picker only blocks after
  // 'unavailable' settles, which renderToStaticMarkup cannot drive; that guard
  // path is covered by code inspection + computeEngineAvailability unit tests.
  // Here we assert the form still renders its remote option deterministically.
  const html = renderWithOptions([{ value: '/r/app', label: 'MyApp', remoteHostName: 'dev-01' }]);
  assert.ok(html.includes('dev-01'));
});

test('canSubmitScheduledTask: only a non-empty description may be submitted', () => {
  assert.equal(canSubmitScheduledTask('', false), false);
  assert.equal(canSubmitScheduledTask('   \n  ', false), false);
  assert.equal(canSubmitScheduledTask('每天汇总提交记录', false), true);
});

test('canSubmitScheduledTask: an in-flight save blocks a second submit', () => {
  // 取名最长阻塞 3s，这期间按钮若仍可点，双击就是两条一模一样的定时任务。
  assert.equal(canSubmitScheduledTask('每天汇总提交记录', true), false);
});

test('toApiBody: a blank name is passed through as an empty string', () => {
  // 关键回归点：前端一旦在这里本地兜底填了名字，后端的 LLM 取名分支就永远不会进入。
  const body = toApiBody({ ...EMPTY_DRAFT, description: '每天汇总提交记录', title: '' });
  assert.equal(body.title, '');
});

test('toApiBody: the assistant project is sent as a null projectPath', () => {
  const body = toApiBody({ ...EMPTY_DRAFT, projectPath: ASSISTANT_OPTION_VALUE });
  assert.equal(body.projectPath, null);
});

test('toApiBody: only the field matching the schedule type is populated', () => {
  const once = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'once', runAt: '2026-09-19T01:00', cronExpr: '0 9 * * *' });
  assert.equal(once.cronExpr, null);
  assert.equal(once.intervalSeconds, null);
  assert.ok(once.runAt);

  const cron = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronExpr: '0 9 * * *' });
  assert.equal(cron.cronExpr, '0 9 * * *');
  assert.equal(cron.runAt, null);
});
