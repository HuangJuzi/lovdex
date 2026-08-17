import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, Button } from '../../shared/view/ui';

import { useFileContent } from './useFileContent';
import { FilePreviewBody } from './FilePreviewBody';

export type FilePreviewModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null | undefined;
  filePath: string | null | undefined;
  line?: number;
};

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

export function FilePreviewModal({ open, onOpenChange, projectId, filePath, line }: FilePreviewModalProps) {
  const { t } = useTranslation('chat');
  const state = useFileContent(open ? projectId : null, open ? filePath : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(92dvh,50rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden rounded-2xl border-border/80 bg-popover p-0 shadow-2xl sm:w-[92vw]">
        <DialogTitle>{filePath ? basename(filePath) : 'File preview'}</DialogTitle>

        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{filePath ? basename(filePath) : ''}</p>
            <p className="truncate text-xs text-muted-foreground">{filePath}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('filePreview.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
          {state.loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">...</div>
          ) : state.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{t('filePreview.loadFailed')}</p>
              <p className="break-all text-xs text-muted-foreground">{filePath}</p>
            </div>
          ) : filePath ? (
            <FilePreviewBody
              kind={state.kind}
              language={state.language}
              filePath={filePath}
              content={state.content}
              blobUrl={state.blobUrl}
              truncated={state.truncated}
              line={line}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
