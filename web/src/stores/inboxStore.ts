/**
 * 收件箱共享状态源。跨路由存活（/inbox、/tasks 会卸载 AppContent，组件级 state
 * 会丢），故用模块级单例 + useSyncExternalStore 风格订阅（仿 branchStore.ts）。
 * 数据来自 REST 首拉 + WS 实时（notification_created / notification_updated /
 * websocket_reconnected 全量 refetch）。
 */

import { api } from '../utils/api';
import {
  inboxReducer,
  countUnread,
  selectUnannouncedImportant,
  type InboxState,
  type InboxNotification,
} from './inboxStore.pure';

type Listener = () => void;

let state: InboxState = { items: [] };
const listeners = new Set<Listener>();

/**
 * 本次页面会话里已经"打扰"过的通知 id（toast 弹过、或已进过汇总弹窗）。
 * 模块级：跨路由存活（AppContent 会在 /inbox、/tasks 卸载重挂），但页面刷新
 * 会重置 —— 刷新后重新补推未读重要项是期望行为。
 */
const announced = new Set<string>();

function setState(next: InboxState) {
  state = next;
  listeners.forEach((l) => l());
}

export function getInboxSnapshot(): InboxState {
  return state;
}

export function getUnreadCount(): number {
  return countUnread(state.items);
}

export function subscribeInbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** REST 全量拉取（首挂 / 重连）。 */
export async function refreshInbox(): Promise<void> {
  try {
    const res = await api.notifications.list({ limit: 200 });
    if (!res.ok) return;
    const rows = (await res.json()) as InboxNotification[];
    setState(inboxReducer(state, { type: 'replaceAll', rows: Array.isArray(rows) ? rows : [] }));
  } catch {
    // 瞬时失败保留上一次快照。
  }
}

/** 把一条 WS 帧喂给 store。返回值不为 null 表示这是一条"值得弹窗"的新告警（created 且非 info）。 */
export function applyInboxEvent(event: { kind?: string; payload?: unknown }): InboxNotification | null {
  if (event.kind === 'notification_created') {
    const row = event.payload as InboxNotification;
    const toaster = row.severity !== 'info';
    // 返回值非 null 即"调用方会 toast 它"（两边是同一个条件），所以这里先记账：
    // 否则稍后一次断线重连的 refetch 会把它当"没打扰过"再汇总弹一次。
    if (toaster) announced.add(row.notification_id);
    setState(inboxReducer(state, { type: 'created', row }));
    return toaster ? row : null;
  }
  if (event.kind === 'notification_updated') {
    // 计数/已读/合并变更：拿不到整行时做一次轻量 refetch 保持一致。
    void refreshInbox();
    return null;
  }
  if (event.kind === 'websocket_reconnected') {
    void refreshInbox();
  }
  return null;
}

/**
 * 取走"值得打扰、且本次会话还没打扰过"的未读重要通知；命中即记账，所以调用方
 * 可以放心地在每次 refetch 后调它。首挂拉取后与断线重连 refetch 后共用它 ——
 * 后者是手机切后台的主路径：那段时间产生的通知不会经过 notification_created
 * （客户端当时根本没连着），只有重连后的全量拉取能发现，而拉取只更新列表和角标，
 * 不弹任何东西，于是"收件箱有、不弹窗"。这里补上那一次弹窗。
 */
export function claimUnannouncedImportant(): InboxNotification[] {
  const fresh = selectUnannouncedImportant(state.items, announced);
  for (const it of fresh) announced.add(it.notification_id);
  return fresh;
}

export function markReadLocal(id: string): void {
  setState(inboxReducer(state, { type: 'markReadLocal', id }));
  void api.notifications.markRead(id);
}

export function markAllReadLocal(): void {
  setState(inboxReducer(state, { type: 'markAllReadLocal' }));
  void api.notifications.markAllRead();
}
