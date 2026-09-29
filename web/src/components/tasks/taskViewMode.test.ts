import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TASK_VIEW_MODE, effectiveTaskViewMode } from './taskViewMode';

test('电脑端默认表格', () => {
  assert.equal(DEFAULT_TASK_VIEW_MODE, 'table');
  assert.equal(effectiveTaskViewMode({ isMobile: false, stored: DEFAULT_TASK_VIEW_MODE }), 'table');
});

test('电脑端可以手动开看板', () => {
  assert.equal(effectiveTaskViewMode({ isMobile: false, stored: 'board' }), 'board');
});

test('手机端强制看板，无视存储值', () => {
  // 手机上表格按钮整个不渲染，所以「存储里选了表格」不是一种可达状态；
  // 真要出现也不能信它，否则会渲染出一个没有对应按钮的视图。
  assert.equal(effectiveTaskViewMode({ isMobile: true, stored: 'table' }), 'board');
  assert.equal(effectiveTaskViewMode({ isMobile: true, stored: 'board' }), 'board');
});
