/**
 * Claw credential resolver.
 *
 * Resolves Appia Claw credentials (JWT / agentId / userId) at call time for
 * execute_skill. Sources, in priority order:
 *
 *   1. process env (CLAW_JWT / APP_AGENT_ID / CLAW_USER_ID and aliases)
 *   2. ~/.claw/cred.json (JSON object with the same key aliases)
 *
 * SECURITY CONTRACT:
 *  - Resolved values are returned ONLY to be injected into the skill child
 *    process env. They must never be written to the tasks table, transcripts,
 *    logs, or the audit trail. This module never logs values — the only log
 *    it emits is a permission-warning for an overly-permissive cred file,
 *    which contains the path and mode but no contents.
 *  - The cred file is expected to be mode 0600; a wider mode warns (non-fatal)
 *    because the file may be group-readable on a single-user box.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ClawCredentials = {
  CLAW_JWT: string;
  APP_AGENT_ID: string;
  CLAW_USER_ID: string;
};

/** Key aliases per field — mirrors the alias set appia_claw.py accepts. */
const FIELD_ALIASES: Record<keyof ClawCredentials, string[]> = {
  CLAW_JWT: ['CLAW_JWT', 'APPIA_CLAW_JWT', 'claw_jwt', 'jwt', 'appia_claw_jwt'],
  APP_AGENT_ID: ['APP_AGENT_ID', 'AGENT_ID', 'app_agent_id', 'agent_id'],
  CLAW_USER_ID: [
    'CLAW_USER_ID',
    'USER_ID',
    'APPIA_USER_ID',
    'claw_user_id',
    'user_id',
    'creator_user_id',
    'appia_user_id',
  ],
};

export const DEFAULT_CRED_FILE = path.join(os.homedir(), '.claw', 'cred.json');

/**
 * Lazily computed default cred path — os.homedir() follows $HOME at call
 * time, which keeps tests (and HOME-redirected environments) honest. Prefer
 * this over the DEFAULT_CRED_FILE constant in runtime code.
 */
export function defaultCredFile(): string {
  return path.join(os.homedir(), '.claw', 'cred.json');
}

function pick(source: Record<string, unknown>, aliases: string[]): string | null {
  for (const key of aliases) {
    const v = source[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function readCredFile(credFile: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(credFile, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON → treated as absent; the caller reports "missing fields".
  }
  return {};
}

function warnIfPermissive(credFile: string): void {
  try {
    const mode = fs.statSync(credFile).mode & 0o777;
    if (mode & 0o077) {
      // Path + mode only — NEVER the file contents.
      console.warn(
        `[credential-resolver] ${credFile} has permissive mode ${mode.toString(8)}; ` +
          'recommended 0600 (chmod 600).',
      );
    }
  } catch {
    // stat failure is non-fatal; the read path already handles a missing file.
  }
}

export type ResolveCredentialsOptions = {
  /** Env source (defaults to process.env) — injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Cred file path (defaults to ~/.claw/cred.json) — injectable for tests. */
  credFile?: string;
};

/**
 * Resolves Claw credentials. env wins per-field; missing fields fall back to
 * the cred file. Throws a readable Error (no values) when any required field
 * is unavailable.
 */
export function resolveClawCredentials(opts: ResolveCredentialsOptions = {}): ClawCredentials {
  const env = opts.env ?? process.env;
  const credFile = opts.credFile ?? defaultCredFile();

  const file = readCredFile(credFile);
  if (Object.keys(file).length > 0) warnIfPermissive(credFile);

  const out: Partial<ClawCredentials> = {};
  const missing: string[] = [];
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [
    keyof ClawCredentials,
    string[],
  ][]) {
    const value = pick(env, aliases) ?? pick(file, aliases);
    if (value) {
      out[field] = value;
    } else {
      missing.push(aliases[0]);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `credentials unavailable: missing ${missing.join(', ')} ` +
        `(set env vars or create ${credFile} with jwt/agent_id/user_id)`,
    );
  }
  return out as ClawCredentials;
}

// ---------------------------------------------------------------------------
// Settings-API helpers (phase 2): status + write. These NEVER return or log
// credential values — only presence booleans and file metadata.
// ---------------------------------------------------------------------------

export type CredentialStatus = {
  /** Where the effective credentials come from, per-field merge considered. */
  source: 'env' | 'file' | 'none';
  /** Presence booleans only — never the values. */
  fields: { jwt: boolean; agentId: boolean; userId: boolean };
  fileExists: boolean;
  /** Octal mode string (e.g. "600") when the file exists, else null. */
  fileMode: string | null;
  filePath: string;
};

/** Reports credential availability without exposing any value. */
export function getCredentialStatus(opts: ResolveCredentialsOptions = {}): CredentialStatus {
  const env = opts.env ?? process.env;
  const credFile = opts.credFile ?? defaultCredFile();

  const file = readCredFile(credFile);
  let fileExists = false;
  let fileMode: string | null = null;
  try {
    fileMode = (fs.statSync(credFile).mode & 0o777).toString(8);
    fileExists = true;
  } catch {
    // absent
  }

  const fromEnv = (aliases: string[]) => pick(env, aliases) != null;
  const fromFile = (aliases: string[]) => pick(file, aliases) != null;
  const present = (aliases: string[]) => fromEnv(aliases) || fromFile(aliases);

  const fields = {
    jwt: present(FIELD_ALIASES.CLAW_JWT),
    agentId: present(FIELD_ALIASES.APP_AGENT_ID),
    userId: present(FIELD_ALIASES.CLAW_USER_ID),
  };
  const anyEnv =
    fromEnv(FIELD_ALIASES.CLAW_JWT) ||
    fromEnv(FIELD_ALIASES.APP_AGENT_ID) ||
    fromEnv(FIELD_ALIASES.CLAW_USER_ID);
  const source = anyEnv ? 'env' : fileExists ? 'file' : 'none';
  return { source, fields, fileExists, fileMode, filePath: credFile };
}

/**
 * Writes the cred file from the settings UI. Creates ~/.claw with 0700 and
 * the file with 0600. The written values are never logged or returned.
 */
export function writeCredFile(
  input: { jwt: string; agentId: string; userId: string },
  credFile: string = defaultCredFile(),
): void {
  const jwt = input.jwt?.trim();
  const agentId = input.agentId?.trim();
  const userId = input.userId?.trim();
  if (!jwt || !agentId || !userId) {
    throw new Error('jwt / agentId / userId 均为必填');
  }
  fs.mkdirSync(path.dirname(credFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    credFile,
    JSON.stringify({ jwt, agent_id: agentId, user_id: userId }, null, 2) + '\n',
    { mode: 0o600 },
  );
  // Enforce 0600 even when the file pre-existed with a wider mode.
  fs.chmodSync(credFile, 0o600);
}
