import type { LLMProvider } from '../../../types/app';
import type { PermissionMode } from '../types/types';

/**
 * 每个 provider 支持哪些权限模式。后端 `provider-capabilities.service.ts` 是权威来源
 * （经 `GET /api/providers/capabilities` 下发），这张表是**同构的静态副本**：
 * composer 在能力表到达前/拉取失败时用它兜底，任务表单直接用它（那里没有异步能力表）。
 *
 * 两处必须与后端保持一致——改一处就要改三处。
 */
export const PROVIDER_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
  qoder: ['default', 'autoApprove', 'acceptEdits', 'bypassPermissions', 'plan'],
};

/**
 * 任务运行时可选的模式：该 provider 的列表减去 `plan`。
 *
 * `plan` 被排除是刻意的——无人值守下它只产出计划、不执行任何工具，任务会永远空跑，
 * 而你要到第二天看历史才发现。这不是「少一个选项」，是避免一个静默失败。
 */
export function taskRunPermissionModesFor(provider: LLMProvider | string): PermissionMode[] {
  const modes = PROVIDER_PERMISSION_MODES[provider as LLMProvider] ?? PROVIDER_PERMISSION_MODES.claude;
  return modes.filter((mode) => mode !== 'plan');
}
