/**
 * Debug sink for the chat "no reply" investigation.
 *
 * Traces are POSTed to /api/__dbglog over HTTP (via the Vite dev proxy),
 * which appends them to /tmp/chat-debug.log. HTTP is used (not the chat WS)
 * so traces still arrive even when the WS itself is down — that's exactly
 * the failure window we need visibility into.
 *
 * Fire-and-forget; never throws into the caller. Low volume: a handful of
 * checkpoints per send.
 */
export function dbg(label: string): void {
  try {
    void fetch('/api/__dbglog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg: label }),
      keepalive: true,
    }).catch(() => {
      // ignore — debug only
    });
  } catch {
    // ignore
  }
}
