import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreateTaskDialog, moreSetCount } from './CreateTaskDialog';

// moreSetCount 是纯函数，直接验证「更多」角标计数。
test('moreSetCount counts name / source session / remark', () => {
  assert.equal(moreSetCount('', '', ''), 0);
  assert.equal(moreSetCount('名', '', ''), 1);
  assert.equal(moreSetCount('', 's-1', ''), 1);
  assert.equal(moreSetCount('', '', '备注'), 1);
  assert.equal(moreSetCount('名', 's-1', '备注'), 3);
  assert.equal(moreSetCount('   ', '', '  '), 0); // 纯空白不算已填
});

// 关闭态下不崩溃（Dialog 的 DialogContent 在 open=false 时返回 null，不碰 document.body）。
test('renders without crashing when closed', () => {
  const html = renderToStaticMarkup(
    <CreateTaskDialog open={false} onClose={() => {}} onCreated={() => {}} />,
  );
  assert.equal(typeof html, 'string');
});
