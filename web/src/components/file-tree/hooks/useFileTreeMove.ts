import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';

import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';

/** Custom dataTransfer type: its presence means "dragging rows inside the
 *  tree" (a move). An OS file drag only ever carries "Files". */
export const TREE_DRAG_MIME = 'application/x-lovdex-tree-items';

/** The backend refuses batches larger than this (see POST /files/move). */
export const MAX_MOVE_ITEMS = 100;

type UseFileTreeMoveArgs = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
  /** Called after a successful move so the caller can drop the now-dangling
   *  selection (the moved paths no longer exist). */
  onMoved?: () => void;
};

export function useFileTreeMove({ selectedProject, onRefresh, showToast, onMoved }: UseFileTreeMoveArgs) {
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);

  /** Start an internal drag with an explicit payload. The caller decides what
   *  travels (a single row, or the ancestor-deduped selection) — this hook
   *  stays decoupled from the selection model. */
  const beginItemDrag = useCallback(
    (e: DragEvent, items: Array<{ path: string; type: 'file' | 'directory' }>) => {
      e.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify({ items }));
      e.dataTransfer.effectAllowed = 'move';
      // A drag abandoned outside the tree (Esc, drop on the desktop) fires no
      // dragleave/drop here, so the highlight would stick. One-shot cleanup.
      const clear = () => {
        document.removeEventListener('dragend', clear);
        setMoveTarget(null);
      };
      document.addEventListener('dragend', clear);
    },
    [],
  );

  /** Directory rows call this on dragOver. Only internal drags are moves;
   *  OS file drags fall through to the upload path. */
  const handleItemDragOver = useCallback(
    (e: DragEvent, itemPath: string, isBlockedTarget: (p: string) => boolean) => {
      if (!e.dataTransfer.types.includes(TREE_DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      if (isBlockedTarget(itemPath)) {
        e.dataTransfer.dropEffect = 'none';
        setMoveTarget(null);
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      setMoveTarget(itemPath);
    },
    [],
  );

  /** Crossing a row's own child elements (icon, label) fires dragleave before
   *  the matching dragenter, so only clear when the pointer really left the row. */
  const handleItemDragLeave = useCallback((e: DragEvent) => {
    const row = e.currentTarget as Node | null;
    const next = e.relatedTarget as Node | null;
    if (row && next && row.contains(next)) return;
    setMoveTarget(null);
  }, []);

  const runMove = useCallback(
    async (items: Array<{ path: string; type: 'file' | 'directory' }>, targetDir: string) => {
      if (!selectedProject) return;
      if (items.length > MAX_MOVE_ITEMS) {
        showToast(`Too many items to move at once (max ${MAX_MOVE_ITEMS})`, 'error');
        return;
      }
      setOperationLoading(true);
      try {
        const response = await api.moveFiles(selectedProject.projectId, { items, targetDir });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Move failed');
        }
        const moved = typeof data.movedCount === 'number' ? data.movedCount : items.length;
        showToast(`Moved ${moved} item${moved === 1 ? '' : 's'}`, 'success');
        onRefresh();
        // The moved paths no longer exist; a lingering selection would show a
        // phantom count whose batch actions are no-ops.
        onMoved?.();
      } catch (err) {
        showToast((err as Error).message, 'error');
      } finally {
        setOperationLoading(false);
      }
    },
    [selectedProject, showToast, onRefresh, onMoved],
  );

  const handleItemDrop = useCallback(
    (e: DragEvent, itemPath: string, isBlockedTarget: (p: string) => boolean) => {
      if (!e.dataTransfer.types.includes(TREE_DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setMoveTarget(null);
      if (isBlockedTarget(itemPath)) {
        showToast('Cannot move a folder into itself', 'error');
        return;
      }
      const raw = e.dataTransfer.getData(TREE_DRAG_MIME);
      if (!raw) return;
      let items: Array<{ path: string; type: 'file' | 'directory' }> = [];
      try {
        ({ items } = JSON.parse(raw) as { items: typeof items });
      } catch {
        return;
      }
      if (!Array.isArray(items) || items.length === 0) return;
      void runMove(items, itemPath);
    },
    [runMove, showToast],
  );

  return {
    moveTarget,
    operationLoading,
    beginItemDrag,
    handleItemDragOver,
    handleItemDragLeave,
    handleItemDrop,
  };
}
