import { execFile } from 'node:child_process';

import type { RemoteHostRow } from '@/shared/types.js';

/**
 * Per-host ssh -R reverse tunnels, so a target host that cannot reach the
 * main server (firewalled / VLAN-isolated — e.g. a server subnet that routes
 * to the desktop subnet is blocked) can still dial the lite WS back to us.
 *
 * Direction matters: the main → target ssh (Lovdex ed25519 key) already works
 * for deploy, so the tunnel rides on the SAME outbound ssh usable today even
 * though target → main is dead. `ssh -N -R 127.0.0.1:<port>:127.0.0.1:<mainPort>`
 * binds a loopback port ON the target that forwards back through this ssh
 * session to the main server's own WS/API listener.
 *
 * The deploy flow then points the lite at `ws://127.0.0.1:<port>/...` (see
 * remote-agents.routes.ts), so the lite only needs its own loopback.
 *
 * Lifecycle: one child per host with `tunnel_port` set; unexpected exits are
 * respawned with doubling backoff (1s → cap 30s, mirroring supervisor.mjs).
 * `syncFromHosts()` (called at boot and after any host mutation) reconciles
 * the set: hosts whose `tunnel_port` was cleared have their tunnels stopped.
 */

export type TunnelHost = Pick<RemoteHostRow, 'host_id' | 'host' | 'port' | 'ssh_user' | 'tunnel_port'>;

export type RemoteTunnelsManager = {
  /** Start (or restart on port change) the tunnel for a host with tunnel_port. */
  ensure(host: TunnelHost): void;
  /** Stop the tunnel for a host (e.g. tunnel disabled or host deleted). */
  stop(hostId: string): void;
  isRunning(hostId: string): boolean;
  /** Last overserved child error (spawn failure), if any. */
  lastError(hostId: string): string | null;
  /** Reconcile against the host list: drop tunnels for hosts lacking tunnel_port. */
  syncFromHosts(hosts: RemoteHostRow[]): void;
  /** Stop everything (backend shutdown). */
  close(): void;
};

export type RemoteTunnelsConfig = {
  /** `-i` identity for the main→target ssh (Lovdex ed25519), or null. */
  identityFile: string | null;
  /** The main server port to forward (the backend listener, e.g. 3188). */
  forwardPort: number;
  sshBin?: string;
  /** Minimum unprivileged loopback bind port (target user is not root). */
  minTunnelPort?: number;
  maxTunnelPort?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected for tests; defaults to node:child_process execFile. */
  execFileFn?: typeof execFile;
  logger?: (message: string) => void;
};

type TunnelState = {
  port: number;
  child: ReturnType<typeof execFile> | null;
  timer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  stopped: boolean;
  lastError: string | null;
};

export const DEFAULT_MIN_TUNNEL_PORT = 1024;
export const DEFAULT_MAX_TUNNEL_PORT = 65535;

export function createRemoteTunnels(config: RemoteTunnelsConfig): RemoteTunnelsManager {
  const exec = config.execFileFn ?? execFile;
  const bin = config.sshBin ?? 'ssh';
  const minPort = config.minTunnelPort ?? DEFAULT_MIN_TUNNEL_PORT;
  const maxPort = config.maxTunnelPort ?? DEFAULT_MAX_TUNNEL_PORT;
  const initialBackoff = config.initialBackoffMs ?? 1000;
  const maxBackoff = config.maxBackoffMs ?? 30_000;
  const log = config.logger ?? ((message: string) => console.warn(`[remote-tunnel] ${message}`));

  const tunnels = new Map<string, TunnelState>();

  function spawn(host: TunnelHost, state: TunnelState): void {
    if (state.stopped) return;
    const argv = [
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'BatchMode=yes',
      // Exit (nonzero) when the -R forward cannot bind on the target — fail
      // fast instead of silently holding a dead session.
      '-o',
      'ExitOnForwardFailure=yes',
      // Detect silent half-open connections between heartbeats.
      '-o',
      'ServerAliveInterval=20',
      '-o',
      'ServerAliveCountMax=2',
    ];
    if (config.identityFile) argv.push('-i', config.identityFile);
    if (host.port && host.port !== 22) argv.push('-p', String(host.port));
    argv.push(
      '-N',
      '-R',
      `127.0.0.1:${state.port}:127.0.0.1:${config.forwardPort}`,
      `${host.ssh_user}@${host.host}`,
    );

    const child = exec(bin, argv, { maxBuffer: 1024 * 1024 });
    state.child = child;
    state.lastError = null;

    // Spawn failure (e.g. ssh binary missing): record + respawn.
    child.on('error', (error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.child = null;
      scheduleRespawn(host, state);
    });
    // Normal/failed exit: schedule a respawn unless stop() said so.
    child.on('exit', () => {
      state.child = null;
      scheduleRespawn(host, state);
    });
    log(`tunnel up for ${host.host_id} (${host.ssh_user}@${host.host}:${host.port ?? 22} → 127.0.0.1:${state.port})`);
  }

  function scheduleRespawn(host: TunnelHost, state: TunnelState): void {
    if (state.stopped || state.timer) return;
    const wait = state.backoff;
    state.backoff = Math.min(state.backoff * 2, maxBackoff);
    state.timer = setTimeout(() => {
      state.timer = null;
      spawn(host, state);
    }, wait);
  }

  function ensure(host: TunnelHost): void {
    const port = host.tunnel_port;
    if (
      typeof port !== 'number'
      || !Number.isInteger(port)
      || port < minPort
      || port > maxPort
    ) {
      stop(host.host_id);
      return;
    }
    let state = tunnels.get(host.host_id);
    // Already running on the same port → nothing to do.
    if (state && state.port === port && state.child) return;
    // Port changed (or a tunnel exists but was stopped internally) → restart.
    if (state && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state?.child) {
      state.stopped = true;
      state.child.removeAllListeners('exit');
      state.child.removeAllListeners('error');
      try {
        state.child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    state = { port, child: null, timer: null, backoff: initialBackoff, stopped: false, lastError: null };
    tunnels.set(host.host_id, state);
    spawn(host, state);
  }

  function stop(hostId: string): void {
    const state = tunnels.get(hostId);
    if (!state) return;
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.child) {
      state.child.removeAllListeners('exit');
      state.child.removeAllListeners('error');
      try {
        state.child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      state.child = null;
    }
    tunnels.delete(hostId);
    log(`tunnel stopped for ${hostId}`);
  }

  return {
    ensure,
    stop,
    isRunning(hostId) {
      const state = tunnels.get(hostId);
      return Boolean(state?.child);
    },
    lastError(hostId) {
      return tunnels.get(hostId)?.lastError ?? null;
    },
    syncFromHosts(hosts) {
      const wanted = new Map(
        hosts
          .filter((h) => typeof h.tunnel_port === 'number' && Number.isInteger(h.tunnel_port))
          .map((h) => [h.host_id, h]),
      );
      for (const host of wanted.values()) {
        try {
          ensure(host);
        } catch (error) {
          log(`ensure failed for ${host.host_id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const hostId of [...tunnels.keys()]) {
        if (!wanted.has(hostId)) stop(hostId);
      }
    },
    close() {
      for (const hostId of [...tunnels.keys()]) stop(hostId);
    },
  };
}