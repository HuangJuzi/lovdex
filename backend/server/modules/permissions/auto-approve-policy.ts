import os from 'node:os';
import path from 'node:path';

/**
 * Auto-approval policy for unattended task runs.
 *
 * When a task has `auto_approve = 1`, the provider runtimes answer their own
 * permission requests instead of asking the human: they call
 * `decideAutoApproval` right in front of the "ask" step. See
 * docs/superpowers/specs/2026-09-21-auto-approve-design.md.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It stops an agent from casually doing
 * something destructive while nobody is watching. A determined agent walks
 * around every rule below (re-encoding a command, variable expansion, running
 * the same thing through an interpreter). Do not treat it as a sandbox, and do
 * not rely on it to make an untrusted prompt safe to run unattended.
 */

export type AutoApproveDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string };

/**
 * Tools that need a human on the other end. `claude-sdk.js` registers these with
 * `timeoutMs: 0` (wait forever), so under auto-approval they must be denied
 * rather than waited on — an invented answer on the model's behalf would be
 * worse than telling it to use its own judgement.
 *
 * Defined here rather than in `claude-sdk.js` so the policy module and the
 * runtimes cannot drift apart; `claude-sdk.js` imports it back.
 */
export const TOOLS_REQUIRING_INTERACTION: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

export const UNATTENDED_INTERACTION_DENY_REASON =
  '无人值守执行中，无人可应答。请基于现有信息自行判断并继续，不要再次请求确认。';

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

/**
 * Split a shell command into argument vectors on separators, so a dangerous
 * command hiding behind `cd /tmp && rm -rf /` is still seen. Pipelines are NOT
 * split here — the pipe-to-shell rule does its own two-level split, because it
 * has to tell pipeline stages apart from command chains inside a stage.
 */
function commandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** The shell command inside a Bash tool input, tolerating the raw-string shape. */
function bashCommandOf(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input === 'object') {
    const command = (input as { command?: unknown }).command;
    if (typeof command === 'string') return command.trim();
  }
  return '';
}

const ROOT_OR_HOME_TARGETS: ReadonlySet<string> = new Set([
  '/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*',
  '/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/home',
]);

/** `rm` with a recursive/force flag pointed at a root-ish target. */
function hasDestructiveRm(command: string): boolean {
  return commandSegments(command).some((tokens) => {
    if (tokens[0] !== 'rm') return false;
    const args = tokens.slice(1);
    const recursiveOrForce = args
      .filter((arg) => arg.startsWith('-'))
      .some((flag) => /[rRf]/.test(flag.replace(/^--?/, '')));
    if (!recursiveOrForce) return false;
    return args.filter((arg) => !arg.startsWith('-')).some((target) => ROOT_OR_HOME_TARGETS.has(target));
  });
}

/**
 * `curl … | sh` — fetch-and-execute. Deny when a shell heads one pipeline stage
 * and curl/wget heads a command in an earlier stage.
 *
 * Two levels on purpose. Stages come from *pipes only*: `&&`/`;` are not
 * pipelines, and treating them as such denied
 * `curl -s localhost:3000/health && sh -c 'echo ok'`, which pipes nothing. But
 * a single stage can chain commands (`cd /tmp && curl x | sh`), so each stage is
 * then split on `&&`/`;` and every command head inspected.
 *
 * Matching command heads (rather than the raw string) is what keeps a command
 * that merely *quotes* the pattern allowed — `grep -rn "curl | bash" docs/` is a
 * search, not an execution.
 */
function hasPipeToShell(command: string): boolean {
  let fetchedEarlier = false;
  for (const stage of command.split(/\|&?/)) {
    const commands = stage
      .split(/&&|\|\||;|\n/)
      .map((part) => part.trim().split(/\s+/).filter(Boolean))
      .filter((tokens) => tokens.length > 0);
    if (commands.length === 0) continue;

    const last = commands[commands.length - 1];
    const head = last[0] === 'sudo' ? last[1] : last[0];
    if ((head === 'sh' || head === 'bash' || head === 'zsh' || head === 'dash') && fetchedEarlier) {
      return true;
    }
    if (commands.some((tokens) => tokens[0] === 'curl' || tokens[0] === 'wget')) {
      fetchedEarlier = true;
    }
  }
  return false;
}

type CommandRule = { reason: string; matches: (command: string) => boolean };

const COMMAND_RULES: readonly CommandRule[] = [
  {
    reason: '拒绝：不允许删除根目录或家目录',
    matches: hasDestructiveRm,
  },
  {
    reason: '拒绝：不允许在无人值守时提权执行',
    matches: (command) => commandSegments(command).some((tokens) => tokens[0] === 'sudo'),
  },
  {
    reason: '拒绝：不允许在无人值守时推送远端（不可逆的外发操作）',
    matches: (command) => commandSegments(command).some((tokens) => tokens[0] === 'git' && tokens[1] === 'push'),
  },
  {
    reason: '拒绝：git reset --hard 会丢弃未提交的改动',
    matches: (command) =>
      commandSegments(command).some((tokens) => tokens[0] === 'git' && tokens[1] === 'reset' && tokens.includes('--hard')),
  },
  {
    reason: '拒绝：git clean 带 -f 会丢弃未跟踪文件',
    matches: (command) =>
      commandSegments(command).some(
        (tokens) =>
          tokens[0] === 'git' &&
          tokens[1] === 'clean' &&
          tokens.slice(2).some((arg) => {
            // 长写法 `--force` 与 `-f` 等价，必须一起拒。只有以短横线开头的参数才算旗标，
            // 否则 `git clean -d foo` 里的普通路径参数会被误判成 force。`--dry-run`(-n)
            // 是空跑预览，bare 含 `-` 走不到规则里，保持放行。
            if (!arg.startsWith('-')) return false;
            const bare = arg.replace(/^--?/, '');
            return bare === 'force' || /^[a-zA-Z]*f[a-zA-Z]*$/.test(bare);
          }),
      ),
  },
  {
    reason: '拒绝：不允许把远端脚本直接管道进 shell 执行',
    matches: hasPipeToShell,
  },
  {
    reason: '拒绝：不允许写裸设备或格式化文件系统',
    matches: (command) =>
      commandSegments(command).some(
        (tokens) =>
          tokens[0] === 'mkfs' ||
          tokens[0].startsWith('mkfs.') ||
          (tokens[0] === 'dd' && tokens.some((arg) => arg.startsWith('of=/dev/'))),
      ),
  },
  {
    reason: '拒绝：不允许关机或重启',
    matches: (command) =>
      commandSegments(command).some((tokens) =>
        ['shutdown', 'reboot', 'halt', 'poweroff'].includes(tokens[0]),
      ),
  },
  {
    reason: '拒绝：不允许发布包到远端仓库（不可逆的外发操作）',
    matches: (command) =>
      commandSegments(command).some(
        (tokens) => ['npm', 'yarn', 'pnpm'].includes(tokens[0]) && tokens[1] === 'publish',
      ),
  },
];

// ---------------------------------------------------------------------------
// File writes
// ---------------------------------------------------------------------------

const FILE_PATH_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/** The target path of a file-writing tool input. */
function filePathOf(input: unknown): string {
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/**
 * Credential directories and Lovdex's own config. The app config is on the list
 * because it holds `AUTH_ENABLED` and the JWT secret — an agent rewriting it can
 * turn the login gate off.
 */
function isSensitivePath(rawPath: string): boolean {
  if (!rawPath) return false;
  const home = os.homedir();
  const expanded =
    rawPath === '~' ? home : rawPath.startsWith('~/') ? path.join(home, rawPath.slice(2)) : rawPath;
  const resolved = path.resolve(expanded);

  const credentialDirs = ['.ssh', '.aws', '.gnupg'].map((dir) => path.join(home, dir));
  if (credentialDirs.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))) {
    return true;
  }
  return resolved === path.join(home, '.lovdex', 'data', 'app.config.json');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide a permission request on the user's behalf during an unattended run.
 *
 * Deliberately NOT on the list: `.env`, `git commit`, ordinary file deletes and
 * `rm -rf node_modules`. Scheduled tasks do those legitimately, and a false
 * denial costs more (a task that fails for no reason the user can see) than the
 * marginal safety it buys. The list errs loose on purpose.
 */
export function decideAutoApproval(toolName: string, input: unknown): AutoApproveDecision {
  if (TOOLS_REQUIRING_INTERACTION.has(toolName)) {
    return { behavior: 'deny', reason: UNATTENDED_INTERACTION_DENY_REASON };
  }

  if (toolName === 'Bash') {
    const command = bashCommandOf(input);
    const hit = COMMAND_RULES.find((rule) => rule.matches(command));
    if (hit) return { behavior: 'deny', reason: hit.reason };
    return { behavior: 'allow' };
  }

  if (FILE_PATH_TOOLS.has(toolName)) {
    const target = filePathOf(input);
    if (isSensitivePath(target)) {
      return { behavior: 'deny', reason: `拒绝：${target} 属于凭证或关键配置路径` };
    }
    return { behavior: 'allow' };
  }

  return { behavior: 'allow' };
}

/**
 * Resolve the auto-approval flag for a session's linked task.
 *
 * `chat.send` options come from the browser, so this must be resolved
 * server-side: trusting a client-supplied flag would let any client grant
 * itself unattended permissions. Returns true only for an explicit
 * `auto_approve === 1`; anything else (no task, flag 0, an unexpected value, a
 * DB error) resolves to false so the run keeps asking the human — exactly what
 * happens today.
 */
export function resolveTaskAutoApprove(
  sessionId: string,
  lookup: (sessionId: string) => { auto_approve: number } | null,
): boolean {
  try {
    return lookup(sessionId)?.auto_approve === 1;
  } catch (error) {
    console.error('[auto-approve] task lookup failed; falling back to asking the human', error);
    return false;
  }
}

/**
 * The Lovdex-level permission mode that means "answer the permission prompts
 * yourself". It is NOT a value the Claude SDK understands — `PermissionMode` is
 * a closed union ('default' | 'acceptEdits' | 'bypassPermissions' | 'plan' |
 * 'dontAsk' | 'auto') and `claude-sdk.js` forwards any non-'default' value
 * straight into it. `normalizePermissionMode` is what translates.
 *
 * Exported so the frontend, the runtimes and the tests all spell it the same
 * way; a typo in any one of them would silently disable the feature.
 */
export const AUTO_APPROVE_MODE = 'autoApprove';

/** Modes Lovdex has actually verified end to end. `dontAsk` is deliberately absent. */
const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'default',
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

/**
 * Translate a Lovdex permission mode into what the provider runtimes consume.
 *
 * `autoApprove` MUST resolve to `'default'`, not to `'bypassPermissions'`:
 * `canUseTool` is only consulted when the mode is not bypass, and the whole
 * auto-approval policy hangs off that callback. Resolving it to bypass would
 * skip the danger rules entirely — the feature would look like it worked while
 * silently approving `rm -rf /`.
 *
 * Unknown values degrade to `'default'`, matching the direction every other
 * fallback in this codebase takes (ask the human, never grant).
 */
export function normalizePermissionMode(mode: unknown): {
  permissionMode: string;
  autoApprove: boolean;
} {
  if (mode === AUTO_APPROVE_MODE) {
    return { permissionMode: 'default', autoApprove: true };
  }
  if (typeof mode === 'string' && KNOWN_PERMISSION_MODES.has(mode)) {
    return { permissionMode: mode, autoApprove: false };
  }
  return { permissionMode: 'default', autoApprove: false };
}
