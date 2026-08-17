import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../../../../hooks/useSidebarWidth';

type SidebarResizeHandleProps = {
  width: number;
  onWidthChange: (width: number) => void;
  onReset: () => void;
};

const KEYBOARD_STEP = 16;

export default function SidebarResizeHandle({ width, onWidthChange, onReset }: SidebarResizeHandleProps) {
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
    else if (event.key === 'Home') next = SIDEBAR_WIDTH_MIN;
    else if (event.key === 'End') next = SIDEBAR_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    onWidthChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
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
