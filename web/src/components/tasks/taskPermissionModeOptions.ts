import { AUTO_APPROVE_MODE } from '../chat/types/types';

import { TASK_RUN_PERMISSION_MODES } from './taskExecution';

/**
 * The permission-mode choices a task form offers, shared by all three entry
 * points (create dialog, scheduled-task form, task detail) so the wording cannot
 * drift between them.
 *
 * Labels are hard-coded Chinese rather than routed through the chat bundle's
 * `codex.modes.*` keys: these forms have no i18n context and every other field on
 * them is hard-coded too. Introducing `t()` here for one field would be the odd
 * one out.
 *
 * `autoApprove` gets a sentence rather than a name because it is the only option
 * that changes what happens *without you present* — the label has to say what
 * that is. The others keep the composer's short names so a user who has seen the
 * mode button recognises them.
 */
export const TASK_PERMISSION_MODE_LABELS: Record<string, string> = {
  default: '默认（每次询问）',
  [AUTO_APPROVE_MODE]: '自动审批（无人值守时自动放行工具调用，危险操作仍会拒绝）',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '跳过全部权限检查',
};

export type TaskPermissionModeOption = { value: string; label: string };

/**
 * Options for the task forms. Derived from `TASK_RUN_PERMISSION_MODES` — the same
 * list the run path validates against — so a mode can never be offered here and
 * then rejected (or silently ignored) at run time. `plan` is absent by design;
 * see that constant.
 */
export const TASK_PERMISSION_MODE_OPTIONS: TaskPermissionModeOption[] =
  TASK_RUN_PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: TASK_PERMISSION_MODE_LABELS[mode] ?? mode,
  }));
