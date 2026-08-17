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
        // Backend wraps the body as { content, path } (JSON). Extract content.
        const body = await res.json();
        if (cancelled) {
          return;
        }
        const raw = typeof body?.content === 'string' ? body.content : '';
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
