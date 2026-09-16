import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 贴锚点定位的弹层原语。为什么必须 portal + fixed：DialogContent 带
 * -translate-1/2 变换 + 入场动画，普通 absolute 弹层会被裁剪/困在含变换的
 * 容器里（sophclaw 的 task-chip-menu 同款坑）。
 * 桌面 = 贴锚点下方的 fixed 弹层；手机(isMobile) = 底部抽屉。
 */
export function AnchorPopover({
  open,
  onOpenChange,
  anchorRef,
  align = 'left',
  isMobile,
  children,
  ariaLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  isMobile: boolean;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; right: number; vw: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 打开时按锚点 getBoundingClientRect 计算固定坐标。
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left, right: r.right, vw: window.innerWidth });
  }, [open, anchorRef]);

  // 外点 / Esc / 滚动 / 窗口缩放关闭（滚动发生在弹层内部时不关）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      onOpenChange(false);
    };
    const onResize = () => onOpenChange(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, anchorRef, onOpenChange]);

  if (!open || !pos) return null;

  return createPortal(
    isMobile ? (
      <div className="fixed inset-0 z-[60]">
        <div className="absolute inset-0 bg-black/30" onClick={() => onOpenChange(false)} aria-hidden />
        <div
          ref={popRef}
          role="dialog"
          aria-label={ariaLabel}
          className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-border bg-popover p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.2)]"
        >
          {children}
        </div>
      </div>
    ) : (
      <div
        ref={popRef}
        role="dialog"
        aria-label={ariaLabel}
        style={{
          top: pos.top,
          left: align === 'right' ? undefined : pos.left,
          right: align === 'right' ? pos.vw - pos.right : undefined,
          maxWidth: 'min(440px, calc(100vw - 24px))',
        }}
        className="fixed z-[60] min-w-[200px] rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_8px_26px_rgba(0,0,0,0.14)]"
      >
        {children}
      </div>
    ),
    document.body,
  );
}
