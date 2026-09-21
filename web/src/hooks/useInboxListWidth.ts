import { useResizableWidth, type WidthStorage } from './useResizableWidth';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from './useSidebarWidth';

/**
 * 收件箱通知列表的宽度。
 *
 * 默认值与侧边栏一致（288），视觉上两栏对齐；但**各用各的 storage key**，
 * 拖动互不影响 —— 在收件箱页调列表宽度不该顺手把侧边栏也改了。
 */
export const INBOX_LIST_WIDTH_STORAGE_KEY = 'inboxListWidth';
export const INBOX_LIST_WIDTH_DEFAULT = SIDEBAR_WIDTH_DEFAULT;
export const INBOX_LIST_WIDTH_MIN = SIDEBAR_WIDTH_MIN;
export const INBOX_LIST_WIDTH_MAX = SIDEBAR_WIDTH_MAX;

const INBOX_LIST_WIDTH_OPTIONS = {
  storageKey: INBOX_LIST_WIDTH_STORAGE_KEY,
  defaultWidth: INBOX_LIST_WIDTH_DEFAULT,
  min: INBOX_LIST_WIDTH_MIN,
  max: INBOX_LIST_WIDTH_MAX,
} as const;

export function useInboxListWidth(storage?: WidthStorage) {
  return useResizableWidth(INBOX_LIST_WIDTH_OPTIONS, storage);
}
