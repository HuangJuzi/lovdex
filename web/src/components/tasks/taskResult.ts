// Minimal message shape consumed by pickLastAssistantText. Kept structural so the
// pure function does not need to import the heavier NormalizedMessage type (which
// pulls in workflow/provider types). The real fetch payload satisfies this shape.
export interface AssistantTextMessage {
  kind: string;
  role?: string;
  content?: string;
}

export type TaskResultState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/**
 * Returns the trimmed content of the LAST assistant `text` message in the list,
 * or null if there is none with non-blank content. Used by the task detail page
 * to surface the agent's conclusion without opening the conversation.
 */
export function pickLastAssistantText(messages: readonly AssistantTextMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind !== 'text' || m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (text) return text;
  }
  return null;
}
