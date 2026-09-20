import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
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

/** `base64` when the buffer contains a NUL byte (text files never do), else `utf8`. */
export function detectEncoding(buf: Buffer): SkillFileEncoding {
  return buf.includes(0) ? 'base64' : 'utf8';
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
 */
export function computeSkillHash(files: readonly SkillFileEntry[]): string {
  const h = createHash('sha256');
  for (const entry of [...files].sort(byRelativePath)) {
    h.update(entry.relativePath);
    h.update('\0');
    h.update(sha256Hex(entryBytes(entry)));
    h.update('\0');
    h.update(entry.executable ? '1' : '0');
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Reads every file under `dir` into wire form, sorted by relativePath.
 * Symlinks are skipped (mirrors the lite fs layer, which never follows them).
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
      // Check the symlink bit FIRST: a symlink to a directory reports
      // isDirectory() === false under withFileTypes, but be explicit anyway.
      if (dirent.isSymbolicLink()) continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;

      const stat = await fsp.stat(abs);
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`skill file too large: ${path.relative(dir, abs)} (${stat.size} bytes)`);
      }
      total += stat.size;
      if (total > MAX_SKILL_TOTAL_BYTES) {
        throw new Error(`skill too large: exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`);
      }

      const buf = await fsp.readFile(abs);
      const encoding = detectEncoding(buf);
      out.push({
        relativePath: path.relative(dir, abs).split(path.sep).join('/'),
        content: buf.toString(encoding),
        encoding,
        executable: (stat.mode & 0o111) !== 0,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  await walk(dir);
  return out.sort(byRelativePath);
}
