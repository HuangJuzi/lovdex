export type InboxSeverity = 'critical' | 'warning' | 'info';

export type InboxNotification = {
  notification_id: string;
  severity: InboxSeverity;
  title: string;
  body?: string | null;
  code?: string | null;
  task_id?: string | null;
  session_id?: string | null;
  occurrence_count: number;
  read_at?: string | null;
  first_seen_at?: string;
  last_seen_at?: string;
};

export type InboxState = { items: InboxNotification[] };

export type InboxAction =
  | { type: 'created'; row: InboxNotification }
  | { type: 'updated'; row: InboxNotification }
  | { type: 'replaceAll'; rows: InboxNotification[] }
  | { type: 'markReadLocal'; id: string }
  | { type: 'markAllReadLocal' };

/** 未读总数 —— 与后端 unread-count、/inbox 页头、列表红点同一口径（含 info）。 */
export function countUnread(items: readonly InboxNotification[]): number {
  return items.filter((it) => !it.read_at).length;
}

/**
 * 挑出"值得打扰用户、且本次会话还没打扰过"的通知：未读 + 非 info + 不在
 * announced 里。补推汇总弹窗用它；announced 由调用方（store）持有并记账。
 *
 * 为什么要记账：断线重连后每次 refetch 都会重新看到同一批未读条，不记就会
 * 网络一抖弹一次。
 */
export function selectUnannouncedImportant(
  items: readonly InboxNotification[],
  announced: ReadonlySet<string>,
): InboxNotification[] {
  return items.filter(
    (it) => !it.read_at && it.severity !== 'info' && !announced.has(it.notification_id),
  );
}

/** 纯 reducer：所有状态变更集中于此，便于单测与 store 复用。 */
export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'created': {
      const rest = state.items.filter((it) => it.notification_id !== action.row.notification_id);
      return { items: [action.row, ...rest] };
    }
    case 'updated': {
      const i = state.items.findIndex((it) => it.notification_id === action.row.notification_id);
      if (i === -1) return { items: [action.row, ...state.items] };
      const items = [...state.items];
      items[i] = action.row;
      return { items };
    }
    case 'replaceAll':
      return { items: [...action.rows] };
    case 'markReadLocal':
      return {
        items: state.items.map((it) =>
          it.notification_id === action.id && !it.read_at ? { ...it, read_at: new Date().toISOString() } : it,
        ),
      };
    case 'markAllReadLocal':
      return { items: state.items.map((it) => (it.read_at ? it : { ...it, read_at: new Date().toISOString() })) };
    default:
      return state;
  }
}

/**
 * 未读里的最高严重度，决定侧栏角标配色；无未读时为 null。
 * 刻意复用 InboxSeverity 而不是另立别名 —— 一份类型，分级变化时编译期会带上角标。
 */
export function selectUnreadTone(items: readonly InboxNotification[]): InboxSeverity | null {
  let tone: InboxSeverity | null = null;
  for (const it of items) {
    if (it.read_at) continue;
    if (it.severity === 'critical') return 'critical';
    if (it.severity === 'warning') tone = 'warning';
    else if (tone === null) tone = 'info';
  }
  return tone;
}
