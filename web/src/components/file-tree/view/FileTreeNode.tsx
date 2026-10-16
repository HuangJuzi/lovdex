import type { DragEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '../types/types';
import { Input } from '../../../shared/view/ui';
import FileContextMenu from './FileContextMenu';

/**
 * Row-level interaction bundle threaded down the tree. Kept as ONE prop so the
 * five levels of manual prop drilling stay readable; every member is optional
 * — without it the row falls back to plain click-to-open behaviour.
 */
export type FileTreeInteractions = {
  isSelected: (path: string) => boolean;
  isMoveTarget: (path: string) => boolean;
  onRowClick: (item: FileTreeNodeType, e: ReactMouseEvent) => void;
  /** Double click opens the item (file → editor / image viewer, directory → expand). */
  onRowDoubleClick: (item: FileTreeNodeType) => void;
  onDragStart: (e: DragEvent, item: FileTreeNodeType) => void;
  onDragOver: (e: DragEvent, item: FileTreeNodeType) => void;
  onDragLeave: (e: DragEvent, item: FileTreeNodeType) => void;
  onDrop: (e: DragEvent, item: FileTreeNodeType) => void;
  onUploadHere?: (path: string) => void;
};

type FileTreeNodeProps = {
  item: FileTreeNodeType;
  level: number;
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  onItemClick: (item: FileTreeNodeType) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNodeType) => void;
  onDelete?: (item: FileTreeNodeType) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNodeType) => void;
  onDownload?: (item: FileTreeNodeType) => void;
  onRefresh?: () => void;
  // Multi-select + drag-move wiring (absent in read-only renderings)
  treeInteractions?: FileTreeInteractions;
  // Rename state for inline editing
  renamingItem?: FileTreeNodeType | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
};

type TreeItemIconProps = {
  item: FileTreeNodeType;
  isOpen: boolean;
  renderFileIcon: (filename: string) => ReactNode;
};

function TreeItemIcon({ item, isOpen, renderFileIcon }: TreeItemIconProps) {
  if (item.type === 'directory') {
    return (
      <span className="flex flex-shrink-0 items-center gap-0.5">
        <ChevronRight
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground/70 transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
        {isOpen ? (
          <FolderOpen className="h-4 w-4 flex-shrink-0 text-primary" />
        ) : (
          <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
      </span>
    );
  }

  return <span className="ml-[18px] flex flex-shrink-0 items-center">{renderFileIcon(item.name)}</span>;
}

export default function FileTreeNode({
  item,
  level,
  viewMode,
  expandedDirs,
  onItemClick,
  renderFileIcon,
  formatFileSize,
  formatRelativeTime,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onRefresh,
  treeInteractions,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
}: FileTreeNodeProps) {
  const isDirectory = item.type === 'directory';
  const isOpen = isDirectory && expandedDirs.has(item.path);
  const hasChildren = Boolean(isDirectory && item.children && item.children.length > 0);
  const isRenaming = renamingItem?.path === item.path;

  const nameClassName = cn(
    'text-sm leading-tight truncate',
    isDirectory ? 'font-medium text-foreground' : 'text-foreground/90',
  );

  // View mode only changes the row layout; selection, expansion, and recursion stay shared.
  const rowClassName = cn(
    viewMode === 'detailed'
      ? 'group grid grid-cols-12 gap-2 py-[3px] pr-2 hover:bg-accent/60 rounded-sm transition-colors duration-100'
      : viewMode === 'compact'
      ? 'group flex items-center justify-between py-[3px] pr-2 hover:bg-accent/60 rounded-sm transition-colors duration-100'
      : 'group flex items-center gap-1.5 py-[3px] pr-2 rounded-sm hover:bg-accent/60 transition-colors duration-100',
    isDirectory && isOpen && 'border-l-2 border-primary/30',
    (isDirectory && !isOpen) || !isDirectory ? 'border-l-2 border-transparent' : '',
  );

  // Render rename input if this item is being renamed
  if (isRenaming && setRenameValue && handleConfirmRename && handleCancelRename) {
    return (
      <div
        className={cn(rowClassName, 'bg-accent/30')}
        style={{ paddingLeft: `${level * 16 + 4}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
        <Input
          ref={renameInputRef}
          type="text"
          value={renameValue || ''}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') handleConfirmRename();
            if (e.key === 'Escape') handleCancelRename();
          }}
          onBlur={() => {
            setTimeout(() => {
              handleConfirmRename();
            }, 100);
          }}
          className="h-6 flex-1 text-sm"
          disabled={operationLoading}
        />
      </div>
    );
  }

  const rowContent = (
    <div
      className={cn(
        rowClassName,
        treeInteractions?.isSelected(item.path) && 'bg-primary/15 hover:bg-primary/20',
        treeInteractions?.isMoveTarget(item.path) && 'ring-1 ring-inset ring-primary/60 bg-primary/10',
      )}
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      data-file-row={treeInteractions ? '' : undefined}
      onClick={(e) => (treeInteractions ? treeInteractions.onRowClick(item, e) : onItemClick(item))}
      onDoubleClick={(e) => {
        // A double click on a row fires two clicks first; those already
        // selected the row. Opening on double click must not re-run the
        // single-click selection (which would replace a multi-selection made
        // with modifier keys right before the open).
        e.stopPropagation();
        if (treeInteractions) treeInteractions.onRowDoubleClick(item);
        else onItemClick(item);
      }}
      draggable={Boolean(treeInteractions)}
      onDragStart={(e) => treeInteractions?.onDragStart(e, item)}
      onDragOver={(e) => treeInteractions?.onDragOver(e, item)}
      onDragLeave={(e) => treeInteractions?.onDragLeave(e, item)}
      onDrop={(e) => treeInteractions?.onDrop(e, item)}
    >
      {viewMode === 'detailed' ? (
        <>
          <div className="col-span-5 flex min-w-0 items-center gap-1.5">
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={nameClassName}>{item.name}</span>
          </div>
          <div className="col-span-2 text-sm tabular-nums text-muted-foreground">
            {item.type === 'file' ? formatFileSize(item.size) : ''}
          </div>
          <div className="col-span-3 text-sm text-muted-foreground">{formatRelativeTime(item.modified)}</div>
          <div className="col-span-2 font-mono text-sm text-muted-foreground">{item.permissionsRwx || ''}</div>
        </>
      ) : viewMode === 'compact' ? (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={nameClassName}>{item.name}</span>
          </div>
          <div className="ml-2 flex flex-shrink-0 items-center gap-3 text-sm text-muted-foreground">
            {item.type === 'file' && (
              <>
                <span className="tabular-nums">{formatFileSize(item.size)}</span>
                <span className="font-mono">{item.permissionsRwx}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
          <span className={nameClassName}>{item.name}</span>
        </>
      )}
    </div>
  );

  // Check if context menu callbacks are provided
  const hasContextMenu = onRename || onDelete || onNewFile || onNewFolder || onCopyPath || onDownload || onRefresh;

  return (
    <div className="select-none">
      {hasContextMenu ? (
        <FileContextMenu
          item={item}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onRefresh={onRefresh}
          onUploadHere={treeInteractions?.onUploadHere}
        >
          {rowContent}
        </FileContextMenu>
      ) : (
        rowContent
      )}

      {isDirectory && isOpen && hasChildren && (
        <div className="relative">
          <span
            className="absolute bottom-0 top-0 border-l border-border/40"
            style={{ left: `${level * 16 + 14}px` }}
            aria-hidden="true"
          />
          {item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              level={level + 1}
              viewMode={viewMode}
              expandedDirs={expandedDirs}
              onItemClick={onItemClick}
              renderFileIcon={renderFileIcon}
              formatFileSize={formatFileSize}
              formatRelativeTime={formatRelativeTime}
              onRename={onRename}
              onDelete={onDelete}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onCopyPath={onCopyPath}
              onDownload={onDownload}
              onRefresh={onRefresh}
              treeInteractions={treeInteractions}
              renamingItem={renamingItem}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              handleConfirmRename={handleConfirmRename}
              handleCancelRename={handleCancelRename}
              renameInputRef={renameInputRef}
              operationLoading={operationLoading}
            />
          ))}
        </div>
      )}
    </div>
  );
}
