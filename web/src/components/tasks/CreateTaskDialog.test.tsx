import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreateTaskDialog, canSubmitNewTask, moreSetCount } from './CreateTaskDialog';

// moreSetCount 是纯函数，直接验证「更多」角标计数。
test('moreSetCount counts name / source session / remark', () => {
  assert.equal(moreSetCount('', '', ''), 0);
  assert.equal(moreSetCount('名', '', ''), 1);
  assert.equal(moreSetCount('', 's-1', ''), 1);
  assert.equal(moreSetCount('', '', '备注'), 1);
  assert.equal(moreSetCount('名', 's-1', '备注'), 3);
  assert.equal(moreSetCount('   ', '', '  '), 0); // 纯空白不算已填
});

// 确认按钮的可用性判据：需求为空、或已有创建请求在途，都不能再提交。
// 在途那一档是「同一个任务被建出多条」的根因 —— title 留空时后端要等模型取名
// （最长 3s）才落库，这期间按钮若仍可点，双击连击就是两次 POST。
test('canSubmitNewTask rejects empty prompt and in-flight submit', () => {
  assert.equal(canSubmitNewTask('需求', false), true);
  assert.equal(canSubmitNewTask('   ', false), false); // 纯空白不算已填
  assert.equal(canSubmitNewTask('需求', true), false); // 创建在途
  assert.equal(canSubmitNewTask('   ', true), false);
});

// 关闭态下不崩溃（Dialog 的 DialogContent 在 open=false 时返回 null，不碰 document.body）。
test('renders without crashing when closed', () => {
  const html = renderToStaticMarkup(
    <CreateTaskDialog open={false} onClose={() => {}} onCreated={() => {}} />,
  );
  assert.equal(typeof html, 'string');
});
