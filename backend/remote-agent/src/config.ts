import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Runtime configuration for the remote-lite agent.
 *
 * - `serverUrl`: the main server WebSocket endpoint (a `token` search param is
 *   appended at connect time).
 * - `token`: shared secret used to authenticate the connection.
 * - `hostId`: stable identifier for this remote host.
 * - `roots`: host directories the lite agent is allowed to operate on.
 * - `apiKeyEnvPath` / `claudeCliPath`: optional paths consumed by the agent
 *   loop (Task 9).
 */
const configSchema = z.object({
  serverUrl: z.string().min(2),
  token: z.string().min(8),
  hostId: z.string().min(1),
  roots: z.array(z.string()).min(1).default(['/']),
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
