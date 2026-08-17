import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { dbg } from '../dbg';
import { buildWebSocketUrl } from '../utils/wsUrl';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * The most recently created socket. Unlike `wsRef` (only set once the socket
   * is OPEN), this is assigned synchronously when a socket is constructed, so
   * the effect cleanup can close a socket that is still CONNECTING.
   *
   * Why this matters: React.StrictMode in dev double-mounts this provider
   * (mount -> cleanup -> mount). The first mount's `connect()` constructs a
   * socket, but `wsRef.current` is only assigned in `onopen` — which fires
   * *after* the synchronous cleanup. So the old cleanup's `wsRef.current.close()`
   * was a no-op and the first socket leaked, remaining connected forever.
   *
   * A leaked socket that stays subscribed to a running chat session keeps the
   * backend's fan-out Set attached to it instead of the live socket the user is
   * actually looking at. The visible tab then misses every `stream_delta` (text
   * never moves) and the terminal `complete` (the session stays "processing", so
   * the composer queues input until a manual refresh) — exactly the two symptoms.
   */
  const activeSocketRef = useRef<WebSocket | null>(null);
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  /**
   * Outbox for messages sent while the socket was not OPEN. They are flushed
   * in order on (re)connect. Without this, a send during a brief disconnect
   * (e.g. after a Vite proxy idle drop, before the 3s reconnect) would be
   * silently dropped while the UI had already optimistically shown the
   * message as sent+processing — the user would see their message with no
   * reply forever.
   */
  const outboxRef = useRef<unknown[]>([]);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  useEffect(() => {
    // The cleanup below closes the socket for this effect run. Without this
    // reset, a re-run of the effect would short-circuit connect() at its
    // unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      // Close the socket for THIS effect run, even if it is still CONNECTING
      // (wsRef is only set in onopen, so it can be null here). See the
      // activeSocketRef comment — this is what stops the StrictMode leak.
      if (activeSocketRef.current) {
        activeSocketRef.current.close();
        activeSocketRef.current = null;
      }
    };
  }, []);

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      const wsUrl = buildWebSocketUrl(
        typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null
      );

      const websocket = new WebSocket(wsUrl);
      activeSocketRef.current = websocket;

      websocket.onopen = () => {
        // A newer socket superseded this one (StrictMode remount, or a
        // reconnect raced an existing socket). Never activate a stale socket —
        // activating it would make sends go to a socket the backend no longer
        // associates with this view, and leak the extra connection.
        if (activeSocketRef.current !== websocket) {
          try { websocket.close(); } catch { /* ignore */ }
          return;
        }
        dbg('WS onopen');
        setIsConnected(true);
        wsRef.current = websocket;
        // Flush anything queued while the socket was down, in order.
        const pending = outboxRef.current;
        outboxRef.current = [];
        for (const queued of pending) {
          try {
            websocket.send(JSON.stringify(queued));
          } catch (error) {
            console.error('WebSocket failed to flush queued message:', error);
          }
        }
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        // A stale socket closing (e.g. this one was superseded by a remount)
        // must not tear down the live connection or schedule a redundant
        // reconnect — only the current socket owns the lifecycle.
        if (activeSocketRef.current !== websocket) {
          return;
        }
        dbg('WS onclose -> reconnect in 3s');
        setIsConnected(false);
        wsRef.current = null;
        activeSocketRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('WebSocket error', error);
    }
  }, [dispatch]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    const ready = socket ? socket.readyState : 'no-socket';
    const t = (message as { type?: string })?.type ?? '?';
    dbg(`sendMessage type=${t} ready=${ready} open=${WebSocket.OPEN} outbox=${outboxRef.current.length}`);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      dbg(`sent type=${t}`);
    } else {
      // Socket is down (initial connect or between reconnects). Queue so the
      // message is delivered once the socket reopens instead of being lost.
      outboxRef.current.push(message);
      dbg(`queued type=${t} (WS not open)`);
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
