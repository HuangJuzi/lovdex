/**
 * 收件箱共享状态源。跨路由存活（/inbox、/tasks 会卸载 AppContent，组件级 state
 * 会丢），故用模块级单例 + useSyncExternalStore 风格订阅（仿 branchStore.ts）。
 * 数据来自 REST 首拉 + WS 实时（notification_created / notification_updated /
 * websocket_reconnected 全量 refetch）。
 */

import { api } from '../utils/api';
import { inboxReducer, countUnread, type InboxState, type InboxNotification } from './inboxStore.pure';

type Listener = () => void;

let state: InboxState = { items: [] };
const listeners = new Set<Listener>();

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
    setState(inboxReducer(state, { type: 'created', row }));
    return row.severity !== 'info' ? row : null;
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

export function markReadLocal(id: string): void {
  setState(inboxReducer(state, { type: 'markReadLocal', id }));
  void api.notifications.markRead(id);
}

export function markAllReadLocal(): void {
  setState(inboxReducer(state, { type: 'markAllReadLocal' }));
  void api.notifications.markAllRead();
}
