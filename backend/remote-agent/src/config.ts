import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Runtime configuration for the remote-lite agent.
 *
 * - `serverUrl`: the main server WebSocket endpoint (a `token` search param is
 *   appended at connect time).
 * - `token`: shared secret used to authenticate the connection.
 * - `hostId`: stable identifier for this remote host.
 * - `roots`: host directories the lite agent is allowed to operate on. REQUIRED
 *   (no `['/']` default): a whitelist that silently defaults to the full
 *   filesystem is a footgun, so the operator must state it explicitly.
 * - `apiKeyEnvPath` / `claudeCliPath`: optional paths consumed by the agent
 *   loop (Task 9).
 */
const configSchema = z.object({
  serverUrl: z.string().min(2),
  token: z.string().min(8),
  hostId: z.string().min(1),
  roots: z.array(z.string()).min(1),
  /**
   * Directories the `skills/*` RPCs may touch, SEPARATE from `roots`.
   *
   * `roots` is the project-directory whitelist for the general `fs/*` surface;
   * adding `~` there would hand the main server read/write over the whole home
   * directory. Skill sync only needs the skill roots, so it gets its own list.
   *
   * Defaults to this host's `~/.claude/skills` — and because it is a zod
   * default (not a required field), a lite deployed before this option existed
   * picks it up on the next parse without a re-deploy.
   */
  skillRoots: z.array(z.string()).min(1).default(() => [path.join(homedir(), '.claude/skills')]),
  agentVersion: z.string().default('0.1.0'),
  apiKeyEnvPath: z.string().optional(),
  claudeCliPath: z.string().optional(),
});

export type RemoteAgentConfig = z.infer<typeof configSchema>;

/** Parse + validate an already-loaded config object. Pure; unit-tested. */
export function loadConfig(raw: unknown): RemoteAgentConfig {
  return configSchema.parse(raw);
}

/**
 * Read a JSON config file from disk and parse it.
 *
 * Resolution order: explicit `filePath` → `LOVDEX_REMOTE_CONFIG` env →
 * default `~/.lovdex-remote/config.json` (via `HOME`).
 */
export function loadConfigFile(filePath?: string): RemoteAgentConfig {
  const resolved =
    filePath ??
    process.env.LOVDEX_REMOTE_CONFIG ??
    `${process.env.HOME ?? '/root'}/.lovdex-remote/config.json`;
  return loadConfig(JSON.parse(readFileSync(resolved, 'utf8')));
}

/**
 * Every directory the `skills/*` RPCs may touch: the project roots plus the
 * dedicated skill roots.
 *
 * Defensive about `skillRoots` being absent: `loadConfig` always fills it, but
 * tests and older call sites construct config literals directly. An absent
 * list degrades to "skill roots are just the project roots" rather than
 * throwing.
 */
export function skillRootsOf(cfg: RemoteAgentConfig): string[] {
  return [...cfg.roots, ...(cfg.skillRoots ?? [])];
}
