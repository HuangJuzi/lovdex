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
  read(
    p: string,
    maxBytes?: number,
    encoding?: 'utf8' | 'base64',
  ): Promise<{ content: string; truncated: boolean }>;
  tree(
    p: string,
    maxDepth?: number,
    showHidden?: boolean,
  ): Promise<{ path: string; nodes: unknown[] }>;
  write(
    p: string,
    content: string,
    encoding?: 'utf8' | 'base64',
  ): Promise<{ success: boolean; size: number }>;
  create(
    parentPath: string,
    type: 'file' | 'directory',
    name: string,
  ): Promise<{ success: boolean; path: string }>;
  rename(oldPath: string, newName: string): Promise<{ success: boolean; newPath: string }>;
  delete(p: string, type: 'file' | 'directory'): Promise<{ success: boolean }>;
};

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024; // 1 MiB

// Hard caps on caller-trusted sizes so a misbehaving RPC peer can never drive a
// huge Buffer.alloc (read) or an unbounded readdir/slice (list).
const MAX_ENTRIES_CAP = 2000;
// 32 MiB — must stay aligned with main's REMOTE_MAX_READ_BYTES (the remote fs
// client clamps maxBytes to that value; `read` clamps to this cap via
// Math.min, so a smaller cap here would silently truncate 16–32 MiB files).
const MAX_READ_BYTES_CAP = 32 * 1024 * 1024; // 32 MiB

/** Directories never surfaced in the file tree (build artifacts, VCS, etc.). */
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '.git', '.svn', '.hg', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
  'venv', '.venv', 'target', 'vendor', '.gradle', '.idea', 'coverage', '.nyc_output',
]);

/** Upper bound on tree nodes returned in a single call (guards the recursion). */
const MAX_TREE_NODES = 5000;

function formatPermissions(mode: number): { permissions: string; permissionsRwx: string } {
  const octal = (mode & 0o777).toString(8).padStart(3, '0');
  const parts = ['owner', 'group', 'other'].map((_u, idx) => {
    const shift = (2 - idx) * 3;
    return ['r', 'w', 'x'].map((b, j) => (mode & (1 << (shift + (2 - j))) ? b : '-')).join('');
  });
  return { permissions: octal, permissionsRwx: parts.join('') };
}

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

    async read(p, maxBytes = defaultMaxReadBytes, encoding: 'utf8' | 'base64' = 'utf8') {
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
        return {
          content: encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'),
          truncated: s.size > limit,
        };
      } finally {
        await handle.close();
      }
    },

    async tree(p, maxDepth = 10, showHidden = true) {
      const target = resolveWithinRoots(p, roots);
      let count = 0;
      async function walk(dir: string, depth: number): Promise<unknown[]> {
        if (depth > maxDepth) return [];
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        const out: unknown[] = [];
        for (const d of dirents) {
          if (count >= MAX_TREE_NODES) throw new Error('FILE_TREE_TOO_LARGE');
          if (!showHidden && d.name.startsWith('.')) continue;
          if (d.isDirectory() && IGNORED_DIRS.has(d.name)) continue;
          count += 1;
          const full = path.join(dir, d.name);
          const st = await fsp.lstat(full);
          let isDir = st.isDirectory();
          let isSymlink = st.isSymbolicLink();
          let size = st.size;
          let mtimeMs = st.mtimeMs;
          let mode = st.mode;
          if (isSymlink) {
            try {
              const t = await fsp.stat(full);
              isDir = t.isDirectory();
              size = t.size;
              mtimeMs = t.mtimeMs;
              mode = t.mode;
            } catch {
              // dangling symlink: keep lstat values
            }
          }
          const { permissions, permissionsRwx } = formatPermissions(mode);
          const node: Record<string, unknown> = {
            name: d.name,
            path: full,
            type: isDir ? 'directory' : 'file',
            size,
            modified: new Date(mtimeMs).toISOString(),
            permissions,
            permissionsRwx,
            isSymlink,
          };
          if (isDir && depth < maxDepth) {
            node.children = await walk(full, depth + 1);
          }
          out.push(node);
        }
        out.sort((a, b) => {
          const A = a as Record<string, unknown>;
          const B = b as Record<string, unknown>;
          if (A.type === 'directory' && B.type !== 'directory') return -1;
          if (A.type !== 'directory' && B.type === 'directory') return 1;
          return String(A.name).localeCompare(String(B.name));
        });
        return out;
      }
      return { path: target, nodes: await walk(target, 0) };
    },

    async write(p, content, encoding: 'utf8' | 'base64' = 'utf8') {
      const target = resolveWithinRoots(p, roots);
      // Never write THROUGH a symlink leaf. resolveRealPath realpaths the
      // nearest existing ancestor, so a symlink that survives resolution here
      // is either dangling (realpath failed, target lexical) or otherwise
      // unresolvable — writing it would follow the link outside the roots
      // (e.g. overwrite ~/.ssh/authorized_keys via a repo-internal symlink).
      let leafStat;
      try {
        leafStat = await fsp.lstat(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // Leaf does not exist yet — writeFile will create it.
      }
      if (leafStat?.isSymbolicLink()) throw new Error('path outside allowed root');
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      await fsp.writeFile(target, buf);
      return { success: true, size: buf.length };
    },

    async create(parentPath, type, name) {
      const parent = resolveWithinRoots(parentPath, roots);
      const target = path.join(parent, name);
      const canonical = resolveWithinRoots(target, roots);
      if (canonical !== path.resolve(target)) throw new Error('invalid target name');
      try {
        await fsp.access(canonical);
        throw Object.assign(new Error(`${type === 'file' ? 'File' : 'Directory'} already exists`), { code: 'EEXIST' });
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') throw err;
      }
      if (type === 'directory') await fsp.mkdir(canonical, { recursive: false });
      else {
        await fsp.mkdir(path.dirname(canonical), { recursive: true });
        // O_CREAT|O_EXCL ('wx') so a pre-existing path — including a dangling
        // symlink that `fsp.access` cannot see — fails with EEXIST instead of
        // being followed/truncated outside the root.
        await fsp.writeFile(canonical, Buffer.alloc(0), { flag: 'wx' });
      }
      return { success: true, path: canonical };
    },

    async rename(oldPath, newName) {
      const oldTarget = resolveWithinRoots(oldPath, roots);
      const newTarget = resolveWithinRoots(path.join(path.dirname(oldTarget), newName), roots);
      try {
        await fsp.access(newTarget);
        throw Object.assign(new Error('A file or directory with this name already exists'), { code: 'EEXIST' });
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') throw err;
      }
      await fsp.rename(oldTarget, newTarget);
      return { success: true, newPath: newTarget };
    },

    async delete(p, type) {
      const target = resolveWithinRoots(p, roots);
      for (const root of roots) {
        const resolvedRoot = resolveRealPath(root);
        if (path.resolve(target) === resolvedRoot) throw new Error('cannot delete root');
      }
      if (type === 'directory') await fsp.rm(target, { recursive: true, force: false });
      else await fsp.unlink(target);
      return { success: true };
    },
  };
}
