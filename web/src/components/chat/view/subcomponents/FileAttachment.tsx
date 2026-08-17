import { FileIcon } from 'lucide-react';

interface FileAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

const formatSize = (bytes: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const FileAttachment = ({ file, onRemove, uploadProgress, error }: FileAttachmentProps) => (
  <div className="group relative flex h-20 w-24 flex-col items-center justify-center rounded-xl border border-border/50 bg-card shadow-sm">
    <FileIcon className="h-6 w-6 text-primary" />
    <span className="mt-1 max-w-full truncate px-1 text-[11px] text-muted-foreground" title={file.name}>
      {file.name}
    </span>
    <span className="text-[10px] text-muted-foreground/70">{formatSize(file.size)}</span>
    {uploadProgress !== undefined && uploadProgress < 100 && (
      <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
        <div className="text-xs text-white">{uploadProgress}%</div>
      </div>
    )}
    {error && (
      <div
        className="absolute inset-0 flex items-center justify-center rounded-xl bg-red-500/60 p-1 text-center text-[10px] leading-tight text-white"
        title={error}
      >
        {error}
      </div>
    )}
    <button
      type="button"
      onClick={onRemove}
      className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
      aria-label={`Remove ${file.name}`}
    >
      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
);

export default FileAttachment;
