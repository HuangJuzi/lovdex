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
      if (!cfg.auth.jwtSecret) cfg.auth.jwtSecret = jwtSecret;
      return cfg;
    } catch {
      // Missing or malformed → generate defaults and persist (idempotent).
      const cfg = structuredClone(DEFAULT_APP_CONFIG) as AppConfig;
      cfg.auth.jwtSecret = jwtSecret;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      return cfg;
    }
  }

  function persist(cfg: AppConfig): void {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  let current = load();

  return {
    get: () => current,
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