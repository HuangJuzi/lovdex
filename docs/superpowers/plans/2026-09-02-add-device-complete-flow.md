# Add-Device Complete Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "添加设备" a complete closed loop — auto-install node/claude, auto-tunnel connect-back, and only report success when the lite is actually online — so a newly added device immediately appears in "新建项目".

**Architecture:** Add a `prepare-remote.sh` dependency installer pushed+run by the bootstrap before its node/claude probes; add `allocateTunnelPort()` to the remote-hosts repo and auto-tunnel in the deploy route when no public WS URL is configured; tighten the frontend add-dialog success gate to `online===true`.

**Tech Stack:** TypeScript (Node `node:test`), Express router, bash deploy scripts, React (existing add-host dialog).

Spec: `docs/superpowers/specs/2026-09-02-add-device-complete-flow-design.md`

---

## File Structure

- Create `backend/remote-agent/deploy/prepare-remote.sh` — idempotent node/claude dependency installer.
- Modify `backend/server/modules/remote-agents/remote-host.db.ts` — add `allocateTunnelPort()`.
- Modify `backend/server/modules/remote-agents/bootstrap.service.ts` — reorder probes, push+run prepare, version-aware node probe.
- Modify `backend/server/modules/remote-agents/remote-agents.routes.ts` — rename `serverUrl`→`publicWsUrl`, auto-tunnel in deploy.
- Modify `backend/server/index.js` — wire `publicWsUrl` + `prepareScriptPath`.
- Modify `web/src/components/settings/AddRemoteHostDialog.tsx` — success gate = `online===true`.
- Test files: `remote-host.db.test.ts`, `bootstrap.service.test.ts`, `remote-agents.routes.test.ts`.

Test invocation (backend, no `npm test` script):

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test <file>
```

---

## Task 1: `allocateTunnelPort()` in the remote-hosts repo

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-host.db.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-host.db.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `remote-host.db.test.ts` (inside the file, after the existing `agent_token_hash` test):

```ts
test('allocateTunnelPort starts at 20000 when no tunnel ports are used', () => {
  repo.create({ host_id: 'h1', name: 'a', host: '10.0.0.1', ssh_user: 'root' });
  assert.equal(repo.allocateTunnelPort(), 20000);
});

test('allocateTunnelPort returns the first free port above the used set', () => {
  repo.create({ host_id: 'h1', name: 'a', host: '10.0.0.1', ssh_user: 'root' });
  repo.create({ host_id: 'h2', name: 'b', host: '10.0.0.2', ssh_user: 'root' });
  repo.setTunnelPort('h1', 20000);
  repo.setTunnelPort('h2', 20001);
  assert.equal(repo.allocateTunnelPort(), 20002);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-host.db.test.ts`
Expected: FAIL — `repo.allocateTunnelPort is not a function`.

- [ ] **Step 3: Implement `allocateTunnelPort`**

In `remote-host.db.ts`, add to the `RemoteHostsRepository` type (after `setTunnelPort`):

```ts
  setTunnelPort(hostId: string, port: number | null): void;
  allocateTunnelPort(): number;
```

Add to the returned object (after `setTunnelPort`, before `getByTokenHash`):

```ts
    allocateTunnelPort() {
      const rows = db
        .prepare('SELECT tunnel_port FROM remote_hosts WHERE tunnel_port IS NOT NULL')
        .all() as { tunnel_port: number }[];
      const used = new Set(rows.map((r) => r.tunnel_port));
      let port = 20000;
      while (port <= 60000 && used.has(port)) port += 1;
      if (port > 60000) throw new Error('no free tunnel port in [20000, 60000]');
      return port;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-host.db.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/remote-agents/remote-host.db.ts backend/server/modules/remote-agents/tests/remote-host.db.test.ts
git commit -m "feat(remote-agents): allocate tunnel port helper"
```

---

## Task 2: `prepare-remote.sh` dependency installer

**Files:**
- Create: `backend/remote-agent/deploy/prepare-remote.sh`

- [ ] **Step 1: Write the script**

Create `backend/remote-agent/deploy/prepare-remote.sh`:

```bash
#!/usr/bin/env bash
#
# Remote-lite dependency prep: ensure node >= 20 and the claude CLI exist on the
# target, installing them when missing. Idempotent — a no-op when both are
# already present. Runs as `bash ~/.lovdex-remote/prepare-remote.sh` from the
# bootstrap (a non-login shell), so `command -v` must find the binaries on the
# default PATH (the same shell the lite's systemd unit will use).
#
#   - node:   official Linux x64 tarball extracted to /usr/local (no apt repo).
#   - claude: `npm i -g @anthropic-ai/claude-code`.
# Auto-install only proceeds under passwordless sudo (`sudo -n true`); otherwise
# this prints the exact manual commands and exits 1 (bootstrap surfaces them).
set -euo pipefail

NODE_VERSION="22.14.0"
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

log() { echo "[prepare] $*"; }

has_passwordless_sudo() {
  sudo -n true >/dev/null 2>&1
}

# True when node is present AND its major version is >= 20.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v 2>/dev/null | LC_ALL=C sed 's/^[vV]//' | cut -d. -f1)"
  [ -n "${major}" ] && [ "${major}" -ge 20 ] 2>/dev/null
}

if ! node_ok; then
  log "node missing or <20 — installing Node ${NODE_VERSION} to /usr/local"
  if ! has_passwordless_sudo; then
    echo "[prepare] error: node >=20 required, and passwordless sudo is unavailable." >&2
    echo "  Install Node >=20 manually, e.g.:" >&2
    echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
    exit 1
  fi
  sudo curl -fsSL "${NODE_URL}" -o "/tmp/${NODE_TARBALL}"
  sudo tar -xJf "/tmp/${NODE_TARBALL}" -C /usr/local --strip-components=1
  sudo rm -f "/tmp/${NODE_TARBALL}"
  node_ok || { echo "[prepare] error: node install completed but node -v still failing" >&2; exit 1; }
fi

if ! command -v claude >/dev/null 2>&1; then
  log "claude missing — installing @anthropic-ai/claude-code globally"
  if ! has_passwordless_sudo; then
    echo "[prepare] error: claude required, and passwordless sudo is unavailable." >&2
    echo "  Install claude manually: sudo npm i -g @anthropic-ai/claude-code" >&2
    exit 1
  fi
  sudo npm i -g @anthropic-ai/claude-code
  command -v claude >/dev/null 2>&1 || { echo "[prepare] error: claude install failed" >&2; exit 1; }
fi

echo "[prepare] ready: node $(node -v), claude $(claude -v)"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x backend/remote-agent/deploy/prepare-remote.sh`

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/remote-agent/deploy/prepare-remote.sh
git commit -m "feat(remote-agent): add prepare-remote.sh dependency installer"
```

---

## Task 3: bootstrap reorder + prepare + version-aware node probe

**Files:**
- Modify: `backend/server/modules/remote-agents/bootstrap.service.ts`
- Test: `backend/server/modules/remote-agents/tests/bootstrap.service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `bootstrap.service.test.ts`, update the `pushCalls` assertion in the test `with push+unit, install.sh + unit template are pushed and install runs` (currently lines 87-91) to include the prepare push first:

```ts
  assert.deepEqual(pushCalls, [
    { localPath: 'remote-agent/deploy/prepare-remote.sh', remotePath: '~/.lovdex-remote/prepare-remote.sh' },
    { localPath: '/local/install.sh', remotePath: '~/.lovdex-remote/install.sh' },
    { localPath: 'remote-agent/deploy/systemd-unit.template', remotePath: '~/.lovdex-remote/lovdex-agent.service' },
    { localPath: '/build/lite.tgz', remotePath: '~/.lovdex-remote/lite.tgz' },
  ]);
```

Add these new tests (after the existing `node missing returns error hint` test):

```ts
test('with push, prepare-remote.sh is pushed and run before the node probe', async () => {
  const { runner, calls } = fakeRunner({ fail: ['node -v'] });
  const { push, calls: pushCalls } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push });

  assert.equal(result.status, 'error');
  assert.deepEqual(pushCalls, [
    { localPath: 'remote-agent/deploy/prepare-remote.sh', remotePath: '~/.lovdex-remote/prepare-remote.sh' },
  ]);
  const joined = calls.map((c) => c.join(' '));
  const prepIdx = joined.findIndex((c) => c.includes('prepare-remote.sh'));
  const nodeIdx = joined.findIndex((c) => c.includes('node -v'));
  assert.ok(prepIdx >= 0, 'prepare script is run');
  assert.ok(nodeIdx > prepIdx, 'node probe happens after prepare');
});

test('prepare failure surfaces a dependency-prepare error', async () => {
  const { runner } = fakeRunner({ fail: ['prepare-remote.sh'] });
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /dependency prepare failed/);
});

test('node present but <20 returns a too-old version error', async () => {
  const { runner } = fakeRunner({
    stdout: (argv) => (argv.join(' ').includes('node -v') ? 'v18.19.0' : ''),
  });
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /too old/);
});

test('no push skips prepare and still gates on the node probe', async () => {
  const { runner, calls } = fakeRunner({ fail: ['node -v'] });

  const result = await runBootstrap(baseInput, { runner });

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /node not found/i);
  const joined = calls.map((c) => c.join(' '));
  assert.ok(!joined.some((c) => c.includes('prepare-remote.sh')), 'no prepare script without a push seam');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/bootstrap.service.test.ts`
Expected: FAIL — `pushCalls` deepEqual mismatch (missing prepare push) and the 4 new tests fail (prepare not pushed / version not checked / no `dependency prepare failed` message).

- [ ] **Step 3: Update constants + deps type in bootstrap.service.ts**

Change the `deps` parameter type of `runBootstrap` (line 115) to add `prepareScriptPath`:

```ts
  deps: { runner?: SshRunner; push?: FilePush; prepareScriptPath?: string; installScriptPath?: string; unitTemplatePath?: string },
```

Add the constants (after `DEFAULT_INSTALL_SCRIPT`/`DEFAULT_UNIT_TEMPLATE`, near line 60):

```ts
const DEFAULT_PREPARE_SCRIPT = 'remote-agent/deploy/prepare-remote.sh';
const REMOTE_PREPARE_PATH = `${REMOTE_DIR}/prepare-remote.sh`;
```

- [ ] **Step 4: Replace the `runBootstrap` body**

Replace the entire body of `runBootstrap` (from `const runner = deps.runner;` at line 117 through the final `return { status: 'online', ... }` at line 241) with:

```ts
  const runner = deps.runner;
  if (!runner) {
    return { status: 'error', message: 'no ssh runner provided' };
  }

  // I5: the lite config schema has `roots: z.array().min(1)` — mirror it so we
  // never push a config the lite would reject at load.
  if (!input.roots || input.roots.length === 0) {
    return {
      status: 'error',
      message: 'roots must contain at least one path (mirrors the lite config schema)',
    };
  }

  const remote = `${input.sshUser}@${input.host}`;
  const id = input.identityFile ?? null;
  const port = input.port;
  // C1: reuse a caller-supplied stable hostId so the lite's hello hostId
  // matches the remote_hosts row the caller binds the token to; fall back to a
  // fresh randomUUID for first-time provisioning.
  const hostId = input.hostId ?? randomUUID();

  const run = (rest: string[]) => runner(sshArgs(remote, id, port, rest));
  const push = deps.push;

  // 1. probe: uname (fail early if unreachable / not a POSIX host).
  const uname = await run(['uname', '-a']);
  if (!uname.ok) {
    return { status: 'error', message: `remote unreachable: ${uname.stderr.trim() || 'uname failed'}`, hostId };
  }

  // 2. create the remote dir — prepare/config/install all land here.
  const mk = await run(['mkdir', '-p', REMOTE_DIR]);
  if (!mk.ok) {
    return { status: 'error', message: `mkdir failed: ${mk.stderr.trim() || 'unknown'}`, hostId };
  }

  // 3. dependency prep: push + run prepare-remote.sh (installs node>=20 and the
  //    claude CLI when missing). Skipped when no FilePush is wired — then the
  //    node/claude probes below must already succeed on the target.
  if (push) {
    const prepareScriptPath = deps.prepareScriptPath ?? DEFAULT_PREPARE_SCRIPT;
    const pushedPrepare = await push(prepareScriptPath, REMOTE_PREPARE_PATH);
    if (!pushedPrepare.ok) {
      return { status: 'error', message: `prepare script upload failed: ${pushedPrepare.error ?? 'unknown'}`, hostId };
    }
    const prep = await run(['bash', REMOTE_PREPARE_PATH]);
    if (!prep.ok) {
      return { status: 'error', message: `dependency prepare failed: ${prep.stderr.trim() || 'unknown'}`, hostId };
    }
  }

  // 4. re-probe node (post-prep). Presence is the bar; version >=20 is a
  //    best-effort guard when the version parses (prepare-remote.sh is the
  //    strict gate).
  const node = await run(['node', '-v']);
  if (!node.ok) {
    return {
      status: 'error',
      message: `node not found on remote — install node >=20 first (prepare couldn't provision it: ${node.stderr.trim() || 'node unavailable'})`,
      hostId,
    };
  }
  const nodeMajor = /^v?(\d+)/.exec(node.stdout.trim())?.[1];
  if (nodeMajor && Number(nodeMajor) < 20) {
    return {
      status: 'error',
      message: `node ${node.stdout.trim()} is too old — need node >=20`,
      hostId,
    };
  }

  // 5. probe claude CLI. install.sh resolves absolute binaries later; this is
  //    only a clear, early failure surface (prepare also installs it).
  const claude = await run(['claude', '-v']);
  if (!claude.ok) {
    return {
      status: 'error',
      message: `claude not installed — run: npm i -g @anthropic-ai/claude-code (prepare couldn't provision it: ${claude.stderr.trim() || 'claude unavailable'})`,
      hostId,
    };
  }

  // 6. write config.json (0600). JSON.stringify sanitizes the caller-provided
  //    serverUrl/token/roots so they embed safely inside the heredoc body.
  const config = {
    serverUrl: input.serverUrl,
    token: input.token,
    hostId,
    roots: input.roots,
    apiKeyEnvPath: ENV_PATH,
  };
  const configJson = JSON.stringify(config, null, 2);
  const cfg = await runner(writeRemoteFileArgs(remote, id, port, CONFIG_PATH, configJson, '600'));
  if (!cfg.ok) {
    return { status: 'error', message: `config write failed: ${cfg.stderr.trim() || 'unknown'}`, hostId };
  }

  // 7. write the env file (0600) with the API key, if provided.
  if (input.apiKey) {
    if (input.apiKey.includes('\n')) {
      return { status: 'error', message: 'apiKey must not contain newlines', hostId };
    }
    const envBody = `ANTHROPIC_API_KEY=${input.apiKey}`;
    const env = await runner(writeRemoteFileArgs(remote, id, port, ENV_PATH, envBody, '600'));
    if (!env.ok) {
      return { status: 'error', message: `env write failed: ${env.stderr.trim() || 'unknown'}`, hostId };
    }
  }

  // 8. push install.sh + systemd unit + lite package, then run install.sh.
  if (!push) {
    // No push seam: config/env are on the remote, but the service is not — never
    // report `online` for a half-finished deploy.
    return {
      status: 'partial',
      message: 'deployed config but systemd install deferred (no FilePush wired)',
      tokenHash: sha256(input.token),
      hostId,
    };
  }

  const installScriptPath = deps.installScriptPath ?? DEFAULT_INSTALL_SCRIPT;
  const pushedInstall = await push(installScriptPath, REMOTE_INSTALL_PATH);
  if (!pushedInstall.ok) {
    return { status: 'error', message: `install script upload failed: ${pushedInstall.error ?? 'unknown'}`, hostId };
  }

  const unitTemplatePath = deps.unitTemplatePath ?? DEFAULT_UNIT_TEMPLATE;
  const pushedUnit = await push(unitTemplatePath, REMOTE_UNIT_PATH);
  if (!pushedUnit.ok) {
    return { status: 'error', message: `systemd unit upload failed: ${pushedUnit.error ?? 'unknown'}`, hostId };
  }

  if (input.litePackagePath) {
    const pushedPkg = await push(input.litePackagePath, REMOTE_LITE_TARBALL);
    if (!pushedPkg.ok) {
      return { status: 'error', message: `lite package upload failed: ${pushedPkg.error ?? 'unknown'}`, hostId };
    }
  }

  // 9. run install.sh (deps/tarball + systemd unit install + enable --now).
  const install = await run(['bash', REMOTE_INSTALL_PATH]);
  if (!install.ok) {
    return { status: 'error', message: `install failed: ${install.stderr.trim() || 'unknown'}`, hostId };
  }

  return { status: 'online', tokenHash: sha256(input.token), hostId, message: 'deployed' };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/bootstrap.service.test.ts`
Expected: PASS (14 existing + 4 new).

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/remote-agents/bootstrap.service.ts backend/server/modules/remote-agents/tests/bootstrap.service.test.ts
git commit -m "feat(remote-agents): bootstrap auto-installs node/claude via prepare script"
```

---

## Task 4: auto-tunnel + `publicWsUrl` in the deploy route

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-agents.routes.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-agents.routes.test.ts`

- [ ] **Step 1: Write the failing tests**

In `remote-agents.routes.test.ts`, update `makeHarness` so the direct-URL dep is `publicWsUrl` (replace the `serverUrl:` line at ~172):

```ts
    identityFile: overrides.identityFile ?? '/home/lovdex/.ssh/id_ed25519',
    publicWsUrl: overrides.publicWsUrl ?? 'ws://main:4000/api/remote-agents/ws',
    tunnels: overrides.tunnels ?? tunnels,
```

Add these tests (after the existing `POST /:id/deploy happy path` test):

```ts
test('POST /:id/deploy auto-tunnels when no public WS URL is configured', async () => {
  const h = await makeHarness({
    publicWsUrl: null,
    bootstrapImpl: async (input) => ({ status: 'online', message: 'deployed', hostId: input.hostId }),
  });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });

    const res = await fetch(`${h.base}/api/remote-agents/h1/deploy`, { method: 'POST' });
    assert.equal(res.status, 200);

    const row = h.repo.getById('h1');
    assert.ok(row?.tunnel_port && row.tunnel_port >= 20000 && row.tunnel_port <= 60000, 'auto-allocated a tunnel port');
    assert.equal(h.ensureCalls.length, 1, 'tunnel ensured before bootstrap');
    assert.equal(h.ensureCalls[0]?.tunnel_port, row?.tunnel_port);
    assert.equal(h.bootstrapCalls[0]?.serverUrl, `ws://127.0.0.1:${row?.tunnel_port}/api/remote-agents/ws`);
  } finally {
    await h.close();
  }
});

test('POST /:id/deploy goes direct when a public WS URL is configured', async () => {
  const h = await makeHarness({
    publicWsUrl: 'wss://lovdex.example.com/api/remote-agents/ws',
  });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });

    const res = await fetch(`${h.base}/api/remote-agents/h1/deploy`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(h.ensureCalls.length, 0, 'no tunnel in direct mode');
    assert.equal(h.repo.getById('h1')?.tunnel_port, null);
    assert.equal(h.bootstrapCalls[0]?.serverUrl, 'wss://lovdex.example.com/api/remote-agents/ws');
  } finally {
    await h.close();
  }
});

test('POST /:id/deploy keeps an existing tunnel over a configured public URL', async () => {
  const h = await makeHarness({
    publicWsUrl: 'wss://lovdex.example.com/api/remote-agents/ws',
  });
  try {
    h.repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
    h.repo.setTunnelPort('h1', 13188);

    const res = await fetch(`${h.base}/api/remote-agents/h1/deploy`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(h.ensureCalls.length, 1);
    assert.equal(h.bootstrapCalls[0]?.serverUrl, 'ws://127.0.0.1:13188/api/remote-agents/ws');
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-agents.routes.test.ts`
Expected: FAIL — type error: `overrides.publicWsUrl`/`publicWsUrl` not in deps; and the 3 new tests fail.

- [ ] **Step 3: Rename `serverUrl` → `publicWsUrl` in the deps type**

In `remote-agents.routes.ts`, replace the `serverUrl` field (line 29-30):

```ts
  /** Main server ws URL the lite connects back to (default for non-tunnel hosts). */
  serverUrl: string;
```

with:

```ts
  /**
   * Public WS URL the lite dials back to for DIRECT (non-tunnel) hosts. When
   * null, deploy auto-tunnels instead (ssh -R on the already-working main→target
   * session) — used when the target cannot reach the main server directly.
   */
  publicWsUrl: string | null;
```

- [ ] **Step 4: Auto-tunnel in the deploy route**

In `remote-agents.routes.ts`, replace the deploy `try` block's bootstrap invocation (the `let result: BootstrapResult;` / `try { ... result = await deps.bootstrap({ ... })` block, lines 194-216) with:

```ts
      let result: BootstrapResult;
      try {
        // Resolve the lite's dial-back address. Precedence: an existing tunnel
        // wins (a user-configured/historical tunnel is never silently dropped),
        // else a configured public WS URL (direct), else auto-tunnel — allocate
        // a loopback port on the target and ride the already-working main→target
        // ssh. The forward is (re)ensured before pushing config so the lite can
        // connect back immediately.
        let serverUrl: string;
        if (host.tunnel_port !== null) {
          deps.tunnels.ensure(host);
          serverUrl = `ws://127.0.0.1:${host.tunnel_port}/api/remote-agents/ws`;
        } else if (deps.publicWsUrl) {
          serverUrl = deps.publicWsUrl;
        } else {
          const tunnelPort = deps.repo.allocateTunnelPort();
          deps.repo.setTunnelPort(hostId, tunnelPort);
          deps.tunnels.ensure({ ...host, tunnel_port: tunnelPort });
          serverUrl = `ws://127.0.0.1:${tunnelPort}/api/remote-agents/ws`;
        }
        result = await deps.bootstrap({
          host: host.host,
          port: host.port,
          sshUser: host.ssh_user,
          identityFile: deps.identityFile,
          // Deterministic per-host token: redeploy mints the SAME token (and
          // persists the same sha256) — a running lite is never bricked by an
          // interrupted deploy resetting its auth.
          token: deps.tokenFor(hostId),
          serverUrl,
          hostId: host.host_id,
          roots,
        });
      } catch (error) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-agents.routes.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/remote-agents/remote-agents.routes.ts backend/server/modules/remote-agents/tests/remote-agents.routes.test.ts
git commit -m "feat(remote-agents): auto-tunnel on deploy when no public WS URL"
```

---

## Task 5: wire `publicWsUrl` + `prepareScriptPath` in index.js

**Files:**
- Modify: `backend/server/index.js`

- [ ] **Step 1: Rename the router dep**

In `index.js`, replace the `serverUrl:` entry in the `createRemoteAgentsRouter({...})` call (currently around line 376-379):

```ts
    // The lite dials back to this ws URL. The localhost default is correct for
    // loopback E2E (ssh host == the Lovdex host); for a real remote host the
    // operator MUST set LOVDEX_PUBLIC_WS_URL to an address reachable from it.
    serverUrl: process.env.LOVDEX_PUBLIC_WS_URL ?? `ws://localhost:${cfg.server.port}/api/remote-agents/ws`,
```

with:

```ts
    // Direct dial-back URL when LOVDEX_PUBLIC_WS_URL is set; otherwise deploy
    // auto-tunnels (ssh -R) so targets that cannot reach the main server still
    // connect back. Passed as null so the route can distinguish "not configured".
    publicWsUrl: process.env.LOVDEX_PUBLIC_WS_URL ?? null,
```

- [ ] **Step 2: Pass the prepare script path to bootstrap**

In the same `createRemoteAgentsRouter({...})` call, inside the `bootstrap:` wrapper, add `prepareScriptPath` next to `installScriptPath` (around line 418):

```ts
                installScriptPath: path.join(__dirname, '..', 'remote-agent', 'deploy', 'install.sh'),
                prepareScriptPath: path.join(__dirname, '..', 'remote-agent', 'deploy', 'prepare-remote.sh'),
                unitTemplatePath: path.join(__dirname, '..', 'remote-agent', 'deploy', 'systemd-unit.template'),
```

- [ ] **Step 3: Sanity-check the edits landed**

Run: `cd /mnt/b/workdir/github/lovdex && grep -n "publicWsUrl\|prepareScriptPath" backend/server/index.js`
Expected: two matches — `publicWsUrl: process.env.LOVDEX_PUBLIC_WS_URL ?? null,` (in the router deps) and `prepareScriptPath: path.join(__dirname, '..', 'remote-agent', 'deploy', 'prepare-remote.sh'),` (in the bootstrap wrapper).

NOTE: do NOT restart the production backend (`systemctl --user lovdex`) just for this task — Task 7's typecheck + the targeted tests cover it; a restart is a separate, user-confirmed action.

- [ ] **Step 4: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js
git commit -m "feat(remote-agents): wire prepare script path and public WS URL"
```

---

## Task 6: frontend success gate = lite actually online

**Files:**
- Modify: `web/src/components/settings/AddRemoteHostDialog.tsx`

No automated frontend test (out of scope per spec — "前端（可选）"); verify manually in the browser.

- [ ] **Step 1: Add the grace constant**

In `AddRemoteHostDialog.tsx`, after `const POLL_INTERVAL_MS = 3000;` (line 22) add:

```ts
// After deploy returns, keep polling this long for the lite to actually dial
// back (online=true). "status===online" only means install.sh finished — it is
// NOT the success signal.
const ONLINE_GRACE_MS = 30_000;
```

- [ ] **Step 2: Replace the poll helper**

Replace `pollUntilSettled` (lines 127-160) with `waitForOnline`:

```ts
  // Poll GET / until the lite actually dials back (online=true), the bootstrap
  // hard-fails (status=error), or the grace deadline elapses. "status===online"
  // is NOT terminal — it merely means install.sh finished; the definitive signal
  // that the device is usable (and appears in 新建项目) is online=true.
  function waitForOnline(hostId: string, graceMs: number): Promise<RemoteHost | null> {
    return new Promise((resolve) => {
      const deadline = Date.now() + graceMs;
      const tick = () => {
        void api
          .get('/remote-agents')
          .then(async (res) => {
            if (!res.ok) return; // transient list error → keep polling
            const body = (await res.json()) as HostsResponse;
            const row = (body.data?.hosts ?? []).find((h) => h.host_id === hostId) ?? null;
            if (!activeRef.current) {
              stopPolling();
              resolve(null);
              return;
            }
            const done = !!row && (row.online === true || row.status === 'error' || Date.now() >= deadline);
            if (done) {
              stopPolling();
              resolve(row);
            }
          })
          .catch(() => {
            // Non-fatal during polling; keep trying.
          });
      };
      pollTimer.current = setInterval(tick, POLL_INTERVAL_MS);
      tick();
    });
  }
```

- [ ] **Step 3: Rewrite the deploy + classification block in `run()`**

Replace the deploy/classification section of `run()` (the `// 2. Deploy ...` through the `onAdded();` before the `} catch`, lines 211-241) with:

```ts
      // 2. Deploy (blocking ssh/scp; includes dependency prep + auto-tunnel).
      setPhase('部署中…');
      const deployRes = await api.post(`/remote-agents/${encodeURIComponent(hostId)}/deploy`, {});
      if (!deployRes.ok) {
        setError(await readErrorMessage(deployRes, '部署失败'));
        return;
      }

      // 3. Wait for the lite to actually connect back (green = 真在线). Only
      //    then is the device usable and visible in 新建项目 — never false-success
      //    on "install.sh finished" (status==='online' but online=false).
      setPhase('等待上线…');
      const terminalRow = await waitForOnline(hostId, ONLINE_GRACE_MS);
      if (!activeRef.current) return;

      if (terminalRow?.online === true) {
        onAdded();
        onClose();
        return;
      }
      if (terminalRow?.status === 'error') {
        setError(terminalRow.last_error ? truncate(terminalRow.last_error) : '部署失败');
      } else {
        setError('部署命令已完成，但 lite 尚未连回主站。检查隧道/网络后点「重试」，或在设置中启用 SSH 隧道。');
      }
      // The host row exists (registered) — refresh the list so it shows up.
      onAdded();
```

Remove the now-unused `type DeployResponse = { data?: { status?: string; message?: string } };` (line 18).

- [ ] **Step 4: Type-check the frontend**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit 2>&1 | grep -i "AddRemoteHostDialog" || echo "no AddRemoteHostDialog errors"`
Expected: `no AddRemoteHostDialog errors` (no new type errors from this file).

- [ ] **Step 5: Manual verification**

Steps: 设置 → 远程机器 → 添加远程机器 → 填 rustdesk 主机 → 添加并部署。Expected: 阶段显示 注入公钥/部署中/等待上线；设备绿点「在线」后才自动关窗；该设备出现在「新建项目 → 远程」下拉。若 30s 未绿，弹窗显示「部署命令已完成，但 lite 尚未连回主站…」且主机行保留可重试。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/settings/AddRemoteHostDialog.tsx
git commit -m "fix(remote-agents): add-device success requires lite actually online"
```

---

## Task 7: full verification

- [ ] **Step 1: Run all remote-agents tests**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/remote-agents/tests/remote-host.db.test.ts \
  server/modules/remote-agents/tests/bootstrap.service.test.ts \
  server/modules/remote-agents/tests/remote-agents.routes.test.ts \
  server/modules/remote-agents/tests/remote-tunnels.test.ts 2>&1 | tail -30
```
Expected: all suites PASS (0 fail).

- [ ] **Step 2: Typecheck — confirm no NEW errors in touched files**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -E "remote-host\.db|bootstrap\.service|remote-agents\.routes|server/index" || echo "no errors in touched files"`
Expected: `no errors in touched files` (the repo has pre-existing baseline tsc errors in unrelated files — only flag errors referencing the files we touched).

- [ ] **Step 3: Commit any remaining changes (if the typecheck surfaced a needed fix)**

```bash
cd /mnt/b/workdir/github/lovdex
git status --short
git add -A
git commit -m "chore(remote-agents): verification fixes for complete add-device flow"
```
(Only run this step if Step 2 surfaced an error you fixed.)
