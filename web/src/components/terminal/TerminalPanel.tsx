import type { CSSProperties, ReactNode } from 'react';

type TerminalPanelProps = {
  /** The terminal pane to mount; injectable for tests. */
  pane?: ReactNode;
  /** Inline style (height) controlled by the parent for resizing. */
  style?: CSSProperties;
};

/**
 * Embedded terminal panel at the bottom of the Files page. The parent mounts it
 * only while the terminal is open, so the pane's WebSocket (and the remote PTY)
 * lives exactly for the panel's lifetime — closing (via the toolbar toggle)
 * exits the shell.
 */
export function TerminalPanel({ pane, style }: TerminalPanelProps) {
  return (
    <div className="relative flex-shrink-0 border-t border-border/60 bg-card" style={style}>
      {pane}
    </div>
  );
}
