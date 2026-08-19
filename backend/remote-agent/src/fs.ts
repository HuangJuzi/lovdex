import { promises as fsp } from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The allowlisted filesystem surface exposed to the main server over `fs/*` RPC.
 *
 * The remote lite is a code-execution surface, so every path is resolved and
 * checked against the configured `roots` whitelist before any syscall. Symlink
 * and `..` traversal that escapes a root is rejected (`resolveWithin`).
 */
export type RemoteDirEntry = {
  name: string;
  type: 'dir' | 'file' | 'symlink';
  size: number | null;
};

export type AllowlistedFs = {
  stat(p: string): Promise<{
    exists: boolean;
    isDirectory: boolean;
    isFile: boolean;
    size: number;
    mtimeMs: number;
  }>;
  list(
    p: string,
    maxEntries?: number,
  ): Promise<{ path: string; entries: RemoteDirEntry[] }>;
  read(p: string, maxBytes?: number): Promise<{ content: string; truncated: boolean }>;
};

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024; // 1 MiB

// Hard caps on caller-trusted sizes so a misbehaving RPC peer can never drive a
// huge Buffer.alloc (read) or an unbounded readdir/slice (list).
const MAX_ENTRIES_CAP = 2000;
const MAX_READ_BYTES_CAP = 16 * 1024 * 1024; // 16 MiB

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolves a user-supplied path to a canonical absolute path: `~` expansion,
 * lexical resolve, then realpath of the nearest existing ancestor (targets may
 * not exist yet). Mirrors main's `resolveRealPath` in
 * `server/modules/operators/operator-exec.service.ts` — this is the
 * symlink/traversal guard.
 */
function resolveRealPath(input: string): string {
  let resolved = path.resolve(expandHome(input));
  // Walk up to the nearest existing ancestor and realpath it, so a symlink
  // anywhere along the path is followed before the whitelist check.
  const missing: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // filesystem root
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    cursor = realpathSync(cursor);
  } catch {
    // Permission errors etc. — fall back to the lexical path.
  }
  resolved = missing.length > 0 ? path.join(cursor, ...missing) : cursor;
  return resolved;
}

/**
 * Resolve `input` and assert it lands inside `root`. The root is itself
 * realpath'd so that a symlinked root (e.g. macOS /tmp) still matches. Throws
 * `path outside allowed root` on any escape.
 */
function resolveWithin(input: string, root: string): string {
  const resolvedRoot = resolveRealPath(root);
  const resolved = resolveRealPath(input);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '' ) return resolved; // the root itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path outside allowed root');
  }
  return resolved;
}

/** Resolve within ANY of the configured roots; throw if it escapes all of them. */
function resolveWithinRoots(input: string, roots: string[]): string {
  let lastErr: unknown;
  for (const root of roots) {
    try {
      return resolveWithin(input, root);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('path outside allowed root');
}

export function createAllowlistedFs(opts: {
  roots: string[];
  maxEntries?: number;
  maxReadBytes?: number;
}): AllowlistedFs {
  const roots = opts.roots;
  // Cap the configured defaults too, so an oversized config cannot set a huge
  // budget that then never gets clamped below the RPC floor.
  const defaultMaxEntries = Math.min(opts.maxEntries ?? DEFAULT_MAX_ENTRIES, MAX_ENTRIES_CAP);
  const defaultMaxReadBytes = Math.min(opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES, MAX_READ_BYTES_CAP);

  return {
    async stat(p) {
      const target = resolveWithinRoots(p, roots);
      try {
        const s = await fsp.stat(target);
        return {
          exists: true,
          isDirectory: s.isDirectory(),
          isFile: s.isFile(),
          size: s.size,
          mtimeMs: s.mtimeMs,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { exists: false, isDirectory: false, isFile: false, size: 0, mtimeMs: 0 };
        }
        throw err;
      }
    },

    async list(p, maxEntries = defaultMaxEntries) {
      const target = resolveWithinRoots(p, roots);
      // Clamp the caller-trusted value: a misbehaving RPC peer must not drive
      // an unbounded readdir/slice.
      const count = Math.min(maxEntries, MAX_ENTRIES_CAP);
      const dirents = await fsp.readdir(target, { withFileTypes: true });
      return {
        // Return the RESOLVED absolute path so the UI can join children onto
        // it — browsing a token like '~' must not lose the /home/<user> prefix.
        path: target,
        entries: dirents.slice(0, count).map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
          // size stays null in Phase 1 — do not stat each entry.
          size: null,
        })),
      };
    },

    async read(p, maxBytes = defaultMaxReadBytes) {
      const target = resolveWithinRoots(p, roots);
      // Clamp the caller-trusted value: a misbehaving RPC peer must not trigger
      // a huge Buffer.alloc.
      const limit = Math.min(maxBytes, MAX_READ_BYTES_CAP);
      const handle = await fsp.open(target, 'r');
      try {
        const s = await handle.stat();
        const toRead = Math.min(s.size, limit);
        const buf = Buffer.alloc(toRead);
        if (toRead > 0) await handle.read(buf, 0, toRead, 0);
        return { content: buf.toString('utf8'), truncated: s.size > limit };
      } finally {
        await handle.close();
      }
    },
  };
}
