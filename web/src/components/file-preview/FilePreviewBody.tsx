import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { Code, Eye, FileQuestion } from 'lucide-react';

import { useTheme } from '../../contexts/ThemeContext';
import { Markdown } from '../chat/view/subcomponents/Markdown';

import type { FileKind } from './filePreviewTypes';

export type FilePreviewBodyProps = {
  kind: FileKind;
  filePath: string;
  content: string | null;
  blobUrl: string | null;
  truncated: boolean;
  language?: string;
  line?: number;
};

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

function HighlightedText({
  code,
  language,
  isDarkMode,
}: {
  code: string;
  language: string;
  isDarkMode: boolean;
}) {
  return (
    <SyntaxHighlighter
      language={language}
      style={isDarkMode ? oneDark : oneLight}
      showLineNumbers
      customStyle={{ margin: 0, borderRadius: '0.5rem', fontSize: '0.8125rem' }}
    >
      {code}
    </SyntaxHighlighter>
  );
}

function useSafeThemeIsDark(): boolean {
  try {
    return useTheme().isDarkMode;
  } catch {
    return false;
  }
}

export function FilePreviewBody({
  kind,
  filePath,
  content,
  blobUrl,
  truncated,
  language,
}: FilePreviewBodyProps) {
  const { t } = useTranslation('chat');
  const [markdownRendered, setMarkdownRendered] = useState(true);
  const [htmlRendered, setHtmlRendered] = useState(true);
  const isDarkMode = useSafeThemeIsDark();

  const truncationNotice = truncated ? (
    <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
      {t('filePreview.truncated')}
    </div>
  ) : null;

  if (kind === 'image') {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-2 sm:p-4">
        {blobUrl ? (
          <img
            src={blobUrl}
            alt={basename(filePath)}
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </div>
    );
  }

  if (kind === 'unsupported') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileQuestion className="h-8 w-8" />
        <p className="text-sm font-medium text-foreground">
          {t('filePreview.unsupported')}
        </p>
        <p className="break-all text-xs">{filePath}</p>
      </div>
    );
  }

  // markdown / html / text / code — all text-backed.
  const text = content ?? '';
  if (text.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {t('filePreview.emptyFile')}
      </div>
    );
  }

  if (kind === 'markdown') {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMarkdownRendered(true)}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs ${markdownRendered ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          >
            <Eye className="h-3.5 w-3.5" /> {t('filePreview.rendered')}
          </button>
          <button
            type="button"
            onClick={() => setMarkdownRendered(false)}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs ${!markdownRendered ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          >
            <Code className="h-3.5 w-3.5" /> {t('filePreview.source')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {truncationNotice}
          {markdownRendered ? (
            <Markdown className="prose prose-sm max-w-none font-serif dark:prose-invert">
              {text}
            </Markdown>
          ) : (
            <HighlightedText
              code={text}
              language="markdown"
              isDarkMode={isDarkMode}
            />
          )}
        </div>
      </div>
    );
  }

  if (kind === 'html') {
    const showRendered = htmlRendered && !truncated;

    return (
      <div className="flex h-full flex-col">
        <div className="mb-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setHtmlRendered(true)}
            disabled={truncated}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${showRendered ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          >
            <Eye className="h-3.5 w-3.5" /> {t('filePreview.rendered')}
          </button>
          <button
            type="button"
            onClick={() => setHtmlRendered(false)}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs ${!showRendered ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          >
            <Code className="h-3.5 w-3.5" /> {t('filePreview.source')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {truncationNotice}
          {showRendered ? (
            <iframe
              title={basename(filePath)}
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
              srcDoc={text}
              className="h-full min-h-[420px] w-full rounded-lg border border-border bg-white"
            />
          ) : (
            <HighlightedText
              code={text}
              language="markup"
              isDarkMode={isDarkMode}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {truncationNotice}
      <HighlightedText
        code={text}
        language={language || 'text'}
        isDarkMode={isDarkMode}
      />
    </div>
  );
}
