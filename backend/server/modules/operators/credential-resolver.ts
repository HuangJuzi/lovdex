/**
 * Claw credential resolver.
 *
 * Resolves Appia Claw credentials at call time for execute_skill, from ONE
 * source only: the cred file ~/.claw/cred.json (JSON). Environment variables
 * are deliberately NOT read — the backend spawns many child processes and an
 * env-sourced JWT would ride along into all of them; a 0600 file keeps the
 * secret surface minimal.
 *
 * File keys (aliases accepted): jwt, agent_id, user_id (required);
 * target_rid, target_group_name (optional — enables the skill's verify-target
 * double-check; injected only when present).
 *
 * SECURITY CONTRACT:
 *  - Resolved values are returned ONLY to be injected into the skill child
 *    process env. They must never be written to the tasks table, transcripts,
 *    logs, HTTP responses, or the audit trail. This module never logs values —
 *    the only log it emits is a permission-warning for an overly-permissive
 *    cred file, which contains the path and mode but no contents.
 *  - The cred file is expected to be mode 0600; a wider mode warns (non-fatal).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ClawCredentials = {
  CLAW_JWT: string;
  APP_AGENT_ID: string;
  CLAW_USER_ID: string;
  /** Optional: enables verify-target. Injected only when configured. */
  TARGET_RID?: string;
  TARGET_GROUP_NAME?: string;
};

/** Required file-key aliases per field — mirrors what appia_claw.py accepts. */
const REQUIRED_FIELD_ALIASES = {
  CLAW_JWT: ['jwt', 'claw_jwt', 'CLAW_JWT', 'APPIA_CLAW_JWT', 'appia_claw_jwt'],
  APP_AGENT_ID: ['agent_id', 'app_agent_id', 'APP_AGENT_ID', 'AGENT_ID'],
  CLAW_USER_ID: [
    'user_id',
    'claw_user_id',
    'CLAW_USER_ID',
    'USER_ID',
    'APPIA_USER_ID',
    'creator_user_id',
    'appia_user_id',
  ],
} as const;

/** Optional file-key aliases — verify-target double-check target. */
const OPTIONAL_FIELD_ALIASES = {
  TARGET_RID: ['target_rid', 'TARGET_RID'],
  TARGET_GROUP_NAME: ['target_group_name', 'TARGET_GROUP_NAME'],
} as const;

export const DEFAULT_CRED_FILE = path.join(os.homedir(), '.claw', 'cred.json');

/**
 * Lazily computed default cred path — os.homedir() follows $HOME at call
 * time, which keeps tests (and HOME-redirected environments) honest. Prefer
 * this over the DEFAULT_CRED_FILE constant in runtime code.
 */
export function defaultCredFile(): string {
  return path.join(os.homedir(), '.claw', 'cred.json');
}

function pick(source: Record<string, unknown>, aliases: readonly string[]): string | null {
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
  /** Cred file path (defaults to ~/.claw/cred.json) — injectable for tests. */
  credFile?: string;
};

/**
 * Resolves Claw credentials from the cred file (the ONLY source). Throws a
 * readable Error (no values) when the file is missing/malformed or any
 * required field is absent.
 */
export function resolveClawCredentials(opts: ResolveCredentialsOptions = {}): ClawCredentials {
  const credFile = opts.credFile ?? defaultCredFile();
  const file = readCredFile(credFile);
  if (Object.keys(file).length > 0) warnIfPermissive(credFile);

  const out: Partial<ClawCredentials> = {};
  const missing: string[] = [];
  for (const [field, aliases] of Object.entries(REQUIRED_FIELD_ALIASES) as [
    keyof typeof REQUIRED_FIELD_ALIASES,
    readonly string[],
  ][]) {
    const value = pick(file, aliases);
    if (value) {
      out[field] = value;
    } else {
      missing.push(aliases[0]);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `credentials unavailable: ${credFile} 缺少 ${missing.join(', ')} ` +
        '（凭证只从配置文件读取，不走环境变量；可在 设置 → Operator Agent 设置 → 凭证管理 写入）',
    );
  }
  for (const [field, aliases] of Object.entries(OPTIONAL_FIELD_ALIASES) as [
    keyof typeof OPTIONAL_FIELD_ALIASES,
    readonly string[],
  ][]) {
    const value = pick(file, aliases);
    if (value) out[field] = value;
  }
  return out as ClawCredentials;
}

// ---------------------------------------------------------------------------
// Settings-API helpers (phase 2): status + write. These NEVER return or log
// credential values — only presence booleans and file metadata.
// ---------------------------------------------------------------------------

export type CredentialStatus = {
  /** 'file' when a cred file exists, else 'none' (env is never a source). */
  source: 'file' | 'none';
  /** Presence booleans only — never the values. */
  fields: {
    jwt: boolean;
    agentId: boolean;
    userId: boolean;
    targetRid: boolean;
    targetGroupName: boolean;
  };
  fileExists: boolean;
  /** Octal mode string (e.g. "600") when the file exists, else null. */
  fileMode: string | null;
  filePath: string;
};

/** Reports credential availability without exposing any value. */
export function getCredentialStatus(opts: ResolveCredentialsOptions = {}): CredentialStatus {
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

  return {
    source: fileExists ? 'file' : 'none',
    fields: {
      jwt: pick(file, REQUIRED_FIELD_ALIASES.CLAW_JWT) != null,
      agentId: pick(file, REQUIRED_FIELD_ALIASES.APP_AGENT_ID) != null,
      userId: pick(file, REQUIRED_FIELD_ALIASES.CLAW_USER_ID) != null,
      targetRid: pick(file, OPTIONAL_FIELD_ALIASES.TARGET_RID) != null,
      targetGroupName: pick(file, OPTIONAL_FIELD_ALIASES.TARGET_GROUP_NAME) != null,
    },
    fileExists,
    fileMode,
    filePath: credFile,
  };
}

/**
 * Writes the cred file from the settings UI. Creates ~/.claw with 0700 and
 * the file with 0600. Optional target fields are merged in when provided;
 * keys not mentioned in `input` keep their previous values (the UI never
 * reads values back, so a save must not silently drop the target config).
 * The written values are never logged or returned.
 */
export function writeCredFile(
  input: {
    jwt: string;
    agentId: string;
    userId: string;
    targetRid?: string;
    targetGroupName?: string;
  },
  credFile: string = defaultCredFile(),
): void {
  const jwt = input.jwt?.trim();
  const agentId = input.agentId?.trim();
  const userId = input.userId?.trim();
  if (!jwt || !agentId || !userId) {
    throw new Error('jwt / agentId / userId 均为必填');
  }
  const existing = readCredFile(credFile);
  const merged: Record<string, string> = {
    ...(existing as Record<string, string>),
    jwt,
    agent_id: agentId,
    user_id: userId,
  };
  const targetRid = input.targetRid?.trim();
  const targetGroupName = input.targetGroupName?.trim();
  if (targetRid) merged.target_rid = targetRid;
  if (targetGroupName) merged.target_group_name = targetGroupName;
  fs.mkdirSync(path.dirname(credFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credFile, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  // Enforce 0600 even when the file pre-existed with a wider mode.
  fs.chmodSync(credFile, 0o600);
}
