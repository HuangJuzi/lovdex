# File Preview Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only popup that previews a file's content (markdown, text, code, images) when a user clicks a file path in chat output.

**Architecture:** Revive the existing-but-severed `onFileOpen` callback chain (`Markdown`/`ToolRenderer` → `MessageComponent` → `ChatInterface` → `MainContent`) and the unused `useFileOpenResolver` hook. `MainContent` owns a single `FilePreviewModal` instance; a new `useFileContent` hook fetches content via the existing `api.readFile`/`readFileBlob`; a `FilePreviewBody` renders per file type using the already-present `react-syntax-highlighter` and `Markdown` components inside the shared `Dialog` primitive.

**Tech Stack:** React + TypeScript, Vite, Tailwind, `react-syntax-highlighter` (Prism), `lucide-react`, i18next. Tests: `node --test` via `npx tsx --test` + `react-dom/server` `renderToStaticMarkup`.

---

## Reference facts (verified against the codebase)

- **Dialog primitive:** `src/shared/view/ui` exports `Dialog`, `DialogContent`, `DialogTitle`. Usage pattern (from `CommandResultModal.tsx:561`):
  ```tsx
  <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="...">
      <DialogTitle>...</DialogTitle>
      ...
    </DialogContent>
  </Dialog>
  ```
  `DialogContent` already provides portal render, `z-50`, backdrop blur, overlay-click / Esc close, focus trap, body-scroll lock. Default width `max-w-lg`, override via `className`.
- **API (`src/utils/api.js`):**
  - `api.readFile(projectId, filePath)` → `GET /api/projects/{id}/file?filePath=...`
  - `api.readFileBlob(projectId, filePath)` → `GET /api/projects/{id}/files/content?path=...`
  - `authenticatedFetch` handles auth/token refresh; responses have `.ok`, `.text()`, `.blob()`.
- **Blob pattern (from `ChatMessageImages.tsx:57`):** `const blob = await response.blob(); URL.createObjectURL(blob)`; revoke on cleanup.
- **Syntax highlighter (from `Markdown.tsx`):**
  ```tsx
  import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
  import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
  import { useTheme } from '../../contexts/ThemeContext'; // exports { isDarkMode }
  ```
- **`useFileOpenResolver`** (`src/hooks/useFileOpenResolver.ts`) signature:
  `useFileOpenResolver(selectedProject, onFileOpen): (filePath, diffInfo?) => void`. It resolves bare refs against the file tree, then calls `onFileOpen(match ?? filePath, diffInfo)`. Currently **not called anywhere**.
- **`onFileOpen` chain:** `MainContent.handleFileOpen` (no-op) → `ChatInterface` prop `onFileOpen` → `ChatMessagesPane` (`:261`, `:281`) → `MessageComponent` (`:182`, `:221` via `ToolRenderer`). `Markdown` has an internal no-op `openFileInEditor` and does **not** yet receive `onFileOpen`.
- **i18n:** only `en` locale exists. Chat namespace: `src/i18n/locales/en/chat.json` (top-level keys include `codeBlock`, `json`, `fileOperations`, …). Add a new `filePreview` key group.
- **Test run command:** `npx tsx --test <file>` (verified working on `QuestionAnswerContent.test.tsx`). There is no `test` script in `package.json`.
- **Relative import roots from the new `src/components/file-preview/` dir:**
  - api → `../../utils/api`
  - Dialog/ui → `../../shared/view/ui`
  - ThemeContext → `../../contexts/ThemeContext`
  - Markdown → `../chat/view/subcomponents/Markdown`

---

## File Structure

**Create:**
- `src/components/file-preview/filePreviewTypes.ts` — extension → `{ kind, language }` classification; supported-extension sets; large-file constants.
- `src/components/file-preview/useFileContent.ts` — fetch + lifecycle hook.
- `src/components/file-preview/FilePreviewBody.tsx` — type-dispatched rendering (image / markdown+toggle / highlighted text / unsupported / empty / truncated).
- `src/components/file-preview/FilePreviewModal.tsx` — `Dialog` shell, header, loading/error switch, delegates to body.
- `src/components/file-preview/filePreviewTypes.test.ts` — classification unit tests.
- `src/components/file-preview/FilePreviewBody.test.tsx` — render tests (no network).

**Modify:**
- `src/components/chat/view/subcomponents/Markdown.tsx` — add optional `onFileOpen` prop; parse line number; replace no-op.
- `src/components/chat/view/subcomponents/MessageComponent.tsx` — forward `onFileOpen` into each `<Markdown>`.
- `src/components/chat/tools/components/ContentRenderers/MarkdownContent.tsx` — accept + forward `onFileOpen`.
- `src/components/main-content/view/MainContent.tsx` — add `preview` state, wire `useFileOpenResolver`, render `FilePreviewModal`.
- `src/i18n/locales/en/chat.json` — add `filePreview` translation keys.

---

## Task 1: File-type classification module

**Files:**
- Create: `src/components/file-preview/filePreviewTypes.ts`
- Test: `src/components/file-preview/filePreviewTypes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/file-preview/filePreviewTypes.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFile, MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES } from './filePreviewTypes';

test('classifies markdown extensions', () => {
  assert.equal(classifyFile('docs/foo.md').kind, 'markdown');
  assert.equal(classifyFile('README.markdown').kind, 'markdown');
});

test('classifies code extensions with mapped Prism language', () => {
  assert.deepEqual(classifyFile('a.py'), { kind: 'code', language: 'python' });
  assert.deepEqual(classifyFile('b.ts'), { kind: 'code', language: 'typescript' });
  assert.deepEqual(classifyFile('c.json'), { kind: 'code', language: 'json' });
  assert.deepEqual(classifyFile('d.yml'), { kind: 'code', language: 'yaml' });
});

test('classifies plain-text extensions', () => {
  assert.equal(classifyFile('notes.txt').kind, 'text');
  assert.equal(classifyFile('server.log').kind, 'text');
});

test('classifies image extensions', () => {
  assert.equal(classifyFile('pic.png').kind, 'image');
  assert.equal(classifyFile('icon.svg').kind, 'image');
});

test('classifies unknown / extensionless as unsupported', () => {
  assert.equal(classifyFile('data.bin').kind, 'unsupported');
  assert.equal(classifyFile('Makefile').kind, 'unsupported');
});

test('strips a trailing :line[:col] suffix before reading the extension', () => {
  assert.equal(classifyFile('src/foo.ts:130').kind, 'code');
  assert.equal(classifyFile('src/foo.ts:130:5').kind, 'code');
});

test('exposes large-file guard constants', () => {
  assert.ok(MAX_PREVIEW_BYTES > 0);
  assert.ok(MAX_PREVIEW_LINES > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/file-preview/filePreviewTypes.test.ts`
Expected: FAIL — cannot find module `./filePreviewTypes`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/file-preview/filePreviewTypes.ts`:

```ts
export type FileKind = 'markdown' | 'text' | 'code' | 'image' | 'unsupported';

export type FileClassification = {
  kind: FileKind;
  /** Prism language id for `code`/`text` kinds; undefined otherwise. */
  language?: string;
};

// Large-file guard: render only the prefix above these thresholds so the
// syntax highlighter does not lock up the tab on huge files.
export const MAX_PREVIEW_BYTES = 1_500_000; // 1.5 MB
export const MAX_PREVIEW_LINES = 5000;

const MARKDOWN_EXTS = new Set(['md', 'markdown']);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

const TEXT_EXTS = new Set(['txt', 'log', 'csv', 'env', 'ini', 'conf', 'text']);

// Extension -> Prism language id. Extensions not listed fall back to the
// extension itself; Prism degrades unknown languages to plain text safely.
const CODE_LANG_MAP: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'markup',
  css: 'css',
  scss: 'scss',
  sh: 'bash',
  bash: 'bash',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  sql: 'sql',
  toml: 'toml',
};

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130:5`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

const getExtension = (filePath: string): string => {
  const cleaned = stripLineSuffix(filePath.trim());
  const base = cleaned.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
};

export function classifyFile(filePath: string): FileClassification {
  const ext = getExtension(filePath);
  if (!ext) {
    return { kind: 'unsupported' };
  }
  if (MARKDOWN_EXTS.has(ext)) {
    return { kind: 'markdown', language: 'markdown' };
  }
  if (IMAGE_EXTS.has(ext)) {
    return { kind: 'image' };
  }
  if (ext in CODE_LANG_MAP) {
    return { kind: 'code', language: CODE_LANG_MAP[ext] };
  }
  if (TEXT_EXTS.has(ext)) {
    return { kind: 'text', language: 'text' };
  }
  return { kind: 'unsupported' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/components/file-preview/filePreviewTypes.test.ts`
Expected: PASS — all 7 tests ok.

- [ ] **Step 5: Commit**

```bash
git add src/components/file-preview/filePreviewTypes.ts src/components/file-preview/filePreviewTypes.test.ts
git commit -m "feat(file-preview): add file-type classification module"
```

---

## Task 2: `useFileContent` fetch hook

**Files:**
- Create: `src/components/file-preview/useFileContent.ts`

> No unit test for this hook (network + effects); it is covered by manual verification in Task 7. TDD does not apply to this thin I/O wrapper.

**Verification-first note (spec §8):** The `api.readFile` response body shape is unconfirmed. This hook reads it as **plain text** via `res.text()`. Task 7 includes a manual check; if the backend returns JSON-wrapped content (`{ content }`), change the marked line to parse JSON. Keep this the only place that reads the body.

- [ ] **Step 1: Write the hook**

Create `src/components/file-preview/useFileContent.ts`:

```ts
import { useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';

import { classifyFile, MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES, type FileKind } from './filePreviewTypes';

export type FileContentState = {
  loading: boolean;
  error: string | null;
  kind: FileKind;
  language?: string;
  /** Text body for markdown/text/code kinds. */
  content: string | null;
  /** Object URL for image kinds. */
  blobUrl: string | null;
  /** True when content was truncated by the large-file guard. */
  truncated: boolean;
};

const truncateIfLarge = (raw: string): { text: string; truncated: boolean } => {
  let text = raw;
  let truncated = false;
  if (text.length > MAX_PREVIEW_BYTES) {
    text = text.slice(0, MAX_PREVIEW_BYTES);
    truncated = true;
  }
  const lines = text.split('\n');
  if (lines.length > MAX_PREVIEW_LINES) {
    text = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
    truncated = true;
  }
  return { text, truncated };
};

export function useFileContent(
  projectId: string | null | undefined,
  filePath: string | null | undefined,
): FileContentState {
  const { kind, language } = filePath ? classifyFile(filePath) : { kind: 'unsupported' as FileKind, language: undefined };
  const [state, setState] = useState<FileContentState>({
    loading: false,
    error: null,
    kind,
    language,
    content: null,
    blobUrl: null,
    truncated: false,
  });
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const revokePrevious = () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };

    if (!projectId || !filePath) {
      revokePrevious();
      setState((s) => ({ ...s, loading: false, error: null, content: null, blobUrl: null }));
      return;
    }

    const classification = classifyFile(filePath);
    let cancelled = false;

    revokePrevious();
    setState({
      loading: classification.kind !== 'unsupported',
      error: null,
      kind: classification.kind,
      language: classification.language,
      content: null,
      blobUrl: null,
      truncated: false,
    });

    if (classification.kind === 'unsupported') {
      return;
    }

    const load = async () => {
      try {
        if (classification.kind === 'image') {
          const res = await api.readFileBlob(projectId, filePath);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const blob = await res.blob();
          if (cancelled) {
            return;
          }
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setState((s) => ({ ...s, loading: false, blobUrl: url }));
          return;
        }

        const res = await api.readFile(projectId, filePath);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const raw = await res.text(); // spec §8: swap to res.json().content if backend wraps
        if (cancelled) {
          return;
        }
        const { text, truncated } = truncateIfLarge(raw);
        setState((s) => ({ ...s, loading: false, content: text, truncated }));
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : 'unknown error';
        setState((s) => ({ ...s, loading: false, error: message }));
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [projectId, filePath]);

  // Revoke the outstanding object URL when the hook unmounts.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  return state;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/file-preview/useFileContent.ts
git commit -m "feat(file-preview): add useFileContent fetch hook"
```

---

## Task 3: `FilePreviewBody` renderer + tests

**Files:**
- Create: `src/components/file-preview/FilePreviewBody.tsx`
- Test: `src/components/file-preview/FilePreviewBody.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/file-preview/FilePreviewBody.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FilePreviewBody } from './FilePreviewBody';

// ThemeContext is required by the syntax highlighter path; render inside a
// provider-free tree by relying on FilePreviewBody's own fallback. If the
// component throws without a ThemeProvider, wrap tests accordingly.

test('unsupported kind renders a cannot-preview message without throwing', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="unsupported"
      filePath="data.bin"
      content={null}
      blobUrl={null}
      truncated={false}
    />,
  );
  assert.match(html, /data\.bin/);
});

test('code kind renders the file content', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="code"
      language="python"
      filePath="a.py"
      content="print('hello world')"
      blobUrl={null}
      truncated={false}
    />,
  );
  assert.match(html, /hello world/);
});

test('image kind renders an img with the blob url', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="image"
      filePath="pic.png"
      content={null}
      blobUrl="blob:fake-url"
      truncated={false}
    />,
  );
  assert.match(html, /<img[^>]+blob:fake-url/);
});

test('empty text content renders an empty-file notice', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="text"
      language="text"
      filePath="empty.txt"
      content=""
      blobUrl={null}
      truncated={false}
    />,
  );
  assert.match(html, /empty/i);
});

test('truncated flag renders a truncation notice', () => {
  const html = renderToStaticMarkup(
    <FilePreviewBody
      kind="code"
      language="python"
      filePath="big.py"
      content="x = 1"
      blobUrl={null}
      truncated={true}
    />,
  );
  assert.match(html, /truncated|too large|first/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/file-preview/FilePreviewBody.test.tsx`
Expected: FAIL — cannot find module `./FilePreviewBody`.

- [ ] **Step 3: Write the implementation**

Create `src/components/file-preview/FilePreviewBody.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
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

function HighlightedText({ code, language }: { code: string; language: string }) {
  // useTheme throws outside a ThemeProvider; guard so unit tests (which render
  // without the provider) still work by defaulting to light theme.
  let isDarkMode = false;
  try {
    isDarkMode = useTheme().isDarkMode;
  } catch {
    isDarkMode = false;
  }
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

  const truncationNotice = truncated ? (
    <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
      {t('filePreview.truncated')}
    </div>
  ) : null;

  if (kind === 'image') {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        {blobUrl ? (
          <img src={blobUrl} alt={basename(filePath)} className="max-h-full max-w-full object-contain" />
        ) : null}
      </div>
    );
  }

  if (kind === 'unsupported') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileQuestion className="h-8 w-8" />
        <p className="text-sm font-medium text-foreground">{t('filePreview.unsupported')}</p>
        <p className="break-all text-xs">{filePath}</p>
      </div>
    );
  }

  // markdown / text / code — all text-backed.
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
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${markdownRendered ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          >
            <Eye className="h-3.5 w-3.5" /> {t('filePreview.rendered')}
          </button>
          <button
            type="button"
            onClick={() => setMarkdownRendered(false)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${!markdownRendered ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
          >
            <Code className="h-3.5 w-3.5" /> {t('filePreview.source')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {truncationNotice}
          {markdownRendered ? (
            <Markdown className="prose prose-sm max-w-none font-serif dark:prose-invert">{text}</Markdown>
          ) : (
            <HighlightedText code={text} language="markdown" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {truncationNotice}
      <HighlightedText code={text} language={language || 'text'} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/components/file-preview/FilePreviewBody.test.tsx`
Expected: PASS — all 5 tests ok.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/file-preview/FilePreviewBody.tsx src/components/file-preview/FilePreviewBody.test.tsx
git commit -m "feat(file-preview): add FilePreviewBody renderer"
```

---

## Task 4: i18n keys

**Files:**
- Modify: `src/i18n/locales/en/chat.json`

- [ ] **Step 1: Add the `filePreview` key group**

Add this top-level entry to `src/i18n/locales/en/chat.json` (insert after the existing `json` block; keep valid JSON — mind the trailing comma):

```json
  "filePreview": {
    "unsupported": "Preview not available for this file type",
    "emptyFile": "(empty file)",
    "truncated": "File is large — showing the first part only",
    "rendered": "Preview",
    "source": "Source",
    "loadFailed": "Failed to load file",
    "retry": "Retry",
    "close": "Close"
  },
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "require('./src/i18n/locales/en/chat.json'); console.log('ok')"`
Expected: prints `ok` (no JSON parse error).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/locales/en/chat.json
git commit -m "feat(file-preview): add i18n strings"
```

---

## Task 5: `FilePreviewModal` shell

**Files:**
- Create: `src/components/file-preview/FilePreviewModal.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/file-preview/FilePreviewModal.tsx`:

```tsx
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
      <DialogContent className="flex h-[80vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-2xl border-border/80 bg-popover p-0 shadow-2xl">
        <DialogTitle>{filePath ? basename(filePath) : 'File preview'}</DialogTitle>

        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{filePath ? basename(filePath) : ''}</p>
            <p className="truncate text-xs text-muted-foreground">{filePath}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('filePreview.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-3">
          {state.loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">…</div>
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
```

- [ ] **Step 2: Confirm `Button` is exported from the ui barrel**

Run: `grep -n "Button" src/shared/view/ui/index.ts`
Expected: a line exporting `Button`. (If absent, import it from `'../../shared/view/ui/Button'` instead.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/file-preview/FilePreviewModal.tsx
git commit -m "feat(file-preview): add FilePreviewModal shell"
```

---

## Task 6: Wire the `onFileOpen` chain

This task connects the dead plumbing end-to-end. After it, clicking a file path in chat opens the modal.

**Files:**
- Modify: `src/components/chat/view/subcomponents/Markdown.tsx`
- Modify: `src/components/chat/view/subcomponents/MessageComponent.tsx`
- Modify: `src/components/chat/tools/components/ContentRenderers/MarkdownContent.tsx`
- Modify: `src/components/main-content/view/MainContent.tsx`

- [ ] **Step 1: Add `onFileOpen` prop to `Markdown` and parse the line number**

In `src/components/chat/view/subcomponents/Markdown.tsx`:

Change the props type:

```tsx
type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  onFileOpen?: (filePath: string, line?: number) => void;
};
```

Add a line-number parser near `stripLineSuffix` (which already exists in this file):

```tsx
// Parse a trailing `:line` / `:line:col` suffix into a line number.
const parseLineSuffix = (value: string): number | undefined => {
  const match = value.match(/:(\d+)(?::\d+)?$/);
  return match ? Number(match[1]) : undefined;
};
```

Change the function signature and replace the no-op `openFileInEditor`:

```tsx
export function Markdown({ children, className, onFileOpen }: MarkdownProps) {
  const content = normalizeInlineCodeFences(String(children ?? ''));
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const openFileInEditor = useCallback(
    (file: string) => {
      const line = parseLineSuffix(file);
      onFileOpen?.(stripLineSuffix(file), line);
    },
    [onFileOpen],
  );
```

Then update the `a` onClick to pass the raw ref (with suffix) so the line is parseable:

```tsx
              onClick={(event) => {
                event.preventDefault();
                openFileInEditor(fileRef);
              }}
```

(Previously it called `openFileInEditor(stripLineSuffix(fileRef))`; now `openFileInEditor` strips internally after extracting the line.)

- [ ] **Step 2: Forward `onFileOpen` from `MessageComponent` into each `<Markdown>`**

In `src/components/chat/view/subcomponents/MessageComponent.tsx`, the component already receives `onFileOpen` in props (`MessageComponentProps.onFileOpen`, destructured at line ~47). Add `onFileOpen={onFileOpen}` to each `<Markdown>` usage. There are four:

- The tool-use displayText block (~line 169):
  ```tsx
  <Markdown className="prose prose-sm max-w-none font-serif dark:prose-invert" onFileOpen={onFileOpen}>
    {String(message.displayText || '')}
  </Markdown>
  ```
- The error tool-result block (~line 207):
  ```tsx
  <Markdown className="prose prose-sm prose-red max-w-none font-serif dark:prose-invert" onFileOpen={onFileOpen}>
    {String(message.toolResult.content || '')}
  </Markdown>
  ```
- The thinking block (~line 315):
  ```tsx
  <Markdown className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert" onFileOpen={onFileOpen}>
    {message.content}
  </Markdown>
  ```
- The normal assistant content block (~line 372):
  ```tsx
  <Markdown className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert" onFileOpen={onFileOpen}>
    {content}
  </Markdown>
  ```

- [ ] **Step 3: Forward `onFileOpen` through `MarkdownContent`**

Replace `src/components/chat/tools/components/ContentRenderers/MarkdownContent.tsx` with:

```tsx
import React from 'react';
import { Markdown } from '../../../view/subcomponents/Markdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
  onFileOpen?: (filePath: string, line?: number) => void;
}

/**
 * Renders markdown content with proper styling
 * Used by: exit_plan_mode, long text results, etc.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = 'mt-1 prose prose-sm max-w-none dark:prose-invert',
  onFileOpen,
}) => {
  return (
    <Markdown className={className} onFileOpen={onFileOpen}>
      {content}
    </Markdown>
  );
};
```

> Note: `ToolRenderer` passes `onFileOpen` with signature `(filePath, diffInfo?) => void`. The extra `line?: number` argument is compatible — existing callers that pass a second `diffInfo` still typecheck because both are optional. `MainContent` (Task 6 Step 4) ignores the second argument.

- [ ] **Step 4: Wire `MainContent` to open the modal**

In `src/components/main-content/view/MainContent.tsx`:

Add imports at the top (after existing imports):

```tsx
import { useState } from 'react';

import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { FilePreviewModal } from '../../file-preview/FilePreviewModal';
```

> `React` is already imported. Merge `useState` into the existing React import if the file uses `import React from 'react'` only — otherwise add the named import as shown.

Replace the no-op handler (line 37: `const handleFileOpen = (_filePath: string) => {};`) with:

```tsx
  const [preview, setPreview] = useState<{ filePath: string; line?: number } | null>(null);

  // Resolve bare/partial refs (e.g. `foo.ts`) against the project file tree,
  // then open the read-only preview modal.
  const handleFileOpen = useFileOpenResolver(selectedProject, (filePath: string) => {
    setPreview({ filePath });
  });
```

> The resolver's callback signature is `(filePath, diffInfo?)`; line numbers are not threaded through the resolver, so best-effort scroll-to-line is deferred. The modal still receives `line` from `preview.line` when set directly (currently unset — acceptable per spec §7 "best-effort").

Render the modal. Add it just before the final closing `</div>` of the returned JSX (after the chat `<div className="flex min-h-0 flex-1 overflow-hidden">…</div>` block, inside the outer `<div className="flex h-full flex-col">`):

```tsx
      <FilePreviewModal
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
          }
        }}
        projectId={selectedProject?.projectId}
        filePath={preview?.filePath}
        line={preview?.line}
      />
```

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS with no errors.

- [ ] **Step 6: Run the full preview test suite**

Run: `npx tsx --test src/components/file-preview/*.test.ts*`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/view/subcomponents/Markdown.tsx \
        src/components/chat/view/subcomponents/MessageComponent.tsx \
        src/components/chat/tools/components/ContentRenderers/MarkdownContent.tsx \
        src/components/main-content/view/MainContent.tsx
git commit -m "feat(file-preview): wire onFileOpen chain to open preview modal"
```

---

## Task 7: Manual verification & response-shape confirmation

**Files:** none (verification only). Requires a running `lovdex-backend`.

- [ ] **Step 1: Confirm the `api.readFile` response shape (spec §8)**

Start the app: `npm run dev`. In the browser devtools Network tab, click a file path in chat output and inspect the `GET /api/projects/{id}/file?filePath=...` response.

- If the response body is **plain text** → no change needed.
- If it is **JSON** like `{ "content": "..." }` → in `useFileContent.ts`, change:
  ```ts
  const raw = await res.text();
  ```
  to:
  ```ts
  const raw = (await res.json()).content ?? '';
  ```
  Then re-run `npm run typecheck` and commit:
  ```bash
  git add src/components/file-preview/useFileContent.ts
  git commit -m "fix(file-preview): parse JSON-wrapped readFile response"
  ```

- [ ] **Step 2: Manual functional checks**

With `npm run dev` running, verify each:

- Click a `.md` path → modal opens, defaults to rendered Markdown; toggle to Source shows highlighted markdown; toggle back works.
- Click a `.py` / `.json` / `.ts` path → syntax-highlighted content with line numbers.
- Click a `.txt` / `.log` path → plain highlighted text.
- Click a `.png` / `.svg` path → image displays centered.
- Click a `.bin` / extensionless path → "Preview not available" message.
- Click a non-existent path → "Failed to load file" error state.
- Press Esc / click the backdrop / click the X → modal closes.
- Reopen a different file → content refreshes (no stale content, no leaked blob URL — check devtools memory/Network).

- [ ] **Step 3: Final full check**

Run: `npm run typecheck && npm run lint && npx tsx --test src/components/file-preview/*.test.ts*`
Expected: all PASS.

- [ ] **Step 4: Commit any verification fixes** (if not already committed in Step 1).

---

## Self-Review

**Spec coverage:**
- §4 trigger & data flow → Task 6 (full chain wiring). ✓
- §5 module layout (4 files) → Tasks 1, 2, 3, 5. ✓
- §6 file-type rules table → Task 1 (classification) + Task 3 (rendering). ✓
- §7 states/errors, large-file guard, close semantics → Task 2 (truncate + blob revoke), Task 3 (empty/unsupported/truncated), Task 5 (loading/error/close). ✓
- §8 readFile response-shape verification → Task 2 note + Task 7 Step 1. ✓
- §9 testing (node:test + renderToStaticMarkup, typecheck, lint, manual) → Tasks 1, 3, 6, 7. ✓
- md render/source toggle → Task 3. ✓
- image preview via readFileBlob → Task 2 + Task 3. ✓
- activate unused `useFileOpenResolver` → Task 6 Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The `useFileContent` no-test decision is justified (thin I/O wrapper, covered by manual verification).

**Type consistency:**
- `FileKind` / `FileClassification` defined in Task 1, imported unchanged in Tasks 2 & 3. ✓
- `classifyFile` used consistently in Tasks 1, 2. ✓
- `FileContentState` fields (`loading, error, kind, language, content, blobUrl, truncated`) produced in Task 2, consumed in Task 5 and passed to `FilePreviewBody` (Task 3) with matching prop names. ✓
- `FilePreviewBodyProps` (Task 3) matches the props passed by `FilePreviewModal` (Task 5). ✓
- `FilePreviewModalProps` (Task 5) matches the usage in `MainContent` (Task 6). ✓
- `onFileOpen: (filePath, line?) => void` in `Markdown`/`MarkdownContent` (Task 6) is compatible with the existing `(filePath, diffInfo?) => void` callers (both second args optional). ✓
