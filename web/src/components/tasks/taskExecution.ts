import type { Task } from '../../types/app';
import { safeLocalStorage } from '../chat/utils/chatStorage';
import { taskRunPermissionModesFor } from '../chat/utils/providerPermissionModes';
import { resolvePermissionMode } from '../chat/utils/resolvePermissionMode';

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
 * watched later by opening the session. Permission mode goes through the same
 * `resolvePermissionMode` as the composer: the session's own localStorage
 * choice first (so a mode the user picked inside the session still wins on
 * retry), then the task's `permission_mode`, then the provider default. A task
 * created in auto-approve therefore runs unattended instead of stopping at the
 * board's "等你批准" marker.
 *
 * `content` defaults to the task's execution prompt (`taskPromptOf`). Retry
 * passes `TASK_RETRY_MESSAGE` instead so the agent continues the existing
 * conversation rather than restarting from scratch.
 *
 * Whenever the task has a non-empty `context_summary` (first run or retry alike),
 * it is prepended as a `【任务历史上下文·从来源会话压缩】` block so the run starts
 * with the source session's compressed context. Repeated injection of the same
 * summary across first run and retry is a harmless context duplication and is
 * accepted — the point is a retry still picks up the summary even if async
 * compression was not ready before the first run.
 */
export function buildTaskChatSend(sessionId: string, task: Task, content?: string): TaskChatSend {
  const toolsSettings = readToolsSettings(task.executor_provider);
  // 只要有非空 context_summary 就注入（首轮或重试均可）：把来源会话的压缩
  // 历史上下文作为前缀传给 agent——解决新任务零历史执行缺背景信息的问题，
  // 也保证首轮压缩未就绪时重试仍能带上摘要。无摘要（或全空白）时原样返回。
  const summary = task.context_summary?.trim();
  const base = content ?? taskPromptOf(task);
  const finalContent = summary ? `【任务历史上下文·从来源会话压缩】\n${summary}\n\n${base}` : base;
  return {
    type: 'chat.send',
    sessionId,
    content: finalContent,
    options: {
      model: task.executor_model || undefined,
      // 走与 composer 相同的解析：会话键 → 任务 → default。任务运行不关心
      // provider 的交互偏好，所以后两档传 null / 'default'。合法模式按 provider 取
      // （与任务表单同源），`plan` 天然不在其中——无人值守跑 plan 就是空跑。
      permissionMode: resolvePermissionMode({
        sessionMode: safeLocalStorage.getItem(`permissionMode-${sessionId}`),
        taskMode: task.permission_mode,
        providerLastMode: null,
        providerDefault: 'default',
        validModes: taskRunPermissionModesFor(task.executor_provider),
      }),
      toolsSettings,
      skipPermissions: toolsSettings.skipPermissions ?? false,
      sessionSummary: task.title,
      includePartialMessages: true,
    },
  };
}
