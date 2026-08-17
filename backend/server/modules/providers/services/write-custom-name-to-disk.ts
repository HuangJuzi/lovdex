import { appendFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type SessionRowLike = {
  provider: string;
  provider_session_id: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
};

/**
 * Best-effort write of a user-renamed session title back to the provider's
 * own disk artifacts so the native CLI also shows the new name. Never throws:
 * failures are logged and swallowed so the rename API stays successful.
 *
 * Claude: appends a `custom-title` event to the transcript jsonl_path.
 * Codex: updates `thread_name` for the matching `id` in session_index.jsonl
 *        (append a new line if no entry exists yet).
 *
 * Codex session_index.jsonl row structure (verified against the codex
 * synchronizer's `buildLookupMap(..., 'id', 'thread_name')` call in
 * list/codex/codex-session-synchronizer.provider.ts): each line is a JSON
 * object keyed by at least `id` (the codex session/thread id) and
 * `thread_name` (the human-readable title). On this machine the file
 * `~/.codex/session_index.jsonl` was not present at implementation time,
 * so the minimal `{ id, thread_name }` shape is used when appending a new
 * entry; pre-existing rows are preserved verbatim apart from the updated
 * `thread_name` field.
 */
export async function writeCustomNameToDisk(
  row: SessionRowLike,
  codexIndexPath?: string
): Promise<void> {
  const customName = row.custom_name?.trim();
  if (!customName) return;
  const providerSessionId = row.provider_session_id;
  if (!providerSessionId) return;

  try {
    if (row.provider === 'claude') {
      if (!row.jsonl_path) return;
      const line = JSON.stringify({ type: 'custom-title', sessionId: providerSessionId, customTitle: customName }) + '\n';
      await appendFile(row.jsonl_path, line, 'utf8');
      return;
    }

    if (row.provider === 'codex') {
      const index = codexIndexPath ?? path.join(os.homedir(), '.codex', 'session_index.jsonl');
      let lines: string[] = [];
      try {
        const content = await readFile(index, 'utf8');
        lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      } catch {
        lines = [];
      }
      let found = false;
      const updated = lines.map((l) => {
        try {
          const obj = JSON.parse(l) as Record<string, unknown>;
          if (obj.id === providerSessionId) {
            found = true;
            return JSON.stringify({ ...obj, thread_name: customName });
          }
        } catch { /* keep line as-is */ }
        return l;
      });
      if (!found) {
        updated.push(JSON.stringify({ id: providerSessionId, thread_name: customName }));
      }
      await writeFile(index, updated.join('\n') + '\n', 'utf8');
    }
  } catch (error) {
    console.error('[writeCustomNameToDisk] failed', {
      provider: row.provider,
      providerSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
