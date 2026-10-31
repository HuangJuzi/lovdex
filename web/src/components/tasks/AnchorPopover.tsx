import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  computeAnchorPlacement,
  isAnchorWithinViewport,
  resolveExternalScrollAction,
  type AnchorPlacement,
  type AnchorRect,
} from './anchorPlacement';

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

  /**
   * 重新量锚点。滚动不再一律关闭（见下方 onScroll）：只要锚点还在视口里就把
   * 弹层跟着移到新位置；因为弹层是 fixed 的，后台会话自动滚动时锚点其实没动，
   * 这次 setState 会命中 sameAnchor 分支、不触发多余渲染。
   */
  const syncAnchor = useCallback(() => {
    const el = anchorRef.current;
    if (!el) {
      onOpenChange(false);
      return;
    }
    const r = el.getBoundingClientRect();
    const rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!isAnchorWithinViewport(rect, vw, vh)) {
      onOpenChange(false);
      return;
    }
    setAnchor((previous) => (
      previous
        && previous.rect.top === rect.top
        && previous.rect.bottom === rect.bottom
        && previous.rect.left === rect.left
        && previous.rect.right === rect.right
        && previous.vw === vw
        && previous.vh === vh
        ? previous
        : { rect, vw, vh }
    ));
  }, [anchorRef, onOpenChange]);

  // 打开时按锚点 getBoundingClientRect 取矩形与视口尺寸。
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      setPanelHeight(null);
      return;
    }
    syncAnchor();
    setPanelHeight(null);
  }, [open, syncAnchor]);

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

  // 外点 / Esc / 窗口缩放关闭；滚动只重算位置，锚点离开视口才关。
  // （弹层内部滚动不处理，否则下拉自己的长列表滚不动。）
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
    let scrollFrame = 0;
    const onScroll = (e: Event) => {
      const el = anchorRef.current;
      if (!el) {
        onOpenChange(false);
        return;
      }
      const target = e.target instanceof Node ? e.target : null;
      if (target && popRef.current?.contains(target)) return;
      // fixed 弹层只可能被「包含锚点的容器」的滚动带动（document 滚动也是）。
      // 后台会话自己的滚动容器与锚点无关，直接跳过 —— 流式输出时它每秒都在滚，
      // 不做这个过滤就白白 getBoundingClientRect（强制布局）每一帧。
      if (target && !target.contains(el)) return;

      const r = el.getBoundingClientRect();
      const action = resolveExternalScrollAction({
        targetInsidePopover: false,
        anchorRect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      if (action === 'ignore') return;
      if (action === 'close') {
        onOpenChange(false);
        return;
      }
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        syncAnchor();
      });
    };
    const onResize = () => onOpenChange(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, anchorRef, onOpenChange, syncAnchor]);

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
