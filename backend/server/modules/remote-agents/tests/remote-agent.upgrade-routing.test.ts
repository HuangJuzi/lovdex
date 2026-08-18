import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

import { createWebSocketServer } from '@/modules/websocket/index.js';
import { createRemoteAgentWss } from '../remote-agent.server.js';
import { createRemoteAgentsRegistry, type RemoteAgentsRegistry } from '../remote-agents.registry.js';

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected HTTP ${res.statusCode}`)));
  });
}

function waitForMessage(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
    ws.once('message', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', () => {
      clearTimeout(timer);
      reject(new Error('ws error while waiting for message'));
    });
  });
}

function expectHttpStatus(url: string, status: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout waiting for HTTP ${status}`));
    }, 3000);
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      if (res.statusCode !== status) {
        ws.terminate();
        reject(new Error(`expected HTTP ${status}, got ${res.statusCode}`));
        return;
      }
      resolve();
    });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`unexpected connect success for ${url}`));
    });
    ws.on('error', () => {}); // suppress post-response socket noise
  });
}

const HELLO = JSON.stringify({
  type: 'hello',
  hostId: 'h1',
  agentVersion: '1',
  nodeVersion: '20',
  os: 'linux',
  roots: [],
  capabilities: ['session/claude'],
});

/**
 * C1 regression: the chat ws gateway (which has no ws `path` option) must NOT
 * claim the lite's `/api/remote-agents/ws` upgrade and 401 it as a JWT. Both
 * wss dispatchers route by pathname, so each upgrade is served by exactly one
 * server. The lite must reach the remote handler with a good token, while the
 * chat endpoint keeps flowing through the chat verifyClient.
 */
test('chat and remote ws servers route upgrades by path (C1)', async () => {
  const server = http.createServer();
  const seenChatTokens: (string | null)[] = [];
  const online: string[] = [];
  const registry: RemoteAgentsRegistry = createRemoteAgentsRegistry();

  createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket: (token) => {
        seenChatTokens.push(token ?? null);
        return null; // always reject → chat wss answers HTTP 401
      },
    },
    // Auth rejects before a connection is established, so chat/terminal hooks
    // are never reached in this test.
    chat: {} as never,
    terminal: {} as never,
  });

  createRemoteAgentWss(server, {
    verifyToken: (token) => (token === 'good' ? 'h1' : null),
    registry,
    onHostOnline: (hostId) => online.push(hostId),
    onHostOffline: () => {},
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `ws://127.0.0.1:${port}`;

  try {
    // (a) the lite path reaches ONLY the remote handler; the chat verifyClient
    // never even sees the request.
    const good = await open(`${base}/api/remote-agents/ws?token=good`);
    good.send(HELLO);
    await waitForMessage(good);
    assert.deepEqual(online, ['h1'], 'remote handler registered the lite');
    assert.deepEqual(seenChatTokens, [], 'chat verifyClient must not see the remote path');
    good.close();

    // (b) /ws flows through the chat verifyClient (rejected → 401) and does NOT
    // reach the remote handler.
    await expectHttpStatus(`${base}/ws?token=evil`, 401);
    assert.deepEqual(seenChatTokens, ['evil'], 'chat verifyClient recorded the ws token');
    assert.deepEqual(online, ['h1'], 'remote handler untouched by the chat path');

    // (c) /ws/terminal still routes through the chat gateway (upgrade-level path
    // isolation must not break the terminal path) and never reaches the remote.
    await expectHttpStatus(`${base}/ws/terminal`, 401);
    assert.deepEqual(online, ['h1'], 'terminal path does not reach the remote handler');

    // (d) bad token on the remote path is rejected by the remote handler itself.
    await new Promise<void>((resolve, reject) => {
      const bad = new WebSocket(`${base}/api/remote-agents/ws?token=bad`);
      bad.on('close', (code) => {
        if (code !== 4001) {
          reject(new Error(`expected close 4001, got ${code}`));
          return;
        }
        resolve();
      });
      bad.on('error', () => {});
    });
    assert.deepEqual(online, ['h1']);
  } finally {
    server.close();
    await new Promise<void>((resolve) => server.on('close', resolve));
  }
});