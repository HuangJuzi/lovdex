export type XtermLike = {
  onData: (cb: (data: string) => void) => void;
  write: (data: string) => void;
  dispose: () => void;
};

export type WebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: 'message', cb: (evt: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', cb: (evt: { data: unknown }) => void) => void;
};

export type TerminalSession = {
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
};

const OPEN = 1;

/**
 * Wires an xterm-like terminal to a WebSocket speaking the /ws/terminal
 * protocol: terminal input -> {type:'input'}, {type:'output'} -> terminal.write,
 * resize -> {type:'resize'}. dispose() tears both sides down idempotently.
 */
export function createTerminalSession(term: XtermLike, ws: WebSocketLike): TerminalSession {
  const onData = (data: string): void => {
    if (ws.readyState === OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  };

  const onMessage = (event: { data: unknown }): void => {
    try {
      const parsed = JSON.parse(String(event.data)) as { type?: string; data?: unknown };
      if (parsed.type === 'output' && typeof parsed.data === 'string') {
        term.write(parsed.data);
      }
    } catch {
      // ignore malformed frames
    }
  };

  term.onData(onData);
  ws.addEventListener('message', onMessage);

  let disposed = false;
  return {
    resize(cols: number, rows: number): void {
      if (disposed || ws.readyState !== OPEN) return;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      term.dispose();
      ws.removeEventListener('message', onMessage);
      ws.close();
    },
  };
}
