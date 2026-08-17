export type DropdownPosition = { left: number; top: number; maxHeight: number };

const PANEL_WIDTH = 256; // w-64
const PANEL_GAP = 8;

/**
 * 计算下拉面板的 fixed 定位：锚定触发器左下角、右边缘不超出视口。
 * 面板渲染在 portal 里，避免被筛选栏的 overflow 容器裁切。
 */
export function computeDropdownPosition(
  trigger: { left: number; bottom: number },
  viewportWidth: number,
  viewportHeight: number,
): DropdownPosition {
  const width = Math.min(PANEL_WIDTH, viewportWidth * 0.8);
  const left = Math.max(PANEL_GAP, Math.min(trigger.left, viewportWidth - width - PANEL_GAP));
  const top = trigger.bottom + PANEL_GAP;
  return { left, top, maxHeight: Math.max(96, viewportHeight - top - PANEL_GAP) };
}