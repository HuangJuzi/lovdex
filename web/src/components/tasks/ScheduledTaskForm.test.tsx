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
const { ScheduledTaskForm, EMPTY_DRAFT, canSubmitScheduledTask, switchCronMode, toApiBody, toDraft, toProjectChipOptions } = await import('./ScheduledTaskForm');
const { ASSISTANT_OPTION_VALUE } = await import('./projectOptions');

const onClose = () => {};
const onSubmit = () => {};

function renderWithOptions(projectOptions: unknown[], initial: unknown = null) {
  return renderToStaticMarkup(
    React.createElement(ScheduledTaskForm, {
      open: true,
      initial: initial as never,
      projectOptions: projectOptions as never,
      submitting: false,
      error: null,
      onClose,
      onSubmit,
    }),
  );
}

// 既有定时任务行的最小形状：interval 相关字段给全套，方便按需覆盖单个字段。
function mkScheduledTask(over: Record<string, unknown>) {
  return {
    schedule_id: 's1', title: 't', description: 'd', project_path: null,
    executor_provider: 'claude', executor_model: null, priority: 'P2', label: 'other',
    is_operator: 1, auto_run: 1, schedule_type: 'interval', cron_expr: null,
    interval_seconds: 5400, run_at: null, timezone: 'local',
    next_run_at: '2026-08-14T09:00:00.000Z', last_run_at: null, last_task_id: null,
    enabled: 1, created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    ...over,
  };
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

  const cron = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'custom', cronExpr: '0 9 * * *' });
  assert.equal(cron.cronExpr, '0 9 * * *');
  assert.equal(cron.runAt, null);
});

test('toApiBody: a preset cron mode is rebuilt from the parameters, ignoring cronExpr', () => {
  const daily = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'daily', cronTime: '08:00', cronExpr: '0 9,17 * * *' });
  assert.equal(daily.cronExpr, '0 8 * * *');

  const weekday = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'weekday', cronTime: '09:30' });
  assert.equal(weekday.cronExpr, '30 9 * * 1-5');

  const monthly = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron', cronMode: 'monthly', cronTime: '10:00', cronDom: '15' });
  assert.equal(monthly.cronExpr, '0 10 15 * *');
});

test('a new scheduled task defaults to a daily 09:00 cron', () => {
  // EMPTY_DRAFT 的默认值应当拼出一个合法的表达式，而不是空串
  assert.equal(EMPTY_DRAFT.cronMode, 'daily');
  assert.equal(EMPTY_DRAFT.cronTime, '09:00');
  assert.equal(toApiBody({ ...EMPTY_DRAFT, scheduleType: 'cron' }).cronExpr, '0 9 * * *');
});

test('a recognised cron expression renders the preset controls with back-filled values', () => {
  const html = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '0 8 * * *', interval_seconds: null }));
  assert.ok(/<button[^>]*aria-label="Cron 模式"[^>]*>/.test(html), 'the mode chip must render');
  const timeBox = /<input[^>]*aria-label="触发时间"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(timeBox.length > 0, 'the time box must render for a preset mode');
  assert.ok(timeBox.includes('value="08:00"'), 'the time must be back-filled from the expression');
  assert.ok(html.includes('每天'), 'the mode chip must show the recognised mode');
});

test('an unrecognised cron expression falls back to custom mode with the raw box', () => {
  const html = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '0 9,17 * * *', interval_seconds: null }));
  const raw = /<input[^>]*aria-label="cron 表达式"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(raw.length > 0, 'custom mode must render the raw expression box');
  assert.ok(raw.includes('value="0 9,17 * * *"'), 'the raw expression must be preserved verbatim');
});

test('the weekly and monthly modes render their extra chip', () => {
  const weekly = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '30 6 * * 0', interval_seconds: null }));
  assert.ok(/<button[^>]*aria-label="星期"[^>]*>/.test(weekly), 'weekly must render the weekday chip');
  assert.ok(weekly.includes('每周'), 'the mode chip must show 每周');

  const monthly = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '0 10 15 * *', interval_seconds: null }));
  assert.ok(/<button[^>]*aria-label="日期"[^>]*>/.test(monthly), 'monthly must render the day-of-month chip');
  assert.ok(monthly.includes('每月'), 'the mode chip must show 每月');
});

test('the custom mode does not render the preset time box', () => {
  const html = renderWithOptions([], mkScheduledTask({ schedule_type: 'cron', cron_expr: '0 9,17 * * *', interval_seconds: null }));
  assert.ok(/<input[^>]*aria-label="cron 表达式"[^>]*>/.test(html), 'the raw box must render');
  assert.ok(!/<input[^>]*aria-label="触发时间"[^>]*>/.test(html), 'the preset time box must NOT render in custom mode');
});

test('switchCronMode: switching to custom seeds the raw box with the effective expression', () => {
  // 新建任务时 cronExpr 是空串，不播种的话用户刚选好的「每天 10:00」会凭空消失。
  const presetDraft = { ...EMPTY_DRAFT, scheduleType: 'cron' as const, cronMode: 'daily' as const, cronTime: '10:00' };
  assert.equal(switchCronMode(presetDraft, 'custom').cronExpr, '0 10 * * *');

  // 播种只发生在切到自定义那一刻：已经在自定义里的内容不受影响，
  // 逐字敲到一半的中间态不会被 clobber（那正是计划里担心的场景）。
  const customDraft = { ...EMPTY_DRAFT, cronMode: 'custom' as const, cronExpr: '0 9,17 * * *' };
  assert.equal(switchCronMode(customDraft, 'custom').cronExpr, '0 9,17 * * *');

  // 反向切换（自定义 → preset）不动 cronExpr，回来时用户敲的内容还在。
  assert.equal(switchCronMode(customDraft, 'daily').cronExpr, '0 9,17 * * *');
  assert.equal(switchCronMode(customDraft, 'daily').cronMode, 'daily');
});

test('switchCronMode: a custom expression survives a round trip through a preset mode', () => {
  const typed = { ...EMPTY_DRAFT, cronMode: 'custom' as const, cronExpr: '0 9,17 * * *' };
  const away = switchCronMode(typed, 'daily');
  assert.equal(away.cronExpr, '0 9,17 * * *', 'leaving custom must not touch cronExpr');
  const back = switchCronMode(away, 'custom');
  assert.equal(back.cronExpr, '0 9,17 * * *', 'coming back must NOT clobber the typed expression');
});

test('switchCronMode: an empty expression is seeded from the current preset parameters', () => {
  const fresh = { ...EMPTY_DRAFT, cronMode: 'daily' as const, cronTime: '08:00', cronExpr: '' };
  assert.equal(switchCronMode(fresh, 'custom').cronExpr, '0 8 * * *');
});

test('toApiBody: the interval seconds are amount × unit', () => {
  const twoDays = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'interval', intervalAmount: '2', intervalUnit: 'day' });
  assert.equal(twoDays.intervalSeconds, 172800);

  const ninetyMin = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'interval', intervalAmount: '90', intervalUnit: 'minute' });
  assert.equal(ninetyMin.intervalSeconds, 5400);
});

test('toApiBody: a fractional amount is rounded to whole seconds', () => {
  // step={1} 拦不住手输的小数；不取整的话 1.1 小时会变成 3960.0000000000005，
  // 落在合法范围内通过校验，却让列表标签退化成「每 3960.0000000000005 秒」。
  const body = toApiBody({ ...EMPTY_DRAFT, scheduleType: 'interval', intervalAmount: '1.1', intervalUnit: 'hour' });
  assert.equal(body.intervalSeconds, 3960);
});

test('toDraft falls back to one hour for a degenerate stored interval', () => {
  // null / NaN / < 1 都必须兜底，不能漏进 decomposeInterval
  // （NaN 漏进去会让数字框渲染成 NaN，且全单位取模都不整除）
  const html = renderWithOptions([], mkScheduledTask({ interval_seconds: null }));
  assert.ok(/<input[^>]*aria-label="间隔数量"[^>]*value="1"/.test(html), 'amount must fall back to 1');
  assert.ok(html.includes('小时'), 'unit must fall back to hours');

  const nan = renderWithOptions([], mkScheduledTask({ interval_seconds: Number.NaN }));
  assert.ok(/<input[^>]*aria-label="间隔数量"[^>]*value="1"/.test(nan), 'NaN must fall back too');
});

test('toDraft keeps a sub-minute stored interval as seconds', () => {
  // 只能通过 API 直调产生；如实回填成「90 秒」，由提交时的范围校验拦下
  const html = renderWithOptions([], mkScheduledTask({ interval_seconds: 90 }));
  assert.ok(/<input[^>]*aria-label="间隔数量"[^>]*value="90"/.test(html));
  assert.ok(html.includes('秒'));
});

test('an interval schedule renders a number box plus a unit chip', () => {
  // 5400 秒 → 分解成 (90, 分钟)，回填的应是分解后的值而不是别的预设
  const html = renderWithOptions([], mkScheduledTask({ interval_seconds: 5400 }));
  const numberBox = /<input[^>]*aria-label="间隔数量"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(numberBox.length > 0, 'interval number box must render');
  assert.ok(numberBox.includes('type="number"'), 'it must be a number input');
  assert.ok(numberBox.includes('value="90"'), 'the amount must be the decomposed value');
  assert.ok(/<button[^>]*aria-label="间隔单位"[^>]*>/.test(html), 'the unit chip must render');
  assert.ok(html.includes('分钟'), 'the unit chip must show the decomposed unit');
});

test('draft no longer carries priority or label', () => {
  assert.equal('priority' in EMPTY_DRAFT, false);
  assert.equal('label' in EMPTY_DRAFT, false);
  assert.equal(EMPTY_DRAFT.executorModel, '');
});

test('toApiBody carries executorModel and drops priority/label', () => {
  const body = toApiBody({ ...EMPTY_DRAFT, executorModel: 'opus' });
  assert.equal(body.executorModel, 'opus');
  assert.equal('priority' in body, false);
  assert.equal('label' in body, false);
});

test('toApiBody maps an empty executorModel to null (provider default slot)', () => {
  assert.equal(toApiBody({ ...EMPTY_DRAFT, executorModel: '' }).executorModel, null);
});

test('toDraft keeps a stored executor_model', () => {
  const d = toDraft(mkScheduledTask({ executor_model: 'opus' }) as never);
  assert.equal(d.executorModel, 'opus');
});

test('toDraft maps a NULL executor_model to the empty value', () => {
  const d = toDraft(mkScheduledTask({ executor_model: null }) as never);
  assert.equal(d.executorModel, '');
});

test('drops the priority and label chips', () => {
  const html = renderWithOptions([]);
  assert.equal(html.includes('aria-label="优先级"'), false);
  assert.equal(html.includes('aria-label="标签"'), false);
});

test('renders a model chip', () => {
  const html = renderWithOptions([]);
  assert.ok(/<button[^>]*aria-label="模型"/.test(html), 'model chip must render');
});

// 引擎还不可用时（列表未到）模型 chip 置灰，但**必须仍在 DOM 里**，
// 否则用户看不到「这里有模型可选」，芯片行会随加载状态抖动。
test('model chip renders disabled before the model list arrives', () => {
  const html = renderWithOptions([]);
  const modelChip = /<button[^>]*aria-label="模型"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(modelChip.length > 0, 'model chip must render');
  // 不能用 modelChip.includes('disabled')：ChipSelect 的 className 恒有
  // disabled:cursor-not-allowed / disabled:opacity-50 字面量，子串匹配在启用态也成立。
  // 见上面引擎芯片那个测试的注释。
  assert.ok(/ disabled=""/.test(modelChip), 'model chip must be disabled before the list arrives');
});

// 兜底项：列表没到（或拉取失败）时显示「默认模型」，而不是空白芯片。
test('model chip shows the 默认模型 fallback before the list arrives', () => {
  const html = renderWithOptions([]);
  assert.ok(html.includes('默认模型'));
});
