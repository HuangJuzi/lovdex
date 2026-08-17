/**
 * Operator agent configuration.
 *
 * Single source of truth for operator automation settings. Persisted as a
 * JSON blob under the `operator_config` key in `app_config`. Reads merge the
 * stored partial over defaults so new fields pick up their default value
 * automatically without a migration.
 *
 * "Safe defaults" philosophy: out-of-box works with conservative automation.
 * AI verdicts write `sub_status` directly onto the task; a `done` verdict keeps
 * the task in the 评审 (review) column so a human gates real completion, while
 * only_plan / needs_review / blocked move the task back to 进行中 (in progress).
 */

import os from 'node:os';

import { appConfigDb } from '@/modules/database/repositories/app-config.js';

export type OperatorConfig = {
  enabled: boolean;
  auto_verdict_enabled: boolean;
  model: string;
  workspace: string;
  max_concurrent: number;
  verdict_prompt_override: string | null;
  interactive_chat_enabled: boolean;
};

export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  enabled: true,
  auto_verdict_enabled: true,
  model: process.env.LOVDEX_OPERATOR_MODEL ?? '',
  workspace:
    process.env.LOVDEX_OPERATOR_WORKSPACE ?? `${os.homedir()}/.lovdex/operator-workspace`,
  max_concurrent: parseInt(process.env.LOVDEX_OPERATOR_MAX_CONCURRENT ?? '2', 10),
  verdict_prompt_override: null,
  interactive_chat_enabled: true,
};

const KEY = 'operator_config';

/** Returns the current operator config, merged over safe defaults. */
export function getOperatorConfig(): OperatorConfig {
  const workspace =
    process.env.LOVDEX_OPERATOR_WORKSPACE?.trim() || DEFAULT_OPERATOR_CONFIG.workspace;
  const base: OperatorConfig = { ...DEFAULT_OPERATOR_CONFIG, workspace };
  const raw = appConfigDb.get(KEY);
  if (!raw) return base;
  try {
    return { ...base, ...JSON.parse(raw) };
  } catch {
    return base;
  }
}

/** Persists a partial update, merged with the current config. */
export function setOperatorConfig(partial: Partial<OperatorConfig>): void {
  const merged = { ...getOperatorConfig(), ...partial };
  appConfigDb.set(KEY, JSON.stringify(merged));
}
