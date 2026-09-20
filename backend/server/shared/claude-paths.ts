import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code's per-user config root (`~/.claude`).
 *
 * Shared by the provider skill discovery (`claude-skills.provider.ts`) and the
 * skill-sync local node, so the two can never drift onto different roots.
 */
export const getClaudeHomePath = (): string => path.join(os.homedir(), '.claude');

/** Claude Code's user-level skills directory (`~/.claude/skills`). */
export const getClaudeSkillsDir = (): string => path.join(getClaudeHomePath(), 'skills');
