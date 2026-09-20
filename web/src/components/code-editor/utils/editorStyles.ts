export const getEditorLoadingStyles = () => {
  return `
    .code-editor-loading {
      background-color: var(--card) !important;
    }

    .code-editor-loading:hover {
      background-color: var(--card) !important;
    }
  `;
};

export const getEditorStyles = () => {
  return `
    .cm-deletedChunk {
      background-color: hsl(var(--destructive) / 0.15) !important;
      border-left: 3px solid hsl(var(--destructive)) !important;
      padding-left: 4px !important;
    }

    .cm-insertedChunk {
      background-color: hsl(var(--success) / 0.15) !important;
      border-left: 3px solid hsl(var(--success)) !important;
      padding-left: 4px !important;
    }

    .cm-editor.cm-merge-b .cm-changedText {
      background: hsl(var(--success) / 0.4) !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-editor .cm-deletedChunk .cm-changedText {
      background: hsl(var(--destructive) / 0.4) !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-gutter.cm-gutter-minimap {
      background-color: var(--muted);
    }

    .cm-editor-toolbar-panel {
      padding: 4px 10px;
      background-color: var(--card);
      border-bottom: 1px solid var(--border);
      color: var(--foreground);
      font-size: 12px;
    }

    .cm-diff-nav-btn,
    .cm-toolbar-btn {
      padding: 3px;
      background: transparent;
      border: none;
      cursor: pointer;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      transition: background-color 0.2s;
    }

    .cm-diff-nav-btn:hover,
    .cm-toolbar-btn:hover {
      background-color: var(--muted);
    }

    .cm-diff-nav-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;
};
