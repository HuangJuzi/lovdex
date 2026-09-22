import test from 'node:test';
import assert from 'node:assert/strict';

import { deletedRunIds, scheduleDeleteConfirmMessage, scheduleDeleteErrorMessage } from './scheduleDelete';

test('scheduleDeleteConfirmMessage: 有运行记录时把条数与「会话一并删除」写进承诺', () => {
  const msg = scheduleDeleteConfirmMessage('每日站会', 3);
  assert.equal(msg, '删除定时任务「每日站会」？它跑出的 3 条任务及关联会话也会一并删除，此操作不可恢复。');
  // 这条承诺是「删调度会毁掉对话记录」的唯一告知点，两个要素缺一不可
  assert.match(msg, /关联会话也会一并删除/);
  assert.match(msg, /不可恢复/);
});

test('scheduleDeleteConfirmMessage: 一条都没跑过时不留「已生成的任务不会被删除」这类旧承诺', () => {
  const msg = scheduleDeleteConfirmMessage('每日站会', 0);
  assert.equal(msg, '删除定时任务「每日站会」？它跑出的任务及关联会话也会一并删除，此操作不可恢复。');
  // 旧文案（已生成的任务不会被删除）现在是假的 —— 钉住它不许回来
  assert.doesNotMatch(msg, /不会被删除/);
});

test('scheduleDeleteErrorMessage: 409 走专用文案（还有一轮在跑）', () => {
  const msg = scheduleDeleteErrorMessage('每日站会', 409, {
    error: { code: 'SESSION_RUNNING', message: 'cannot delete schedule s1: its run t1 is running/in_progress' },
  });
  assert.equal(msg, '「每日站会」还有一轮未结束的运行，先停止或中断它再删除');
});

test('scheduleDeleteErrorMessage: 其它失败带出后端 message，读不到就退回状态码', () => {
  assert.equal(
    scheduleDeleteErrorMessage('每日站会', 500, { error: { code: 'INTERNAL', message: '数据库连接失败' } }),
    '「每日站会」数据库连接失败',
  );
  assert.equal(scheduleDeleteErrorMessage('每日站会', 503, null), '「每日站会」删除失败 (503)');
  assert.equal(scheduleDeleteErrorMessage('每日站会', 502, { error: { message: '   ' } }), '「每日站会」删除失败 (502)');
  assert.equal(scheduleDeleteErrorMessage('每日站会', 500, 'oops'), '「每日站会」删除失败 (500)', '非对象 body');
  assert.equal(scheduleDeleteErrorMessage('每日站会', 500, { error: 5 }), '「每日站会」删除失败 (500)', 'error 不是对象');
});

test('deletedRunIds: 读出后端级联删掉的任务 id', () => {
  assert.deepEqual(deletedRunIds({ success: true, deletedTaskIds: ['t1', 't2'] }), ['t1', 't2']);
});

test('deletedRunIds: 读不到就退回空数组（老后端 / 非对象 body / 字段不是数组）', () => {
  assert.deepEqual(deletedRunIds(null), []);
  assert.deepEqual(deletedRunIds(undefined), []);
  assert.deepEqual(deletedRunIds('oops'), []);
  assert.deepEqual(deletedRunIds({ success: true }), []);
  assert.deepEqual(deletedRunIds({ deletedTaskIds: 't1' }), []);
  // 数组里混进非字符串：只留字符串，别把 undefined 塞进 onRunsDeleted
  assert.deepEqual(deletedRunIds({ deletedTaskIds: ['t1', 7, null, 't2'] }), ['t1', 't2']);
});
