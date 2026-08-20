export type FileKind =
  'markdown' | 'html' | 'text' | 'code' | 'image' | 'unsupported';

export type FileClassification = {
  kind: FileKind;
  /** Prism language id for text-backed preview kinds; undefined otherwise. */
  language?: string;
};

// Large-file guard: render only the prefix above these thresholds so the
// syntax highlighter does not lock up the tab on huge files.
export const MAX_PREVIEW_BYTES = 1_500_000; // 1.5 MB
export const MAX_PREVIEW_LINES = 5000;

const MARKDOWN_EXTS = new Set(['md', 'markdown']);

const HTML_EXTS = new Set(['html', 'htm']);

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

const TEXT_EXTS = new Set([
  'txt',
  'log',
  'csv',
  'env',
  'ini',
  'conf',
  'text',
  'gitignore',
  'envrc',
]);

// Extension -> Prism language id. Extensions not listed here fall through
// to TEXT_EXTS, and if not found there either, become 'unsupported'.
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
const stripLineSuffix = (value: string): string =>
  value.replace(/:\d+(?::\d+)?$/, '');

const getExtension = (filePath: string): string => {
  const cleaned = stripLineSuffix(filePath.trim());
  const base = cleaned.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  // No dot → no extension.
  if (dot === -1) {
    return '';
  }
  // Dot-prefixed file (e.g. `.env`, `.gitignore`) → treat the whole
  // basename as the extension so `.env` matches TEXT_EXTS.
  if (dot === 0) {
    return base.slice(1).toLowerCase();
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
  if (HTML_EXTS.has(ext)) {
    return { kind: 'html', language: 'markup' };
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
