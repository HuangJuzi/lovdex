import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReplyState } from './panelReply';
import { canSendReply, isSendKey, shouldSendOnEnter, showQuickReplies } from './panelReplyBox';

/** 只关心「能不能敲/能不能发」的替身；文案由 panelReply 拥有，这里不测。 */
const ready: ReplyState = { mode: 'ready', canType: true, willQueue: false, hint: 'hint' };
const queued: ReplyState = { mode: 'queued', canType: true, willQueue: true, hint: 'hint' };
const noSession: ReplyState = { mode: 'no-session', canType: false, willQueue: false, hint: 'hint' };

/** 一个「普通键盘按下」：非组合态、无 Shift。 */
const key = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  ...over,
});

test('canSendReply：可输入且去掉首尾空白后非空才为真', () => {
  assert.equal(canSendReply(ready, '好的'), true);
  assert.equal(canSendReply(ready, '  好的  '), true);
  assert.equal(canSendReply(ready, ''), false);
});

test('canSendReply：纯空白不算内容（只有空格 / 换行 / 制表符都不发）', () => {
  // 少了 trim 的话这些都会变成「可发」——用户按 Enter 发出一串空白给模型。
  for (const blank of [' ', '   ', '\n', '\n\n', '\t', ' \n\t ']) {
    assert.equal(canSendReply(ready, blank), false, JSON.stringify(blank));
  }
});

test('canSendReply：不可输入的会话一律不能发，哪怕框里有内容', () => {
  // 会话被清理后 value 可能还留着上一轮的草稿：只判 value 会放行一次注定失败的发送。
  assert.equal(canSendReply(noSession, '好的'), false);
});

test('canSendReply：排队态仍可发 —— 发送只是排队，不是被禁止', () => {
  // willQueue 是**提示**不是闸门：后端没有服务端队列，前端替它排队。
  // 若有人把 `&& !willQueue` 加进来，执行中的任务就再也回不了话。
  assert.equal(canSendReply(queued, '好的'), true);
});

test('shouldSendOnEnter：Enter 且非 Shift、非组合态、有内容 —— 发送', () => {
  assert.equal(shouldSendOnEnter(ready, '好的', key()), true);
});

test('shouldSendOnEnter：Shift+Enter 是换行，不发送', () => {
  assert.equal(shouldSendOnEnter(ready, '好的', key({ shiftKey: true })), false);
});

test('shouldSendOnEnter：输入法组合中的 Enter 是选字，不发送', () => {
  // 中文输入法里 Enter 用来确认拼音候选词。少了这个判断，用户敲「nihao」按 Enter
  // 选词就会把半成品的候选串当成消息发出去 —— 这是本仓库（中文优先）的必守项，
  // 两处既有发送入口（useChatComposerState / QuickRepliesMenu）都做了同样的判断。
  assert.equal(shouldSendOnEnter(ready, '好的', key({ isComposing: true })), false);
});

test('shouldSendOnEnter：内容为空或纯空白时 Enter 不发', () => {
  assert.equal(shouldSendOnEnter(ready, '', key()), false);
  assert.equal(shouldSendOnEnter(ready, '   ', key()), false);
});

test('shouldSendOnEnter：别的键不发送', () => {
  assert.equal(shouldSendOnEnter(ready, '好的', key({ key: 'a' })), false);
  assert.equal(shouldSendOnEnter(ready, '好的', key({ key: 'Escape' })), false);
});

test('shouldSendOnEnter：队列中（willQueue）照常发送', () => {
  assert.equal(shouldSendOnEnter(queued, '好的', key()), true);
});

test('isSendKey：只看键与修饰键，与内容无关（内容闸门是 canSendReply 的事）', () => {
  // 这个判据决定要不要 preventDefault —— 组合态里绝不能 preventDefault，
  // 否则会干扰输入法选字。所以「有内容」不参与这里。
  assert.equal(isSendKey(key()), true);
  assert.equal(isSendKey(key({ shiftKey: true })), false);
  assert.equal(isSendKey(key({ isComposing: true })), false);
  assert.equal(isSendKey(key({ key: 'a' })), false);
});

test('showQuickReplies：可用且有条目才显示', () => {
  assert.equal(showQuickReplies(ready, 2), true);
});

test('showQuickReplies：列表为空时整行不渲染（空行是噪音，不承诺可插入）', () => {
  assert.equal(showQuickReplies(ready, 0), false);
});

test('showQuickReplies：会话不可用时连常用语也不给 —— 给一个插不进去的片段比不给更糟', () => {
  assert.equal(showQuickReplies(noSession, 3), false);
});
