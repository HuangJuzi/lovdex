import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';
import { createRemoteAgentWss } from '../remote-agent.server.js';
import { createRemoteRouting } from '../remote-spawn.js';

/**
 * In-process loopback: a REAL ws client plays the lite role over a REAL http
 * server + createRemoteAgentWss + the real registry + createRemoteRouting. This
 * validates the whole MAIN-side composition (wrapSpawn → registry.rpc over the
 * wire → push bus → normalizeEvent → writer.send → terminal complete resolves,
 * and the approval round-trip) without a second machine or the claude CLI.
 */

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label = 'condition', timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A tiny normalizer: maps raw→[raw] with an eventId + providerSessionId stamp. */
function makeNormalizer() {
  let n = 0;
  return (raw: Record<string, unknown>, sid: string | null): unknown[] => [
    { eventId: `e${++n}`, ...raw, providerSessionId: sid },
  ];
}

/** A writer surface (WebSocketWriter shape): captures sends + late setSessionId. */
function makeWriter() {
  return {
    sent: [] as Record<string, unknown>[],
    sessionId: undefined as string | undefined,
    send(e: unknown) {
      this.sent.push(e as Record<string, unknown>);
    },
    setSessionId(id: string) {
      this.sessionId = id;
    },
  };
}

type ScriptedEvent = Record<string, unknown>;

/**
 * Drives a real ws client as the lite. On `session/start` it replies with the
 * providerSessionId and, after a real delay, pushes the scripted
 * `session:<appId>` events. On `approval/respond` it records the request. Set
 * `pushComplete=false` to keep the run open (approval flow); the caller pushes
 * `complete` later. Any OTHER rpc_req method fails loudly so a main-side method
 * rename surfaces fast instead of being silently acked.
 */
function fakeLite(
  ws: WebSocket,
  opts: {
    providerSessionId?: string;
    scripted?: ScriptedEvent[];
    pushComplete?: boolean;
    onApprovalRespond?: (frame: { requestId?: unknown; decision?: unknown }) => void;
  },
) {
  const providerSessionId = opts.providerSessionId ?? 'P1';
  const scripted = opts.scripted ?? [];
  const pushComplete = opts.pushComplete !== false;
  let appSessionId = '';

  const push = (topic: string, payload: unknown) => {
    ws.send(JSON.stringify({ type: 'push', topic, payload }));
  };

  ws.on('message', (raw) => {
    let frame: { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.type !== 'rpc_req') return;

    if (frame.method === 'session/start') {
      appSessionId = String(frame.params?.appSessionId ?? '');
      ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: true, data: { providerSessionId } }));
      // Emit scripted events (+ optional terminal complete) after a real delay so
      // the rpc_res frame is fully processed on main first (its `.then` runs
      // setSessionHost + writer.setSessionId). Pushing in the same network read
      // as the rpc_res would starve that microtask and trip the production
      // early-resolve guard — a valid path, but not the ordering this flow
      // asserts. The delay keeps the "rpc_res then events" ordering deterministic.
      void delay(30).then(() => {
        for (const ev of scripted) push(`session:${appSessionId}`, ev);
        if (pushComplete) push(`session:${appSessionId}`, { type: 'complete', session_id: providerSessionId });
      });
      return;
    }

    if (frame.method === 'approval/respond') {
      opts.onApprovalRespond?.(frame.params ?? {});
      ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: true, data: {} }));
      return;
    }

    // A main-side method rename must surface immediately, not hang or blind-ack.
    assert.fail(`fakeLite: unexpected rpc_req method "${frame.method}"`);
  });

  return {
    push,
    pushApproval(requestId: string, approval: Record<string, unknown>) {
      push(`approval:${requestId}`, { appSessionId, approval });
    },
    pushComplete() {
      push(`session:${appSessionId}`, { type: 'complete', session_id: providerSessionId });
    },
  };
}

/** Connects a lite ws client, sends hello, resolves after the hello ack. */
async function connectLite(port: number, hostId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote-agents/ws?token=loop-token`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connectLite: open timeout')), 2000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connectLite: hello-ack timeout')), 2000);
    const onMsg = (raw: unknown) => {
      let f: { id?: string; ok?: boolean };
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.id === 'hello' && f.ok) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve();
      }
    };
    ws.on('message', onMsg);
    ws.send(
      JSON.stringify({
        type: 'hello',
        hostId,
        agentVersion: '1',
        nodeVersion: '20',
        os: 'linux',
        roots: ['/srv'],
        capabilities: [],
      }),
    );
  });
  return ws;
}

test(
  'loopback lite: spawn → early resolve → events → terminal complete',
  { timeout: 10_000 },
  async () => {
    const server = http.createServer();
    const registry = createRemoteAgentsRegistry();
    let wss: WebSocketServer | undefined;
    let routing: ReturnType<typeof createRemoteRouting> | undefined;
    let ws: WebSocket | undefined;

    try {
      wss = createRemoteAgentWss(server, {
        verifyToken: (t) => (t === 'loop-token' ? 'h1' : null),
        registry,
        onHostOnline: () => {},
        onHostOffline: () => {},
      });
      const port = await listen(server);

      ws = await connectLite(port, 'h1');
      assert.equal(registry.isOnline('h1'), true);

      // NOTE: the scripted assistant event deliberately carries NO session_id so
      // the providerSessionId stamp on the forwarded message can ONLY come from
      // the post-rpc_res sessionHost entry (entry?.providerSessionId), exercising
      // the main-side sid-resolution chain rather than short-circuiting on the
      // raw event's own field.
      const lite = fakeLite(ws, {
        providerSessionId: 'P1',
        scripted: [{ type: 'assistant', message: { role: 'assistant' } }],
      });

      routing = createRemoteRouting({
        lookupHost: (p) => (p === '/srv/app' ? 'h1' : null),
        registry,
        normalizeEvent: makeNormalizer(),
      });

      const writer = makeWriter();
      const localSpawn = () => {
        throw new Error('must not run locally');
      };

      const result = await routing.wrapSpawn('claude', localSpawn)('do it', {
        appSessionId: 's1',
        projectPath: '/srv/app',
        cwd: '/srv/app',
        sessionId: null,
      }, writer);

      assert.equal(result, undefined);
      // providerSessionId was set on the writer after the rpc_res.
      assert.equal(writer.sessionId, 'P1');

      // The assistant event was normalized (eventId + providerSessionId stamp) and
      // forwarded; the terminal complete was forwarded too.
      const assistant = writer.sent.find((m) => m.type === 'assistant');
      assert.ok(assistant, 'assistant event forwarded');
      assert.ok(typeof assistant.eventId === 'string' && assistant.eventId.length > 0, 'eventId stamped');
      // 'P1' can only be sourced from the sessionHost entry: the raw event had no
      // session_id and the writer-sessionId fallback (options.sessionId) is null.
      assert.equal(assistant.providerSessionId, 'P1');

      const complete = writer.sent.find((m) => m.type === 'complete');
      assert.ok(complete, 'complete event forwarded');

      // After the terminal complete the sessionHost mapping is swept clear.
      await waitFor(() => registry.getSessionHost('s1') === undefined, 'sessionHost swept');

      // A duplicate terminal complete must be a no-op: the per-session push
      // handler was torn down on the first complete, so no second complete is
      // forwarded and the sessionHost mapping stays clear.
      lite.pushComplete();
      await delay(40); // let any (buggy) second delivery land before asserting
      assert.equal(writer.sent.filter((m) => m.type === 'complete').length, 1);
      assert.equal(registry.getSessionHost('s1'), undefined);
    } finally {
      routing?.dispose();
      ws?.close();
      await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test(
  'loopback lite: approval round-trip → respond rpc reaches the lite → complete',
  { timeout: 10_000 },
  async () => {
    const server = http.createServer();
    const registry = createRemoteAgentsRegistry();
    let wss: WebSocketServer | undefined;
    let routing: ReturnType<typeof createRemoteRouting> | undefined;
    let ws: WebSocket | undefined;

    try {
      wss = createRemoteAgentWss(server, {
        verifyToken: (t) => (t === 'loop-token' ? 'h1' : null),
        registry,
        onHostOnline: () => {},
        onHostOffline: () => {},
      });
      const port = await listen(server);

      ws = await connectLite(port, 'h1');
      assert.equal(registry.isOnline('h1'), true);

      let seenApproval: { requestId?: unknown; decision?: unknown } | undefined;
      const lite = fakeLite(ws, {
        providerSessionId: 'P1',
        scripted: [],
        pushComplete: false, // keep the run open so we can drive an approval
        onApprovalRespond: (f) => {
          seenApproval = f;
        },
      });

      routing = createRemoteRouting({
        lookupHost: (p) => (p === '/srv/app' ? 'h1' : null),
        registry,
        normalizeEvent: makeNormalizer(),
      });

      const writer = makeWriter();
      const localSpawn = () => {
        throw new Error('must not run locally');
      };

      const runPromise = routing.wrapSpawn('claude', localSpawn)('do it', {
        appSessionId: 's1',
        projectPath: '/srv/app',
        cwd: '/srv/app',
        sessionId: null,
      }, writer);

      // Wait until the session is established (sessionHost set after rpc_res).
      await waitFor(() => registry.getSessionHost('s1') !== undefined, 'session established');

      // The lite raises an approval; main forwards a permission_request and mirrors
      // it as pending.
      lite.pushApproval('req-1', { name: 'Bash', input: { command: 'ls' } });
      // The forwarded message is a NormalizedMessage (kind discriminant), not a raw
      // SDK event, so match on `kind`.
      await waitFor(() => writer.sent.some((m) => m.kind === 'permission_request'), 'permission_request forwarded');
      const pr = writer.sent.find((m) => m.kind === 'permission_request')!;
      assert.equal(pr.requestId, 'req-1');
      assert.equal(pr.toolName, 'Bash');
      // sessionId is sourced from the post-rpc_res sessionHost entry
      // (entry.providerSessionId), not from anywhere else.
      assert.equal(pr.sessionId, 'P1');

      // Resolve it on main → an approval/respond rpc must reach the lite, the
      // local mirror is cleared, and the registry's pending entry is consumed.
      routing.wrapResolveToolApproval(() => {
        throw new Error('should route remotely, not locally');
      })('req-1', { allow: true });

      assert.equal(routing.getPendingApprovalsForAppSession('s1').length, 0);
      assert.equal(registry.takePendingApproval('req-1'), undefined);

      await waitFor(() => seenApproval !== undefined, 'lite saw approval/respond');
      assert.equal(seenApproval!.requestId, 'req-1');
      assert.deepEqual(seenApproval!.decision, { allow: true });

      // End the run; the final sweep leaves no approvals behind either.
      lite.pushComplete();
      await runPromise;
      await waitFor(() => registry.getSessionHost('s1') === undefined, 'sessionHost swept');
      assert.equal(routing.getPendingApprovalsForAppSession('s1').length, 0);
    } finally {
      routing?.dispose();
      ws?.close();
      await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
