/**
 * Syncs provider credentials from app.config back into process.env.
 *
 * SDK subprocesses (claude/codex/opencode/qoder CLIs) receive credentials by
 * inheriting process.env (`sdkOptions.env = { ...process.env }`). Config is the
 * SINGLE source of truth for the claude provider's runtime knobs, so the
 * claude section below makes process.env match app.config authoritatively:
 * non-empty values are (trimmed and) written, empty values DELETE their env
 * var — a cleared field really turns the knob off, overriding hostenv (e.g.
 * .bashrc injected by the supervisor). providers.claude.apiKey is the
 * exception (legacy non-empty-only) so an empty field never clobbers an
 * ANTHROPIC_API_KEY another provider shares via opencode.apiKeys. Everything
 * else (codex/opencode/qoder) keeps the legacy non-empty-only semantics.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

import type { LLMProvider } from '@/shared/types.js';
import type { AppConfig } from './config.js';

/** Every env var owned by `providers.claude` config. The supervisor filters
 * exactly this set out of the shell env it injects so config stays the sole
 * source — keep in sync with supervisor/env-filter.mjs. */
export const OWNED_ANTHROPIC_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CLI_PATH',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
] as const;

export function syncProviderEnv(cfg: AppConfig): void {
  const { providers } = cfg;

  // opencode — a per-env credential map that can reference keys shared with
  // other providers (e.g. ANTHROPIC_API_KEY). Process it FIRST so the
  // dedicated per-provider fields below (qoder.PAT, ...) always take
  // precedence on a key collision. Values are trimmed so whitespace-only
  // entries don't become junk env keys the auth logic (which trims) won't
  // believe in. (Legacy: non-empty only, never deletes.)
  for (const [key, value] of Object.entries(providers.opencode.apiKeys)) {
    if (value?.trim()) process.env[key] = value.trim();
  }

  // claude — authoritative: process.env matches config exactly.
  const c = providers.claude;
  setOrDelete('ANTHROPIC_BASE_URL', c.baseUrl);
  // "API Key" (config apiKey) is the single UI credential: write the same value
  // to both the API-key and auth-token slots so the CLI/proxy works whichever
  // one it reads. Empty clears both (config is the only source). Note: this
  // drops the old opencode.apiKeys sharing protection — an empty claude.apiKey
  // now deletes ANTHROPIC_API_KEY even if opencode.apiKeys also wrote it.
  setOrDelete('ANTHROPIC_API_KEY', c.apiKey);
  setOrDelete('ANTHROPIC_AUTH_TOKEN', c.apiKey);
  // Legacy backend-only authToken (no settings-page field) overrides AUTH_TOKEN
  // when explicitly set — it wins over apiKey's AUTH_TOKEN write.
  if (c.authToken?.trim()) process.env.ANTHROPIC_AUTH_TOKEN = c.authToken.trim();
  setOrDelete('ANTHROPIC_MODEL', c.defaultModel);
  // Alias aliases write BOTH the MODEL and MODEL_NAME mirrors (the CLI reads
  // the _NAME variant on new versions and the plain one on old; both must
  // point at the same real model id).
  setOrDelete('ANTHROPIC_DEFAULT_HAIKU_MODEL', c.haikuModel);
  setOrDelete('ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', c.haikuModel);
  setOrDelete('ANTHROPIC_DEFAULT_OPUS_MODEL', c.opusModel);
  setOrDelete('ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', c.opusModel);
  setOrDelete('ANTHROPIC_DEFAULT_SONNET_MODEL', c.sonnetModel);
  setOrDelete('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', c.sonnetModel);
  // cliPath: the default 'claude' means "resolve from PATH" — never leave an
  // env override pointing at a stale path.
  setOrDelete('CLAUDE_CLI_PATH', c.cliPath && c.cliPath.trim() !== 'claude' ? c.cliPath : '');

  // qoder (legacy, non-empty only)
  if (providers.qoder.personalAccessToken?.trim()) {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = providers.qoder.personalAccessToken.trim();
  }
  // binaries (legacy, non-empty only)
  if (providers.codex.binPath?.trim() && providers.codex.binPath.trim() !== 'codex') {
    process.env.CODEX_PATH_OVERRIDE = providers.codex.binPath.trim();
  }
  if (providers.opencode.binPath?.trim() && providers.opencode.binPath.trim() !== 'opencode') {
    process.env.OPENCODE_BIN = providers.opencode.binPath.trim();
  }
}

/** Writes a trimmed value, or deletes the env var when the value is empty. */
function setOrDelete(key: string, value: string | undefined): void {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v) process.env[key] = v;
  else delete process.env[key];
}

/**
 * Builds the per-provider config env a REMOTE lite host should run a session
 * with. Same source fields as {@link syncProviderEnv} (so main and remote
 * agree), but returns a `Record` for the `session/start` `configEnv` param
 * instead of writing `process.env` (the lite overlays it onto its own child
 * process env, never the daemon's). Only explicitly-configured values are
 * included; empty/unset fields are hidden so the lite's own environment is
 * left alone.
 */
export function buildProviderConfigEnv(cfg: AppConfig, provider: LLMProvider): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v) out[key] = v;
  };
  const { providers } = cfg;
  switch (provider) {
    case 'claude': {
      const c = providers.claude;
      put('ANTHROPIC_BASE_URL', c.baseUrl);
      put('ANTHROPIC_API_KEY', c.apiKey);
      put('ANTHROPIC_AUTH_TOKEN', c.apiKey || c.authToken);
      put('ANTHROPIC_MODEL', c.defaultModel);
      put('ANTHROPIC_DEFAULT_HAIKU_MODEL', c.haikuModel);
      put('ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', c.haikuModel);
      put('ANTHROPIC_DEFAULT_OPUS_MODEL', c.opusModel);
      put('ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', c.opusModel);
      put('ANTHROPIC_DEFAULT_SONNET_MODEL', c.sonnetModel);
      put('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', c.sonnetModel);
      put('CLAUDE_CLI_PATH', c.cliPath && c.cliPath.trim() !== 'claude' ? c.cliPath : undefined);
      break;
    }
    case 'codex': {
      put('CODEX_PATH_OVERRIDE', providers.codex.binPath && providers.codex.binPath.trim() !== 'codex' ? providers.codex.binPath : undefined);
      // Reuse the local codex auth.json OPENAI_API_KEY when present, so a
      // remote host can authenticate without its own codex login.
      const home = process.env.HOME ?? os.homedir();
      const authPath = `${home}/.codex/auth.json`;
      if (existsSync(authPath)) {
        try {
          const auth = JSON.parse(readFileSync(authPath, 'utf8')) as { OPENAI_API_KEY?: unknown };
          if (typeof auth.OPENAI_API_KEY === 'string') put('OPENAI_API_KEY', auth.OPENAI_API_KEY);
        } catch {
          /* unreadable/unparseable auth file — remote handles its own auth */
        }
      }
      break;
    }
    case 'opencode': {
      put('OPENCODE_BIN', providers.opencode.binPath && providers.opencode.binPath.trim() !== 'opencode' ? providers.opencode.binPath : undefined);
      for (const [key, value] of Object.entries(providers.opencode.apiKeys)) put(key, value);
      break;
    }
    case 'qoder': {
      put('QODER_PERSONAL_ACCESS_TOKEN', providers.qoder.personalAccessToken);
      break;
    }
  }
  return out;
}
