import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { ChildProcess } from 'node:child_process';

import { createRemoteTunnels } from '../remote-tunnels.js';

type SpawnRecord = { bin: string; argv: string[] };

/** A fake ssh ChildProcess whose lifecycle the test drives manually. */
class FakeChild extends EventEmitter {
  closed = false;
  killCalls = 0;
  pid = 4242;
  constructor(
    public readonly bin: string,
    public readonly argv: string[],
  ) {
    super();
  }
  kill(_signal?: NodeJS.Signals) {
    this.killCalls += 1;
    if (!this.closed) {
      this.closed = true;
      // Simulate the clean exit a SIGTERM produces.
      queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    }
    return true;
  }
  // Test helpers: simulate outcomes.
  exitNormally() {
    this.closed = true;
    this.emit('exit', 0, null);
  }
  failToSpawn(message = 'spawn ssh ENOENT') {
    const error = new Error(message) as Error & { code?: string };
    error.code = 'ENOENT';
    this.emit('error', error);
  }
}

function makeHarness() {
  const spawned: SpawnRecord[] = [];
  const children: FakeChild[] = [];
  const loggerCalls: string[] = [];
  const execFileFn = (bin: string, argv: string[]) => {
    const child = new FakeChild(bin, argv);
    spawned.push({ bin, argv });
    children.push(child);
    return child;
  };
  const tunnels = createRemoteTunnels({
    identityFile: '/keys/lovdex_ed25519',
    forwardPort: 3188,
    initialBackoffMs: 10,
    maxBackoffMs: 40,
    execFileFn: execFileFn as unknown as typeof import('node:child_process').execFile,
    logger: (m) => loggerCalls.push(m),
  });
  return { tunnels, spawned, children, loggerCalls };
}

const host = { host_id: 'h1', host: '172.26.167.52', port: 22, ssh_user: 'sophgo', tunnel_port: 13188 };
const hostWithPort = { ...host, port: 2222 };

test('ensure spawns ssh -N -R with the Lovdex identity and host port', () => {
  const { tunnels, spawned } = makeHarness();
  tunnels.ensure(hostWithPort);
  assert.equal(spawned.length, 1);
  const { bin, argv } = spawned[0]!;
  assert.equal(bin, 'ssh');
  assert.ok(argv.includes('-i') && argv.includes('/keys/lovdex_ed25519'), 'uses the Lovdex identity');
  assert.ok(argv.includes('-p') && argv.includes('2222'), 'passes the host ssh port');
  assert.ok(argv.includes('-N'));
  const rIdx = argv.indexOf('-R');
  assert.ok(rIdx >= 0, 'has -R');
  assert.equal(argv[rIdx + 1], '127.0.0.1:13188:127.0.0.1:3188');
  assert.equal(argv[argv.length - 1], 'sophgo@172.26.167.52');
  assert.ok(argv.includes('ExitOnForwardFailure=yes'), 'fails fast on un-bindable forward');
  assert.ok(tunnels.isRunning('h1'));
  tunnels.close();
});

test('ensure is idempotent while the tunnel is up; restart on port change', () => {
  const { tunnels, spawned, children } = makeHarness();
  tunnels.ensure(host);
  tunnels.ensure(host);
  assert.equal(spawned.length, 1, 'second ensure is a no-op while child is alive');

  tunnels.ensure({ ...host, tunnel_port: 13189 });
  assert.equal(spawned.length, 2, 'port change restarts the tunnel');
  assert.equal(children[0]!.killCalls, 1, 'old child was SIGTERMed');
  assert.equal(
    spawned[1]!.argv[spawned[1]!.argv.indexOf('-R') + 1],
    '127.0.0.1:13189:127.0.0.1:3188',
  );
  tunnels.close();
});

test('unexpected exit → respawn with backoff; stop() prevents respawns', async () => {
  const { tunnels, spawned, children } = makeHarness();
  tunnels.ensure(host);
  children[0]!.exitNormally(); // e.g. dropped network session
  assert.equal(tunnels.isRunning('h1'), false);
  await new Promise((r) => setTimeout(r, 50)); // let the 10ms respawn fire
  assert.equal(spawned.length, 2, 'respawned after unexpected exit');

  tunnels.stop('h1');
  children[1]!.exitNormally();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spawned.length, 2, 'no respawn after stop()');
});

test('syncFromHosts drops tunnels for hosts without tunnel_port and starts new ones', async () => {
  const { tunnels, spawned, children } = makeHarness();
  const keep = { host_id: 'keep', host: '10.0.0.1', port: 22, ssh_user: 'root', tunnel_port: 14000 };
  const drop = { host_id: 'drop', host: '10.0.0.2', port: 22, ssh_user: 'root', tunnel_port: 14001 };
  tunnels.ensure(drop);
  assert.equal(spawned.length, 1);

  // Sync with `drop`'s tunnel_port cleared (row updated) and `keep` new.
  tunnels.syncFromHosts([
    { ...drop, tunnel_port: null } as never,
    keep as never,
  ]);
  assert.equal(tunnels.isRunning('drop'), false);
  assert.ok(tunnels.isRunning('keep'));
  assert.equal(children[0]!.killCalls, 1, 'dropped host tunnel was killed');
  assert.equal(spawned.length, 2);
  tunnels.close();
});

test('spawn failure records lastError and respawns', async () => {
  const { tunnels, spawned, children } = makeHarness();
  tunnels.ensure(host);
  children[0]!.failToSpawn('SSH binary missing');
  assert.equal(tunnels.lastError('h1'), 'SSH binary missing');
  assert.equal(tunnels.isRunning('h1'), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spawned.length, 2, 'respawned after spawn error');
  tunnels.close();
});