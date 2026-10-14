/**
 * Pure helpers for the file-tree multi-select model. Paths are the
 * project-relative POSIX paths used by FileTreeNode.path ('docs/sub/a.ts').
 */

/** Whether `path` is strictly inside any of `ancestors` (segment-aware). */
export function isDescendantOfAny(path: string, ancestors: string[]): boolean {
  return ancestors.some((a) => a !== path && path.startsWith(a + '/'));
}

/** Drop selected paths already covered by a selected ancestor directory. */
export function topMostSelectedPaths(selected: string[]): string[] {
  return selected.filter((p) => !isDescendantOfAny(p, selected));
}

/** The inclusive range between two paths in visible order (either direction). */
export function rangeBetween(visibleOrder: string[], from: string, to: string): string[] {
  const i = visibleOrder.indexOf(from);
  const j = visibleOrder.indexOf(to);
  if (i === -1 || j === -1) return [];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return visibleOrder.slice(lo, hi + 1);
}

type VisibleNode = { path: string; type: string; children?: unknown[] };

/**
 * Flatten the tree down to the rows the user can actually see: a directory's
 * children are included only when that directory is expanded. `expandedDirs`
 * is REQUIRED — FileTreeNode renders children only under
 * `expandedDirs.has(path)`, so flattening without it would hand Shift-range
 * selection paths for rows that are collapsed out of view.
 */
export function flattenVisiblePaths(items: VisibleNode[], expandedDirs: Set<string>): string[] {
  const out: string[] = [];
  const walk = (nodes: VisibleNode[]): void => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.type === 'directory' && expandedDirs.has(n.path) && Array.isArray(n.children)) {
        walk(n.children as VisibleNode[]);
      }
    }
  };
  walk(items);
  return out;
}
