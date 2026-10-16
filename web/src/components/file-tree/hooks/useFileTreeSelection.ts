import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';

import type { FileTreeNode } from '../types/types';
import { flattenVisiblePaths, rangeBetween, topMostSelectedPaths } from '../utils/fileTreeSelection';

type UseFileTreeSelectionArgs = {
  visibleItems: FileTreeNode[];
  expandedDirs: Set<string>;
};

export type SelectionClickResult =
  | { kind: 'select'; path: string; type: 'file' | 'directory' }
  | { kind: 'toggle'; path: string }
  | { kind: 'range'; paths: string[] };

/**
 * Pure decision for what a row click means. Kept outside the hook so the
 * double-click-to-open behaviour can be unit-tested without a React render.
 */
export function classifySelectionClick(
  item: FileTreeNode,
  e: MouseEvent,
  visibleOrder: string[],
  anchorPath: string | null,
): SelectionClickResult {
  if (e.shiftKey) {
    const from = anchorPath ?? item.path;
    return { kind: 'range', paths: rangeBetween(visibleOrder, from, item.path) };
  }
  if (e.ctrlKey || e.metaKey) {
    return { kind: 'toggle', path: item.path };
  }
  // Plain click: select (or re-select) this row. No 'clear' branch — the
  // selection is replaced by the clicked row instead of being wiped, so
  // single clicks never open files by accident while multi-selecting.
  return { kind: 'select', path: item.path, type: item.type };
}

export function useFileTreeSelection({ visibleItems, expandedDirs }: UseFileTreeSelectionArgs) {
  const [selected, setSelected] = useState<Map<string, 'file' | 'directory'>>(new Map());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const visibleOrder = useMemo(
    () => flattenVisiblePaths(visibleItems, expandedDirs),
    [visibleItems, expandedDirs],
  );

  /** Decide what a row click means. A plain click is always a selection:
   *  it replaces the selection with the clicked row (and never opens the
   *  file — opening now happens on double click). Modifier clicks keep the
   *  standard file-manager semantics: Ctrl/Cmd toggles one row, Shift
   *  selects the range from the anchor. */
  const classifyClick = useCallback(
    (item: FileTreeNode, e: MouseEvent): SelectionClickResult => {
      return classifySelectionClick(item, e, visibleOrder, anchorPath);
    },
    [anchorPath, visibleOrder],
  );

  const applyClick = useCallback((result: SelectionClickResult, item: FileTreeNode) => {
    if (result.kind === 'toggle') {
      setSelected((prev) => {
        const next = new Map(prev);
        const deselecting = next.has(result.path);
        if (deselecting) next.delete(result.path);
        else next.set(result.path, item.type);
        // Ctrl-clicking the LAST selected row empties the set; leaving the
        // anchor behind would let the next Shift-click start a range from a
        // path the user no longer has anchored anywhere.
        setAnchorPath(deselecting && next.size === 0 ? null : result.path);
        return next;
      });
    } else if (result.kind === 'range') {
      // Resolve row types once, before the updater — the updater must stay
      // side-effect free (StrictMode double-invokes it in dev).
      const types = new Map<string, 'file' | 'directory'>();
      for (const p of result.paths) {
        types.set(p, findNodeByPath(visibleItems, p)?.type ?? 'file');
      }
      setSelected((prev) => {
        const next = new Map(prev);
        for (const p of result.paths) {
          if (next.has(p)) continue;
          next.set(p, types.get(p) ?? 'file');
        }
        return next;
      });
    } else {
      // Plain single click: replace the selection with this one row and
      // re-anchor range selection on it.
      setSelected(new Map([[result.path, result.type]]));
      setAnchorPath(result.path);
    }
  }, [visibleItems]);

  const isSelected = useCallback((path: string) => selected.has(path), [selected]);

  /** Selection with descendants-of-selected stripped (for batch ops). */
  const selectedPaths = useMemo(() => [...selected.keys()], [selected]);
  const topMostSelected = useMemo(() => topMostSelectedPaths(selectedPaths), [selectedPaths]);

  const clearSelection = useCallback(() => {
    setSelected(new Map());
    setAnchorPath(null);
  }, []);

  return {
    selectedPaths,
    selectedCount: selected.size,
    topMostSelected,
    isSelected,
    classifyClick,
    applyClick,
    clearSelection,
  };
}

/** Depth-first lookup of a node by path within a (possibly nested) tree. */
function findNodeByPath(items: FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of items) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}
