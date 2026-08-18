/**
 * Operator skill/workbench allowlist.
 *
 * Single source of truth for what the operator's in-place execution tools
 * (execute_skill / workbench) are permitted to touch. Resolution priority:
 *
 *   1. env LOVDEX_OPERATOR_ALLOWLIST_JSON  (inline JSON string)
 *   2. env LOVDEX_OPERATOR_ALLOWLIST_PATH  (path to a JSON file)
 *   3. persisted DB override (app_config key `operator_skill_allowlist`,
 *      written by PUT /api/operator/skill-exec/allowlist)
 *   4. config file server/config/operator-skill-allowlist.json
 *   5. built-in defaults below
 *
 * `workbench_write_prefixes` entries may use `~` (expanded at load) and are
 * realpath-normalized so symlink tricks cannot smuggle a write outside the
 * allowed roots. Anything not listed is denied — the tools fail loudly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appConfigDb } from '@/modules/database/repositories/app-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type SkillAllowlistEntry = {
  /** Skill directory name under ~/.claude/skills (no separators, no '..'). */
  name: string;
  /** Entry script relative to the skill root, e.g. "scripts/appia_claw.py". */
  entry: string;
  /** Runner executable. "uv" runs `uv run <entry> ...`; anything else runs `<runner> <entry> ...`. */
  runner: string;
  /** Subcommands the operator may invoke (first non-flag argv token). */
  allowed_subcommands: string[];
  /** Informational: subcommands that are read-only (phase-2 approval tiers). */
  readonly_subcommands?: string[];
};

export type OperatorAllowlist = {
  enabled_skills: SkillAllowlistEntry[];
  workbench_write_prefixes: string[];
};

export const DEFAULT_OPERATOR_ALLOWLIST: OperatorAllowlist = {
  enabled_skills: [
    {
      name: 'claw-agent-get-send',
      entry: 'scripts/appia_claw.py',
      runner: 'uv',
      allowed_subcommands: ['groups', 'verify-target', 'send', 'send-md', 'send-file'],
      readonly_subcommands: ['groups', 'verify-target'],
    },
  ],
  workbench_write_prefixes: [
    path.join(os.homedir(), '.lovdex', 'operator-workspace'),
    path.join(os.homedir(), '.claude', 'skills'),
  ],
};

const CONFIG_FILE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'config',
  'operator-skill-allowlist.json',
);

/** Skill names are plain directory names — no separators, no traversal. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Realpath when the path exists, else lexical resolve (write targets may not exist yet). */
function normalizePrefix(p: string): string {
  const expanded = path.resolve(expandHome(p));
  try {
    return fs.realpathSync(expanded);
  } catch {
    return expanded;
  }
}

function isSkillEntry(value: unknown): value is SkillAllowlistEntry {
  const e = value as SkillAllowlistEntry;
  return (
    !!e &&
    typeof e.name === 'string' &&
    isValidSkillName(e.name) &&
    typeof e.entry === 'string' &&
    e.entry.length > 0 &&
    !e.entry.startsWith('/') &&
    !e.entry.includes('..') &&
    typeof e.runner === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(e.runner) &&
    Array.isArray(e.allowed_subcommands) &&
    e.allowed_subcommands.every((s) => typeof s === 'string' && s.length > 0)
  );
}

/** Validates + normalizes a raw parsed allowlist. Throws on malformed input. */
export function normalizeAllowlist(raw: unknown): OperatorAllowlist {
  const obj = raw as Partial<OperatorAllowlist>;
  if (!obj || !Array.isArray(obj.enabled_skills) || !Array.isArray(obj.workbench_write_prefixes)) {
    throw new Error('allowlist must define enabled_skills[] and workbench_write_prefixes[]');
  }
  if (!obj.enabled_skills.every(isSkillEntry)) {
    throw new Error('allowlist has a malformed enabled_skills entry');
  }
  if (!obj.workbench_write_prefixes.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new Error('allowlist workbench_write_prefixes must be non-empty strings');
  }
  return {
    enabled_skills: obj.enabled_skills,
    workbench_write_prefixes: obj.workbench_write_prefixes.map(normalizePrefix),
  };
}

export type AllowlistSource = 'env' | 'database' | 'file' | 'default';

const DB_KEY = 'operator_skill_allowlist';

/** True when an env override is set — it always wins, so API edits are futile. */
export function isAllowlistEnvOverrideActive(): boolean {
  return Boolean(
    process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON?.trim() ||
      process.env.LOVDEX_OPERATOR_ALLOWLIST_PATH?.trim(),
  );
}

function loadRawAllowlist(): { raw: unknown; source: AllowlistSource } {
  const inline = process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON?.trim();
  if (inline) {
    return { raw: JSON.parse(inline), source: 'env' };
  }
  const envPath = process.env.LOVDEX_OPERATOR_ALLOWLIST_PATH?.trim();
  if (envPath) {
    return { raw: JSON.parse(fs.readFileSync(expandHome(envPath), 'utf8')), source: 'env' };
  }
  // DB override (written by the settings API). appConfigDb.get swallows
  // early-startup errors and returns null, so this is safe pre-init.
  const stored = appConfigDb.get(DB_KEY);
  if (stored) {
    return { raw: JSON.parse(stored), source: 'database' };
  }
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    return { raw: JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8')), source: 'file' };
  }
  return { raw: DEFAULT_OPERATOR_ALLOWLIST, source: 'default' };
}

let cached: { list: OperatorAllowlist; source: AllowlistSource } | null = null;

/**
 * Returns the effective allowlist + where it came from (cached). A malformed
 * env/DB/file override falls back to built-in defaults with a warning — a
 * broken config must never silently widen or crash the operator tools.
 */
export function getOperatorAllowlistInfo(): { list: OperatorAllowlist; source: AllowlistSource } {
  if (cached) return cached;
  try {
    const { raw, source } = loadRawAllowlist();
    cached = { list: normalizeAllowlist(raw), source };
  } catch (e) {
    console.warn(
      '[operator-allowlist] invalid allowlist config, falling back to built-in defaults:',
      e instanceof Error ? e.message : String(e),
    );
    cached = { list: normalizeAllowlist(DEFAULT_OPERATOR_ALLOWLIST), source: 'default' };
  }
  return cached;
}

/** Returns the effective allowlist (cached). */
export function getOperatorAllowlist(): OperatorAllowlist {
  return getOperatorAllowlistInfo().list;
}

/**
 * Persists a DB override (settings API). Throws on malformed input — the
 * caller surfaces the validation error to the user and nothing is written.
 */
export function saveOperatorAllowlistOverride(raw: unknown): OperatorAllowlist {
  const normalized = normalizeAllowlist(raw);
  appConfigDb.set(DB_KEY, JSON.stringify(raw));
  resetOperatorAllowlistCache();
  return normalized;
}

/** Removes the DB override so the file/default layers apply again. */
export function clearOperatorAllowlistOverride(): void {
  appConfigDb.remove(DB_KEY);
  resetOperatorAllowlistCache();
}

/** Test seam: drop the cached allowlist so env/file changes are re-read. */
export function resetOperatorAllowlistCache(): void {
  cached = null;
}

/** Looks up an enabled skill entry by name, or null when not allowlisted. */
export function findSkillEntry(name: string, list: OperatorAllowlist = getOperatorAllowlist()) {
  if (!isValidSkillName(name)) return null;
  return list.enabled_skills.find((s) => s.name === name) ?? null;
}

/**
 * True when `resolvedPath` (already realpath-normalized by the caller) sits
 * under one of the write prefixes. Prefix boundary is enforced with a
 * separator check so `/home/x/operator-workspace-evil` does not match
 * `/home/x/operator-workspace`.
 */
export function isWriteAllowed(
  resolvedPath: string,
  list: OperatorAllowlist = getOperatorAllowlist(),
): boolean {
  return list.workbench_write_prefixes.some(
    (prefix) => resolvedPath === prefix || resolvedPath.startsWith(prefix + path.sep),
  );
}
