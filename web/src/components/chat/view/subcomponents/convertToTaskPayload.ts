import type { ProjectSession, TaskEngine, TaskStatus, TaskPriority, TaskLabel, LLMProvider } from '../../../../types/app';
import { resolveSessionTitle } from '../../../../utils/sessionTitle';

export type SessionToTaskPayload = {
  title: string;
  description: string;
  executorProvider: TaskEngine;
  executorModel: string;
  status: TaskStatus;
  priority: TaskPriority;
  label: TaskLabel;
  deadline: string;
  remark: string;
};

/** 各 provider 的兜底模型（与 useChatProviderState 的私有副本同值，保持模块自包含）。 */
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  codex: 'gpt-5.4',
  opencode: 'opencode/deepseek-v4-flash-free',
  qoder: 'auto',
};

function isTaskEngine(value: unknown): value is TaskEngine {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'qoder';
}

function resolveProviderModelDefault(provider: LLMProvider | undefined | null): string {
  if (!provider) return '';
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(`${provider}-model`);
  return stored || FALLBACK_DEFAULT_MODEL[provider] || '';
}

/**
 * Compute the conversion dialog's default payload from a session.
 * Pure so it can be unit-tested without a React renderer.
 * Status defaults from the running rule (running → in_progress, else todo);
 * the dialog lets the user override it. Meta fields default to the same values
 * TaskDetail uses; executorModel is carried silently (not shown in the dialog).
 */
export function buildSessionToTaskPayload(input: {
  session: ProjectSession | null;
  isRunning: boolean;
}): SessionToTaskPayload {
  const session = input.session;
  const title = resolveSessionTitle(session) ?? '';
  const description = typeof session?.summary === 'string' ? session.summary : '';
  const executorProvider = isTaskEngine(session?.provider) ? session.provider : 'claude';
  const executorModel = resolveProviderModelDefault(session?.provider);
  const status: TaskStatus = input.isRunning ? 'in_progress' : 'todo';
  return {
    title,
    description,
    executorProvider,
    executorModel,
    status,
    priority: 'P2',
    label: 'other',
    deadline: '',
    remark: '',
  };
}
