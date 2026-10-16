import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, Upload } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { ICON_SIZE_CLASS, getFileIconData } from '../constants/fileIcons';
import { useExpandedDirectories } from '../hooks/useExpandedDirectories';
import { useFileTreeData } from '../hooks/useFileTreeData';
import { useFileTreeMove, TREE_DRAG_MIME } from '../hooks/useFileTreeMove';
import { useFileTreeOperations } from '../hooks/useFileTreeOperations';
import { useFileTreeSearch } from '../hooks/useFileTreeSearch';
import { useFileTreeSelection } from '../hooks/useFileTreeSelection';
import { useFileTreeViewMode } from '../hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '../hooks/useFileTreeUpload';
import { useTerminalResize } from '../hooks/useTerminalResize';
import type { FileTreeImageSelection, FileTreeNode } from '../types/types';
import { formatFileSize, formatRelativeTime, isImageFile } from '../utils/fileTreeUtils';
import { isDescendantOfAny } from '../utils/fileTreeSelection';
import { Project } from '../../../types/app';
import { ScrollArea, Input } from '../../../shared/view/ui';
import { TerminalPanel } from '../../terminal/TerminalPanel';
import { TerminalPane } from '../../terminal/TerminalPane';

import FileTreeBody from './FileTreeBody';
import FileTreeDetailedColumns from './FileTreeDetailedColumns';
import FileTreeHeader from './FileTreeHeader';
import FileTreeLoadingState from './FileTreeLoadingState';
import FileTreeSelectionBar from './FileTreeSelectionBar';
import FileTreeUploadProgress from './FileTreeUploadProgress';
import ImageViewer from './ImageViewer';


type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
};

export default function FileTree({ selectedProject, onFileOpen }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 终端面板开合是 Files 页本地状态：默认隐藏；切走 tab 即卸载、退出 shell。
  const [terminalOpen, setTerminalOpen] = useState(false);
  const { terminalFraction, resizeHandleRef, handleResizeStart } = useTerminalResize();

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const { files, loading, error, refreshFiles } = useFileTreeData(selectedProject);
  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
  });

  // The operations hook is built before `selection`; this ref lets its
  // post-delete callback reach the live selection without a cycle.
  const selectionRef = useRef<{ clearSelection: () => void } | null>(null);

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
    onBatchDeleted: () => selectionRef.current?.clearSelection(),
  });

  // File upload (drag and drop)
  const upload = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });

  // Multi-select over the rows the user can actually see (expansion-aware).
  const selection = useFileTreeSelection({ visibleItems: filteredFiles, expandedDirs });
  selectionRef.current = selection;

  // Drag-move: dragging selected rows onto a folder relocates them.
  const move = useFileTreeMove({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
    onMoved: () => selectionRef.current?.clearSelection(),
  });

  const operationLoading =
    operations.operationLoading || upload.operationLoading || move.operationLoading;

  // Escape clears the selection, same as clicking empty space.
  useEffect(() => {
    if (selection.selectedCount === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selection.clearSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  // Paths are project-relative, so a selection left over from another project
  // would be a phantom count pointing at rows that no longer exist.
  const { clearSelection } = selection;
  useEffect(() => {
    clearSelection();
  }, [selectedProject?.projectId, clearSelection]);

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        toggleDirectory(item.path);
        return;
      }

      if (isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          // Image URL uses the DB projectId so ImageViewer can hit the
          // /api/projects/:projectId/files/content endpoint directly.
          projectId: selectedProject.projectId,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [onFileOpen, selectedProject, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  // A row click never opens anything: it only feeds the selection model
  // (plain = select, Ctrl/Cmd = toggle, Shift = range). Opening happens on
  // double click, in handleRowDoubleClick.
  const handleRowClick = useCallback(
    (item: FileTreeNode, e: ReactMouseEvent) => {
      const result = selection.classifyClick(item, e);
      selection.applyClick(result, item);
    },
    [selection],
  );

  // Double click opens the item. Both single clicks that form the double
  // click already went through handleRowClick, so the selection is already
  // on the row being opened — no re-selection needed (re-selecting here
  // would clobber a Ctrl/Shift multi-selection made right before opening).
  const handleRowDoubleClick = useCallback(
    (item: FileTreeNode) => {
      handleItemClick(item);
    },
    [handleItemClick],
  );

  // Selected nodes, in tree order (drives the batch bar's delete / zip).
  const topMostNodes = useMemo(() => {
    const top = new Set(selection.topMostSelected);
    if (top.size === 0) return [];
    const found: FileTreeNode[] = [];
    const walk = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        if (top.has(node.path)) found.push(node);
        if (node.children && node.children.length > 0) walk(node.children);
      }
    };
    walk(filteredFiles);
    return found;
  }, [filteredFiles, selection.topMostSelected]);

  // Dropping onto a selected row (or inside a selected folder) is rejected by
  // the backend too — this is the front-end half of that guard.
  const isBlockedMoveTarget = useCallback(
    (path: string) => selection.isSelected(path) || isDescendantOfAny(path, selection.selectedPaths),
    [selection],
  );

  const treeInteractions = useMemo(
    () => ({
      isSelected: selection.isSelected,
      isMoveTarget: (path: string) => move.moveTarget === path,
      onRowClick: handleRowClick,
      onRowDoubleClick: handleRowDoubleClick,
      onDragStart: (e: DragEvent, item: FileTreeNode) => {
        // Carry the ancestor-deduped set: dragging a folder must move the
        // folder, not it plus every child the user also happened to select.
        const dragged = { path: item.path, type: item.type };
        const items = selection.isSelected(item.path)
          ? topMostNodes.map((n) => ({ path: n.path, type: n.type }))
          : [dragged];
        move.beginItemDrag(e, items);
      },
      onDragOver: (e: DragEvent, item: FileTreeNode) => {
        // Only directories accept anything: internal drags (move) and OS file
        // drags (upload). Each hook then filters on its own dataTransfer type.
        if (item.type !== 'directory') return;
        move.handleItemDragOver(e, item.path, isBlockedMoveTarget);
        upload.handleItemDragOver(e, item.path);
      },
      onDragLeave: (e: DragEvent) => {
        move.handleItemDragLeave(e);
        // Also drop the upload target: without this, wandering off a directory
        // row leaves it armed, and a later drop on blank space uploads there.
        upload.handleItemDragLeave();
      },
      onDrop: (e: DragEvent, item: FileTreeNode) => {
        if (item.type !== 'directory') return;
        move.handleItemDrop(e, item.path, isBlockedMoveTarget);
        upload.handleItemDrop(e, item.path);
      },
      onUploadHere: (path: string) => upload.openFilePicker(path),
    }),
    [selection, move, upload, handleRowClick, handleRowDoubleClick, isBlockedMoveTarget, topMostNodes],
  );

  const handleTreeDrop = useCallback(
    (e: DragEvent) => {
      // Blank space under the tree is not a legal move destination (the
      // project root is not a valid target), and the upload hook ignores
      // internal drags anyway.
      if (e.dataTransfer.types.includes(TREE_DRAG_MIME)) return;
      void upload.handleDrop(e);
    },
    [upload],
  );

  // Clicking anywhere that is not a row clears the selection.
  const handleBackgroundClick = useCallback(
    (e: ReactMouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-file-row]')) return;
      selection.clearSelection();
    },
    [selection],
  );

  if (loading) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={upload.treeRef}
      className="relative flex h-full flex-col bg-background"
      onDragEnter={upload.handleDragEnter}
      onDragOver={upload.handleDragOver}
      onDragLeave={upload.handleDragLeave}
      onDrop={handleTreeDrop}
    >
      {/* Drag overlay */}
      {/* Drag overlay — pointer-events-none so directory rows underneath stay
          hoverable; otherwise this z-50 layer swallows the row's dragover and
          the drop can never target a subfolder. */}
      {upload.isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary bg-primary/10">
          <div className="flex items-center gap-3 rounded-lg bg-background/95 px-6 py-4 shadow-lg">
            <Upload className="h-6 w-6 text-primary" />
            <span className="text-sm font-medium">{t('fileTree.dropToUpload', 'Drop files to upload')}</span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onUploadFiles={upload.handleFileSelect}
        onUploadFolder={upload.handleFolderSelect}
        onOpenFilePicker={(targetPath) => upload.openFilePicker(targetPath ?? '')}
        onOpenFolderPicker={(targetPath) => upload.openFolderPicker(targetPath ?? '')}
        onNewFile={() => operations.handleStartCreate('', 'file')}
        onNewFolder={() => operations.handleStartCreate('', 'directory')}
        onRefresh={refreshFiles}
        onCollapseAll={collapseAll}
        loading={loading}
        operationLoading={operationLoading}
        isUploading={upload.uploadProgress?.status === 'uploading'}
        uploadProgress={upload.uploadProgress?.progress ?? null}
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((prev) => !prev)}
      />

      {/* Hidden picker inputs the header's buttons drive. */}
      <input
        ref={upload.fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void upload.handleFileSelect(e.target.files ?? []);
          e.target.value = '';
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={upload.folderInputRef}
        type="file"
        multiple
        {...{ webkitdirectory: '', directory: '' }}
        className="hidden"
        onChange={(e) => {
          void upload.handleFolderSelect(e.target.files ?? []);
          e.target.value = '';
        }}
        tabIndex={-1}
        aria-hidden="true"
      />

      <FileTreeSelectionBar
        count={selection.selectedCount}
        operationLoading={operationLoading}
        onDelete={() => operations.handleStartDeleteMany(topMostNodes)}
        onDownloadZip={() =>
          void operations.downloadItemsAsZip(
            topMostNodes,
            `selection-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`,
          )
        }
        onClear={selection.clearSelection}
      />

      <FileTreeUploadProgress upload={upload.uploadProgress} />

      {viewMode === 'detailed' && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="min-h-0 flex-1 px-2 py-1" data-file-tree-background onClick={handleBackgroundClick}>
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-primary')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 flex-1 text-sm"
              disabled={operationLoading}
            />
          </div>
        )}

        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          error={error}
          searchQuery={searchQuery}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onItemClick={handleItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTimeLabel}
          onRename={operations.handleStartRename}
          onDelete={operations.handleStartDelete}
          onNewFile={(path) => operations.handleStartCreate(path, 'file')}
          onNewFolder={(path) => operations.handleStartCreate(path, 'directory')}
          onCopyPath={operations.handleCopyPath}
          onDownload={operations.handleDownload}
          onRefresh={refreshFiles}
          treeInteractions={treeInteractions}
          // Pass rename state and handlers for inline editing
          renamingItem={operations.renamingItem}
          renameValue={operations.renameValue}
          setRenameValue={operations.setRenameValue}
          handleConfirmRename={operations.handleConfirmRename}
          handleCancelRename={operations.handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
        />
      </ScrollArea>

      {terminalOpen && (
        <>
          <div
            ref={resizeHandleRef}
            onMouseDown={handleResizeStart}
            className="h-1 flex-shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary"
            title="拖拽调整终端高度"
          />
          <TerminalPanel style={{ height: `${terminalFraction * 100}%` }} pane={<TerminalPane />} />
        </>
      )}

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen &&
        (operations.deleteConfirmation.item || (operations.deleteConfirmation.items?.length ?? 0) > 0) && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-destructive/10 p-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {operations.deleteConfirmation.item
                    ? t('fileTree.delete.title', 'Delete {{type}}', {
                        type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                      })
                    : t('fileTree.delete.titleMany', 'Delete {{count}} items', {
                        count: operations.deleteConfirmation.items?.length ?? 0,
                      })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item
                    ? operations.deleteConfirmation.item.name
                    : (() => {
                        const names = (operations.deleteConfirmation.items ?? []).map((n) => n.name);
                        const shown = names.slice(0, 5).join(', ');
                        return names.length > 5 ? `${shown} … +${names.length - 5}` : shown;
                      })()}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item
                ? operations.deleteConfirmation.item.type === 'directory'
                  ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                  : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')
                : t('fileTree.delete.manyWarning', 'These items (and folder contents) will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                {operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-success text-success-foreground'
              : 'bg-destructive text-destructive-foreground'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
