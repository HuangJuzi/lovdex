import test from 'node:test';
import assert from 'node:assert/strict';

import { createdTaskNavState, readCreatedTaskId } from './createdTaskHandoff';

test('读出 createdTaskId', () => {
  assert.equal(readCreatedTaskId({ createdTaskId: 't1' }), 't1');
});

test('多余的字段不影响', () => {
  assert.equal(readCreatedTaskId({ createdTaskId: 't1', other: 1 }), 't1');
});

test('null / undefined / 非对象一律当没有', () => {
  assert.equal(readCreatedTaskId(null), null);
  assert.equal(readCreatedTaskId(undefined), null);
  assert.equal(readCreatedTaskId('t1'), null);
  assert.equal(readCreatedTaskId(42), null);
  assert.equal(readCreatedTaskId([]), null);
});

test('空串与非字符串的 createdTaskId 当没有', () => {
  assert.equal(readCreatedTaskId({ createdTaskId: '' }), null);
  assert.equal(readCreatedTaskId({ createdTaskId: 7 }), null);
  assert.equal(readCreatedTaskId({ createdTaskId: null }), null);
  assert.equal(readCreatedTaskId({}), null);
});

test('写出来的 state 能被读回来（导航契约两端同时钉住）', () => {
  // 读写两侧在同一个模块里，改 key 名字会同时挂掉这两条 —— 否则 Sidebar.tsx
  // 改个字段名、TaskBoard 静默读不到，正是这条链路最容易悄悄坏的方式。
  assert.equal(readCreatedTaskId(createdTaskNavState('t9')), 't9');
});
