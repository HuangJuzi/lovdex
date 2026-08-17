// Env keys owned by backend app.config providers.claude — mirror of
// backend/server/modules/config/env-sync.ts OWNED_ANTHROPIC_ENV (keep in sync).
// The supervisor strips these from the shell env it injects into children so
// app.config.json is the single source of truth; a cleared config field really
// clears, and editing ~/.bashrc no longer affects the lovdex services.
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
]

export function filterOwnedAnthropicEnv(env) {
  const owned = new Set(OWNED_ANTHROPIC_ENV)
  const out = { ...env }
  for (const key of Object.keys(out)) {
    if (owned.has(key)) delete out[key]
  }
  return out
}
