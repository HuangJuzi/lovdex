import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'claude';

/**
 * Claude Code names each project's transcript directory by encoding the cwd:
 * every character outside [a-zA-Z0-9-] becomes '-' (so '/', '.', and '_' all
 * collapse into dashes), e.g. `/mnt/b/workdir` -> `-mnt-b-workdir`.
 */
export function encodeClaudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Resolves the on-disk transcript path for a provider session under
 * `~/.claude/projects` from the session's project path, without relying on the
 * watcher to have indexed it. Returns null when no such file exists.
 */
export function resolveClaudeTranscriptPath(
  projectPath: string,
  providerSessionId: string,
  claudeHome: string = path.join(os.homedir(), '.claude'),
): string | null {
  if (!projectPath || !providerSessionId) {
    return null;
  }
  const candidate = path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectDirName(projectPath),
    `${providerSessionId}.jsonl`,
  );
  try {
    if (fs.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    // fall through
  }
  return null;
}

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

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
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return tools;
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // The DB row is keyed by the app-facing session id, while the JSONL rows
    // on disk carry the provider-native id — both ids are needed here.
    const session = sessionsDb.getSessionById(sessionId);
    let jsonLPath = session?.jsonl_path ?? null;

    // App-created rows only receive jsonl_path through the disk-watcher index.
    // A run whose transcript was never indexed (failed early, or the file's
    // first records carry no cwd so the indexer skips it) leaves it NULL, and
    // returning empty here makes the session read as blank even though the
    // provider id exists. Derive the location from the row's project path and
    // backfill the row so later reads skip this branch.
    if (!jsonLPath && session?.project_path) {
      jsonLPath = resolveClaudeTranscriptPath(session.project_path, providerSessionId);
      if (jsonLPath) {
        sessionsDb.updateSessionJsonlPath(sessionId, jsonLPath);
      }
    }

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const projectDir = path.dirname(jsonLPath);
    const files = await fsp.readdir(projectDir);
    const agentFiles = files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));

    const messages: AnyRecord[] = [];
    const agentToolsCache = new Map<string, AnyRecord[]>();

    const fileStream = fs.createReadStream(jsonLPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        if (entry.sessionId === providerSessionId) {
          messages.push(entry);
        }
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (!agentFiles.includes(agentFileName)) {
        continue;
      }

      const agentFilePath = path.join(projectDir, agentFileName);
      const tools = await parseAgentTools(agentFilePath);
      agentToolsCache.set(agentId, tools);
    }

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const agentTools = agentToolsCache.get(String(agentId));
      if (agentTools && agentTools.length > 0) {
        message.subagentTools = agentTools;
      }
    }

    const sortedMessages = messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

const LIVE_STREAM_CHUNK_SIZE = 24;

function splitLiveStreamDelta(text: string): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= LIVE_STREAM_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += LIVE_STREAM_CHUNK_SIZE) {
    chunks.push(text.slice(index, index + LIVE_STREAM_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Aggregates Workflow task_started/task_progress/tool_progress/task_notification/tool_result
 * events onto the matching Workflow tool_use so history replay renders the same
 * card shape the live stream produces. Mutates and returns `normalized`.
 * Exported for the history contract test. See
 * docs/superpowers/specs/2026-08-05-workflow-adaptation-design.md §3.5.
 */
export function aggregateWorkflowState(normalized: NormalizedMessage[]): NormalizedMessage[] {
  const wfStartedByToolUseId = new Map<string, NormalizedMessage>();
  const wfProgressByTaskId = new Map<string, NormalizedMessage[]>();
  const wfToolProgressByTaskId = new Map<string, NormalizedMessage[]>();
  const wfNotifByTaskId = new Map<string, NormalizedMessage>();
  const wfToolResultByToolId = new Map<string, NormalizedMessage>();
  for (const msg of normalized) {
    if (msg.kind === 'task_started' && msg.toolUseId) {
      wfStartedByToolUseId.set(msg.toolUseId, msg);
    } else if (msg.kind === 'task_progress') {
      const arr = wfProgressByTaskId.get(msg.taskId ?? '') ?? [];
      arr.push(msg);
      wfProgressByTaskId.set(msg.taskId ?? '', arr);
    } else if (msg.kind === 'tool_progress' && msg.taskId) {
      const arr = wfToolProgressByTaskId.get(msg.taskId) ?? [];
      arr.push(msg);
      wfToolProgressByTaskId.set(msg.taskId, arr);
    } else if (msg.kind === 'task_notification') {
      wfNotifByTaskId.set(msg.taskId ?? '', msg);
    } else if (msg.kind === 'tool_result' && msg.toolId) {
      // First-wins: WorkflowOutput fields (runId/scriptPath/...) are stable
      // across the paired tool_result rows. The pre-existing toolResultMap in
      // fetchHistory keeps the LAST raw content payload; this index deliberately
      // keeps the first normalized tool_result.
      if (!wfToolResultByToolId.has(msg.toolId)) {
        wfToolResultByToolId.set(msg.toolId, msg);
      }
    }
  }
  for (const msg of normalized) {
    if (msg.kind !== 'tool_use' || msg.toolName !== 'Workflow') continue;
    const started = msg.toolId ? wfStartedByToolUseId.get(msg.toolId) : undefined;
    const taskId = started?.taskId;
    if (!taskId) continue;
    const progress = wfProgressByTaskId.get(taskId) ?? [];
    const tools = wfToolProgressByTaskId.get(taskId) ?? [];
    const notif = wfNotifByTaskId.get(taskId);
    const toolResult = msg.toolId ? wfToolResultByToolId.get(msg.toolId) : undefined;
    msg.workflowState = {
      status: notif?.status ?? 'running',
      workflowName: started?.workflowName,
      agents: progress.map((p) => ({
        taskId: p.taskId ?? '',
        description: p.description ?? '',
        lastToolName: p.lastToolName,
        usage: p.usage,
        tools: tools.map((t) => ({
          toolUseId: t.toolUseId ?? '',
          toolName: t.toolName ?? '',
          elapsedTimeSeconds: t.elapsedTimeSeconds ?? 0,
        })),
      })),
      notification: notif
        ? { status: notif.status ?? 'completed', summary: notif.summary ?? '', usage: notif.usage }
        : undefined,
    };
    // Hoist WorkflowOutput fields from the matching tool_result so the
    // Workflow tool_use is self-contained for re-run/resume buttons.
    if (toolResult) {
      msg.runId = toolResult.runId;
      msg.scriptPath = toolResult.scriptPath;
      msg.transcriptDir = toolResult.transcriptDir;
      msg.summary = toolResult.summary;
    }
  }
  return normalized;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return splitLiveStreamDelta(raw.delta.text).map((content) =>
        createNormalizedMessage({ kind: 'stream_delta', content, sessionId, provider: PROVIDER }),
      );
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    // ── Workflow / background-task system events ─────────────────────────
    // SDK emits these as { type:'system', subtype:'task_*' } plus the non-system
    // { type:'tool_progress' }. Mirror them as their own kinds so the frontend
    // can aggregate a Workflow progress tree. See
    // docs/superpowers/specs/2026-08-05-workflow-adaptation-design.md §2.
    if (raw.type === 'system') {
      const subtype = raw.subtype;
      if (subtype === 'task_started') {
        return [createNormalizedMessage({
          id: raw.uuid || baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'task_started',
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id ?? null,
          taskType: raw.task_type ?? null,
          workflowName: raw.workflow_name ?? null,
          subagentType: raw.subagent_type ?? null,
          description: raw.description ?? '',
          skipTranscript: raw.skip_transcript ?? false,
        })];
      }
      if (subtype === 'task_progress') {
        return [createNormalizedMessage({
          id: raw.uuid || baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'task_progress',
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id ?? null,
          description: raw.description ?? '',
          usage: raw.usage ?? null,
          lastToolName: raw.last_tool_name ?? null,
          summary: raw.summary ?? null,
        })];
      }
      if (subtype === 'task_notification') {
        return [createNormalizedMessage({
          id: raw.uuid || baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'task_notification',
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id ?? null,
          status: raw.status,
          summary: raw.summary ?? '',
          usage: raw.usage ?? null,
          outputFile: raw.output_file ?? null,
        })];
      }
      if (subtype === 'background_tasks_changed') {
        const tasks = Array.isArray(raw.tasks)
          ? raw.tasks.map((t: AnyRecord) => ({
              taskId: String(t.task_id),
              taskType: String(t.task_type),
              description: String(t.description ?? ''),
            }))
          : [];
        return [createNormalizedMessage({
          id: raw.uuid || baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'background_tasks_changed',
          tasks,
        })];
      }
      // thinking_tokens / commands_changed / other system subtypes are not handled yet.
      return [];
    }

    if (raw.type === 'tool_progress') {
      return [createNormalizedMessage({
        id: raw.uuid || baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_progress',
        toolUseId: raw.tool_use_id,
        toolName: raw.tool_name,
        parentToolUseId: raw.parent_tool_use_id ?? null,
        taskId: raw.task_id ?? null,
        elapsedTimeSeconds: raw.elapsed_time_seconds ?? 0,
      })];
    }

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            const tur = (raw.toolUseResult || part.toolUseResult) as AnyRecord | undefined;
            const isLocalWorkflow = tur?.taskType === 'local_workflow';
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
              // Lift WorkflowOutput fields for local_workflow so the frontend
              // card can offer re-run/resume without parsing toolUseResult.
              taskId: isLocalWorkflow ? tur?.taskId : undefined,
              taskType: isLocalWorkflow ? tur?.taskType : undefined,
              workflowName: isLocalWorkflow ? tur?.workflowName : undefined,
              runId: isLocalWorkflow ? tur?.runId : undefined,
              scriptPath: isLocalWorkflow ? tur?.scriptPath : undefined,
              transcriptDir: isLocalWorkflow ? tur?.transcriptDir : undefined,
              summary: isLocalWorkflow ? tur?.summary : undefined,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (text && !isInternalContent(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
              }));
              imagesAttached = true;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        if (text && !isInternalContent(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      const tur = raw.toolUseResult as AnyRecord | undefined;
      const isLocalWorkflow = tur?.taskType === 'local_workflow';
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
        // Lift WorkflowOutput fields for local_workflow so the frontend card
        // can offer re-run/resume without parsing toolUseResult.
        taskId: isLocalWorkflow ? tur?.taskId : undefined,
        taskType: isLocalWorkflow ? tur?.taskType : undefined,
        workflowName: isLocalWorkflow ? tur?.workflowName : undefined,
        runId: isLocalWorkflow ? tur?.runId : undefined,
        scriptPath: isLocalWorkflow ? tur?.scriptPath : undefined,
        transcriptDir: isLocalWorkflow ? tur?.transcriptDir : undefined,
        summary: isLocalWorkflow ? tur?.summary : undefined,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, providerSessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    // ── Workflow progress aggregation ──────────────────────────────────
    // Attach task_started/task_progress/tool_progress/task_notification onto
    // the matching Workflow tool_use so history replay renders the same card
    // shape the live stream produces. Exported as aggregateWorkflowState for
    // the history contract test (see claude-sessions.provider.ts).
    aggregateWorkflowState(normalized);

    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
