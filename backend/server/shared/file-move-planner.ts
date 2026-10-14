/**
 * Pure planning logic for batch file-tree moves. Shared by the main server's
 * /files/move route and the remote lite's fs.move RPC — both resolve paths
 * against their own roots first, then hand the resolved POSIX-style absolute
 * paths to the planner. No IO here: conflict detection is injected so callers
 * keep their own fs access semantics.
 */

export type MoveItem = { path: string; type: 'file' | 'directory' };

export type PlannedMove = { from: string; to: string; name: string };

export type MovePlan =
  | { ok: true; moves: PlannedMove[]; skippedNoOp: string[] }
  | { ok: false; code: 'INTO_ITSELF'; path: string }
  | { ok: false; code: 'DUPLICATE_TARGET'; path: string; conflictWith: string };

const isUnder = (child: string, ancestor: string) =>
  child.startsWith(ancestor + '/');

/**
 * Plan a batch move of `items` into `targetDir`.
 *
 * Input contract: paths are assumed already normalized by the caller's
 * `path.resolve` — absolute POSIX paths, no trailing slash, and strictly below
 * each caller's own root (a root directory itself is never a movable item).
 */
export function planMoves(items: MoveItem[], targetDir: string): MovePlan {
  // Deduplicate exact paths (later duplicates dropped).
  const seen = new Set<string>();
  const unique: MoveItem[] = [];
  for (const it of items) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    unique.push(it);
  }

  // Drop items already covered by a selected ancestor directory.
  const topLevel = unique.filter(
    (it) => !unique.some((other) => other.path !== it.path && isUnder(it.path, other.path)),
  );

  const moves: PlannedMove[] = [];
  const skippedNoOp: string[] = [];
  const claimedTargets = new Map<string, string>();
  for (const it of topLevel) {
    // Moving an item onto itself or into its own subtree is invalid.
    if (targetDir === it.path || isUnder(targetDir, it.path)) {
      return { ok: false, code: 'INTO_ITSELF', path: it.path };
    }
    const name = it.path.split('/').pop() ?? it.path;
    const to = `${targetDir}/${name}`;
    if (to === it.path) {
      skippedNoOp.push(it.path);
      continue;
    }
    // Two different sources resolving to the same destination would silently
    // overwrite each other on rename — reject the batch instead.
    const previous = claimedTargets.get(to);
    if (previous !== undefined) {
      return { ok: false, code: 'DUPLICATE_TARGET', path: it.path, conflictWith: previous };
    }
    claimedTargets.set(to, it.path);
    moves.push({ from: it.path, to, name });
  }
  return { ok: true, moves, skippedNoOp };
}

/** Collect the display names of destinations that already exist. */
export async function collectMoveConflicts(
  moves: PlannedMove[],
  exists: (p: string) => Promise<boolean>,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const m of moves) {
    if (await exists(m.to)) conflicts.push(m.name);
  }
  return conflicts;
}
