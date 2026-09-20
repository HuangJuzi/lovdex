import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { collectSkillDir, computeSkillHash, isIgnoredSkillEntry, MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES, type SkillFileEntry } from './skill-hash.js';
import { parseFrontMatter } from './frontmatter.js';
import { resolveWithinRoots } from './path-allowlist.js';
import type {
  RemoteSkillApplyResult,
  RemoteSkillBundle,
  RemoteSkillManifest,
  SkillManifestEntry,
} from './agent-runtime/protocol.js';

/**
 * Directory-level skill read/write, shared by the main server's local node and
 * the remote lite agent.
 *
 * Both sides run THIS code — same fingerprint, same atomic-write discipline —
 * which is what lets the sync orchestrator treat "local" and "remote" as two
 * interchangeable nodes with no branching.
 *
 * Scratch directories (backup / staging / the pre-swap original) are all
 * dot-prefixed so `isIgnoredSkillEntry` skips them: they must never show up in
 * a manifest or leak into a fingerprint.
 */
export const SKILL_BACKUP_DIR = '.skill-sync-backup';
const SKILL_TMP_PREFIX = '.skill-sync-tmp-';
const SKILL_OLD_PREFIX = '.skill-sync-old-';

/** A skill name is a single directory name — never a path. */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

export type SkillApplyInput = {
  root: string;
  name: string;
  /** The fingerprint the caller believes `files` produce (verified here). */
  contentHash: string;
  files: SkillFileEntry[];
  /** Fingerprint the caller saw for the CURRENT target during planning.
   * `null` means "the target did not exist". */
  expectedTargetHash: string | null;
  force: boolean;
};

export type SkillStore = {
  manifest(root: string): Promise<RemoteSkillManifest>;
  bundle(root: string, name: string): Promise<RemoteSkillBundle>;
  apply(input: SkillApplyInput): Promise<RemoteSkillApplyResult>;
};

function byteLength(entry: SkillFileEntry): number {
  return Buffer.byteLength(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Builds a manifest row from an already-collected skill directory.
 *
 * Frontmatter parsing is best-effort: a malformed block must not break the
 * whole listing, because the skill still syncs fine by content hash.
 */
export function buildManifestEntry(name: string, files: SkillFileEntry[]): SkillManifestEntry {
  let description: string | undefined;
  let version: string | undefined;
  const skillMd = files.find((f) => f.relativePath === 'SKILL.md' && f.encoding === 'utf8');
  if (skillMd) {
    try {
      const data = parseFrontMatter(skillMd.content).data as Record<string, unknown>;
      if (typeof data.description === 'string') description = data.description;
      if (typeof data.version === 'string') version = data.version;
      else if (typeof data.version === 'number') version = String(data.version);
    } catch {
      // ignore — see docstring
    }
  }
  return {
    name,
    contentHash: computeSkillHash(files),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + byteLength(f), 0),
    mtime: files.reduce((n, f) => Math.max(n, f.mtimeMs ?? 0), 0),
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

export function createSkillStore(opts: { roots: string[] }): SkillStore {
  const roots = opts.roots;

  function resolveRoot(root: string): string {
    return resolveWithinRoots(root, roots);
  }

  /** Resolves `<root>/<name>` and asserts `name` is exactly ONE path segment. */
  function resolveSkillDir(root: string, name: string): string {
    if (!SKILL_NAME_RE.test(name) || name === '.' || name === '..') {
      throw new Error(`invalid skill name: ${name}`);
    }
    const resolvedRoot = resolveRoot(root);
    const dir = resolveWithinRoots(path.join(resolvedRoot, name), roots);
    // Belt and braces: `path.join` + the allowlist already block traversal, but
    // assert the parent so a name can never address a nested directory.
    if (path.dirname(dir) !== resolvedRoot) {
      throw new Error(`invalid skill name: ${name}`);
    }
    return dir;
  }

  async function readExistingHash(dir: string): Promise<string | null> {
    let stat;
    try {
      stat = await fsp.stat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
    return computeSkillHash(await collectSkillDir(dir));
  }

  return {
    async manifest(root) {
      const resolvedRoot = resolveRoot(root);
      let dirents;
      try {
        dirents = await fsp.readdir(resolvedRoot, { withFileTypes: true });
      } catch (err) {
        // A host that has never had a skill installed is a normal state, not
        // an error — main renders "此主机还没有技能" from exists:false.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { root: resolvedRoot, exists: false, entries: [] };
        }
        throw err;
      }

      const entries: SkillManifestEntry[] = [];
      for (const dirent of dirents) {
        if (isIgnoredSkillEntry(dirent.name)) continue;
        if (dirent.isSymbolicLink() || !dirent.isDirectory()) continue;
        try {
          const files = await collectSkillDir(path.join(resolvedRoot, dirent.name));
          entries.push(buildManifestEntry(dirent.name, files));
        } catch (err) {
          // One unreadable or oversized skill must not blank the whole listing
          // — that would hide every OTHER skill too. Record it as inert and let
          // the plan refuse to touch it.
          entries.push({
            name: dirent.name,
            contentHash: '',
            fileCount: 0,
            totalBytes: 0,
            mtime: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { root: resolvedRoot, exists: true, entries: entries.sort(byName) };
    },

    async bundle(root, name) {
      const dir = resolveSkillDir(root, name);
      let files;
      try {
        files = await collectSkillDir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`skill not found: ${name}`);
        }
        throw err;
      }
      return { name, contentHash: computeSkillHash(files), files };
    },
    async apply() {
      throw new Error('not implemented');
    },
  };
}
