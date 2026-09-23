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
 * 某个 provider 的模式列表，未知 provider 回落 claude。
 *
 * 任务表单与任务运行路径都用它，所以两边看到的档位与 composer **完全一致**——
 * 之前这里额外过滤掉了 `plan`，理由是「无人值守下任务空跑」；那个理由站不住：
 * `only_plan` 与 `waiting_plan` 在 `verdict` / `sub_status` 里都是一等状态，有专门的
 * UI 档位。隐藏一个 composer 有的档位，换来的只是两边对不上。
 *
 * 代价说清楚：`plan` 模式下 agent 要结束规划得调 `ExitPlanMode`，而它在
 * `TOOLS_REQUIRING_INTERACTION` 里 —— 无人值守时开了自动审批会被策略拒掉、没开则
 * 无限期挂起。所以定时任务选 `plan` 会停在 `waiting_plan` 等你回来批。那是个**有标签、
 * 看得见**的状态，不是静默挂死。
 */
export function permissionModesFor(provider: LLMProvider | string): PermissionMode[] {
  return PROVIDER_PERMISSION_MODES[provider as LLMProvider] ?? PROVIDER_PERMISSION_MODES.claude;
}
