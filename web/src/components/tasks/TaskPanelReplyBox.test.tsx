import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ReplyState } from './panelReply';
import { TaskPanelReplyBox } from './TaskPanelReplyBox';

const ready = (over: Partial<ReplyState> = {}): ReplyState => ({
  mode: 'ready',
  canType: true,
  willQueue: false,
  hint: 'Enter 发送 · Shift+Enter 换行',
  ...over,
});

const render = (
  props: Partial<Parameters<typeof TaskPanelReplyBox>[0]> = {},
): string =>
  renderToStaticMarkup(
    <TaskPanelReplyBox
      value=""
      onChange={() => {}}
      onSend={() => {}}
      quickReplies={[]}
      replyState={ready()}
      onInsertQuickReply={() => {}}
      {...props}
    />,
  );

/**
 * 取某个具体元素的开标签。
 *
 * **不要**对整页用 `assert.match(html, /disabled/)`：本组件里 Tailwind 的
 * `disabled:opacity-45` / `disabled:opacity-50` 类名里就含 "disabled" 这个子串，
 * 于是「有没有 disabled」永远为真，断言恒过。必须把范围收到目标元素上。
 * 同一文件里可能有多个 `<button>`，所以发送键的匹配要带上它的文案。
 */
const tagOf = (html: string, pattern: RegExp): string => {
  const match = html.match(pattern);
  assert.ok(match, `没找到匹配 ${pattern} 的元素`);
  return match[0];
};

const textareaTag = (html: string): string => tagOf(html, /<textarea[^>]*>/);
const sendButtonTag = (html: string): string => tagOf(html, /<button[^>]*>发送<\/button>/);

const isDisabled = (tag: string): boolean => tag.includes('disabled=""');

test('会话被清理：输入框与发送键都禁用，提示不可回复，且常用语整行不出现', () => {
  const html = render({
    value: '上一轮留下的草稿',
    quickReplies: [{ quick_reply_id: 'q1', content: '继续' }],
    replyState: ready({
      mode: 'no-session',
      canType: false,
      willQueue: false,
      hint: '这个会话已被清理，无法再回复',
    }),
  });

  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.equal(isDisabled(textareaTag(html)), true, '输入框应禁用');
  // 框里虽有内容，会话没了也一样发不出去 —— 只判 value 的实现会在这里放行。
  assert.equal(isDisabled(sendButtonTag(html)), true, '发送键应禁用');
  // 插不进去的片段比不给更糟：整行（连带「点一下填入」提示）都不该出现。
  assert.doesNotMatch(html, /继续/);
  assert.doesNotMatch(html, /点一下填入/);
});

test('执行中：输入框仍可编辑（排队不是禁止），提示来自 replyState', () => {
  const html = render({
    replyState: ready({
      mode: 'queued',
      willQueue: true,
      hint: '执行中 · 消息将排队发送，等这一轮结束',
    }),
  });

  assert.match(html, /执行中 · 消息将排队发送，等这一轮结束/);
  assert.equal(isDisabled(textareaTag(html)), false, '排队态输入框必须可编辑');
});

test('执行中：有内容时发送键可用 —— 排队态不是发送闸门', () => {
  const html = render({
    value: '好的',
    replyState: ready({ mode: 'queued', willQueue: true, hint: 'x' }),
  });

  assert.equal(isDisabled(sendButtonTag(html)), false, '排队态有内容应当能发');
});

test('常用语渲染为可点的 chip，并声明「点一下填入，不会直接发送」', () => {
  const html = render({
    quickReplies: [
      { quick_reply_id: 'q1', content: '继续' },
      { quick_reply_id: 'q2', content: '先停下' },
    ],
  });

  assert.match(html, /继续/);
  assert.match(html, /先停下/);
  assert.match(html, /点一下填入，不会直接发送/);
});

test('常用语列表为空：不渲染 chip 容器，也不出现「点一下填入」', () => {
  const html = render({ quickReplies: [] });

  assert.doesNotMatch(html, /点一下填入/);
});

test('header 恒有「↩ 快速回复」，与是否可用无关', () => {
  assert.match(render(), /↩ 快速回复/);
  assert.match(render({ replyState: ready({ mode: 'no-session', canType: false, hint: 'x' }) }), /↩ 快速回复/);
});

test('发送键：内容为纯空白时禁用（trim 后为空不该发空白）', () => {
  assert.equal(isDisabled(sendButtonTag(render({ value: '   ' }))), true);
  assert.equal(isDisabled(sendButtonTag(render({ value: '\n' }))), true);
});

test('发送键：有内容时可用', () => {
  assert.equal(isDisabled(sendButtonTag(render({ value: '好的' }))), false);
});

test('hint 逐字取自 replyState，组件不自己派生文案', () => {
  // 用一句别处不存在的文案：若组件把 hint 硬编码或重新推导，这里必挂。
  const html = render({ replyState: ready({ hint: '哨兵文案-Zz9' }) });

  assert.match(html, /哨兵文案-Zz9/);
});

test('不可用时 placeholder 换成「无法回复」，且不承诺 Enter 发送', () => {
  const disabledHtml = render({
    replyState: ready({ mode: 'no-session', canType: false, hint: 'x' }),
  });
  let placeholder = disabledHtml.match(/placeholder="([^"]*)"/)?.[1] ?? '';
  assert.equal(placeholder.includes('无法回复'), true);
  assert.equal(placeholder.includes('Enter 发送'), false);

  const readyHtml = render();
  placeholder = readyHtml.match(/placeholder="([^"]*)"/)?.[1] ?? '';
  assert.equal(placeholder.includes('Enter 发送'), true);
});
