import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * 严重度只落在图标块上，卡片本体一律毛玻璃底 —— 整块染色是「突兀」的主因。
 * 导出供测试断言，避免有人日后把染色加回卡片本体。
 */
export const SEVERITY_STYLE: Record<ToastSeverity, { icon: React.ReactNode; iconClass: string }> = {
  critical: {
    icon: <AlertCircle className="h-4 w-4" />,
    iconClass: 'bg-destructive/10 text-destructive',
  },
  warning: {
    icon: <AlertTriangle className="h-4 w-4" />,
    iconClass: 'bg-warning/10 text-warning',
  },
  info: {
    icon: <Info className="h-4 w-4" />,
    iconClass: 'bg-muted text-muted-foreground',
  },
};

export const AUTO_DISMISS_MS = 6000;

/** 退场动画 180ms；兜底定时器略长一点，防止 animationend 不触发时卡片永久留在 DOM 里。 */
const EXIT_FALLBACK_MS = 250;

/** 单条 toast：入场淡入缩放，AUTO_DISMISS_MS 后播放退场动画再卸载。 */
export function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const [closing, setClosing] = useState(false);
  // 用 deadline 时间戳而不是剩余毫秒数：暂停/恢复反复切换不会累积漂移。
  const deadlineRef = useRef(0);
  const remainingRef = useRef(AUTO_DISMISS_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback((ms: number) => {
    clearTimer();
    remainingRef.current = ms;
    deadlineRef.current = Date.now() + ms;
    timerRef.current = setTimeout(() => setClosing(true), ms);
  }, [clearTimer]);

  useEffect(() => {
    schedule(AUTO_DISMISS_MS);
    return clearTimer;
  }, [schedule, clearTimer, item.id]);

  // 兜底：退场动画可能压根不跑（用户样式表 animation:none、不支持的旧内核），
  // 那样 onAnimationEnd 永远不触发，卡片会停在 opacity:0 却仍然 pointer-events-auto，
  // 在右上角形成一块看不见的点击黑洞。dismiss 按 id 过滤，天然幂等，重复调用无害。
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => onDismiss(item.id), EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [closing, item.id, onDismiss]);

  // 悬停暂停：记下剩余时间并清掉定时器；移出后按剩余时间续跑。
  const handleMouseEnter = useCallback(() => {
    clearTimer();
    remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
  }, [clearTimer]);

  const handleMouseLeave = useCallback(() => {
    if (closing) return;
    schedule(remainingRef.current);
  }, [closing, schedule]);

  const style = SEVERITY_STYLE[item.severity];

  return (
    <div
      className={cn(
        'pointer-events-auto w-80 rounded-2xl border border-border/70 bg-popover/80 p-3 shadow-raised-md backdrop-blur-xl',
        item.onClick && 'cursor-pointer',
        closing ? 'animate-toast-out' : 'animate-toast-in',
      )}
      onClick={item.onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      // 入场动画结束时不做事；只有退场动画结束才真正移除节点。
      onAnimationEnd={() => { if (closing) onDismiss(item.id); }}
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', style.iconClass)}>
          {style.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{item.title}</div>
          {item.body ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</div> : null}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); setClosing(true); }}
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
