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

/** Backups kept per skill. Every apply copies the whole directory, so without
 * a cap a busy skill would grow the host's disk without bound. */
const MAX_BACKUPS_PER_SKILL = 10;

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

  // Applies for the same skill must not interleave: two concurrent runs can
  // otherwise move each other's freshly-written directory aside and then delete
  // it, so one caller reports success for content that no longer exists.
  const locks = new Map<string, Promise<void>>();

  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the previous outcome
    const guard = run.then(() => undefined, () => undefined);
    locks.set(key, guard);
    // Drop the entry only once nobody else has chained onto it.
    void guard.then(() => {
      if (locks.get(key) === guard) locks.delete(key);
    });
    return run;
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
    async apply(input) {
      const dir = resolveSkillDir(input.root, input.name);
      const parent = path.dirname(dir);

      // `resolveSkillDir` is pure, so the lock key can be computed before the
      // lock is taken; the body below must not run concurrently for one target.
      return withLock(dir, async () => {
        // An empty bundle hashes to the well-known empty-input digest, so it
        // would compare equal to any other empty target and silently empty a
        // skill. Refuse it — a sync never legitimately produces one.
        if (input.files.length === 0) {
          throw new Error(`refusing to apply an empty bundle for ${input.name}`);
        }

        // 0. Bound the payload. The wire schema caps each file coarsely, but this
        //    is the authoritative check on the DECODED byte length — and it also
        //    covers in-process callers (the local node) that never touch the wire
        //    schema at all. Without it, a single apply could write an unbounded
        //    amount to disk on a host with a small footprint.
        let totalBytes = 0;
        for (const file of input.files) {
          // Path safety first, so an escaping path reports `unsafe relativePath`
          // rather than being mislabelled by the ignored-entry check below.
          assertSafeRelativePath(dir, file.relativePath);
          // `collectSkillDir` skips these on read, so a bundle carrying one could
          // never pass the post-write verification below — reject it here with an
          // honest error instead of failing later as "post-write verification
          // failed".
          const ignored = file.relativePath.split('/').find(isIgnoredSkillEntry);
          if (ignored !== undefined) {
            throw new Error(`ignored path in bundle: ${file.relativePath} (${ignored})`);
          }
          const bytes = Buffer.byteLength(
            file.content,
            file.encoding === 'base64' ? 'base64' : 'utf8',
          );
          if (bytes > MAX_SKILL_FILE_BYTES) {
            throw new Error(`skill file too large: ${file.relativePath} (${bytes} bytes)`);
          }
          totalBytes += bytes;
        }
        if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
          throw new Error(`skill too large: exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`);
        }

        // 1. The caller's declared hash must actually match the files it sent —
        //    otherwise the drift checks below compare against a lie.
        const desired = computeSkillHash(input.files);
        if (desired !== input.contentHash) {
          throw new Error(
            `bundle hash mismatch for ${input.name}: declared ${input.contentHash}, computed ${desired}`,
          );
        }

        const current = await readExistingHash(dir);
        if (current === desired) {
          return { action: 'skipped' as const, contentHash: desired };
        }
        // 2. The target must still be what the caller previewed. This is what
        //    makes "preview before overwrite" real rather than decorative: a
        //    skill edited on this host since the preview is never silently lost.
        if (current !== null && current !== input.expectedTargetHash && !input.force) {
          throw new Error(
            `target changed: ${input.name} on this host no longer matches the previewed hash`,
          );
        }

        // 3. Back up the current version before touching anything. The uuid
        //    suffix matters: the stamp alone is only millisecond-granular, and
        //    `cp` onto an existing non-empty directory fails.
        let backupPath: string | undefined;
        if (current !== null) {
          backupPath = path.join(parent, SKILL_BACKUP_DIR, `${input.name}.${stamp()}.${randomUUID()}`);
          await fsp.mkdir(path.dirname(backupPath), { recursive: true });
          await fsp.cp(dir, backupPath, { recursive: true });
        }

        // 4. Stage the new content in a sibling temp dir (same filesystem, so
        //    the rename below is atomic).
        const tmpDir = path.join(parent, `${SKILL_TMP_PREFIX}${randomUUID()}`);
        await fsp.mkdir(tmpDir, { recursive: true });
        try {
          await writeSkillFiles(tmpDir, input.files);
        } catch (err) {
          await fsp.rm(tmpDir, { recursive: true, force: true });
          throw err;
        }

        // 5. Swap. POSIX rename onto a NON-EMPTY directory fails with ENOTEMPTY,
        //    so the old directory has to move aside first.
        const oldDir = path.join(parent, `${SKILL_OLD_PREFIX}${randomUUID()}`);
        let movedAside = false;
        try {
          if (current !== null) {
            await fsp.rename(dir, oldDir);
            movedAside = true;
          }
          await fsp.rename(tmpDir, dir);
        } catch (err) {
          await fsp.rm(tmpDir, { recursive: true, force: true });
          if (movedAside) {
            // Put the original back — a failed swap must not leave a hole.
            await fsp.rename(oldDir, dir);
          }
          throw err;
        }

        // 6. Verify what actually landed; restore from the backup if it differs.
        const landed = await readExistingHash(dir);
        if (landed !== desired) {
          // Move the bad result aside rather than deleting it: restoring from the
          // backup can itself fail (ENOSPC is the likeliest cause of a verify
          // failure), and the target must never be left as a hole.
          const failedDir = path.join(parent, `${SKILL_OLD_PREFIX}${randomUUID()}`);
          try {
            await fsp.rename(dir, failedDir);
            if (backupPath) await fsp.cp(backupPath, dir, { recursive: true });
          } catch (restoreErr) {
            throw new Error(
              `post-write verification failed for ${input.name} AND rollback failed: ${errorMessage(restoreErr)}. ` +
                `The previous version is preserved at ${backupPath ?? failedDir} — restore it manually.`,
            );
          }
          await fsp.rm(failedDir, { recursive: true, force: true });
          throw new Error(`post-write verification failed for ${input.name}`);
        }

        if (movedAside) await fsp.rm(oldDir, { recursive: true, force: true });

        // Best-effort retention: a failed prune must never fail the apply.
        try {
          await pruneBackups(path.join(parent, SKILL_BACKUP_DIR), input.name);
        } catch (err) {
          console.warn(
            `[skill-store] failed to prune backups for ${input.name}: ${errorMessage(err)}`,
          );
        }

        return {
          action: current === null ? ('created' as const) : ('updated' as const),
          ...(backupPath !== undefined ? { backupPath } : {}),
          contentHash: desired,
        };
      });
    },
  };
}

/** Filesystem-safe ISO timestamp for backup directory names. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rejects a skill-relative path that escapes `baseDir`.
 *
 * The escape test runs on the RESULT of the join, never on the raw string:
 * `path.join` collapses interior segments, so a literal `..` segment escapes,
 * while a NAME that merely starts with dots (`..foo.md`) stays inside and must
 * not be refused here. (Such a name is still refused upstream — see the
 * ignored-entry check in `apply` — but for its own reason.)
 */
function assertSafeRelativePath(baseDir: string, relativePath: string): void {
  const abs = path.join(baseDir, ...relativePath.split('/'));
  const rel = path.relative(baseDir, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`unsafe relativePath: ${relativePath}`);
  }
}

/**
 * Writes `files` under `baseDir`, recreating the directory structure.
 *
 * `relativePath` is validated again here (not just at the RPC schema) because
 * this function is also reachable from unit tests and any future caller that
 * builds a bundle in-process.
 */
async function writeSkillFiles(baseDir: string, files: readonly SkillFileEntry[]): Promise<void> {
  for (const file of files) {
    assertSafeRelativePath(baseDir, file.relativePath);
    const abs = path.join(baseDir, ...file.relativePath.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const mode = file.executable ? 0o755 : 0o644;
    await fsp.writeFile(abs, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), { mode });
    // writeFile's mode is masked by umask, so normalize explicitly — the exec
    // bit is part of the fingerprint and must survive the round trip.
    await fsp.chmod(abs, mode);
  }
}

/** Keeps the newest N backups for `name`; ISO-derived stamps sort lexically. */
async function pruneBackups(backupRoot: string, name: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(backupRoot);
  } catch {
    return; // no backup dir yet
  }
  const mine = entries.filter((e) => e.startsWith(`${name}.`)).sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS_PER_SKILL))) {
    await fsp.rm(path.join(backupRoot, stale), { recursive: true, force: true });
  }
}
