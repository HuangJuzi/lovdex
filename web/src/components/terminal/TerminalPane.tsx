import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
import { buildWebSocketUrl } from '../../utils/wsUrl';
import { createTerminalSession } from './terminalSession';

/**
 * Mounts an xterm.js terminal and a dedicated /ws/terminal WebSocket. The
 * socket is opened on mount and torn down on unmount (closing the drawer
 * therefore exits the remote shell — a fresh shell spawns next open).
 *
 * The shell starts in the drawer's `cwd` (the current project directory, when
 * known), passed through as a query param and validated server-side.
 */
export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { cwd } = useTerminalDrawer();
  // Freeze the cwd at mount: the shell should start in whatever project the
  // user was in when they opened the drawer, and not restart mid-session if the
  // selection changes underneath it.
  const cwdRef = useRef(cwd);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#141414' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null;
    let url = buildWebSocketUrl(token, '/ws/terminal');
    if (cwdRef.current) {
      url += `${url.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwdRef.current)}`;
    }
    const ws = new WebSocket(url);
    const session = createTerminalSession(term, ws);

    const sendResize = () => {
      try {
        fitAddon.fit();
        session.resize(term.cols, term.rows);
      } catch {
        // container not measurable yet (e.g. drawer animating in); next tick will retry
      }
    };
    // fit() can no-op if xterm hasn't measured a cell yet on the first paint;
    // a rAF re-fit plus the ResizeObserver covers both that race and real size
    // changes (window resize, drawer width change).
    sendResize();
    const raf = requestAnimationFrame(sendResize);
    const observer = new ResizeObserver(sendResize);
    observer.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      session.dispose();
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0 overflow-hidden" />;
}
