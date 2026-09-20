import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Content fingerprint of a skill directory, shared verbatim by the main server
 * and the remote lite agent.
 *
 * Both ends MUST produce bit-identical hashes — the whole diff (and therefore
 * the "preview before overwrite" guarantee) rests on it. There is exactly ONE
 * copy of this algorithm on purpose; do not fork it per side.
 *
 * mtime is deliberately NOT part of the hash: cross-host clocks are
 * unreliable, and including it would make every sync look like a conflict.
 * mtime is carried in the manifest for display only.
 */

/** Directories never walked. Dot-entries are skipped wholesale (see
 * {@link isIgnoredSkillEntry}), which covers `.git`, `.DS_Store` and the
 * `.skill-sync-backup` / `.skill-sync-tmp-*` scratch dirs the apply path
 * creates INSIDE a skill root — they must never leak into a fingerprint. */
export const SKILL_IGNORED_DIRS: readonly string[] = ['node_modules'];

/** Per-file and per-skill transfer caps. These bound a skill BUNDLE (not a
 * single fs read), so they live here rather than in the lite fs layer. */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MiB

export type SkillFileEncoding = 'utf8' | 'base64';

/** One file of a skill directory, in wire form. */
export type SkillFileEntry = {
  /** POSIX separators, relative to the skill directory. */
  relativePath: string;
  content: string;
  encoding: SkillFileEncoding;
  executable: boolean;
  /** Display only — NOT part of the fingerprint (see the module docstring).
   * Optional so hand-built fixtures and the wire format stay simple. */
  mtimeMs?: number;
};

export function isIgnoredSkillEntry(name: string): boolean {
  return name.startsWith('.') || SKILL_IGNORED_DIRS.includes(name);
}

/**
 * `base64` for anything that is not safely representable as text, `utf8`
 * otherwise.
 *
 * The decision is a ROUND-TRIP test, not a NUL scan. A NUL-byte heuristic is
 * not safe on its own: a Latin-1/CP1252/GBK file (or a small binary) with no
 * NUL byte would be labelled `utf8`, and `toString('utf8')` replaces its
 * invalid sequences with U+FFFD. Two different byte sequences then collapse to
 * the same string — same fingerprint for different content — and an applied
 * skill would be silently corrupted while both sides still compare equal.
 *
 * A NUL byte additionally forces `base64` (binary fast path, and it avoids
 * decoding a large binary buffer twice). UTF-8 does permit U+0000, so a NUL is
 * not proof of non-text — but carrying such a file as base64 is never wrong,
 * since base64 is lossless either way.
 *
 * `TextDecoder({ fatal: true })` is deliberately NOT used: it strips a BOM by
 * default, which would introduce a new lossy path.
 */
export function detectEncoding(buf: Buffer): SkillFileEncoding {
  if (buf.includes(0)) return 'base64';
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? 'utf8' : 'base64';
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function entryBytes(entry: SkillFileEntry): Buffer {
  return Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
}

function byRelativePath(a: SkillFileEntry, b: SkillFileEntry): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

/**
 * Fingerprints `files`. Entries are sorted first, so directory enumeration
 * order never changes the result.
 *
 * This is a trust boundary (wire manifests, hand-built fixtures): a duplicate
 * `relativePath` would otherwise make the result depend on input order, so it
 * is rejected outright.
 */
export function computeSkillHash(files: readonly SkillFileEntry[]): string {
  const sorted = [...files].sort(byRelativePath);
  const h = createHash('sha256');
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (i > 0 && entry.relativePath === sorted[i - 1].relativePath) {
      throw new Error(`duplicate relativePath: ${entry.relativePath}`);
    }
    h.update(entry.relativePath);
    h.update('\0');
    h.update(sha256Hex(entryBytes(entry)));
    h.update('\0');
    h.update(entry.executable ? '1' : '0');
    h.update('\0');
  }
  return h.digest('hex');
}

/** O_NOFOLLOW so a file swapped for a symlink between the readdir snapshot and
 * the open cannot be followed out of the skill root. O_NONBLOCK so a FIFO
 * raced in does not block the open forever (ignored for regular files; absent
 * on Windows, hence the `?? 0`). */
const SKILL_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0);

/** Transient conditions that must skip one entry, not fail the whole walk. */
function isSkippableOpenError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  // ELOOP: swapped for a symlink (O_NOFOLLOW). ENOENT: deleted mid-walk.
  return code === 'ELOOP' || code === 'ENOENT';
}

/**
 * Reads every file under `dir` into wire form, sorted by relativePath.
 * Symlinks are never followed (mirrors the lite fs layer) — enforced at open
 * time, not just from the readdir snapshot.
 * Throws when a file exceeds {@link MAX_SKILL_FILE_BYTES} or the skill exceeds
 * {@link MAX_SKILL_TOTAL_BYTES}.
 */
export async function collectSkillDir(dir: string): Promise<SkillFileEntry[]> {
  const out: SkillFileEntry[] = [];
  let total = 0;

  async function walk(current: string): Promise<void> {
    const dirents = await fsp.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      if (isIgnoredSkillEntry(dirent.name)) continue;
      // Fast path only — the authoritative check is O_NOFOLLOW at open time.
      if (dirent.isSymbolicLink()) continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;

      const rel = path.relative(dir, abs).split(path.sep).join('/');

      let handle;
      try {
        handle = await fsp.open(abs, SKILL_OPEN_FLAGS);
      } catch (err) {
        if (isSkippableOpenError(err)) continue;
        throw err;
      }
      try {
        const stat = await handle.stat();
        // A FIFO / device / directory may have raced in after the snapshot.
        if (!stat.isFile()) continue;
        if (stat.size > MAX_SKILL_FILE_BYTES) {
          throw new Error(`skill file too large: ${rel} (${stat.size} bytes)`);
        }

        const buf = await handle.readFile();
        // Re-check against the REAL byte length: the file may have grown
        // between stat and read, which would otherwise bypass the caps.
        if (buf.length > MAX_SKILL_FILE_BYTES) {
          throw new Error(`skill file too large: ${rel} (${buf.length} bytes)`);
        }
        total += buf.length;
        if (total > MAX_SKILL_TOTAL_BYTES) {
          throw new Error(`skill too large: exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`);
        }

        const encoding = detectEncoding(buf);
        out.push({
          relativePath: rel,
          content: buf.toString(encoding),
          encoding,
          executable: (stat.mode & 0o111) !== 0,
          mtimeMs: stat.mtimeMs,
        });
      } finally {
        await handle.close();
      }
    }
  }

  await walk(dir);
  return out.sort(byRelativePath);
}
