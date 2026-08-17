/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { buildOperatorTools } from './modules/operators/operator.tools.js';
import { getOperatorConfig } from './modules/operators/operator.config.js';
import { isTaskStatus } from './modules/database/repositories/tasks.db.js';
import { z } from 'zod';
import { appConfig } from './modules/config/config.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

// Default is 60000 (config: providers.claude.toolApprovalTimeoutMs).
const TOOL_APPROVAL_TIMEOUT_MS = appConfig().get().providers.claude.toolApprovalTimeoutMs;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Opt-in per-token streaming: when a client sends chat.send options.includePartialMessages,
  // the SDK emits SDKPartialAssistantMessage (stream_event) frames during generation so
  // consumers can render live typing. Default off → existing behavior (one assistant
  // message per turn at completion) is unchanged for clients that don't opt in.
  if (options.includePartialMessages) {
    sdkOptions.includePartialMessages = true;
  }

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  // Workflow feature toggles — now sourced from app.config (server.workflowsEnabled /
  // server.ultracodeKeywordTrigger), replacing the WORKFLOWS_ENABLED /
  // ULTRACODE_KEYWORD_TRIGGER env vars (see merge-config design).
  // Semantics vs the old env logic:
  //   - workflowsEnabled default true → we explicitly enable. Old env unset left the
  //     option unset (SDK default = enabled); old env 'true' explicitly enabled. Both
  //     now map to the same explicit `true`, so the default behavior is unchanged.
  //     `?? true` guards a hand-edited `null` in app.config.json.
  //   - ultracodeKeywordTrigger default '' → disabled until a trigger keyword is
  //     configured. Old env unset fell through to the SDK's own default of enabled
  //     ("Default: true"); gating it behind a configured keyword ('' → false) makes
  //     the ultracode trigger explicitly opt-in at the platform level, which is the
  //     intended design change. Non-string values (e.g. a hand-edited `false` in
  //     app.config.json) are treated as disabled.
  const cfg = appConfig().get();
  sdkOptions.enableWorkflows = cfg.server.workflowsEnabled ?? true;
  // Strict string guard: `false ?? ''` → false would still satisfy `!== ''`, so a
  // hand-edited boolean/other non-string must not accidentally enable the trigger.
  sdkOptions.workflowKeywordTriggerEnabled =
    typeof cfg.server.ultracodeKeywordTrigger === 'string' && cfg.server.ultracodeKeywordTrigger !== '';

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // SDKPartialAssistantMessage arrives as { type:'stream_event', event:<Anthropic raw stream event>, parent_tool_use_id }.
  // Unwrap to the raw event so normalizeMessage sees { type:'content_block_delta', delta:{text} } / { type:'content_block_stop' }
  // and can emit stream_delta/stream_end. Only produced when the client opts in via
  // chat.send options.includePartialMessages (see buildSdkOptions) — otherwise this
  // branch is dead, so existing consumers (lovdex-cli et al.) are unaffected.
  if (sdkMessage && sdkMessage.type === 'stream_event' && sdkMessage.event) {
    return {
      ...sdkMessage.event,
      parentToolUseId: sdkMessage.parent_tool_use_id || null
    };
  }
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Maps a Claude Code CLI / SDK stream error to a user-facing message. The CLI
 * is a Bun (JavaScriptCore) binary, so its internal crashes surface as JSC
 * errors like `undefined is not an object (evaluating 's.thinking.length')` —
 * a known CLI bug where a `thinking` content block without the `thinking` text
 * crashes the CLI's token-usage accumulator. Lovdex can't patch the binary, so
 * we surface the raw message plus a hint that the crash is CLI-internal (not a
 * Lovdex wiring bug) so the operator can switch model/effort or update claude.
 */
function describeSdkError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error);
  const jscUndefined = /is not an object \(evaluating '[^']*'\)/.test(raw);
  const thinkingCrash = /thinking/i.test(raw);
  if (jscUndefined && thinkingCrash) {
    return `${raw} — Claude Code CLI 内部在解析 thinking 推理块时崩溃（CLI bug，Lovdex 无法修补）。可尝试降低该模型的 effort 或在 claude 会话里 /model 切换模型以绕过；升级 @anthropic-ai/claude-code 后如仍复现请反馈给 Anthropic。`;
  }
  if (jscUndefined) {
    return `${raw} — Claude Code CLI 内部运行时崩溃（非 Lovdex 错误）。`;
  }
  return raw;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    // Context window budget comes from app.config (server.contextWindow). The read
    // is done only inside budget-building branches so the `appConfig().get()`
    // structuredClone isn't performed for the many streamed messages that return
    // null before reaching here (hot path). Non-number values — a hand-edited `0` /
    // `"abc"`, or the old unset `null` default — still fall back to 160000, matching
    // the old `parseInt(process.env.CONTEXT_WINDOW, 10) || 160000` default.
    const serverCfg = appConfig().get().server;
    const contextWindow = typeof serverCfg.contextWindow === 'number' ? serverCfg.contextWindow : 160000;

    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  // Same off-hot-path config read as the messageUsage branch above; only reached
  // for legacy modelUsage messages that actually build a budget object.
  const serverCfg = appConfig().get().server;
  const contextWindow = typeof serverCfg.contextWindow === 'number' ? serverCfg.contextWindow : 160000;

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    });

    // Operator assistant sessions: swap in the CLOSED operator tool set + use
    // the operator workspace as cwd (never the project path, never the
    // project's MCP servers). This is the interactive counterpart to
    // runOperatorHeadless — same safety boundary (no Bash/Edit/Write, only the
    // lovdex-operator MCP tools), but WITH websocket streaming so the user can
    // chat. `tools: []` disables all built-in tools; the operator MCP server
    // supplies list_tasks/create_task/write_task_summary/etc.
    if (options.isOperator && operatorDepsRef) {
      const cfg = getOperatorConfig();
      const operatorServer = createSdkMcpServer({
        name: 'lovdex-operator',
        tools: buildOperatorSdkTools(operatorDepsRef),
        alwaysLoad: true,
      });
      sdkOptions.tools = [];
      sdkOptions.mcpServers = { 'lovdex-operator': operatorServer };
      sdkOptions.cwd = cfg.workspace || sdkOptions.cwd;
      sdkOptions.permissionMode = 'bypassPermissions';
      sdkOptions.allowDangerouslySkipPermissions = true;
      // Custom string system prompt (NOT the claude_code preset): the operator
      // has no coding tools (tools: []), so the preset coding prompt is both
      // wasteful and mismatched. A string also avoids the SDK cache_control bug.
      sdkOptions.systemPrompt = '你是 Lovdex Operator，一个跨项目的助手。你只能调用 lovdex-operator 工具集（list_tasks/get_task/get_session_transcript/create_task/start_task_execution/move_task/update_task/write_task_summary 等）来查看任务状态、下发任务、写完成度判定。不要试图直接编辑代码或运行 shell——这些工具不可用；要改代码就下发任务。';
      if (cfg.model) sdkOptions.model = cfg.model;
    } else {
      const mcpServers = await loadMcpConfig(options.cwd);
      if (mcpServers) {
        sdkOptions.mcpServers = mcpServers;
      }
    }

    // Turns with image attachments switch to streaming input so the images
    // ride along as real content blocks. Built per query attempt because an
    // async generator cannot be replayed once consumed.
    const createPrompt = () => buildPromptPayload(command, options.images, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }],
      // `Stop` fires when the agent finishes a turn. Surface it as a
      // same-session notification so the UI can toast "session stopped"
      // independently of the cross-session `session_status{state:'completed'}`
      // broadcast. The dedupe key is per-turn, so re-emits within one run are
      // collapsed by the orchestrator.
      Stop: [{
        matcher: '',
        hooks: [async (input) => {
          const hookSessionId = capturedSessionId || sessionId || null;
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: hookSessionId,
            kind: 'session_stopped',
            code: 'agent.stop',
            meta: { sessionName: sessionSummary, stopReason: input?.stop_hook_active ? 'stop_hook' : 'turn' },
            severity: 'info',
            requiresUserAction: false,
            dedupeKey: `claude:hook:stop:${hookSessionId || 'none'}:${Date.now()}`
          }));
          return {};
        }]
      }],
      // `SessionEnd` fires when the session is tearing down. This is the
      // Claude-native "this conversation just ended" signal — distinct from a
      // per-turn `Stop`. Best-effort: if the run already completed the writer
      // will have been torn down, in which case the dispatch is a no-op.
      SessionEnd: [{
        matcher: '',
        hooks: [async (input) => {
          const hookSessionId = capturedSessionId || sessionId || null;
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: hookSessionId,
            kind: 'session_ended',
            code: 'agent.session_end',
            meta: { sessionName: sessionSummary, reason: typeof input?.reason === 'string' ? input.reason : 'end' },
            severity: 'info',
            requiresUserAction: false,
            dedupeKey: `claude:hook:session_end:${hookSessionId || 'none'}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // In-process env set/restore (NOT app.config): the SDK's Query constructor
    // reads CLAUDE_CODE_STREAM_CLOSE_TIMEOUT synchronously from process.env, so we
    // temporarily set it here and restore it immediately below. This stays env
    // manipulation because it's the SDK's own knob, not a Lovdex config value.
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, ws);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, ws);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : describeSdkError(error);

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// ---------------------------------------------------------------------------
// Operator agent: headless verdict run + operator-mode tool wiring
//
// The operator agent runs Claude with a CLOSED custom tool set (no Bash/Edit/
// Write) so it can autonomously read a session transcript and write a task
// summary + verdict without human interaction. `runOperatorHeadless` is the
// headless entry point: it builds the operator tools, calls the SDK `query()`,
// and drains the stream to completion WITHOUT emitting any websocket messages
// (there is no client watching). Failures are swallowed + logged per spec
// ("失败 try/catch 记日志，不抛").
//
// SDK custom-tool shape (verified against
// @anthropic-ai/claude-agent-sdk sdk.d.ts):
//   SdkMcpToolDefinition = { name, description, inputSchema, handler }
//   handler: (args, extra) => Promise<CallToolResult>
//   CallToolResult = { content: ContentBlock[], isError?: boolean }
// Tools are registered via createSdkMcpServer({ name, tools }) → passed to
// options.mcpServers. Built-in tools are disabled with `tools: []` so only the
// operator closed set runs — this is the safety boundary.
// ---------------------------------------------------------------------------

/**
 * Adapts the real TasksService to the OperatorToolDeps.tasks shape.
 *
 * The deps type uses `status?: string` (the model sends arbitrary strings)
 * while the service uses `status?: TaskStatus`. The service already validates
 * internally and throws on invalid status, but to keep the type narrowing
 * explicit and mirror write_task_summary's isAiVerdict guard, we validate
 * with isTaskStatus at the adapter boundary and throw a clear error before
 * delegating. This is the clean assignability resolution (approach a) — no
 * unsafe cast.
 */
export function adaptTasksServiceForOperatorTools(svc) {
  const assertStatus = (status) => {
    if (status !== undefined && !isTaskStatus(status)) {
      throw new Error(`invalid status: ${String(status)}`);
    }
  };
  return {
    createTask: (i) => {
      assertStatus(i.status);
      return svc.createTask({
        projectPath: i.projectPath,
        title: i.title,
        description: i.description,
        status: i.status,
        priority: i.priority,
      });
    },
    listTasks: (f) => {
      assertStatus(f.status);
      return svc.listTasks({ projectPath: f.projectPath, status: f.status });
    },
    getTask: (id) => svc.getTask(id),
    writeSummary: (id, i) => svc.writeSummary(id, i),
    startExecution: (id, createSession) => svc.startExecution(id, createSession),
    updateTask: (id, u) => svc.updateTask(id, u),
    moveTask: (id, status, before, after) => {
      assertStatus(status);
      return svc.moveTask(id, status, before, after);
    },
  };
}

/**
 * Converts a JSON-Schema-ish `inputSchema` ({ type:'object', properties,
 * required }) from buildOperatorTools into a Zod raw shape (the shape the
 * SDK's SdkMcpToolDefinition.inputSchema expects — verified against
 * @anthropic-ai/claude-agent-sdk sdk.d.ts: inputSchema is `AnyZodRawShape`,
 * i.e. `Record<string, ZodType>`, NOT a JSON-schema object). The SDK
 * createSdkMcpServer throws if handed a plain JSON-schema object
 * ("inputSchema must be a Zod schema or raw shape").
 *
 * Only the subset buildOperatorTools emits is supported: object properties
 * that are strings, optional or required. Optional → `.optional()`,
 * required → bare `z.string()`.
 */
function jsonSchemaToZodRawShape(inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set(inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const shape = {};
  for (const [key, def] of Object.entries(props)) {
    const isRequired = required.has(key);
    // buildOperatorTools declares string and number properties. String props may
    // carry an enum (e.g. priority: P0/P1/P2/P3) — preserve it so the SDK schema
    // tells the model the exact allowed values instead of an unconstrained
    // string, and keep descriptions so the model sees why a param matters.
    let base;
    if (def && def.type === 'number') {
      base = z.number();
    } else if (
      def && Array.isArray(def.enum) && def.enum.length > 0
      && def.enum.every((e) => typeof e === 'string')
    ) {
      base = z.enum(def.enum);
    } else {
      base = z.string();
    }
    if (def && typeof def.description === 'string' && def.description) {
      base = base.describe(def.description);
    }
    shape[key] = isRequired ? base : base.optional();
  }
  return shape;
}

/**
 * Builds the SDK custom-tool array (SdkMcpToolDefinition[]) from the operator
 * tool set. Each handler is wrapped so its raw return value is normalized into
 * a CallToolResult ({ content: [{ type:'text', text }] }) as the SDK requires,
 * and handler errors are surfaced as isError:true results (so the model can
 * self-correct) rather than thrown protocol errors.
 */
export function buildOperatorSdkTools(deps) {
  const tools = buildOperatorTools(deps);
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: jsonSchemaToZodRawShape(def.inputSchema),
    handler: async (args) => {
      try {
        const result = await def.handler(args);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = e && typeof e.message === 'string' ? e.message : String(e);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  }));
}

/**
 * Module-level singleton holding the wired operator deps (real tasksService,
 * projectsDb, sessionsService). Initialized once at app startup via
 * initOperatorHeadless so runOperatorHeadless can build the closed tool set
 * without a circular import of index.js. Tests pass `deps` directly to
 * runOperatorHeadless instead of touching this singleton.
 */
let operatorDepsRef = null;

/**
 * Initializes the operator headless deps at app startup. index.js calls this
 * after constructing tasksService:
 *   initOperatorHeadless({
 *     tasks: adaptTasksServiceForOperatorTools(tasksService),
 *     projects: projectsDb,
 *     sessions: sessionsService,
 *   });
 */
export function initOperatorHeadless(deps) {
  operatorDepsRef = deps;
}

/**
 * Headless operator verdict run. Reads a session transcript and writes a task
 * summary + verdict via the closed operator tool set, with NO websocket
 * streaming and NO user interaction. Safe to call from automation (T9 trigger).
 *
 * @param {object} params
 * @param {string} params.sessionId  - session whose transcript to judge
 * @param {string} params.taskId     - task to write the verdict onto
 * @param {string} params.title      - task title (for the prompt)
 * @param {string} [params.promptOverride] - replace the default verdict prompt
 * @param {Function} [params.queryFn] - seam: inject a fake query() for tests
 * @param {object} [params.config]   - seam: inject operator config for tests
 * @param {object} [params.deps]     - seam: inject operator tool deps for tests
 */
export async function runOperatorHeadless({ sessionId, taskId, title, promptOverride, queryFn, config, deps }) {
  const cfg = config ?? getOperatorConfig();
  if (!cfg.enabled || !cfg.auto_verdict_enabled) return;

  const resolvedDeps = deps ?? operatorDepsRef;
  if (!resolvedDeps) {
    console.error('[operator-headless] no deps wired — call initOperatorHeadless at startup');
    return;
  }

  // A task may already have an AI verdict from an earlier run (ai_summary /
  // verdict_at survive reopening). The prior verdict is only a weak reference:
  // each run must judge this session's actual output independently. When the
  // user keeps chatting in a completed task's session, an unrelated AND
  // fully-wrapped-up follow-up may keep done — but a follow-up that is still
  // plan-only / waiting for review / unimplemented must not be crushed back to
  // done by the history prior.
  let priorVerdictContext = '';
  try {
    const taskRow = resolvedDeps.tasks?.getTask?.(taskId);
    if (taskRow?.ai_summary || taskRow?.verdict_at) {
      priorVerdictContext = `\n【任务此前的判定记录】该任务此前已被 AI 判定过：verdict_at=${taskRow.verdict_at ?? '未知'}，summary="${taskRow.ai_summary ?? ''}"。此前的判定只是弱参考，不得绑架本次判定——每次都应基于本会话的实际产出、验证结果与是否真正收尾独立评审。若本次追加工作与主任务无关，且追加工作本身也已完整收尾（改动落地、验证通过、无待决事项），可维持 done，不因追加工作的存在而降级；但若追加工作仍停留在计划/方案阶段、代码未实现（例如只有 spec 没有落地），或会话停在等 review/等用户决策，则按本次实际产出独立判定为 only_plan / needs_review / blocked，不得因历史判定是 done 而强行维持 done。\n`;
    }
  } catch (e) {
    // Best-effort: a missing task / prior record must never block the verdict.
    console.error('[operator-headless] read prior verdict failed', e);
  }

  const prompt = promptOverride ?? cfg.verdict_prompt_override ??
    `你是 Lovdex Operator。判断任务 ${taskId}（${title}）在 session ${sessionId} 里的实际完成度。
${priorVerdictContext}
先读 get_session_transcript 返回的 finalOutput（最终输出，即最后一条 assistant 消息），再参考整段 transcript 佐证。判定要同时权衡三方面，不要只看结尾措辞：
1. 实际产出质量：是否定位了根因、做了真实改动、交付物已落地（而非只给计划）。
2. 验证结果：单测/E2E/构建等是否通过（看 finalOutput 与 transcript 里明确给出的验证结论）。
3. 是否真正收尾：剩余事项的性质——是 Agent 按惯例应自行完成的例行收尾（提交、推送、合入 main、重启、部署），还是必须用户亲自决策的事项（选方案、确认业务方向、授权外部操作）。

判定规则（按优先级）：
- 实际改动已落地 + 验证通过 + 仅差例行收尾（提交/推送/合入/部署，或最终输出礼貌性地问「要我提交并推送吗？」「还需要我做什么吗？」等）→ verdict = done。按 Lovdex 用户偏好，提交推送合入 main 是 Agent 的例行职责，不算用户决策门；这类礼貌性提问不否定完成度。
- 实际改动已落地 + 验证通过 + 剩余事项确实需要用户决策（非例行收尾）→ verdict = needs_review（待你决策）。
- 只给了计划/方案、没有实际改动 → verdict = only_plan。
- 产出错误、验证失败、卡死或必须用户介入才能继续 → verdict = blocked。

注意：仅凭最终输出以问句结尾不足以判 needs_review/blocked——若工作实质完成且验证通过，礼貌性收尾提问应判 done。

调 write_task_summary 写入：summary（中文≤3句）、verdict（done|only_plan|needs_review|blocked）、reason（一句，说明判定依据，含验证结论与剩余事项性质）。`;

  try {
    const sdkTools = buildOperatorSdkTools(resolvedDeps);
    const operatorServer = createSdkMcpServer({
      name: 'lovdex-operator',
      tools: sdkTools,
      alwaysLoad: true,
    });

    const sdkOptions = {
      // Forward host env (ANTHROPIC_API_KEY etc.) to the SDK subprocess.
      env: { ...process.env },
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      cwd: cfg.workspace,
      model: cfg.model || CLAUDE_FALLBACK_MODELS.DEFAULT,
      // Closed tool set: disable ALL built-in tools so only the operator MCP
      // tools (write_task_summary, get_session_transcript, …) can run. This is
      // the safety boundary — no Bash/Edit/Write/AskUserQuestion.
      tools: [],
      mcpServers: { 'lovdex-operator': operatorServer },
      // No interactive prompts possible (built-ins disabled, operator tools are
      // programmatic). bypassPermissions ensures the SDK never blocks waiting
      // for a human approval that cannot arrive in headless mode.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Custom string system prompt (NOT the claude_code preset): the operator
      // has no coding tools (tools: []), so the full coding-agent system prompt
      // is both wasteful and mismatched. A string systemPrompt also avoids the
      // SDK's cache_control-on-middle-block bug that the preset path triggers
      // when combined with a user prompt (API 400 "Extra inputs are not
      // permitted, cache_control").
      systemPrompt: '你是 Lovdex Operator，一个负责评估任务完成度的助手。你只能调用 lovdex-operator 工具集（list_tasks/get_task/get_session_transcript/write_task_summary 等）。不要试图编辑代码或运行 shell——这些工具不可用。判定完成度时以 get_session_transcript 的 finalOutput（最终输出，即最后一条 assistant 消息）为第一依据，并参考整段 transcript 佐证，同时权衡三方面：实际产出质量（根因定位/真实改动/交付物落地）、验证结果（单测/E2E/构建是否通过）、是否真正收尾（剩余事项是 Agent 例行收尾如提交推送合入部署，还是必须用户决策）。按 Lovdex 用户偏好，提交推送合入 main 是 Agent 的例行职责，不算用户决策门。判定规则：实际改动已落地+验证通过+仅差例行收尾（含礼貌性问「要我提交并推送吗？」「还需要我做什么吗？」）→ done；实际改动已落地+验证通过+剩余事项确需用户决策 → needs_review；只给计划无改动 → only_plan；产出错误/验证失败/卡死/需用户介入 → blocked。仅凭最终输出以问句结尾不足以判 needs_review/blocked——工作实质完成且验证通过时，礼貌性收尾提问应判 done。但注意：如果该任务此前已被判定完成（用户 prompt 中会给出现成判定记录），此前的判定只是弱参考——若本次追加工作与主任务无关且追加工作本身也已完整收尾，可维持 done，不因追加工作的存在而降级；若追加工作仍停留在计划/方案、代码未实现、或停在等 review/等用户决策，则按本次实际产出独立判定（only_plan/needs_review/blocked），不得被历史判定强行压成 done。',
      settingSources: ['project', 'user', 'local'],
    };

    const queryToUse = queryFn ?? query;
    const queryInstance = queryToUse({ prompt, options: sdkOptions });

    // Drain the stream to completion. Headless = no ws: we deliberately do NOT
    // emit any websocket messages. We only care that write_task_summary was
    // invoked as a side effect of the agent running to completion.
    for await (const _message of queryInstance) {
      // intentionally empty — drain without emitting
    }
  } catch (e) {
    // Per spec: 失败 try/catch 记日志，不抛. A headless verdict failure must
    // never crash the caller (e.g. the T9 auto-verdict trigger).
    console.error('[operator-headless] run failed', e);
  }
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
