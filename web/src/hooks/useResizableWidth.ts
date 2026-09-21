import { useEffect, useState } from 'react';

/**
 * 通用的「可拖动调宽」hook：夹取范围 + localStorage 记忆。
 *
 * 侧边栏（`useSidebarWidth`）与收件箱通知列表（`useInboxListWidth`）共用这套逻辑，
 * 但**各用各的 storage key** —— 两边默认同宽、拖动互不影响。
 */

export type ResizableWidthOptions = {
  /** localStorage 键。不同面板必须用不同的键，否则会互相覆盖。 */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
};

export type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function clampToRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function readStoredNumber(
  storage: Pick<Storage, 'getItem'>,
  options: ResizableWidthOptions,
): number {
  try {
    const raw = storage.getItem(options.storageKey);
    if (raw === null) {
      return options.defaultWidth;
    }
    return clampToRange(Number(raw), options.min, options.max, options.defaultWidth);
  } catch {
    return options.defaultWidth;
  }
}

function resolveStorage(): WidthStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useResizableWidth(
  options: ResizableWidthOptions,
  storage?: WidthStorage,
) {
  const { storageKey, defaultWidth, min, max } = options;
  const resolved = storage ?? resolveStorage();
  const [width, setWidthState] = useState<number>(() =>
    resolved ? readStoredNumber(resolved, options) : defaultWidth,
  );

  const setWidth = (value: number) => setWidthState(clampToRange(value, min, max, defaultWidth));
  const resetWidth = () => setWidthState(defaultWidth);

  useEffect(() => {
    if (!resolved) {
      return;
    }
    try {
      resolved.setItem(storageKey, String(width));
    } catch {
      // Ignore quota/security errors (e.g. private browsing).
    }
  }, [width, resolved, storageKey]);

  return { width, setWidth, resetWidth };
}
