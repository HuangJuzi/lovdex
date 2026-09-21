import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOX_LIST_WIDTH_DEFAULT,
  INBOX_LIST_WIDTH_MAX,
  INBOX_LIST_WIDTH_MIN,
  INBOX_LIST_WIDTH_STORAGE_KEY,
} from './useInboxListWidth';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_STORAGE_KEY } from './useSidebarWidth';

test('收件箱列表默认宽度与侧边栏一致', () => {
  assert.equal(INBOX_LIST_WIDTH_DEFAULT, SIDEBAR_WIDTH_DEFAULT);
});

test('收件箱列表用自己的 storage key，不与侧边栏共用', () => {
  assert.notEqual(INBOX_LIST_WIDTH_STORAGE_KEY, SIDEBAR_WIDTH_STORAGE_KEY);
  assert.equal(INBOX_LIST_WIDTH_STORAGE_KEY, 'inboxListWidth');
});

test('宽度区间有下限上限且默认值落在区间内', () => {
  assert.ok(INBOX_LIST_WIDTH_MIN < INBOX_LIST_WIDTH_DEFAULT);
  assert.ok(INBOX_LIST_WIDTH_DEFAULT < INBOX_LIST_WIDTH_MAX);
});
