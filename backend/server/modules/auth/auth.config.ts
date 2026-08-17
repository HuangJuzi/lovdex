/**
 * Auth gate configuration. The login credentials (email / verification code /
 * JWT signing key) live in `auth.config.json` — a plain config file, NOT in
 * environment variables. Edit that file to change who can log in.
 *
 * AUTH_ENABLED stays an env switch: setting AUTH_ENABLED=false reverts to the
 * open no-login mode (safety valve). Platform mode is exempt.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { IS_PLATFORM } from '@/constants/config.js';

type AuthCredentials = {
  email: string;
  code: string;
  jwtSecret: string;
};

const CONFIG_PATH = fileURLToPath(new URL('./auth.config.json', import.meta.url));

const DEFAULT_CREDENTIALS: AuthCredentials = {
  email: 'zhiju.huang@sophgo.com',
  code: '888888',
  jwtSecret: 'lovdex@2026',
};

/**
 * Loads the credentials from the JSON config file. Falls back to the defaults
 * if the file is missing or malformed so the app never fails to boot or locks
 * itself out — but the misconfiguration is logged loudly.
 */
function loadCredentials(): AuthCredentials {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AuthCredentials>;
    return {
      email:
        typeof parsed.email === 'string' && parsed.email ? parsed.email : DEFAULT_CREDENTIALS.email,
      code: typeof parsed.code === 'string' && parsed.code ? parsed.code : DEFAULT_CREDENTIALS.code,
      jwtSecret:
        typeof parsed.jwtSecret === 'string' && parsed.jwtSecret
          ? parsed.jwtSecret
          : DEFAULT_CREDENTIALS.jwtSecret,
    };
  } catch (err) {
    console.warn(
      `[auth] Could not read ${CONFIG_PATH}; using default credentials:`,
      err instanceof Error ? err.message : String(err)
    );
    return DEFAULT_CREDENTIALS;
  }
}

const credentials = loadCredentials();

export const authConfig = {
  /** Allowed login email. */
  email: credentials.email,
  /** Fixed verification code / password. */
  code: credentials.code,
  /** HS256 signing key. */
  jwtSecret: credentials.jwtSecret,
  /** Token lifetime: 7 days. */
  expiresInSeconds: 7 * 24 * 60 * 60,
  /** When a token has this much (or less) life left, re-issue on the next request. */
  refreshWindowSeconds: 24 * 60 * 60,
};

/**
 * Whether HTTP/WS auth enforcement is active. Reads env at call time so the
 * AUTH_ENABLED switch takes effect per-request (testable). Platform mode keeps
 * its own auth flow and is exempt.
 */
export const isAuthEnabled = (): boolean =>
  !IS_PLATFORM && process.env.AUTH_ENABLED !== 'false';

export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 64;

/**
 * Persists a new verification code to the config file (atomic tmp + rename) and
 * hot-updates the in-memory value so the change applies immediately. Returns
 * false (and leaves memory untouched) if the write fails. `configPath` is a
 * test seam — production always targets the real CONFIG_PATH.
 */
export function updateAuthCode(newCode: string, configPath: string = CONFIG_PATH): boolean {
  let existing: AuthCredentials;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AuthCredentials>;
    existing = {
      email: typeof parsed.email === 'string' && parsed.email ? parsed.email : authConfig.email,
      code: typeof parsed.code === 'string' && parsed.code ? parsed.code : authConfig.code,
      jwtSecret:
        typeof parsed.jwtSecret === 'string' && parsed.jwtSecret
          ? parsed.jwtSecret
          : authConfig.jwtSecret,
    };
  } catch {
    existing = { email: authConfig.email, code: authConfig.code, jwtSecret: authConfig.jwtSecret };
  }
  const next = { ...existing, code: newCode };
  const tmpPath = `${configPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    console.warn(
      `[auth] Failed to persist new code to ${configPath}:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
  authConfig.code = newCode;
  console.log(`[auth] Verification code updated (persisted to ${configPath})`);
  return true;
}
