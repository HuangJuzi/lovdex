import { useTranslation } from 'react-i18next';
import { Download, Loader2, Trash2, X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';

type FileTreeSelectionBarProps = {
  count: number;
  operationLoading?: boolean;
  onDelete: () => void;
  onDownloadZip: () => void;
  onClear: () => void;
};

/** Batch actions for the current multi-selection. Rendered only while at
 *  least one row is selected. Moving is deliberately absent: dragging the
 *  selection onto a folder IS the move affordance. */
export default function FileTreeSelectionBar({
  count,
  operationLoading,
  onDelete,
  onDownloadZip,
  onClear,
}: FileTreeSelectionBarProps) {
  const { t } = useTranslation();
  if (count <= 0) return null;

  return (
    <div className="flex items-center justify-between border-b border-border bg-accent/40 px-3 py-1.5">
      <span className="text-xs font-medium text-foreground">
        {t('fileTree.selection.selected', '{{count}} selected', { count })}
      </span>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onDownloadZip}
          disabled={operationLoading}
          title={t('fileTree.selection.downloadZip', 'Download as ZIP')}
          aria-label={t('fileTree.selection.downloadZip', 'Download as ZIP')}
        >
          <Download className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10"
          onClick={onDelete}
          disabled={operationLoading}
          title={t('fileTree.selection.delete', 'Delete selected')}
          aria-label={t('fileTree.selection.delete', 'Delete selected')}
        >
          {operationLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onClear}
          title={t('fileTree.selection.clear', 'Clear selection')}
          aria-label={t('fileTree.selection.clear', 'Clear selection')}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
