import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';

import type { FileTreeNode } from '../types/types';
import { flattenVisiblePaths, rangeBetween, topMostSelectedPaths } from '../utils/fileTreeSelection';

type UseFileTreeSelectionArgs = {
  visibleItems: FileTreeNode[];
  expandedDirs: Set<string>;
};

export type SelectionClickResult =
  | { kind: 'default' }
  | { kind: 'toggle'; path: string }
  | { kind: 'range'; paths: string[] }
  | { kind: 'clear' };

export function useFileTreeSelection({ visibleItems, expandedDirs }: UseFileTreeSelectionArgs) {
  const [selected, setSelected] = useState<Map<string, 'file' | 'directory'>>(new Map());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const visibleOrder = useMemo(
    () => flattenVisiblePaths(visibleItems, expandedDirs),
    [visibleItems, expandedDirs],
  );

  /** Decide what a row click means. The caller (FileTreeNode) runs the default
   *  open/expand behavior only for `default`/`clear` results. */
  const classifyClick = useCallback(
    (item: FileTreeNode, e: MouseEvent): SelectionClickResult => {
      if (e.shiftKey) {
        const from = anchorPath ?? item.path;
        return { kind: 'range', paths: rangeBetween(visibleOrder, from, item.path) };
      }
      if (e.ctrlKey || e.metaKey) {
        return { kind: 'toggle', path: item.path };
      }
      if (selected.size > 0) {
        return { kind: 'clear' };
      }
      return { kind: 'default' };
    },
    [anchorPath, selected, visibleOrder],
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
      setAnchorPath(null);
      setSelected(new Map());
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
