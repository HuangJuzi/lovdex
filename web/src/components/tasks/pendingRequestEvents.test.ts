import test from 'node:test';
import assert from 'node:assert/strict';

import type { PendingPermissionRequest } from '../chat/types/types';

import {
  EMPTY_PENDING_STATE,
  applyPendingEvent,
  type PendingRequestsEvent,
  type PendingRequestsState,
} from './pendingRequestEvents';

const SID = 'sess-1';
const NOW = new Date('2026-01-02T03:04:05.000Z');
const opts = { now: NOW };

const req = (requestId: string, toolName = 'Bash'): PendingPermissionRequest => ({
  requestId,
  toolName,
  receivedAt: NOW,
});

const stateWith = (
  pendingRequests: PendingPermissionRequest[],
  isProcessing = true,
): PendingRequestsState => ({ pendingRequests, isProcessing });

test('未选中会话（sessionId 为 null）时任何帧都原样返回', () => {
  const events: PendingRequestsEvent[] = [
    { kind: 'chat_subscribed', sessionId: SID, isProcessing: true, pendingPermissions: [req('a')] },
    { kind: 'permission_request', sessionId: SID, requestId: 'a', toolName: 'Bash' },
    { kind: 'permission_cancelled', sessionId: SID, requestId: 'a' },
    { kind: 'complete', sessionId: SID },
    { kind: 'other' },
  ];

  for (const event of events) {
    assert.equal(applyPendingEvent(EMPTY_PENDING_STATE, event, null, opts), EMPTY_PENDING_STATE, event.kind);
  }
});

test('sessionId 为空串同样不跟踪', () => {
  const event: PendingRequestsEvent = { kind: 'complete', sessionId: '' };
  assert.equal(applyPendingEvent(stateWith([req('a')]), event, '', opts).pendingRequests.length, 1);
});

test('chat_subscribed：别的会话的 ack 不改变状态', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: 'other',
    isProcessing: false,
    pendingPermissions: [],
  };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('chat_subscribed：本会话的 ack 整体替换待办并带上 isProcessing', () => {
  const state = stateWith([req('stale')], false);
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [req('a'), req('b')],
  };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(next.isProcessing, true);
});

test('chat_subscribed：pendingPermissions 不是数组时清空（不残留上个会话的条目）', () => {
  const state = stateWith([req('stale')]);

  for (const bogus of [undefined, null, 'nope', { 0: req('x') }]) {
    const next = applyPendingEvent(
      state,
      { kind: 'chat_subscribed', sessionId: SID, isProcessing: true, pendingPermissions: bogus },
      SID,
      opts,
    );
    assert.deepEqual(next.pendingRequests, [], String(bogus));
  }
});

test('chat_subscribed：ISO 字符串的 receivedAt 转成 Date —— 丢了它倒计时就静默失效', () => {
  const iso = '2025-12-31T23:59:00.000Z';
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [{ requestId: 'a', toolName: 'Bash', receivedAt: iso }],
  };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.ok(entry.receivedAt instanceof Date, 'receivedAt 必须是 Date，不能是线上传来的字符串');
  assert.equal(entry.receivedAt?.getTime(), new Date(iso).getTime());
});

test('chat_subscribed：缺 receivedAt 的条目用注入的 now 打点', () => {
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [{ requestId: 'a', toolName: 'Bash' }],
  };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.equal(entry.receivedAt?.getTime(), NOW.getTime());
});

test('chat_subscribed：snapshot 条目原样带出（input/context/sessionId 都是喂给面板的）', () => {
  // 后端构造快照时已经把 sessionId 重映射成应用会话 id（registry 的出站覆写 +
  // handleChatSubscribe 的 .map），所以这里的 sessionId 是**穿过**来的，不是本
  // 函数补的 —— 本函数只补 receivedAt。
  const event: PendingRequestsEvent = {
    kind: 'chat_subscribed',
    sessionId: SID,
    isProcessing: true,
    pendingPermissions: [
      { requestId: 'a', toolName: 'Bash', sessionId: SID, input: { cmd: 'ls' }, context: { cwd: '/tmp' } },
    ],
  };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.equal(entry.sessionId, SID);
  assert.deepEqual(entry.input, { cmd: 'ls' });
  assert.deepEqual(entry.context, { cwd: '/tmp' });
});

test('permission_request：别的会话的请求不进来', () => {
  const state = stateWith([], true);
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: 'other',
    requestId: 'a',
    toolName: 'Bash',
  };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('permission_request：本会话的请求追加到队尾并置 isProcessing', () => {
  const state = stateWith([req('a')], false);
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'b',
    toolName: 'Write',
    input: { file_path: '/tmp/x' },
    context: { cwd: '/tmp' },
  };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(next.isProcessing, true);

  const added = next.pendingRequests[1];
  assert.equal(added.toolName, 'Write');
  assert.equal(added.sessionId, SID);
  assert.equal(added.receivedAt?.getTime(), NOW.getTime());
  assert.deepEqual(added.input, { file_path: '/tmp/x' });
});

test('permission_request：toolName 缺失时落到 UnknownTool', () => {
  const event: PendingRequestsEvent = { kind: 'permission_request', sessionId: SID, requestId: 'a' };

  const [entry] = applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests;
  assert.equal(entry.toolName, 'UnknownTool');
});

test('permission_request：没有 requestId 的直接丢弃（答不了）', () => {
  const state = stateWith([req('a')]);
  for (const requestId of [undefined, '']) {
    const event: PendingRequestsEvent = { kind: 'permission_request', sessionId: SID, requestId, toolName: 'Bash' };
    assert.equal(applyPendingEvent(state, event, SID, opts), state, String(requestId));
  }
});

test('permission_request：已在队列里的 requestId 不重复追加', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = { kind: 'permission_request', sessionId: SID, requestId: 'a', toolName: 'Bash' };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.equal(next.pendingRequests.length, 1);
  assert.equal(next.pendingRequests.filter((r) => r.requestId === 'a').length, 1);
});

test('permission_cancelled：按 requestId 过滤掉，其余保持顺序', () => {
  const state = stateWith([req('a'), req('b'), req('c')]);
  const event: PendingRequestsEvent = { kind: 'permission_cancelled', sessionId: SID, requestId: 'b' };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['a', 'c']);
});

test('permission_cancelled：没有这个 id 时返回同一个引用（不白造新数组）', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = { kind: 'permission_cancelled', sessionId: SID, requestId: 'nope' };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('permission_cancelled：别的会话的取消不影响本会话', () => {
  const state = stateWith([req('a')]);
  const event: PendingRequestsEvent = { kind: 'permission_cancelled', sessionId: 'other', requestId: 'a' };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('complete：本会话结束时清空待办并落下 isProcessing（丢帧时的兜底）', () => {
  const state = stateWith([req('a'), req('b')], true);
  const event: PendingRequestsEvent = { kind: 'complete', sessionId: SID };

  const next = applyPendingEvent(state, event, SID, opts);
  assert.deepEqual(next.pendingRequests, []);
  assert.equal(next.isProcessing, false);
});

test('complete：别的会话结束不改变本会话状态', () => {
  const state = stateWith([req('a')], true);
  const event: PendingRequestsEvent = { kind: 'complete', sessionId: 'other' };

  assert.equal(applyPendingEvent(state, event, SID, opts), state);
});

test('other：不认识的帧原样返回同一个引用', () => {
  const state = stateWith([req('a')]);
  assert.equal(applyPendingEvent(state, { kind: 'other' }, SID, opts), state);
});

test('纯函数：任何一条分支都不改动入参的 state 与其中的数组/对象', () => {
  const list = [req('a'), req('b')];
  const state = stateWith(list, true);
  const snapshot = JSON.stringify(list.map((r) => ({ id: r.requestId, at: r.receivedAt?.toISOString() })));

  applyPendingEvent(state, { kind: 'permission_cancelled', sessionId: SID, requestId: 'a' }, SID, opts);
  applyPendingEvent(state, { kind: 'permission_request', sessionId: SID, requestId: 'c' }, SID, opts);
  applyPendingEvent(state, { kind: 'complete', sessionId: SID }, SID, opts);
  applyPendingEvent(
    state,
    { kind: 'chat_subscribed', sessionId: SID, isProcessing: false, pendingPermissions: [req('z')] },
    SID,
    opts,
  );

  assert.deepEqual(state.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(state.isProcessing, true);
  assert.equal(
    JSON.stringify(list.map((r) => ({ id: r.requestId, at: r.receivedAt?.toISOString() }))),
    snapshot,
  );
});
