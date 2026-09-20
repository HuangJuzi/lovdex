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

export function countUnread(items: readonly InboxNotification[]): number {
  // info 不计入角标（spec §5）：只有 warning/critical 才是"要你看一眼"的。
  return items.filter((it) => !it.read_at && it.severity !== 'info').length;
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
