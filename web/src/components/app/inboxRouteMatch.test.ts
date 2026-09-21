import test from 'node:test';
import assert from 'node:assert/strict';

import { isInboxPath } from './inboxRouteMatch';

test('精确路径命中', () => {
  assert.equal(isInboxPath('/inbox'), true);
});

test('尾斜杠也命中（react-router 会匹配该 Route，但 pathname 保留斜杠）', () => {
  assert.equal(isInboxPath('/inbox/'), true);
});

test('其他路径不命中', () => {
  assert.equal(isInboxPath('/'), false);
  assert.equal(isInboxPath('/inboxes'), false);
  assert.equal(isInboxPath('/task/inbox'), false);
  assert.equal(isInboxPath('/inbox/123'), false);
});
