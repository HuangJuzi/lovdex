import { useEffect, useState } from 'react';

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 288;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebarWidth';

type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return SIDEBAR_WIDTH_DEFAULT;
  }
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

export function readStoredWidth(storage: Pick<Storage, 'getItem'>): number {
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) {
      return SIDEBAR_WIDTH_DEFAULT;
    }
    return clampWidth(Number(raw));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
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

export function useSidebarWidth(storage?: WidthStorage) {
  const resolved = storage ?? resolveStorage();
  const [width, setWidthState] = useState<number>(() =>
    resolved ? readStoredWidth(resolved) : SIDEBAR_WIDTH_DEFAULT,
  );

  const setWidth = (value: number) => setWidthState(clampWidth(value));
  const resetWidth = () => setWidthState(SIDEBAR_WIDTH_DEFAULT);

  useEffect(() => {
    if (!resolved) {
      return;
    }
    try {
      resolved.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // Ignore quota/security errors (e.g. private browsing).
    }
  }, [width, resolved]);

  return { width, setWidth, resetWidth };
}
