import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSkillsCapable,
  createRemoteSkillStore,
  createRemoteSkillsClient,
} from '../remote-skills.service.js';
import { SKILLS_CAPABILITY } from '@/shared/agent-runtime/protocol.js';

type Call = { hostId: string; method: string; params: unknown; timeoutMs: number };

function fakeRegistry(caps: string[] | undefined, calls: Call[]) {
  return {
    getCapabilities: () => caps,
    rpc: async (hostId: string, method: string, params: unknown, timeoutMs = 60_000) => {
      calls.push({ hostId, method, params, timeoutMs });
      if (method === 'skills/manifest') return { root: '/x', exists: true, entries: [] };
      if (method === 'skills/bundle') return { name: 'demo', contentHash: 'h', files: [] };
      return { action: 'created', contentHash: 'h' };
    },
  } as never;
}

test('assertSkillsCapable accepts a host advertising skills/v1', () => {
  assertSkillsCapable(fakeRegistry([SKILLS_CAPABILITY], []), 'h1');
});

test('assertSkillsCapable rejects an offline host', () => {
  assert.throws(() => assertSkillsCapable(fakeRegistry(undefined, []), 'h1'), /不在线/);
});

test('assertSkillsCapable rejects a lite without the capability', () => {
  assert.throws(
    () => assertSkillsCapable(fakeRegistry(['fs/read'], []), 'h1'),
    /版本过旧/,
  );
});

test('remote client forwards the three methods with their timeouts', async () => {
  const calls: Call[] = [];
  const client = createRemoteSkillsClient(() => fakeRegistry([SKILLS_CAPABILITY], calls));

  await client.manifest('h1', '~/.claude/skills');
  await client.bundle('h1', '/srv/.claude/skills', 'demo');
  await client.apply('h1', {
    root: '/srv/.claude/skills',
    name: 'demo',
    contentHash: 'h',
    files: [],
    expectedTargetHash: null,
    force: false,
  });

  assert.deepEqual(calls.map((c) => c.method), ['skills/manifest', 'skills/bundle', 'skills/apply']);
  assert.deepEqual(calls.map((c) => c.timeoutMs), [30_000, 60_000, 120_000]);
  assert.deepEqual(calls[0].params, { root: '~/.claude/skills' });
  assert.equal((calls[2].params as { force: boolean }).force, false);
});

test('the remote store binds hostId into every call', async () => {
  const calls: Call[] = [];
  const store = createRemoteSkillStore(() => fakeRegistry([SKILLS_CAPABILITY], calls), 'h9');
  await store.manifest('/srv/.claude/skills');
  assert.equal(calls[0].hostId, 'h9');
});

test('every remote store call is gated on the capability', async () => {
  const store = createRemoteSkillStore(() => fakeRegistry(['fs/read'], []), 'h1');
  await assert.rejects(() => store.manifest('/x'), /版本过旧/);
});
