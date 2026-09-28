import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQuickReplyInput } from './quickReplyInsert';

test('输入框为空时直接填入', () => {
  assert.equal(buildQuickReplyInput('', '继续'), '继续');
});

test('输入框只有空白时也视为空', () => {
  assert.equal(buildQuickReplyInput('   ', '继续'), '继续');
});

test('输入框有内容时追加到末尾，单空格分隔', () => {
  assert.equal(buildQuickReplyInput('写个测试', '继续'), '写个测试 继续');
});

test('输入框有尾随空格时不产生双空格', () => {
  assert.equal(buildQuickReplyInput('写个测试   ', '继续'), '写个测试 继续');
});

test('输入框两端都有空白时一并 trim', () => {
  assert.equal(buildQuickReplyInput(' 写个测试 ', '继续'), '写个测试 继续');
});
