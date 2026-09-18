/**
 * Session-transcript compaction: normalized provider messages → plain text.
 *
 * Provider payloads are far too large (and too irregular) to hand an LLM
 * prompt directly, so each message is flattened to one line and capped: tool
 * results to 300 chars, user/assistant text to 1200. The caller gets the gist
 * of what the agent did, not every byte.
 *
 * This logic previously lived as two byte-identical copies — the
 * `get_session_transcript` operator tool and the task-context compression job.
 * It lives in `shared/` because that is the only element type the `boundaries`
 * ESLint config recognises besides `backend-module`; importing it across
 * modules would add a `boundaries/no-unknown` warning to every caller.
 */

/** Per-message cap for a tool result line. */
const MAX_TOOL_RESULT_CHARS = 300;

/** Per-message cap for a user/assistant text line. */
const MAX_TEXT_CHARS = 1200;

/** Returned when every message was blank, so callers never get an empty string. */
const EMPTY_TRANSCRIPT = '(empty transcript)';

/**
 * Flatten normalized session messages into capped plain text, one block per
 * message joined by a blank line. Message shape mirrors what the provider
 * history readers emit: `{ role|kind, content }`, with tool messages carrying
 * `{ toolName, toolResult }` and local slash-commands carrying
 * `{ isLocalCommand, commandName }`.
 */
export function compactTranscriptToText(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as {
      role?: string;
      kind?: string;
      content?: string;
      commandName?: string;
      toolName?: string;
      toolResult?: string;
      isLocalCommand?: boolean;
    };
    const role = m.role ?? m.kind ?? 'message';
    if (m.isLocalCommand && m.commandName) {
      lines.push(`[${role}] /${m.commandName}`);
      continue;
    }
    if (role === 'tool' || m.kind === 'tool') {
      const res = typeof m.toolResult === 'string' ? m.toolResult : '';
      lines.push(`[tool ${m.toolName ?? ''}] ${res.slice(0, MAX_TOOL_RESULT_CHARS)}`);
      continue;
    }
    const text = (m.content ?? '').trim();
    if (text) {
      lines.push(`[${role}] ${text.slice(0, MAX_TEXT_CHARS)}`);
    }
  }
  return lines.join('\n\n') || EMPTY_TRANSCRIPT;
}
