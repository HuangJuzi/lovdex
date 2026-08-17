/**
 * Central app configuration.
 *
 * Single source of truth for all backend runtime settings and provider
 * credentials. Lives at <DATA_DIR>/app.config.json (default ~/.lovdex/data),
 * auto-generated on first load with deep-merged defaults. Writes are atomic
 * (tmp + rename) so a crash can never corrupt the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_APP_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 3188,
    corsOrigin: '*',
    contextWindow: null as number | null,
    isPlatform: false,
    workflowsEnabled: true,
    ultracodeKeywordTrigger: '',
  },
  database: { path: path.join(os.homedir(), '.sophcode', 'auth.db') },
  workspaces: { root: '~', mainWorkspace: '' },
  auth: { enabled: true, email: null as string | null, code: null as string | null, jwtSecret: '' },
  providers: {
    claude: {
      cliPath: 'claude',
      apiKey: '',
      authToken: '',
      baseUrl: '',
      defaultModel: '',
      haikuModel: '',
      opusModel: '',
      sonnetModel: '',
      oneMillionModels: '',
      streamCloseTimeoutMs: 10000,
      toolApprovalTimeoutMs: 60000,
    },
    codex: { binPath: 'codex' },
    opencode: { binPath: 'opencode', apiKeys: {} as Record<string, string> },
    qoder: { personalAccessToken: '', toolApprovalTimeoutMs: 60000 },
  },
  operator: {
    enabled: true,
    autoVerdictEnabled: true,
    model: '',
    workspace: '',
    maxConcurrent: 2,
  },
  runtime: { fsConcurrency: 64 },
};

export type AppConfig = typeof DEFAULT_APP_CONFIG;

/** Keys whose values are secrets; masked when serialized for the API. */
const SENSITIVE_KEYS = new Set([
  'apiKey', 'authToken', 'personalAccessToken', 'jwtSecret', 'code',
]);
/**
 * Keys masked with a zero-hint marker (no tail) because they're user-guessable
 * (login code / JWT secret) and the config is served anonymously — revealing
 * the last 4 chars of a 6-digit code leaves only ~100 brute-force combos.
 */
const ZERO_HINT_KEYS = new Set(['code', 'jwtSecret']);

/**
 * Keys whose object VALUES are all secrets (e.g. `providers.opencode.apiKeys`,
 * a `Record<envVarName, key>`). Containers are masked wholesale so inner keys
 * like `ANTHROPIC_API_KEY` don't need to match SENSITIVE_KEYS.
 */
const SENSITIVE_CONTAINER_KEYS = new Set(['apiKeys']);

function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      const b = (base as Record<string, unknown>)[k];
      out[k] = deepMerge(b, v);
    }
    return out as T;
  }
  return (override ?? base) as T;
}

export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/** Recursively replaces sensitive leaf values with a masked marker. */
export function maskConfig(value: unknown, key?: string): unknown {
  // Container keys (e.g. `apiKeys`) hold secrets under arbitrary inner key
  // names, so mask every value immediately instead of recursing into them.
  if (key && SENSITIVE_CONTAINER_KEYS.has(key) && typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecret(v);
    return out;
  }
  // Zero-hint keys never reveal a tail: the login code / JWT secret is
  // user-guessable and this config is served to anonymous clients. Empty
  // values still serialize as '' rather than the mask.
  if (key && ZERO_HINT_KEYS.has(key)) {
    return typeof value === 'string' && value.length > 0 ? '••••' : '';
  }
  if (Array.isArray(value)) return value.map((v) => maskConfig(v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskConfig(v, k);
    }
    return out;
  }
  if (key && SENSITIVE_KEYS.has(key)) return maskSecret(value);
  return value;
}

export type AppConfigApi = {
  /** Returns the full merged config (runtime use). */
  get(): AppConfig;
  /** Returns a masked copy for the HTTP API. */
  getMasked(): AppConfig;
  /** Deep-merges a partial update and atomically persists. */
  update(partial: unknown): AppConfig;
  /** The config file path. */
  filePath: string;
};

export function createAppConfig(options?: {
  dataDir?: string;
  filePath?: string;
}): AppConfigApi {
  // Overridable data dir enables isolated E2E/data-dir tests while defaulting
  // to the stable user-level location (~/.lovdex/data).
  const dir = options?.dataDir ?? process.env.LOVDEX_DATA_DIR ?? path.join(os.homedir(), '.lovdex', 'data');
  const filePath = options?.filePath ?? path.join(dir, 'app.config.json');
  const jwtSecret = crypto.randomBytes(48).toString('hex');

  function load(): AppConfig {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const cfg = deepMerge(structuredClone(DEFAULT_APP_CONFIG), parsed) as AppConfig;
      if (!cfg.auth.jwtSecret) {
        // Persisted file has no JWT secret — inject a stable random one and
        // write it back now, so restarts don't rotate the key and invalidate
        // existing logins.
        cfg.auth.jwtSecret = jwtSecret;
        persist(cfg); // hoisted function declaration — safe to call from here
      }
      return cfg;
    } catch (err) {
      // ENOENT → first boot: generate defaults and persist (idempotent).
      // Anything else (corrupt JSON, EACCES, ...) → rotate the damaged file to
      // `<filePath>.corrupt` so stored credentials stay recoverable, then
      // regenerate defaults.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        if (fs.existsSync(filePath)) {
          try {
            fs.renameSync(filePath, `${filePath}.corrupt`);
          } catch {
            // Best-effort rotation; never mask the original error.
          }
        }
        console.error(
          `app.config: failed to load ${filePath} (${code ?? 'unknown'}); rotated to .corrupt`, err);
      }
      const cfg = structuredClone(DEFAULT_APP_CONFIG) as AppConfig;
      cfg.auth.jwtSecret = jwtSecret;
      persist(cfg);
      return cfg;
    }
  }

  function persist(cfg: AppConfig): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  let current = load();

  return {
    get: () => structuredClone(current),
    getMasked: () => maskConfig(current) as AppConfig,
    update(partial: unknown): AppConfig {
      const next = deepMerge(structuredClone(current), partial) as AppConfig;
      if (!next.auth.jwtSecret) next.auth.jwtSecret = current.auth.jwtSecret;
      persist(next);
      current = next;
      return current;
    },
    filePath,
  };
}

/** Process-wide singleton (call once at server boot). */
let singleton: AppConfigApi | null = null;
export function appConfig(): AppConfigApi {
  if (!singleton) singleton = createAppConfig();
  return singleton;
}
