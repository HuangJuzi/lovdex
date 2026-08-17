import type { Task } from '../../types/app';
import { safeLocalStorage } from '../chat/utils/chatStorage';

type ToolsSettings = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
};

/**
 * The message the board/detail send over the shared WebSocket to actually run
 * a task. Same `chat.send` shape the composer uses, so the backend run path is
 * identical — the only difference is nobody navigates to the chat page.
 */
export type TaskChatSend = {
  type: 'chat.send';
  sessionId: string;
  content: string;
  options: {
    model?: string;
    permissionMode: string;
    toolsSettings: ToolsSettings;
    skipPermissions: boolean;
    sessionSummary: string;
    /**
     * Opt the provider runtime into per-token streaming (SDKPartialAssistantMessage)
     * exactly like the chat composer's `buildSendOptions`. Without this a task run
     * produces ZERO `stream_delta` frames — the session looks frozen ("消息不会动")
     * until the turn completes and the transcript is re-fetched over REST.
     */
    includePartialMessages: boolean;
  };
};

// Mirror the composer's per-provider tools-settings storage keys so a task run
// respects the same allow/deny lists and skip-permissions choice the user set
// for interactive chats.
function settingsKeyFor(provider: string): string {
  switch (provider) {
    case 'codex':
      return 'codex-settings';
    case 'opencode':
      return 'opencode-settings';
    case 'qoder':
      return 'qoder-settings';
    default:
      return 'claude-settings';
  }
}

function readToolsSettings(provider: string): ToolsSettings {
  try {
    const raw = safeLocalStorage.getItem(settingsKeyFor(provider));
    if (raw) return JSON.parse(raw) as ToolsSettings;
  } catch (error) {
    console.error('read task tools settings failed', error);
  }
  return { allowedTools: [], disallowedTools: [], skipPermissions: false };
}

/**
 * The prompt actually sent to the agent: the task's execution content
 * (`description`), falling back to the display name for older tasks that only
 * ever had a title.
 */
export function taskPromptOf(task: Pick<Task, 'description' | 'title'>): string {
  const prompt = (task.description ?? '').trim() || task.title;
  // A leading "/" makes the provider CLI parse the whole prompt as a local
  // slash command, so the run ends with no transcript and the session reads
  // empty. Prefixing a line keeps the intent while dodging that parsing.
  return prompt.startsWith('/') ? `执行以下任务：\n${prompt}` : prompt;
}

/**
 * The message sent into an existing session when the user hits "重试" on a
 * failed task. Deliberately does NOT re-send the task prompt — the session
 * transcript already carries it and the prior attempt; the agent resumes with
 * that context. Wording covers both "interrupted without an error in the
 * transcript" (crash/kill/restart) and "errored with the error recorded".
 */
export const TASK_RETRY_MESSAGE = '上次执行中断/出错了，请重试继续完成';

/**
 * Build the `chat.send` frame that runs a task on its linked session. Sent over
 * the board/detail's existing socket so execution begins in place — the run
 * streams and persists server-side exactly like an interactive chat, and can be
 * watched later by opening the session. Permission mode is the default (ask):
 * any prompt surfaces as the board's "等你批准" marker until the user opens the
 * session to decide.
 *
 * `content` defaults to the task's execution prompt (`taskPromptOf`). Retry
 * passes `TASK_RETRY_MESSAGE` instead so the agent continues the existing
 * conversation rather than restarting from scratch.
 */
export function buildTaskChatSend(sessionId: string, task: Task, content?: string): TaskChatSend {
  const toolsSettings = readToolsSettings(task.executor_provider);
  return {
    type: 'chat.send',
    sessionId,
    content: content ?? taskPromptOf(task),
    options: {
      model: task.executor_model || undefined,
      permissionMode: 'default',
      toolsSettings,
      skipPermissions: toolsSettings.skipPermissions ?? false,
      sessionSummary: task.title,
      includePartialMessages: true,
    },
  };
}
