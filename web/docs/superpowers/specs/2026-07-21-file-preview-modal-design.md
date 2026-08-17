# File Preview Modal — Design

- Date: 2026-07-21
- Status: Approved (brainstormed)
- Scope: `lovdex-cli` frontend (React + Vite SPA)

## 1. Goal

Add a read-only popup that previews file content when a file path in chat output is
clicked. Supports markdown, plain text, code (py/json/ts/etc.), and images. Binary or
otherwise unsupported files show a clear "cannot preview" message.

## 2. Background — existing plumbing

The codebase already invested in file-path detection and an `onFileOpen` callback chain,
but two no-ops sever it. This design revives that plumbing rather than building parallel
mechanisms.

- `src/components/chat/view/subcomponents/Markdown.tsx` — already detects file paths in
  message links (`looksLikeFilePath`, strips `:line:col` suffixes via `stripLineSuffix`)
  and renders them as clickable blue anchors. The click handler `openFileInEditor` is
  currently a **no-op** ("simplified edition" removed the in-app editor).
- `src/components/main-content/view/MainContent.tsx` — passes a no-op
  `handleFileOpen = (_filePath: string) => {}` down to `ChatInterface`.
- `src/hooks/useFileOpenResolver.ts` — resolves bare/partial references
  (`foo.ts`, `utils/foo.ts`) against the project file tree, then calls `onFileOpen`.
  **Defined but never called anywhere** — dead code this design activates.
- `onFileOpen` is threaded through `ChatInterface → MessageComponent → ToolRenderer`.
- `src/utils/api.js`:
  - `api.readFile(projectId, filePath)` → `GET /api/projects/{id}/file?filePath=...`
  - `api.readFileBlob(projectId, filePath)` → `GET /api/projects/{id}/files/content?path=...`
  - `api.getFiles(projectId)` → file tree (used by the resolver)
- `src/shared/view/ui/Dialog.tsx` — portal-based dialog primitive (`Dialog`,
  `DialogContent`, `DialogTitle`): fixed `inset-0 z-50`, overlay with backdrop blur,
  click-overlay / Esc to close, focus trap, body-scroll lock, auto-focus, controlled via
  `open` / `onOpenChange`. Default content width `max-w-lg`, overridable via `className`.
- `react-syntax-highlighter` (Prism, `oneDark`/`oneLight`) already used by `Markdown` —
  syntax highlighting for py/json/etc. is free.

## 3. Non-goals (YAGNI)

- No editing / saving (read-only preview only).
- No new test framework — reuse existing `node:test` + `renderToStaticMarkup` pattern.
- No network-hook unit tests for `useFileContent` (covered by manual verification).
- No `FilePreviewContext` provider (Approach A); revisit if many unrelated components
  need to trigger previews later.

## 4. Trigger & data flow

```
user clicks a file path in a chat message link / tool output
      │
   Markdown.a  or  ToolRenderer  ──calls──▶  onFileOpen(filePath, lineNo?)
      │
   MessageComponent / MarkdownContent  (forward onFileOpen to <Markdown>)
      │
   ChatInterface  (forwards onFileOpen)
      │
   MainContent.handleFileOpen(filePath, line)   ← was no-op, now opens modal
      │
   useFileOpenResolver(selectedProject, setPreview)  resolves bare refs → full path
      │
   setPreview({ filePath, line })  →  <FilePreviewModal>
      │
   api.readFile / readFileBlob  →  per-type rendering
```

- **One** modal instance, owned by `MainContent` (it has `selectedProject` for the API).
- `MainContent.handleFileOpen` becomes `setPreview(...)`, wrapped by
  `useFileOpenResolver(selectedProject, ...)` so bare/partial refs resolve first.
- `Markdown` gains an optional `onFileOpen` prop, replacing the internal no-op
  `openFileInEditor`. The stripped `:line:col` suffix is parsed into a line number and
  forwarded (best-effort scroll-to-line).

## 5. Module layout

New focused module under `src/components/file-preview/`:

```
src/components/file-preview/
├── FilePreviewModal.tsx      // Dialog shell + header + loading/error states; delegates to body
├── FilePreviewBody.tsx       // type-dispatched rendering; .md render/source toggle
├── useFileContent.ts         // fetch (readFile for text, readFileBlob for images); lifecycle
└── filePreviewTypes.ts       // classify by extension, supported set, kind enum, language map
```

### 5.1 `useFileContent(projectId, filePath)`

- Returns `{ content: string | null, blobUrl: string | null, loading, error, kind, language }`.
- `kind` is derived from the extension (cheap, synchronous, no request).
  - `unsupported` → no request, `loading=false` immediately.
  - `image` → `api.readFileBlob` → `res.blob()` → `URL.createObjectURL`.
  - `markdown` / `text` / `code` → `api.readFile` → `res.text()` → size guard.
- Revokes the previous blob URL on unmount or when `filePath` changes (no leak).
- `filePath` is the effect dependency.

### 5.2 `FilePreviewModal.tsx` (controlled)

- Props: `{ open, onOpenChange, projectId, filePath, line? }`.
- `<Dialog open onOpenChange>` + `<DialogContent className="max-w-4xl h-[80vh] w-[90vw]">`.
- Header: file basename (primary), full path (muted), close button (right).
- Body switches on `loading / error / kind`.
- Reset body state when `filePath` changes (the modal in `MainContent` is keyed by
  `filePath` so it remounts cleanly).

### 5.3 `FilePreviewBody.tsx`

- Props: `{ content, blobUrl, kind, language, filePath, line? }`.
- `image` → `<img>` centered, max-scaled.
- `markdown` → toggle between rendered (reuse `Markdown` component) and source
  (`SyntaxHighlighter` language=markdown). Toggle in header (`Eye`/`Code` icons from
  `lucide-react`); default **preview**; state resets on file change.
- `text` / `code` → `SyntaxHighlighter` with mapped Prism language; `showLineNumbers`;
  if `line` given, highlight it and `scrollIntoView` on mount.
- `unsupported` → "cannot preview" + file name + path; optional download button.
- empty content → "(empty file)".

### 5.4 `filePreviewTypes.ts`

- `classify(filePath): { kind, language }`.
- Extension → Prism language map (`py→python`, `js→javascript`, `ts→typescript`,
  `yml→yaml`, …). Unknown extension → extension itself; still unknown to Prism →
  safe fallback `text` (SyntaxHighlighter degrades gracefully, never throws).

### 5.5 Edits to existing files

- `Markdown.tsx` — add optional `onFileOpen?: (filePath: string, line?: number) => void`;
  in the `a` onClick, call `onFileOpen?.(cleanedPath, lineNumber)` (no-op fallback when
  unset, so existing call sites keep working).
- `MessageComponent.tsx` — forward its existing `onFileOpen` to each `<Markdown>` usage.
- `MarkdownContent.tsx` (`src/components/chat/tools/components/ContentRenderers/`) —
  accept and forward `onFileOpen` to `<Markdown>`; `ToolRenderer` already has it.
- `MainContent.tsx` — add `preview` state; `handleFileOpen =
  useFileOpenResolver(selectedProject, (filePath, line) => setPreview({ filePath, line }))`;
  render `<FilePreviewModal ... key={preview?.filePath} />`.

## 6. File type rules

| kind | extensions | rendering |
|---|---|---|
| `markdown` | `md`, `markdown` | render/source toggle (default render) |
| `text` | `txt`, `log`, `csv`, `env`, `ini`, `conf`, … | `SyntaxHighlighter` language=text |
| `code` | `py`, `js`, `jsx`, `ts`, `tsx`, `json`, `yaml`/`yml`, `xml`, `html`, `css`, `scss`, `sh`, `go`, `rs`, `java`, `c`, `cpp`, `sql`, … | `SyntaxHighlighter`, mapped language |
| `image` | `png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`, `ico` | `<img>` centered |
| `unsupported` | other / no extension / binary | "cannot preview" + name + path |

`text` and `code` share one highlighting branch (only the Prism language differs).

## 7. States & error handling

| state | display |
|---|---|
| `loading` | centered spinner (reuse `ActivityIndicator` or `Shimmer`) |
| `error` (404 / unresolvable path) | red box: "file not found or unreadable" + path |
| `error` (network / auth) | "load failed" + retry button (reset effect) |
| `unsupported` | "cannot preview" + file name + path; optional download via `readFileBlob` |
| empty file | "(empty file)" |

Close: Esc / overlay click / close button → `onOpenChange(false)` → `MainContent` clears
`preview`; `useFileContent` revokes any blob URL.

Large-file guard: truncate above **1.5 MB or 5000 lines**, render the prefix with a
"file too large, showing first N lines" notice. Threshold adjustable.

Resolution fallback: if `useFileOpenResolver.findBestMatch` returns null, the original
`filePath` is passed through; the modal shows a 404 if the backend can't read it.

## 8. Open question to verify during implementation

- **`api.readFile` response shape**: is the body plain text or JSON-wrapped
  (`{ content }`)? First implementation step is to hit the endpoint once and confirm;
  `useFileContent` parses accordingly (`res.text()` vs `res.json().content`). The sibling
  `readFileBlob` is clearly binary (`res.blob()`).

## 9. Testing

Runner: `node --test` + `react-dom/server` `renderToStaticMarkup`, matching the existing
`QuestionAnswerContent.test.tsx`. Plus `npm run typecheck` and `npm run lint`.

Unit (pure logic, highest value):

1. `filePreviewTypes.test.ts` — classification: `foo.md`/`README.markdown`→markdown;
   `a.py`/`b.ts`/`c.json`/`d.yaml`→code with correct language map; `x.png`/`y.svg`→image;
   `data.bin`/no-extension→unsupported; `:130` suffix handled.
2. `FilePreviewBody.test.tsx` — `renderToStaticMarkup`, no network:
   unsupported→renders "cannot preview" without throwing; code with content→output
   contains content; image with blobUrl→renders `<img>`; empty→"(empty file)";
   oversized→truncation notice present.

Manual / integration (written into the implementation plan, not automated):

- `npm run dev` (needs backend), click a path in chat → modal opens; .md toggles
  preview/source; image displays; 404 path shows error; Esc closes.

Not done (YAGNI): no vitest/RTL, no `useFileContent` network-hook tests, no Dialog tests.

## 10. Approach considered and rejected

- **Approach B — `FilePreviewContext` provider**: cleaner for `Markdown` (no prop) and
  extensible, but adds context machinery and needs `selectedProject` access at the root.
  All current triggers already flow through the existing `onFileOpen` chain, so a context
  buys little now. Revisit if unrelated components need to trigger previews.
- **Approach C — per-message inline modal**: rejected — wasteful instances, focus/z-index
  headaches, no benefit.
