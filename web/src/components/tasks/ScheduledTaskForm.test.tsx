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
const { ScheduledTaskForm, EMPTY_DRAFT, canSubmitScheduledTask, toApiBody, toProjectChipOptions } = await import('./ScheduledTaskForm');
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

test('renders the big composer textarea with the auto-naming hint', () => {
  const html = renderWithOptions([]);
  assert.ok(html.includes('说清楚要做什么就行，名称留空会自动生成'));
});

test('renders a name chip that reads 名称 while the name is blank', () => {
  const html = renderWithOptions([]);
  assert.ok(html.includes('名称'));
});

test('engine chip is disabled while availability resolves (loading)', () => {
  const html = renderWithOptions([]);
  const engineChip = /<button[^>]*aria-label="引擎"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(engineChip.length > 0, 'engine chip must render');
  // 断言 disabled 属性本身，不能用 engineChip.includes('disabled')：ChipSelect 的
  // className 里恒有 Tailwind 的 disabled:cursor-not-allowed / disabled:opacity-50
  // 字面量，子串匹配在启用态也成立，等于没测。renderToStaticMarkup 把该属性渲染成
  // disabled=""（启用态则完全不渲染该属性）。
  assert.ok(/ disabled=""/.test(engineChip), 'engine chip must be disabled while availability is loading');
});

test('renders the schedule section segmented control, defaulting to 单次', () => {
  const html = renderWithOptions([]);
  for (const label of ['单次', '间隔', 'Cron']) assert.ok(html.includes(label));
  assert.ok(html.includes('自动执行'));
});

test('toProjectChipOptions: a remote project carries its host name as a hint', () => {
  const options = toProjectChipOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
    { value: '/l/app', label: 'LocalApp' },
  ]);
  assert.deepEqual(options[0], { value: '/r/app', label: 'MyApp', hint: 'dev-01' });
  assert.deepEqual(options[1], { value: '/l/app', label: 'LocalApp', hint: undefined });
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
  // description 空串要转 null，与 title 的「原样透传」刻意相反 —— 别顺手统一。
  assert.equal(toApiBody({ ...EMPTY_DRAFT, description: '' }).description, null);
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
