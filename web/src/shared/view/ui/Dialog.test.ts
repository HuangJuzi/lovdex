import test from 'node:test';
import assert from 'node:assert/strict';

import { DIALOG_CONTENT_VARIANT_CLASS } from './Dialog';

test('center 变体保持居中定位与 max-w-lg', () => {
  const cls = DIALOG_CONTENT_VARIANT_CLASS.center;
  assert.ok(cls.includes('left-1/2'), '应含 left-1/2');
  assert.ok(cls.includes('top-1/2'), '应含 top-1/2');
  assert.ok(cls.includes('-translate-x-1/2'), '应含 -translate-x-1/2');
  assert.ok(cls.includes('-translate-y-1/2'), '应含 -translate-y-1/2');
  assert.ok(cls.includes('max-w-lg'), '应含 max-w-lg');
});

test('sheet 变体贴底、全宽、只保留顶部圆角', () => {
  const cls = DIALOG_CONTENT_VARIANT_CLASS.sheet;
  assert.ok(cls.includes('bottom-0'), '应含 bottom-0');
  assert.ok(cls.includes('inset-x-0'), '应含 inset-x-0');
  assert.ok(cls.includes('rounded-t-2xl'), '应含 rounded-t-2xl');
  assert.ok(cls.includes('rounded-b-none'), '应含 rounded-b-none');
});

test('sheet 变体不带任何居中位移（否则会飘到屏幕中间）', () => {
  const cls = DIALOG_CONTENT_VARIANT_CLASS.sheet;
  assert.ok(!cls.includes('translate'), '不应含 translate 类');
  assert.ok(!cls.includes('top-1/2'), '不应含 top-1/2');
  assert.ok(!cls.includes('max-w-lg'), '不应含 max-w-lg');
});

test('center 与 sheet 各自绑定自己的入场动画', () => {
  assert.ok(
    DIALOG_CONTENT_VARIANT_CLASS.center.includes('animate-dialog-content-show'),
    'center 应使用居中动画',
  );
  assert.ok(
    DIALOG_CONTENT_VARIANT_CLASS.sheet.includes('animate-dialog-sheet-show'),
    'sheet 应使用底部滑入动画',
  );
});

test('sheet 不得沿用居中动画（其 keyframes 会强行注入 translate(-50%,-50%)）', () => {
  assert.ok(
    !DIALOG_CONTENT_VARIANT_CLASS.sheet.includes('animate-dialog-content-show'),
    'sheet 不能带 animate-dialog-content-show',
  );
});
