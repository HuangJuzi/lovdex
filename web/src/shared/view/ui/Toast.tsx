import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type ToastSeverity = 'critical' | 'warning' | 'info';

export type ToastItem = {
  id: string;
  severity: ToastSeverity;
  title: string;
  body?: string | null;
  onClick?: () => void;
};

const SEVERITY_STYLE: Record<ToastSeverity, { ring: string; icon: React.ReactNode }> = {
  critical: { ring: 'border-destructive/50 bg-destructive/10', icon: <AlertCircle className="h-4 w-4 text-destructive" /> },
  warning: { ring: 'border-warning/50 bg-warning/10', icon: <AlertTriangle className="h-4 w-4 text-warning" /> },
  info: { ring: 'border-border bg-muted', icon: <Info className="h-4 w-4 text-muted-foreground" /> },
};

const AUTO_DISMISS_MS = 6000;

/** 单条 toast：挂载后 AUTO_DISMISS_MS 自动淡出。 */
function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(item.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [item.id, onDismiss]);

  const style = SEVERITY_STYLE[item.severity];
  return (
    <div
      className={cn('pointer-events-auto w-80 rounded-md border p-3 shadow-lg', style.ring, item.onClick && 'cursor-pointer')}
      onClick={item.onClick}
      role="alert"
    >
      <div className="flex items-start gap-2">
        {style.icon}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{item.title}</div>
          {item.body ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</div> : null}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onDismiss(item.id); }}
          aria-label="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** 容器：固定右上角。由调用方通过 push/remove 控制 items。 */
export function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex flex-col gap-2">
      {items.map((it) => <ToastCard key={it.id} item={it} onDismiss={onDismiss} />)}
    </div>,
    document.body,
  );
}

/** 便捷 hook：维护一个 toast 列表 + push/dismiss。 */
export function useToastStack() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((item: ToastItem) => setItems((prev) => [...prev, item]), []);
  const dismiss = useCallback((id: string) => setItems((prev) => prev.filter((it) => it.id !== id)), []);
  return { items, push, dismiss };
}
