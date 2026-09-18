import { useEffect, useState } from 'react';

/**
 * 观测某个元素的宽度（ResizeObserver），返回挂到该元素上的 ref 与当前宽度。
 *
 * 用**回调 ref**（而不是 `useRef` + `useEffect(…, [])`）是因为被观测的节点是
 * 条件渲染的：图表在空态时不渲染，等数据到了才挂载。`useRef` 方案里 effect 只在
 * 挂载时跑一次，那时 `ref.current` 还是 null，节点后来才出现也没人再观测，
 * 宽度会永远停在 0。
 *
 * 首帧返回 0，调用方必须把它当「还没测量到」而不是「宽度为 0」——
 * `pickAxisTargetTicks(0)` 会回落到上限，避免首帧渲染 3 个刻度再跳变。
 */
export function useElementWidth<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  width: number;
} {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const update = () => setWidth(element.clientWidth);
    // 先同步量一次：ResizeObserver 的首次回调要等下一帧，否则首屏会闪一下
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, width };
}
