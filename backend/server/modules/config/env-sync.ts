/**
 * Syncs provider credentials from app.config back into process.env.
 *
 * SDK subprocesses (claude/codex/opencode/qoder CLIs) receive credentials by
 * inheriting process.env (`sdkOptions.env = { ...process.env }`). Once the
 * source of truth moved to app.config.json we must re-surface non-empty values
 * on process.env at boot so child processes keep working unchanged. Empty
 * values are never written, so pre-existing hostenv (e.g. ANTHROPIC_AUTH_TOKEN
 * injected by systemd) stays authoritative when config leaves it blank.
 */
import type { AppConfig } from './config.js';

export function syncProviderEnv(cfg: AppConfig): void {
  const { providers } = cfg;

  // opencode — a per-env credential map that can reference keys shared with
  // other providers (e.g. ANTHROPIC_API_KEY). Process it FIRST so the
  // dedicated per-provider fields below (claude.apiKey, qoder.PAT, ...) always
  // take precedence on a key collision.
  for (const [key, value] of Object.entries(providers.opencode.apiKeys)) {
    if (value) process.env[key] = value;
  }

  // claude
  if (providers.claude.apiKey) process.env.ANTHROPIC_API_KEY = providers.claude.apiKey;
  if (providers.claude.authToken) process.env.ANTHROPIC_AUTH_TOKEN = providers.claude.authToken;
  if (providers.claude.cliPath && providers.claude.cliPath !== 'claude') {
    process.env.CLAUDE_CLI_PATH = providers.claude.cliPath;
  }
  // qoder
  if (providers.qoder.personalAccessToken) {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = providers.qoder.personalAccessToken;
  }
  // binaries
  if (providers.codex.binPath && providers.codex.binPath !== 'codex') {
    process.env.CODEX_PATH_OVERRIDE = providers.codex.binPath;
  }
  if (providers.opencode.binPath && providers.opencode.binPath !== 'opencode') {
    process.env.OPENCODE_BIN = providers.opencode.binPath;
  }
}