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
  snapshotSeq = -1,
): PendingRequestsState => ({ pendingRequests, isProcessing, snapshotSeq });

const ack = (lastSeq: number, pendingPermissions: unknown = []): PendingRequestsEvent => ({
  kind: 'chat_subscribed',
  sessionId: SID,
  isProcessing: true,
  lastSeq,
  pendingPermissions,
});

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

test('complete：水线一起归零 —— 下一轮 run 的 seq 从 1 重数，旧水线会静默吞掉它的实时帧', () => {
  const finished = applyPendingEvent(
    applyPendingEvent(EMPTY_PENDING_STATE, ack(9), SID, opts),
    { kind: 'complete', sessionId: SID },
    SID,
    opts,
  );
  assert.equal(finished.snapshotSeq, -1);

  // 下一轮的第一个审批帧 seq=1。若水线还停在 9，这一帧会被当成重放丢掉。
  const nextRunFrame: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'round-2',
    toolName: 'Bash',
    seq: 1,
  };
  assert.deepEqual(
    applyPendingEvent(finished, nextRunFrame, SID, opts).pendingRequests.map((r) => r.requestId),
    ['round-2'],
  );
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

/*
 * 重放水线：`chat.subscribe` 的 ack 之后，后端还会把 run 缓冲区里的整段事件重放
 * 给这个 socket（`readReplayStart` 对**首次**订阅返回 0，与客户端发的 lastSeq 无关）。
 * 答复一条审批**不会**发 `permission_cancelled`，所以已经答过的 `permission_request`
 * 仍躺在缓冲区里，重放会把它当成一条新待办加回来 —— 而且带着新打的 receivedAt，
 * 连倒计时都是全新的。点它毫无反应（后端对未知 requestId 静默忽略）。
 */

test('chat_subscribed：ack 把 lastSeq 记成快照水线', () => {
  const next = applyPendingEvent(EMPTY_PENDING_STATE, ack(7), SID, opts);
  assert.equal(next.snapshotSeq, 7);
});

test('chat_subscribed：lastSeq 不是数字时水线落到 -1（宁可不拦，也不要误拦实时帧）', () => {
  for (const bogus of [undefined, null, '7', Number.NaN]) {
    const event = { kind: 'chat_subscribed', sessionId: SID, isProcessing: true, lastSeq: bogus } as PendingRequestsEvent;
    assert.equal(applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).snapshotSeq, -1, String(bogus));
  }
});

test('permission_request：seq 落在快照水线以内的（重放）丢弃，不复活已答的待办', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const replayed: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'answered',
    toolName: 'Bash',
    seq: 5,
  };

  assert.equal(applyPendingEvent(state, replayed, SID, opts), state);
  assert.equal(
    applyPendingEvent(state, { ...replayed, seq: 2 }, SID, opts),
    state,
    '水线以下的更早帧同样丢弃',
  );
});

test('permission_request：seq 高于快照水线的（真·实时帧）正常追加', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const live: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'live',
    toolName: 'Bash',
    seq: 6,
  };

  const next = applyPendingEvent(state, live, SID, opts);
  assert.deepEqual(next.pendingRequests.map((r) => r.requestId), ['live']);
  assert.equal(next.isProcessing, true);
  assert.equal(next.snapshotSeq, 5, '水线不因增量帧前进');
});

test('permission_request：没有 seq 的帧照常处理（别把不盖 seq 的 provider 静默吞掉）', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'no-seq',
    toolName: 'Bash',
  };

  assert.deepEqual(
    applyPendingEvent(state, event, SID, opts).pendingRequests.map((r) => r.requestId),
    ['no-seq'],
  );
});

test('permission_cancelled：seq 落在快照水线以内的（重放）丢弃', () => {
  const state = applyPendingEvent(EMPTY_PENDING_STATE, ack(5), SID, opts);
  const withPending = { ...state, pendingRequests: [req('a')] };
  const replayed: PendingRequestsEvent = {
    kind: 'permission_cancelled',
    sessionId: SID,
    requestId: 'a',
    seq: 5,
  };

  assert.equal(applyPendingEvent(withPending, replayed, SID, opts), withPending);
  assert.deepEqual(
    applyPendingEvent(withPending, { ...replayed, seq: 6 }, SID, opts).pendingRequests.map((r) => r.requestId),
    [],
  );
});

test('水线是会话级的：没收到 ack 之前（-1）不拦任何帧', () => {
  const event: PendingRequestsEvent = {
    kind: 'permission_request',
    sessionId: SID,
    requestId: 'a',
    toolName: 'Bash',
    seq: 1,
  };

  assert.deepEqual(
    applyPendingEvent(EMPTY_PENDING_STATE, event, SID, opts).pendingRequests.map((r) => r.requestId),
    ['a'],
  );
});

test('纯函数：任何一条分支都不改动入参的 state 与其中的数组/对象', () => {
  const list = [req('a'), req('b')];
  const state = stateWith(list, true, 3);
  const snapshot = JSON.stringify(list.map((r) => ({ id: r.requestId, at: r.receivedAt?.toISOString() })));

  applyPendingEvent(state, { kind: 'permission_cancelled', sessionId: SID, requestId: 'a' }, SID, opts);
  applyPendingEvent(state, { kind: 'permission_request', sessionId: SID, requestId: 'c' }, SID, opts);
  applyPendingEvent(state, { kind: 'permission_request', sessionId: SID, requestId: 'd', seq: 1 }, SID, opts);
  applyPendingEvent(state, { kind: 'complete', sessionId: SID }, SID, opts);
  applyPendingEvent(state, ack(9, [req('z')]), SID, opts);

  assert.deepEqual(state.pendingRequests.map((r) => r.requestId), ['a', 'b']);
  assert.equal(state.isProcessing, true);
  assert.equal(state.snapshotSeq, 3);
  assert.equal(
    JSON.stringify(list.map((r) => ({ id: r.requestId, at: r.receivedAt?.toISOString() }))),
    snapshot,
  );
});
