import { readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Lite-side transcript directory resolution + content reading for the
 * `session/messages` RPC (remote chat history).
 *
 * A remote session's transcript is written by the provider CLI ON this host
 * (e.g. `~/.claude/projects/<encoded cwd>/<session>.jsonl`), and the lite is
 * the only component that can reach it. The RPC reads the JSONL + subagent
 * `agent-*.jsonl` files here and ships the raw CONTENT back to main, which
 * decodes it with the shared parser in
 * `server/modules/providers/list/shared/transcript-history.ts` — the lite
 * never re-implements parsing rules, so local and remote history cannot
 * diverge.
 *
 * Directory encoders mirror the main-side providers:
 * - claude: every char outside `[a-zA-Z0-9-]` becomes `-` (see
 *   `encodeClaudeProjectDirName` in claude-sessions.provider.ts).
 * - qoder: every `/` becomes `-` (see `encodeQoderProjectDir` in
 *   qoder-sessions.provider.ts).
 */

export type ProviderSessionFiles = {
  /** True when the main `<providerSessionId>.jsonl` exists on disk. */
  exists: boolean;
  /** Raw content of the main transcript file ('' when missing). */
  transcript: string;
  /** Raw content of each `agent-<id>.jsonl` sibling, keyed by agent id. */
  agentFiles: Record<string, string>;
};

/**
 * Resolve a provider's transcript directory on this host, or null for
 * providers whose format is not implemented (codex/opencode).
 */
export function resolveProviderTranscriptDir(
  provider: string,
  projectPath: string,
  home: string = os.homedir(),
): string | null {
  if (provider === 'claude') {
    const encoded = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
    return path.join(home, '.claude', 'projects', encoded);
  }
  if (provider === 'qoder') {
    const encoded = projectPath.replace(/\//g, '-');
    return path.join(home, '.qoder', 'projects', encoded);
  }
  return null;
}

/**
 * Read a session's transcript directory: the main `<providerSessionId>.jsonl`
 * plus every `agent-*.jsonl` sibling. Missing main file → `exists: false`
 * with empty payload (the caller treats it like the Phase-1 empty history);
 * unreadable agent files are omitted rather than thrown.
 */
export function readSessionMessagesDir(
  provider: string,
  projectPath: string,
  providerSessionId: string,
  home: string = os.homedir(),
): ProviderSessionFiles {
  const dir = resolveProviderTranscriptDir(provider, projectPath, home);
  const mainPath = dir ? path.join(dir, `${providerSessionId}.jsonl`) : null;
  if (!mainPath || !existsSync(mainPath)) {
    return { exists: false, transcript: '', agentFiles: {} };
  }

  let transcript = '';
  try {
    transcript = readFileSync(mainPath, 'utf8');
  } catch {
    // concurrent truncation/unlink mid-run → treat as empty rather than crash
    return { exists: true, transcript: '', agentFiles: {} };
  }

  const agentFiles: Record<string, string> = {};
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return { exists: true, transcript, agentFiles };
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl') || !file.startsWith('agent-')) continue;
    const agentId = file.slice('agent-'.length, -'.jsonl'.length);
    try {
      agentFiles[agentId] = readFileSync(path.join(dir, file), 'utf8');
    } catch {
      // unreadable agent file → omit (main transcript stays intact)
    }
  }

  return { exists: true, transcript, agentFiles };
}