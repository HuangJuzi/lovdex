import { clampToRange, readStoredNumber, useResizableWidth, type WidthStorage } from './useResizableWidth';

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 288;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebarWidth';

const SIDEBAR_WIDTH_OPTIONS = {
  storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
  defaultWidth: SIDEBAR_WIDTH_DEFAULT,
  min: SIDEBAR_WIDTH_MIN,
  max: SIDEBAR_WIDTH_MAX,
} as const;

export function clampWidth(value: number): number {
  return clampToRange(value, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_DEFAULT);
}

export function readStoredWidth(storage: Pick<Storage, 'getItem'>): number {
  return readStoredNumber(storage, SIDEBAR_WIDTH_OPTIONS);
}

export function useSidebarWidth(storage?: WidthStorage) {
  return useResizableWidth(SIDEBAR_WIDTH_OPTIONS, storage);
}
