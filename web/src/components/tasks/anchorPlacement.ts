export type AnchorRect = { top: number; bottom: number; left: number; right: number };

/**
 * 弹层的 fixed 定位。`top` 与 `bottom` 互斥：贴锚点下方时给 `top`，
 * 翻到锚点上方时给 `bottom`（距视口底的距离）。`maxHeight` 是可用空间的
 * 上限，配合 `overflow-y-auto` 保证内容再多也不会溢出视口。
 */
export type AnchorPlacement = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
};

/** 弹层与锚点之间、以及与视口边缘之间留的间距。 */
export const ANCHOR_GAP = 6;
export const ANCHOR_MARGIN = 8;

/** 夹取下限：视口再挤也留一段可滚动的高度，而不是塌成一条线。 */
const MIN_PANEL_HEIGHT = 96;

/**
 * 计算贴锚点弹层的位置。
 *
 * 必须夹取 + 必要时翻转，否则锚点靠近视口底时弹层会伸到视口外 —— 小屏
 * （MacBook 去掉菜单栏 / Dock / 浏览器 chrome 后视口不到 900px）上新建任务
 * 弹窗的芯片行正好贴着弹窗底边，下拉的尾部会落在视口外，滚也滚不到。
 *
 * `panelHeight` 传弹层的自然高度（未夹取时量到的），决定是否需要翻上去。
 */
export function computeAnchorPlacement(
  anchor: AnchorRect,
  viewportWidth: number,
  viewportHeight: number,
  panelHeight: number,
  align: 'left' | 'right' = 'left',
): AnchorPlacement {
  const spaceBelow = viewportHeight - anchor.bottom - ANCHOR_GAP - ANCHOR_MARGIN;
  const spaceAbove = anchor.top - ANCHOR_GAP - ANCHOR_MARGIN;
  const horizontal = align === 'right'
    ? { right: viewportWidth - anchor.right }
    : { left: anchor.left };

  // 优先贴锚点下方；下方放不下、且上方更宽裕时翻上去。
  if (panelHeight <= spaceBelow || spaceAbove <= spaceBelow) {
    return {
      top: anchor.bottom + ANCHOR_GAP,
      ...horizontal,
      maxHeight: Math.max(MIN_PANEL_HEIGHT, spaceBelow),
    };
  }
  return {
    bottom: viewportHeight - anchor.top + ANCHOR_GAP,
    ...horizontal,
    maxHeight: Math.max(MIN_PANEL_HEIGHT, spaceAbove),
  };
}
