import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshRemoteProjectsIndex,
  lookupRemoteHost,
  setOnlineHostsLookup,
  lookupHostForPath,
} from '../remote-projects.index.js';

test('lookupRemoteHost is an exact project-path map hit', () => {
  refreshRemoteProjectsIndex([{ project_path: '/abs/p', remote_host_id: 'h1' }]);
  assert.equal(lookupRemoteHost('/abs/p'), 'h1');
  assert.equal(lookupRemoteHost('/abs/other'), null);
  assert.equal(lookupRemoteHost(undefined), null);
});

test('lookupHostForPath prefers the exact project-path map hit over host roots', () => {
  refreshRemoteProjectsIndex([{ project_path: '/srv/app', remote_host_id: 'h2' }]);
  setOnlineHostsLookup(() => [{ hostId: 'h1', roots: ['/srv'] }]);
  // exact project row wins even though both paths would match by prefix
  assert.equal(lookupHostForPath('/srv/app'), 'h2');
  // non-project path under the same root falls back to the host prefix match
  assert.equal(lookupHostForPath('/srv/other'), 'h1');
});

test('lookupHostForPath falls back to longest roots-prefix match across online hosts', () => {
  refreshRemoteProjectsIndex([]);
  setOnlineHostsLookup(() => [
    { hostId: 'h-wide', roots: ['/srv'] },
    { hostId: 'h-specific', roots: ['/srv/app'] },
    { hostId: 'h-other', roots: ['/elsewhere'] },
  ]);
  assert.equal(lookupHostForPath('/srv/app/x'), 'h-specific');
  assert.equal(lookupHostForPath('/srv'), 'h-wide'); // root itself
  assert.equal(lookupHostForPath('/srv/app-x'), 'h-wide'); // prefix boundary is a path segment
  assert.equal(lookupHostForPath('/elsewhere/deep/file.txt'), 'h-other');
  assert.equal(lookupHostForPath('/unrelated'), null);
});

test('lookupHostForPath handles empty input and a missing/empty hosts lookup', () => {
  refreshRemoteProjectsIndex([]);
  setOnlineHostsLookup(() => null); // routing layer not wired
  assert.equal(lookupHostForPath(undefined), null);
  assert.equal(lookupHostForPath(''), null);
  assert.equal(lookupHostForPath('/x'), null);
  setOnlineHostsLookup(() => []); // no hosts online
  assert.equal(lookupHostForPath('/x'), null);
});