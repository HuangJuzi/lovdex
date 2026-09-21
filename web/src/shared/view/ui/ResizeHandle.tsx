import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export type ResizeHandleProps = {
  /** 当前宽度（受控）。 */
  width: number;
  min: number;
  max: number;
  /** 无障碍名称，例如「调整侧边栏宽度」。 */
  label: string;
  onWidthChange: (width: number) => void;
  /** 双击复位。 */
  onReset: () => void;
};

const KEYBOARD_STEP = 16;

/**
 * 竖直分隔条：拖动或键盘（←/→/Home/End）调整相邻面板宽度，双击复位。
 *
 * 绝对定位在父容器的右边缘 —— **父容器必须是 `position: relative` 且不能是滚动容器**，
 * 否则分隔条会跟着内容一起滚走。
 */
export function ResizeHandle({ width, min, max, label, onWidthChange, onReset }: ResizeHandleProps) {
  // Pointer capture keeps pointermove/pointerup arriving on this element even
  // when the cursor leaves it mid-drag.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    onWidthChange(drag.startWidth + (event.clientX - drag.startX));
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width - KEYBOARD_STEP;
    else if (event.key === 'ArrowRight') next = width + KEYBOARD_STEP;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    onWidthChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className="group absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="h-full w-full transition-colors group-hover:bg-border group-active:bg-primary/40" />
    </div>
  );
}
