import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { PendingPermissionRequest } from '../chat/types/types';

import { PendingPromptList } from './PendingPromptList';

const NOW = 1_700_000_000_000;
const TIMEOUT = 60_000;

const ask = (id: string, question = `问题 ${id}`): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'AskUserQuestion',
  receivedAt: new Date(NOW),
  input: { questions: [{ question, options: [{ label: '好' }] }] },
});

/** 已过去 `agoMs` 的普通工具 —— 剩余时间就是 `TIMEOUT - agoMs`。 */
const bash = (id: string, agoMs: number): PendingPermissionRequest => ({
  requestId: id,
  toolName: 'Bash',
  receivedAt: new Date(NOW - agoMs),
  input: { command: `echo ${id}` },
});

const render = (requests: PendingPermissionRequest[]): string =>
  renderToStaticMarkup(
    <PendingPromptList requests={requests} nowMs={NOW} timeoutMs={TIMEOUT} onRespond={() => {}} />,
  );

/** 完整卡片的壳体类名（来自 PendingPromptCard 的 `cardShell`）。 */
const CARD_SHELL = 'border-info/40';

test('零条待办：整个待办区不渲染（连空壳都不留）', () => {
  assert.equal(render([]), '');
});

test('单条待办：渲染卡片，但不渲染队列条（一条的「队」是噪音）', () => {
  const html = render([ask('a1')]);
  assert.doesNotMatch(html, /还有 \d+ 件事等你/);
  assert.match(html, /问题 a1/);
});

test('两条待办：渲染队列条并给出总数', () => {
  const html = render([bash('b1', 50_000), ask('a1')]);
  assert.match(html, /还有 2 件事等你/);
});

// 「只完整渲染当前那一条」的判据必须是**卡片独有的**内容，不能拿队列行也会
// 打印的题面/命令原文来断言 —— 那些字符串在队列行里也出现，断言恒真。
// 卡片壳体只该出现一次，非当前项的那张不该存在。
test('两条待办：只完整渲染当前那一条卡片，其余不在卡片形态里出现', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);

  assert.equal(html.split(CARD_SHELL).length - 1, 1);

  // 当前项是 b1（会超时，排最前）—— 卡片里是它的工具授权形态。
  assert.match(html, /要执行一个写操作/);
  assert.match(html, /echo b1/);

  // a1 只在队列行里以短描述出现，绝不以卡片形态出现。
  assert.match(html, /回答「问题 a1」/);
  assert.doesNotMatch(html, /它在等你回答/);
});

test('当前项是会超时的那条，且它的倒计时出现在卡片里', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);

  // 卡片的 TimeoutHint 用 formatCountdown；剩余 10 秒 → 紧迫措辞。
  assert.match(html, /即将自动拒绝（10 秒）/);
  // 永不超时的 a1 在队列行里说「不会超时」。
  assert.match(html, /不会超时/);
});

test('队列行按超时时刻升序：越快到期排越前', () => {
  const html = render([ask('a1'), bash('b1', 50_000), bash('b2', 10_000)]);

  // b1 已过 50 秒 → 只剩 10 秒；b2 已过 10 秒 → 还剩 50 秒。
  // 升序即「b1 在前」：10 秒那行必须早于 50 秒那行。
  const ten = html.indexOf('即将自动拒绝（10 秒）');
  const fifty = html.indexOf('50 秒后自动拒绝');
  assert.ok(ten >= 0 && fifty >= 0);
  assert.ok(ten < fifty, '越快到期的排在前面');
});

test('永不超时的请求沉到队底，不会顶掉会超时的当前项', () => {
  const html = render([ask('a1'), bash('b1', 50_000)]);

  // 当前卡片是 b1，不是 a1。
  assert.match(html, /echo b1/);
  assert.equal(html.split(CARD_SHELL).length - 1, 1);
  assert.doesNotMatch(html, /它在等你回答/);
});

test('队列行的摘要：普通工具带工具名，交互类工具不等于卡片文案', () => {
  const html = render([ask('a1'), ask('a2')]);

  // 两条都是 AskUserQuestion、都不超时 —— 队头是入参第一条（稳定排序）。
  assert.match(html, /回答「问题 a1」/);
  assert.match(html, /回答「问题 a2」/);
  // 卡片只画一条。
  assert.equal(html.split(CARD_SHELL).length - 1, 1);
});

test('未知工具名不崩，队列行退化为通用摘要', () => {
  const html = render([
    bash('b1', 0),
    { requestId: 'u1', toolName: 'UnknownTool', receivedAt: new Date(NOW), input: {} },
  ]);

  assert.match(html, /允许 UnknownTool 执行/);
});
