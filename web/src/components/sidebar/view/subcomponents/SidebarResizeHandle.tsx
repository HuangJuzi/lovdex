import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '../../../../hooks/useSidebarWidth';
import { ResizeHandle } from '../../../../shared/view/ui/ResizeHandle';

type SidebarResizeHandleProps = {
  width: number;
  onWidthChange: (width: number) => void;
  onReset: () => void;
};

/** 侧边栏专用的分隔条：把通用的 `ResizeHandle` 绑到侧边栏的宽度区间上。 */
export default function SidebarResizeHandle({ width, onWidthChange, onReset }: SidebarResizeHandleProps) {
  return (
    <ResizeHandle
      width={width}
      min={SIDEBAR_WIDTH_MIN}
      max={SIDEBAR_WIDTH_MAX}
      label="Resize sidebar"
      onWidthChange={onWidthChange}
      onReset={onReset}
    />
  );
}
