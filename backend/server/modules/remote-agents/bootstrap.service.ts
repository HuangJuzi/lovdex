import { createHash, randomUUID } from 'node:crypto';

/**
 * Bootstrap service: provision a remote machine to run the remote-lite agent.
 *
 * The real ssh/scp are injected through the `SshRunner` + `FilePush` seams so
 * this module is unit-testable without a network. The E2E (Task 15) exercises
 * the real transport. All remote commands are issued as argv arrays — never a
 * single shell string built from user input — so caller-provided values cannot
 * inject shell metacharacters into the ssh invocation itself.
 */

export type SshRunner = (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
export type FilePush = (localPath: string, remotePath: string) => Promise<{ ok: boolean; error?: string }>;

export type BootstrapInput = {
  host: string;
  port?: number;
  sshUser: string;
  identityFile?: string | null; // -i path (Lovdex ed25519 or existing key)
  token: string; // long-lived lite auth token
  serverUrl: string; // main server ws URL, e.g. ws://host:port/api/remote-agents/ws
  roots: string[];
  /**
   * Stable identifier for this remote host. When provided it is written
   * verbatim into config.json and echoed back in the result so the caller can
   * persist it against the `remote_hosts` row bound to the token — the lite's
   * hello hostId must match that row (main closes the lite with 4002 'host id
   * mismatch' otherwise), so Task 12 passes `host.host_id` here. When absent a
   * fresh randomUUID is used for first-time provisioning.
   */
  hostId?: string;
  apiKey?: string | null; // claude API key to provision (optional)
  /**
   * Path to the built lite bundle. Contract: a **tarball** (pushed to
   * `~/.lovdex-remote/lite.tgz`, install.sh runs `tar -zxf` into the remote
   * dir) OR an artifact that already expands to `dist/lite.mjs` +
   * `package.json` on the remote. install.sh runs `npm ci --omit=dev`
   * whenever a package.json is present after extraction.
   */
  litePackagePath?: string;
};

export type BootstrapResult = {
  status: 'online' | 'partial' | 'error';
  message?: string;
  tokenHash?: string;
  /** The hostId used for this run (caller-supplied or freshly generated). */
  hostId?: string;
};

const REMOTE_DIR = '~/.lovdex-remote';
const CONFIG_PATH = `${REMOTE_DIR}/config.json`;
const ENV_PATH = `${REMOTE_DIR}/.env`;
const REMOTE_INSTALL_PATH = `${REMOTE_DIR}/install.sh`;
const REMOTE_UNIT_PATH = `${REMOTE_DIR}/lovdex-agent.service`;
const REMOTE_LITE_TARBALL = `${REMOTE_DIR}/lite.tgz`;

/** Default deploy artifacts, relative to the backend working directory. */
const DEFAULT_INSTALL_SCRIPT = 'remote-agent/deploy/install.sh';
const DEFAULT_UNIT_TEMPLATE = 'remote-agent/deploy/systemd-unit.template';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Build the ssh argv for a remote command. `rest` is the remote command,
 * passed as separate argv tokens (ssh joins them into the remote shell line).
 * `BatchMode=yes` guarantees no interactive password prompt hangs the caller's
 * request handler; `ConnectTimeout` bounds the failure latency.
 */
export function sshArgs(
  remote: string,
  identityFile: string | null | undefined,
  port: number | undefined,
  rest: string[],
): string[] {
  const argv = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'BatchMode=yes',
  ];
  if (identityFile) argv.push('-i', identityFile);
  if (port && port !== 22) argv.push('-p', String(port));
  argv.push(remote, ...rest);
  return argv;
}

/**
 * Write a file on the remote using a quoted heredoc. The heredoc delimiter is
 * single-quoted so the shell performs no expansion on the body — the content
 * is emitted verbatim. `content` is embedded literally; callers pass already
 * JSON-stringified / sanitized payloads. A token or path containing the exact
 * heredoc delimiter or a newline is out of scope (documented contract).
 */
function writeRemoteFileArgs(
  remote: string,
  identityFile: string | null | undefined,
  port: number | undefined,
  remotePath: string,
  content: string,
  mode: string,
): string[] {
  const script =
    `cat > ${remotePath} <<'LOVDEX_EOF'\n` + `${content}\n` + `LOVDEX_EOF\n` + `chmod ${mode} ${remotePath}`;
  return sshArgs(remote, identityFile, port, [script]);
}

export async function runBootstrap(
  input: BootstrapInput,
  deps: { runner?: SshRunner; push?: FilePush; installScriptPath?: string; unitTemplatePath?: string },
): Promise<BootstrapResult> {
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

  // 1. probe: uname (fail early if unreachable / not a POSIX host).
  const uname = await run(['uname', '-a']);
  if (!uname.ok) {
    return { status: 'error', message: `remote unreachable: ${uname.stderr.trim() || 'uname failed'}`, hostId };
  }

  // 2. probe: node.
  const node = await run(['node', '-v']);
  if (!node.ok) {
    return {
      status: 'error',
      message: 'node not found on remote — install node >=20 first (see deploy/install.sh)',
      hostId,
    };
  }

  // 3. probe: claude CLI. Note this probe runs inside an ssh login shell where
  //    nvm / npm globals are on PATH; the systemd --user unit later runs with a
  //    minimal PATH, so install.sh resolves absolute binaries and substitutes
  //    them into the unit (deploy/install.sh + systemd-unit.template).
  const claude = await run(['claude', '-v']);
  if (!claude.ok) {
    return {
      status: 'error',
      message: 'claude not installed — run: npm i -g @anthropic-ai/claude-code',
      hostId,
    };
  }

  // 4. create the remote dir.
  const mk = await run(['mkdir', '-p', REMOTE_DIR]);
  if (!mk.ok) {
    return { status: 'error', message: `mkdir failed: ${mk.stderr.trim() || 'unknown'}`, hostId };
  }

  // 5. write config.json (0600). JSON.stringify sanitizes the caller-provided
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

  // 6. write the env file (0600) with the API key, if provided.
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

  // 7. push install.sh + systemd unit + lite package, then run install.sh.
  const push = deps.push;
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

  // 8. run install.sh (deps/tarball + systemd unit install + enable --now).
  const install = await run(['bash', REMOTE_INSTALL_PATH]);
  if (!install.ok) {
    return { status: 'error', message: `install failed: ${install.stderr.trim() || 'unknown'}`, hostId };
  }

  return { status: 'online', tokenHash: sha256(input.token), hostId, message: 'deployed' };
}

// Re-exported so callers persisting the token hash can reuse the same digest.
export { sha256 as tokenHash };