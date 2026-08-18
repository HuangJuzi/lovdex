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
  apiKey?: string | null; // claude API key to provision (optional)
  litePackagePath?: string; // path to the built lite bundle (optional for now)
};

export type BootstrapResult = { status: 'online' | 'error'; message?: string; tokenHash?: string };

const REMOTE_DIR = '~/.lovdex-remote';
const CONFIG_PATH = `${REMOTE_DIR}/config.json`;
const ENV_PATH = `${REMOTE_DIR}/.env`;
const REMOTE_INSTALL_PATH = `${REMOTE_DIR}/install.sh`;
const REMOTE_UNIT_PATH = `${REMOTE_DIR}/lovdex-agent.service`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Build the ssh argv for a remote command. `rest` is the remote command,
 * passed as separate argv tokens (ssh joins them into the remote shell line).
 */
export function sshArgs(
  remote: string,
  identityFile: string | null | undefined,
  port: number | undefined,
  rest: string[],
): string[] {
  const argv: string[] = ['-o', 'StrictHostKeyChecking=accept-new'];
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
  deps: { runner?: SshRunner; push?: FilePush; installScriptPath?: string },
): Promise<BootstrapResult> {
  const runner = deps.runner;
  if (!runner) {
    return { status: 'error', message: 'no ssh runner provided' };
  }
  const remote = `${input.sshUser}@${input.host}`;
  const id = input.identityFile ?? null;
  const port = input.port;

  const run = (rest: string[]) => runner(sshArgs(remote, id, port, rest));

  // 1. probe: uname (fail early if unreachable / not a POSIX host).
  const uname = await run(['uname', '-a']);
  if (!uname.ok) {
    return { status: 'error', message: `remote unreachable: ${uname.stderr.trim() || 'uname failed'}` };
  }

  // 2. probe: node.
  const node = await run(['node', '-v']);
  if (!node.ok) {
    return {
      status: 'error',
      message: 'node not found on remote — install node >=20 first (see deploy/install.sh)',
    };
  }

  // 3. probe: claude CLI.
  const claude = await run(['claude', '-v']);
  if (!claude.ok) {
    return {
      status: 'error',
      message: 'claude not installed — run: npm i -g @anthropic-ai/claude-code',
    };
  }

  // 4. create the remote dir.
  const mk = await run(['mkdir', '-p', REMOTE_DIR]);
  if (!mk.ok) {
    return { status: 'error', message: `mkdir failed: ${mk.stderr.trim() || 'unknown'}` };
  }

  const hostId = randomUUID();

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
    return { status: 'error', message: `config write failed: ${cfg.stderr.trim() || 'unknown'}` };
  }

  // 6. write the env file (0600) with the API key, if provided.
  if (input.apiKey) {
    const envBody = `ANTHROPIC_API_KEY=${input.apiKey}`;
    const env = await runner(writeRemoteFileArgs(remote, id, port, ENV_PATH, envBody, '600'));
    if (!env.ok) {
      return { status: 'error', message: `env write failed: ${env.stderr.trim() || 'unknown'}` };
    }
  }

  // 7. push install.sh + systemd unit, then run install.sh. When no FilePush
  //    seam is wired (unit tests), the systemd install is deferred.
  const push = deps.push;
  if (!push) {
    return { status: 'online', tokenHash: sha256(input.token), message: 'deployed (systemd install deferred: no file push)' };
  }

  const installScriptPath = deps.installScriptPath;
  if (installScriptPath) {
    const pushed = await push(installScriptPath, REMOTE_INSTALL_PATH);
    if (!pushed.ok) {
      return { status: 'error', message: `install script upload failed: ${pushed.error ?? 'unknown'}` };
    }
  }

  if (input.litePackagePath) {
    const pushedPkg = await push(input.litePackagePath, `${REMOTE_DIR}/lite-package`);
    if (!pushedPkg.ok) {
      return { status: 'error', message: `lite package upload failed: ${pushedPkg.error ?? 'unknown'}` };
    }
  }

  // 8. run install.sh (npm ci + systemd unit install + enable --now).
  const install = await run(['bash', REMOTE_INSTALL_PATH]);
  if (!install.ok) {
    return { status: 'error', message: `install failed: ${install.stderr.trim() || 'unknown'}` };
  }

  return { status: 'online', tokenHash: sha256(input.token), message: 'deployed' };
}

// Re-exported so callers persisting the token hash can reuse the same digest.
export { sha256 as tokenHash };
export { REMOTE_UNIT_PATH };
