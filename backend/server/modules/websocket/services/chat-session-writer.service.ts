import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createCompleteMessage, readObjectRecord } from '@/shared/utils.js';

type ChatSessionWriterOptions = {
  connection: RealtimeClientConnection;
  userId: string | number | null;
  provider: LLMProvider;
  /** Provider-native id when resuming an existing session, otherwise null. */
  providerSessionId: string | null;
  /**
   * Invoked the moment the provider runtime reveals its native session id
   * (either via `setSessionId` or a `session_created` event). The registry
   * persists the app-id-to-provider-id mapping from this callback.
   */
  onProviderSessionId: (providerSessionId: string) => void;
  /**
   * Remaps/sequences/buffers one outbound live event. Implemented by the chat
   * run registry; the writer never forwards a provider event untouched.
   * Returns `null` when the event must be dropped (duplicate terminal
   * `complete` after an abort already completed the run).
   */
  decorateOutboundEvent: (message: NormalizedMessage) => NormalizedMessage | null;
};

/**
 * Gateway writer handed to provider runtimes instead of a raw websocket writer.
 *
 * It exposes the exact same surface as `WebSocketWriter` (`send`,
 * `setSessionId`, `getSessionId`, `updateWebSocket`, `userId`,
 * `isWebSocketWriter`) so the provider runtimes (`claude-sdk.js`,
 * `cursor-cli.js`, ...) need zero changes — but everything that flows through
 * it is translated from the provider's world into the app's protocol:
 *
 * - `session_created` events are swallowed and turned into a provider-id
 *   mapping; the frontend never learns provider-native ids.
 * - every other event gets `sessionId` remapped to the app session id and a
 *   per-run `seq` assigned before being forwarded.
 * - `setSessionId(...)` calls (used by runtimes to label captured ids) are
 *   intercepted and recorded as the provider-id mapping as well.
 */
export class ChatSessionWriter {
  userId: string | number | null;
  /**
   * Some runtimes feature-detect their writer with this flag; keep it so the
   * gateway writer is a drop-in replacement for `WebSocketWriter`.
   */
  isWebSocketWriter = true;

  /**
   * Every subscriber socket this run's live frames are fanned out to.
   *
   * This is a Set (not a single socket) on purpose: a page can be open in more
   * than one tab, and each tab subscribes to the same session. If the writer
   * only sent to the LAST subscriber, a later `chat.subscribe` from another
   * tab would silently steal the stream — the original tab would freeze
   * (no stream_delta) and its input would stay loading until a refresh. With
   * fan-out, every subscribed tab receives the live stream and no tab can
   * steal it from another.
   */
  private sockets = new Set<RealtimeClientConnection>();

  private readonly options: ChatSessionWriterOptions;
  /**
   * The provider-native session id as the runtime knows it. Kept locally
   * (besides the registry) because runtimes read it back via `getSessionId()`
   * to label their own outgoing events — those labels are remapped on send
   * anyway, but the runtime-visible value must stay provider-native.
   */
  private providerSessionId: string | null;

  constructor(options: ChatSessionWriterOptions) {
    this.options = options;
    this.userId = options.userId;
    this.providerSessionId = options.providerSessionId;
    // The socket that sent `chat.send` is the first subscriber. It gets the
    // stream, and so does every later socket that subscribes to this session.
    this.addConnection(options.connection);
  }

  send(data: unknown): void {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') {
      // Provider runtimes only emit kind-based normalized messages. Anything
      // else indicates a programming error; drop it rather than leaking an
      // un-remapped payload to the client.
      console.error('[ChatSessionWriter] Dropping non-normalized outbound payload', data);
      return;
    }

    const message = record as NormalizedMessage;

    if (message.kind === 'session_created') {
      const announcedId =
        typeof message.newSessionId === 'string' && message.newSessionId
          ? message.newSessionId
          : message.sessionId;
      if (announcedId) {
        this.captureProviderSessionId(announcedId);
      }
      // Swallowed on purpose: the frontend already has the stable app session
      // id, so there is no client-side handoff to perform anymore.
      return;
    }

    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Emits the synthetic terminal `complete` for runs that ended without one
   * (runtime crash before completing, or user abort).
   */
  sendComplete(opts: { exitCode: number; aborted?: boolean }): void {
    const message = createCompleteMessage({
      provider: this.options.provider,
      sessionId: this.providerSessionId,
      exitCode: opts.exitCode,
      aborted: opts.aborted,
    });
    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Adds a socket to the run's live fan-out set. Idempotent — re-subscribing
   * from the same socket (session open, reconnect, keepalive) is a no-op.
   *
   * The socket is removed from the set automatically when it closes, so a
   * torn-down tab (refresh, close) stops receiving frames and cannot hold the
   * stream hostage. This is what makes mid-stream page refreshes work: the old
   * tab's socket closes and the new tab's subscribe lands on a clean set.
   */
  addConnection(newConnection: RealtimeClientConnection): void {
    if (!newConnection || this.sockets.has(newConnection)) {
      return;
    }
    this.sockets.add(newConnection);
    newConnection.on?.('close', () => {
      this.sockets.delete(newConnection);
    });
  }

  /**
   * Removes a socket from the live fan-out set. Kept for symmetry / explicit
   * cleanup; the automatic close-listener path covers the normal teardown.
   */
  removeConnection(connection: RealtimeClientConnection): void {
    this.sockets.delete(connection);
  }

  /**
   * Backward-compatible alias: the old contract was "re-bind the single ws".
   * Runtimes and the registry still call this; under fan-out it just adds the
   * connection as another subscriber instead of replacing the previous one.
   */
  updateWebSocket(newConnection: RealtimeClientConnection): void {
    this.addConnection(newConnection);
  }

  setSessionId(sessionId: string): void {
    this.captureProviderSessionId(sessionId);
  }

  getSessionId(): string | null {
    return this.providerSessionId;
  }

  private captureProviderSessionId(providerSessionId: string): void {
    if (!providerSessionId || this.providerSessionId === providerSessionId) {
      return;
    }

    this.providerSessionId = providerSessionId;
    this.options.onProviderSessionId(providerSessionId);
  }

  private forward(message: NormalizedMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === WS_OPEN_STATE) {
        try {
          socket.send(data);
        } catch {
          // A socket that reports OPEN but throws on send is broken — drop it
          // so it stops blocking the run's fan-out to the healthy subscribers.
          this.sockets.delete(socket);
        }
      } else {
        this.sockets.delete(socket);
      }
    }
  }
}
