import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { computeAnchorPlacement, type AnchorPlacement, type AnchorRect } from './anchorPlacement';

/**
 * 贴锚点定位的弹层原语。为什么必须 portal + fixed：DialogContent 带
 * -translate-1/2 变换 + 入场动画，普通 absolute 弹层会被裁剪/困在含变换的
 * 容器里（sophclaw 的 task-chip-menu 同款坑）。
 * 桌面 = 贴锚点的 fixed 弹层（下方放不下就翻到上方，见 computeAnchorPlacement）；
 * 手机(isMobile) = 底部抽屉。
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
  const [anchor, setAnchor] = useState<{ rect: AnchorRect; vw: number; vh: number } | null>(null);
  // 弹层自然高度：null = 还没量到。量到之前按「贴下」渲染、不加高度约束，
  // 否则量到的是被夹取后的高度，就永远判不出该不该翻上去。
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 打开时按锚点 getBoundingClientRect 取矩形与视口尺寸。
  useEffect(() => {
    if (!open || !anchorRef.current) {
      setAnchor(null);
      setPanelHeight(null);
      return;
    }
    const r = anchorRef.current.getBoundingClientRect();
    setAnchor({
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      vw: window.innerWidth,
      vh: window.innerHeight,
    });
    setPanelHeight(null);
  }, [open, anchorRef]);

  // 首帧渲染后量自然高度、定最终位置。用 layout effect：在 paint 前跑完，
  // 用户看不到「先贴下再翻上去」的跳动。窗口缩放会直接关弹层，不必重量。
  // 打开后内容再变长（如「更多」里选出上下文来源后多出「压缩方式」）不重量：
  // maxHeight 是按锚点算的定值，面板最多变成「夹取 + 可滚动」，不会溢出视口。
  useLayoutEffect(() => {
    if (!open || isMobile || !anchor || panelHeight !== null) return;
    const h = popRef.current?.offsetHeight;
    if (h && h > 0) setPanelHeight(h);
  }, [open, isMobile, anchor, panelHeight]);

  const placement: AnchorPlacement | null = anchor
    ? computeAnchorPlacement(anchor.rect, anchor.vw, anchor.vh, panelHeight ?? 0, align)
    : null;

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

  if (!open || !placement) return null;

  return createPortal(
    isMobile ? (
      <div className="fixed inset-0 z-[60]">
        <div className="absolute inset-0 bg-black/30" onClick={() => onOpenChange(false)} aria-hidden />
        <div
          ref={popRef}
          role="dialog"
          aria-label={ariaLabel}
          className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-border bg-popover p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_hsl(var(--foreground)/0.2)]"
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
          top: placement.top,
          bottom: placement.bottom,
          left: placement.left,
          right: placement.right,
          maxHeight: panelHeight === null ? undefined : placement.maxHeight,
          maxWidth: 'min(440px, calc(100vw - 24px))',
        }}
        className="fixed z-[60] min-w-[200px] overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_8px_26px_hsl(var(--foreground)/0.14)]"
      >
        {children}
      </div>
    ),
    document.body,
  );
}
