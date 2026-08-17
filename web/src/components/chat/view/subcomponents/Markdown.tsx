import React, { useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { useTranslation } from 'react-i18next';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { useTheme } from '../../../../contexts/ThemeContext';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  onFileOpen?: (filePath: string, line?: number) => void;
};

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// Parse a trailing `:line` / `:line:col` suffix into a line number.
const parseLineSuffix = (value: string): number | undefined => {
  const match = value.match(/:(\d+)(?::\d+)?$/);
  return match ? Number(match[1]) : undefined;
};

// A previewable file reference: its final path segment must carry a file
// extension. This excludes directories (`src/components`, `docs/output/`),
// which have no extension on the last segment and cannot be previewed.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  // Trailing separator => directory, not a file.
  if (/[\\/]$/.test(cleaned)) {
    return false;
  }
  // The last segment (basename) must have an extension like `.ts` / `.png`.
  const base = cleaned.split(/[\\/]/).pop() || '';
  return /\.[a-z0-9]+$/i.test(base);
};

// ---------------------------------------------------------------------------
// Pre-processor: wrap bare file paths in markdown links so the existing <a>
// onClick handler can detect and open them in the preview modal.
// Protected: fenced code blocks, inline code, existing links, and URLs.
// ---------------------------------------------------------------------------

// Path-like run: filename-safe chars plus an optional `:line[:col]` suffix.
// Deliberately excludes CJK and whitespace so a path embedded next to Chinese
// punctuation (e.g. `保存：docs/a.png`) is extracted cleanly.
const BARE_PATH_RE = /[A-Za-z0-9_.@~/\\-]+(?::\d+(?::\d+)?)?/g;

export function autoLinkBareFilePaths(raw: string): string {
  const placeholders: string[] = [];

  const save = (match: string): string => {
    placeholders.push(match);
    return `◊FPPH${placeholders.length - 1}◊`;
  };

  // 1. Protect fenced code blocks (``` .. ```)
  let text = raw.replace(/```[\s\S]*?```/g, save);

  // 2. Protect inline code (`..`)
  text = text.replace(/`[^`]+`/g, save);

  // 3. Protect existing markdown links [text](url)
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, save);

  // 4. Protect URLs so their `//host/path` part is not linked as a file.
  text = text.replace(/\b(?:https?|ftp|file):\/\/[^\s]+/gi, save);

  // 5. Wrap bare file paths in [path](path)
  text = text.replace(BARE_PATH_RE, (token) => {
    if (token.startsWith('◊')) return token;
    // Strip trailing sentence punctuation before the path check.
    const cleaned = token.replace(/[.,;:!?]+$/, '');
    if (cleaned && !/^FPPH\d+$/.test(cleaned) && looksLikeFilePath(cleaned)) {
      const trail = token.slice(cleaned.length);
      return `[${cleaned}](${cleaned})${trail}`;
    }
    return token;
  });

  // 6. Restore protected segments
  text = text.replace(/◊FPPH(\d+)◊/g, (_, i) => placeholders[Number(i)]);

  return text;
}

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  onInlineFileClick?: (fileRef: string) => void;
};

const CodeBlock = ({ node, inline, className, children, onInlineFileClick, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(raw);
  const inlineDetected = inline || (node && node.type === 'inlineCode');
  const shouldInline = inlineDetected || !looksMultiline;

  if (shouldInline) {
    // Inline code that is a lone file path becomes a clickable preview link.
    const trimmed = raw.trim();
    const isFileRef =
      onInlineFileClick && !/\s/.test(trimmed) && !isExternalHref(trimmed) && looksLikeFilePath(trimmed);
    if (isFileRef) {
      return (
        <code
          role="button"
          tabIndex={0}
          onClick={() => onInlineFileClick(trimmed)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onInlineFileClick(trimmed);
            }
          }}
          className={`cursor-pointer whitespace-pre-wrap break-words rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-mono text-[0.9em] text-blue-700 hover:underline dark:border-blue-800/60 dark:bg-blue-900/20 dark:text-blue-300 ${className || ''
            }`}
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100 ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';

  return (
    <div className="group relative my-2">
      {language && language !== 'text' && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(raw).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })
        }
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-foreground/80 opacity-0 transition-opacity hover:bg-muted focus:opacity-100 active:opacity-100 group-hover:opacity-100"
        title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
      >
        {copied ? (
          <span className="flex items-center gap-1">
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            {t('codeBlock.copied')}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
            {t('codeBlock.copy')}
          </span>
        )}
      </button>

      <SyntaxHighlighter
        language={language}
        style={isDarkMode ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderRadius: '0.75rem',
          fontSize: '0.875rem',
          padding: language && language !== 'text' ? '2rem 1rem 1rem 1rem' : '1rem',
          // ChatGPT-style soft grey block in light mode; keep oneDark's own bg in dark.
          ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            ...(isDarkMode ? {} : { background: 'transparent' }),
          },
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  );
};

const markdownComponents = {
  code: CodeBlock,
  // CodeBlock renders its own syntax-highlighted <pre>; this passthrough stops
  // react-markdown (and Tailwind Typography) from wrapping it in a second,
  // dark-themed <pre> shell that would frame the block.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
      {children}
    </blockquote>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{children}</td>
  ),
};

export function Markdown({ children, className, onFileOpen }: MarkdownProps) {
  const content = autoLinkBareFilePaths(normalizeInlineCodeFences(String(children ?? '')));
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const openFileInEditor = useCallback(
    (fileRef: string) => {
      if (!onFileOpen) return;
      const line = parseLineSuffix(fileRef);
      onFileOpen(stripLineSuffix(fileRef), line);
    },
    [onFileOpen],
  );

  const components = useMemo(
    () => ({
      ...markdownComponents,
      code: (codeProps: CodeBlockProps) => (
        <CodeBlock {...codeProps} onInlineFileClick={onFileOpen ? openFileInEditor : undefined} />
      ),
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (fileRef && !isExternalHref(href)) {
          return (
            <a
              href={href || fileRef}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                openFileInEditor(fileRef);
              }}
            >
              {linkChildren}
            </a>
          );
        }

        return (
          <a
            href={href}
            className="text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [openFileInEditor, onFileOpen],
  );

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components as any}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
