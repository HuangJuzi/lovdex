import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteHistoryClient } from '../remote-history.service.js';
import type { RemoteAgentsRegistry } from '../remote-agents.registry.js';

type RpcCall = { hostId: string; method: string; params: unknown };

function fakeRegistry(reply: (call: RpcCall) => unknown, timeoutMs = 0): {
  reg: RemoteAgentsRegistry;
  calls: RpcCall[];
  timeouts: number[];
} {
  const calls: RpcCall[] = [];
  const timeouts: number[] = [];
  const reg = {
    async rpc<T = unknown>(
      hostId: string,
      method: string,
      params: unknown,
      usedTimeout = 60_000,
    ): Promise<T> {
      const call = { hostId, method, params };
      calls.push(call);
      timeouts.push(usedTimeout);
      if (timeoutMs > 0) {
        // Reserved for asserting the caller's timeout; unused today.
      }
      return reply(call) as T;
    },
  } as unknown as RemoteAgentsRegistry;
  return { reg, calls, timeouts };
}

test('fetchMessages delegates to rpc session/messages with provider/sessionId/projectPath', async () => {
  const result = { transcript: '{"a":1}\n', agentFiles: {} };
  const { reg, calls } = fakeRegistry(() => result);
  const client = createRemoteHistoryClient(() => reg);

  const fetched = await client.fetchMessages('h1', {
    provider: 'claude',
    providerSessionId: 'sid-9',
    projectPath: '/srv/app',
  });

  assert.deepEqual(fetched, result);
  assert.deepEqual(calls, [
    {
      hostId: 'h1',
      method: 'session/messages',
      params: { provider: 'claude', providerSessionId: 'sid-9', projectPath: '/srv/app' },
    },
  ]);
});

test('fetchMessages rejects when the rpc rejects (host offline)', async () => {
  const { reg } = fakeRegistry(() => {
    throw new Error('remote host offline: h1');
  });
  const client = createRemoteHistoryClient(() => reg);

  await assert.rejects(
    client.fetchMessages('h1', { provider: 'qoder', providerSessionId: 's', projectPath: '/p' }),
    /remote host offline/,
  );
});