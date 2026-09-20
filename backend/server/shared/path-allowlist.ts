import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Path allowlist primitives shared by the main server and the remote lite
 * agent.
 *
 * A symlink- and `..`-aware resolver that answers exactly one question: "is
 * this path inside one of these roots?" The security decision always uses the
 * realpath form; the caller gets the lexical (symlink-preserving) form back so
 * a symlinked project root keeps the path the user actually chose.
 *
 * Extracted verbatim from `remote-agent/src/fs.ts` so the skill store can run
 * on BOTH sides without forking this logic.
 */

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Expands `~` and lexically resolves a user-supplied path WITHOUT following
 * symlinks. This is the DISPLAY/round-trip form: `fs/list` and `fs/tree`
 * return it (and build node paths from it) so the UI keeps the path the user
 * actually chose — a symlinked project root must not silently turn into its
 * realpath target in the sidebar, wizard, terminal and file-open calls.
 */
function resolveDisplayPath(input: string): string {
  return path.resolve(expandHome(input));
}

/**
 * Resolves a user-supplied path to a canonical absolute path: `~` expansion,
 * lexical resolve, then realpath of the nearest existing ancestor (targets may
 * not exist yet). Mirrors main's `resolveRealPath` in
 * `server/modules/operators/operator-exec.service.ts` — this is the
 * symlink/traversal guard used ONLY for the allowlist check, never for the
 * paths echoed back to the client.
 */
export function resolveRealPath(input: string): string {
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
 * `path outside allowed root` on any escape. Returns the DISPLAY path (lexical,
 * symlink-preserving) on success — the security decision always uses the
 * realpath form, but callers echo the lexical form back to the client.
 */
function resolveWithin(input: string, root: string): string {
  const resolvedRoot = resolveRealPath(root);
  const resolved = resolveRealPath(input);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path outside allowed root');
  }
  // The input is inside the root. Echo the lexical (symlink-preserving) form,
  // except when it IS the root itself resolved from a symlinked root — then
  // the resolved root is the honest absolute path (e.g. '~' → /home/<user>).
  const display = resolveDisplayPath(input);
  if (path.relative(resolvedRoot, display).startsWith('..') || path.isAbsolute(path.relative(resolvedRoot, display))) {
    return resolvedRoot;
  }
  return display;
}

/** Resolve within ANY of the configured roots; throw if it escapes all of them. */
export function resolveWithinRoots(input: string, roots: string[]): string {
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
