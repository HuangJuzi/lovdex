import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';

/**
 * Content-based transcript parsing shared by the claude and qoder providers.
 *
 * Both providers previously duplicated a ~110-line `getSessionMessages`
 * (stream-read jsonl → filter by provider session id → read `agent-*.jsonl`
 * subagent tools → attach → sort) plus a ~90-line `parseAgentTools`. The
 * decode half of that pipeline is here, operating on raw STRINGS so one core
 * serves every source: local transcript files (readTranscriptDir) AND the
 * remote `session/messages` RPC payload (lite reads the files on the remote
 * host, sends the content back, main decodes identically). No provider
 * needs its own copy; the lite never re-plays these rules.
 */

/**
 * Parse JSONL content into records, skipping blank and malformed lines.
 */
export function parseJsonlRecords(content: string): AnyRecord[] {
  const records: AnyRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }
  return records;
}

/**
 * Filter provider-native records down to one session id (each claude/qoder
 * jsonl file is named after a session, but extra rows can appear while the
 * file is shared/written, so the same filter the old fs path applied stays).
 */
export function filterProviderSessionRecords(records: AnyRecord[], providerSessionId: string): AnyRecord[] {
  return records.filter((record) => record.sessionId === providerSessionId);
}

/**
 * Parse a subagent `agent-*.jsonl` content into `{toolId,toolName,toolInput,
 * timestamp}` tools with matched `toolResult` (mirrors the old fs-based
 * `parseAgentTools`).
 */
export function parseAgentToolsContent(agentJsonl: string): AnyRecord[] {
  const tools: AnyRecord[] = [];
  for (const record of parseJsonlRecords(agentJsonl)) {
    if (record.message?.role === 'assistant' && Array.isArray(record.message?.content)) {
      for (const part of record.message.content as AnyRecord[]) {
        if (part.type === 'tool_use') {
          tools.push({
            toolId: part.id,
            toolName: part.name,
            toolInput: part.input,
            timestamp: record.timestamp,
          });
        }
      }
    }

    if (record.message?.role === 'user' && Array.isArray(record.message?.content)) {
      for (const part of record.message.content as AnyRecord[]) {
        if (part.type !== 'tool_result') continue;
        const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
        if (!tool) continue;
        tool.toolResult = {
          content: typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? part.content
                .map((contentPart: AnyRecord) => contentPart?.text || '')
                .join('\n')
              : JSON.stringify(part.content),
          isError: Boolean(part.is_error),
        };
      }
    }
  }
  return tools;
}

/**
 * Sort provider-native records by timestamp ascending.
 */
export function sortByTimestamp(records: AnyRecord[]): AnyRecord[] {
  return records.sort(
    (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
  );
}

/**
 * Assemble provider-native history records for one session from the main
 * transcript content plus the subagent `agent-*` file contents. Filters to
 * `providerSessionId`, attaches each `toolUseResult.agentId`'s parsed tools as
 * `subagentTools` (only when tools exist, matching the old local behavior),
 * and returns records sorted by timestamp.
 */
export function assembleHistoryRecords(
  transcript: string,
  agentFiles: Record<string, string>,
  providerSessionId: string,
): AnyRecord[] {
  const messages = filterProviderSessionRecords(parseJsonlRecords(transcript), providerSessionId);

  const agentIds = new Set<string>();
  for (const message of messages) {
    const agentId = message.toolUseResult?.agentId;
    if (agentId) agentIds.add(String(agentId));
  }

  const agentToolsCache = new Map<string, AnyRecord[]>();
  for (const agentId of agentIds) {
    const content = agentFiles[agentId];
    if (!content) continue;
    const tools = parseAgentToolsContent(content);
    if (tools.length > 0) agentToolsCache.set(agentId, tools);
  }

  for (const message of messages) {
    const agentId = message.toolUseResult?.agentId;
    if (!agentId) continue;
    const agentTools = agentToolsCache.get(String(agentId));
    if (agentTools && agentTools.length > 0) {
      message.subagentTools = agentTools;
    }
  }

  return sortByTimestamp(messages);
}

/**
 * Local-disk decode half: reads the main transcript file + every `agent-*.jsonl`
 * sibling under `projectDir` into the content shape `assembleHistoryRecords`
 * consumes. Missing main file / unreadable agent files degrade to empty rather
 * than throw (parity with the old stream-based readers).
 */
export async function readTranscriptDir(
  mainPath: string,
  projectDir: string,
): Promise<{ transcript: string; agentFiles: Record<string, string> }> {
  let transcript = '';
  try {
    transcript = await fsp.readFile(mainPath, 'utf8');
  } catch {
    // main file missing/unreadable → empty transcript (old readers returned []).
  }

  const agentFiles: Record<string, string> = {};
  let files: string[] = [];
  try {
    files = await fsp.readdir(projectDir);
  } catch {
    // dir may vanish mid-read; treat as empty.
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl') || !file.startsWith('agent-')) continue;
    const agentId = file.slice('agent-'.length, -'.jsonl'.length);
    try {
      agentFiles[agentId] = await fsp.readFile(path.join(projectDir, file), 'utf8');
    } catch {
      // unreadable agent file → omit (old readers logged + continued).
    }
  }

  return { transcript, agentFiles };
}