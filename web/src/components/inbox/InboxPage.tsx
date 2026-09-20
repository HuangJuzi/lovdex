import * as React from 'react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCheck, AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import { useWebSocket } from '../../contexts/WebSocketContext';
import {
  subscribeInbox, getInboxSnapshot, refreshInbox, applyInboxEvent, markReadLocal, markAllReadLocal,
} from '../../stores/inboxStore';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';

const SEVERITY_ICON: Record<InboxSeverity, React.ReactNode> = {
  critical: <AlertCircle className="h-4 w-4 text-destructive" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning" />,
  info: <Info className="h-4 w-4 text-muted-foreground" />,
};

const SEVERITY_ORDER: InboxSeverity[] = ['critical', 'warning', 'info'];

export default function InboxPage() {
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();
  const snapshot = useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);

  // 首挂全量拉取。
  useEffect(() => { void refreshInbox(); }, []);

  // WS 实时：喂给 store（含重连全量刷新）。
  useEffect(() => subscribe((event) => { applyInboxEvent(event as { kind?: string; payload?: unknown }); }), [subscribe]);

  const grouped = useMemo(() => {
    const by: Record<InboxSeverity, InboxNotification[]> = { critical: [], warning: [], info: [] };
    for (const it of snapshot.items) by[it.severity].push(it);
    return by;
  }, [snapshot.items]);

  const openTarget = (it: InboxNotification) => {
    markReadLocal(it.notification_id);
    if (it.task_id) navigate(`/task/${it.task_id}`);
    else if (it.session_id) navigate(`/session/${it.session_id}`);
    // 版本更新通知没有 task/session 关联，点它跳设置页去更新 skill。
    else if (it.code === 'skill_update') navigate('/settings?tab=operator');
  };

  return (
    <div className="mx-auto flex h-screen w-full max-w-3xl flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /></Button>
          <h1 className="text-lg font-semibold">收件箱</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => markAllReadLocal()}>
          <CheckCheck className="mr-1 h-4 w-4" />全部已读
        </Button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto">
        {snapshot.items.length === 0 ? (
          <div className="py-20 text-center text-sm text-muted-foreground">暂无通知</div>
        ) : (
          SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((severity) => (
            <section key={severity}>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                {SEVERITY_ICON[severity]} {severity}
              </div>
              <ul className="space-y-1.5">
                {grouped[severity].map((it) => (
                  <li
                    key={it.notification_id}
                    className={`rounded-md border p-3 ${it.read_at ? 'opacity-60' : 'bg-muted/40'} ${(it.task_id || it.session_id) ? 'cursor-pointer hover:bg-muted' : ''}`}
                    onClick={() => openTarget(it)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium">{it.title}</span>
                      {it.occurrence_count > 1 ? (
                        <span className="ml-2 shrink-0 text-xs text-muted-foreground">×{it.occurrence_count}</span>
                      ) : null}
                    </div>
                    {it.body ? <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{it.body}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
