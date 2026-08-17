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
  // take precedence on a key collision. Values are trimmed so whitespace-only
  // entries don't become junk env keys the auth logic (which trims) won't
  // believe in.
  for (const [key, value] of Object.entries(providers.opencode.apiKeys)) {
    if (value?.trim()) process.env[key] = value.trim();
  }

  // claude
  if (providers.claude.apiKey?.trim()) process.env.ANTHROPIC_API_KEY = providers.claude.apiKey.trim();
  if (providers.claude.authToken?.trim()) process.env.ANTHROPIC_AUTH_TOKEN = providers.claude.authToken.trim();
  if (providers.claude.cliPath?.trim() && providers.claude.cliPath.trim() !== 'claude') {
    process.env.CLAUDE_CLI_PATH = providers.claude.cliPath.trim();
  }
  // qoder
  if (providers.qoder.personalAccessToken?.trim()) {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = providers.qoder.personalAccessToken.trim();
  }
  // binaries
  if (providers.codex.binPath?.trim() && providers.codex.binPath.trim() !== 'codex') {
    process.env.CODEX_PATH_OVERRIDE = providers.codex.binPath.trim();
  }
  if (providers.opencode.binPath?.trim() && providers.opencode.binPath.trim() !== 'opencode') {
    process.env.OPENCODE_BIN = providers.opencode.binPath.trim();
  }
}