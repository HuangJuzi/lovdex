import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import type { AnyRecord } from '@/shared/types.js';

/** The zstd frame magic every compressed record in a session log starts with. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** `session.vN.jsonl.zstd` (default) or `session.vN.jsonl` (compression: none). */
const SESSION_FILE_PATTERN = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/;

/** Provider-native session ids are uuids; anything else is rejected outright. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Encodes a working directory the way dsh names its per-project session dirs.
 *
 * `/mnt/b/workdir/gitlab/hub` becomes `--mnt-b-workdir-gitlab-hub--` (one
 * leading dash + every `/` replaced by `-` + two trailing dashes — verified
 * against every real dir under `~/.dsh/sessions/`). The encoding is lossy for
 * cwds that contain literal dashes, which is why `findDshSessionLogFile`
 * treats it as a hint first and falls back to scanning by session id.
 */
export function mungeDshProjectDir(projectPath: string): string {
  const trimmed = projectPath.trim().replace(/\/+$/, '');
  return `-${trimmed.split('/').join('-')}--`;
}

/**
 * Locates the newest session log for one provider-native session id.
 *
 * Layout: `<dsh home>/sessions/<munged cwd>/<session id>/session.vN.jsonl.zstd`
 * (plus `session.lock`, which is never a candidate). The munged dir from
 * `projectPath` is tried first; when it misses (or `projectPath` is unknown)
 * every project dir is scanned for the session id, so a DB row whose
 * `project_path` drifted from the cwd dsh actually ran with still resolves.
 *
 * Returns the highest-version log file (`.zstd` preferred over a plain
 * `.jsonl` at the same version), or null when no log exists.
 */
export async function findDshSessionLogFile(
  sessionsRoot: string,
  projectPath: string | null | undefined,
  providerSessionId: string,
): Promise<string | null> {
  if (!sessionsRoot || !providerSessionId || !SESSION_ID_PATTERN.test(providerSessionId)) {
    return null;
  }

  const candidateDirs: string[] = [];
  if (typeof projectPath === 'string' && projectPath.trim()) {
    candidateDirs.push(path.join(sessionsRoot, mungeDshProjectDir(projectPath)));
  }
  try {
    for (const entry of await fsp.readdir(sessionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dir = path.join(sessionsRoot, entry.name);
        if (!candidateDirs.includes(dir)) {
          candidateDirs.push(dir);
        }
      }
    }
  } catch {
    // A missing sessions root simply has no logs.
  }

  let best: { filePath: string; version: number; zstd: boolean } | null = null;
  for (const dir of candidateDirs) {
    const sessionDir = path.join(dir, providerSessionId);
    let entries;
    try {
      entries = await fsp.readdir(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const match = SESSION_FILE_PATTERN.exec(entry.name);
      if (!match) {
        continue;
      }
      const version = Number.parseInt(match[1] ?? '0', 10);
      const zstd = entry.name.endsWith('.zstd');
      if (!best || version > best.version || (version === best.version && zstd && !best.zstd)) {
        best = { filePath: path.join(sessionDir, entry.name), version, zstd };
      }
    }
  }

  return best ? best.filePath : null;
}

/**
 * Decodes a dsh session log file into its JSONL text lines.
 *
 * The default format is a sequence of INDEPENDENT zstd frames — one per write,
 * some carrying several records — so the whole-file one-shot decompress stops
 * after the first frame. The frame boundaries are found by scanning for the
 * zstd magic and each frame is decompressed on its own; `zstdDecompressSync`
 * ignores trailing bytes after a frame's end, so a false-positive magic inside
 * compressed payload costs at most its own garbage "frame", never a real one.
 * A frame that fails to decompress (torn tail write) is skipped the same way.
 *
 * Plain `session.vN.jsonl` files (deployments running `compression: none`)
 * pass through as utf8 JSONL. Returns [] when this Node build lacks the
 * node:zlib zstd API (pre-22.15) and the file is compressed.
 */
export function decodeDshSessionLog(buffer: Buffer): string[] {
  if (buffer.length === 0) {
    return [];
  }

  const collect = (text: string): void => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
      }
    }
  };

  const lines: string[] = [];

  if (!buffer.subarray(0, 4).equals(ZSTD_MAGIC)) {
    collect(buffer.toString('utf8'));
    return lines;
  }

  if (typeof zlib.zstdDecompressSync !== 'function') {
    console.warn(
      '[dsh-session-log] this Node build has no node:zlib zstd support; cannot decode the compressed session log',
    );
    return [];
  }

  const frameStarts: number[] = [];
  let at = buffer.indexOf(ZSTD_MAGIC);
  while (at !== -1) {
    frameStarts.push(at);
    at = buffer.indexOf(ZSTD_MAGIC, at + 1);
  }

  for (let i = 0; i < frameStarts.length; i++) {
    const start = frameStarts[i];
    const end = i + 1 < frameStarts.length ? frameStarts[i + 1] : buffer.length;
    try {
      collect(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      // One undecodable frame loses only its own records.
    }
  }

  return lines;
}

/**
 * Parses the decoded JSONL lines into records, dropping unparseable ones and
 * ordering by the `seq` every record carries (dsh appends with monotonic seq;
 * sorting guards against any future out-of-order frame write).
 */
export function parseDshSessionRecords(lines: string[]): Array<AnyRecord & { seq?: number }> {
  const records: Array<AnyRecord & { seq?: number }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}
