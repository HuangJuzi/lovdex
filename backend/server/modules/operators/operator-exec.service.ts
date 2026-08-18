/**
 * Operator in-place execution service.
 *
 * Backs the execute_skill / workbench operator tools. All policy lives here:
 * allowlist checks (operator-allowlist.ts), credential resolution
 * (credential-resolver.ts — injected into the child env ONLY), output
 * redaction (output-sanitizer.ts), and the audit hook.
 *
 * Hard rules encoded here (see docs/spec/operator-skill-execution.md):
 *  - No shell anywhere: every spawn is execFile with an argv array. User
 *    input is tokenized by splitArgs (quotes/escapes only — metacharacters
 *    like `;` `|` `>` stay literal argv, never interpreted).
 *  - No background processes / sub-agents: no `detached`, the child is
 *    awaited with a timeout that kills it. Skills can never spawn a nested
 *    agent CLI with the credentials because credentials only exist in the
 *    direct child's env and the child is a whitelisted script.
 *  - Writes stay inside the allowlisted prefixes (Operator Home + skills
 *    root by default); anything else is denied loudly and audited.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findSkillEntry,
  isValidSkillName,
  isWriteAllowed,
  getOperatorAllowlist,
  type OperatorAllowlist,
} from '@/modules/operators/operator-allowlist.js';
import {
  resolveClawCredentials,
  defaultCredFile,
  type ClawCredentials,
} from '@/modules/operators/credential-resolver.js';
import { sanitizeOutput } from '@/modules/operators/output-sanitizer.js';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 200;
const AUDIT_SUMMARY_LEN = 500;

/** One audit record per tool call (allowed or denied). */
export type OperatorAuditEntry = {
  caller: string;
  tool: 'execute_skill' | 'workbench';
  action: string;
  target: string | null;
  decision: 'allow' | 'deny';
  reason: string | null;
  durationMs: number;
  exitCode: number | null;
  resultSummary: string | null;
};

/** Result of a spawned child — resolved (never rejected) by the runner. */
export type SpawnResult = { code: number | null; stdout: string; stderr: string; error?: string };

export type SpawnFn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<SpawnResult>;

export type OperatorExecDeps = {
  /** Operator Home (workspace). Default: operator config workspace. */
  home: string;
  /** User-level skills root. Default ~/.claude/skills. */
  skillsRoot?: string;
  /** Cred file path for blocked-read checks + credential resolution. */
  credFile?: string;
  /** Allowlist snapshot. Default: getOperatorAllowlist(). */
  allowlist?: OperatorAllowlist;
  /** Credential resolver seam (tests inject fakes; never receives real values). */
  resolveCredentials?: () => ClawCredentials;
  /** Process spawner seam (tests inject fakes). */
  spawn?: SpawnFn;
  /** Audit sink — failures inside are swallowed by the service. */
  audit?: (entry: OperatorAuditEntry) => void;
};

/** Default spawner: execFile, no shell, awaited, timeout-killed. */
const defaultSpawn: SpawnFn = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // shell stays false (default) and detached stays false (default):
        // synchronous, foreground, no sub-agent fan-out.
      },
      (error, stdout, stderr) => {
        // Non-zero exit → error.code is the numeric exit code; signal/timeout
        // kill → error.code is null (error.signal/killed describe it).
        const errCode = (error as { code?: unknown } | null)?.code;
        const code = error ? (typeof errCode === 'number' ? errCode : null) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error ? error.message : undefined,
        });
      },
    );
  });

/**
 * Splits a command-line style string into argv tokens WITHOUT a shell.
 * Supports single/double quotes and backslash escapes; shell metacharacters
 * (`;`, `|`, `>`, `$(...)`) are literal characters inside a token.
 */
export function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: 'single' | 'double' | null = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === 'single') {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === 'double') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && input[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '\\' && input[i + 1] === '\\') {
        cur += '\\';
        i += 1;
      } else cur += ch;
      continue;
    }
    if (ch === "'") {
      quote = 'single';
      hasToken = true;
    } else if (ch === '"') {
      quote = 'double';
      hasToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1];
      i += 1;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken || cur) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in args`);
  if (hasToken || cur) tokens.push(cur);
  return tokens;
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeoutMs), 1000), MAX_TIMEOUT_MS);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolves a user-supplied path to a canonical absolute path: `~` expansion,
 * lexical resolve, then realpath of the nearest existing ancestor (write
 * targets may not exist yet). This is the symlink/traversal guard — all
 * allowlist decisions are made against the result.
 */
export function resolveRealPath(input: string): string {
  let resolved = path.resolve(expandHome(input));
  // Walk up to the nearest existing ancestor and realpath it.
  const missing: string[] = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // filesystem root
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    cursor = fs.realpathSync(cursor);
  } catch {
    // Permission errors etc. — fall back to the lexical path.
  }
  resolved = missing.length > 0 ? path.join(cursor, ...missing) : cursor;
  return resolved;
}

/** First non-flag token = the subcommand (matches appia_claw.py's argparse layout). */
function extractSubcommand(tokens: string[]): string | null {
  for (const t of tokens) {
    if (!t.startsWith('-')) return t;
  }
  return null;
}

export function createOperatorExecService(deps: OperatorExecDeps) {
  const home = resolveRealPath(deps.home);
  const skillsRoot = deps.skillsRoot ? resolveRealPath(deps.skillsRoot) : path.join(os.homedir(), '.claude', 'skills');
  const credFile = deps.credFile ?? defaultCredFile();
  // An explicitly injected allowlist is a fixed snapshot (tests); otherwise
  // resolve per call so settings-API updates take effect without a restart.
  const resolveAllowlist = deps.allowlist ? () => deps.allowlist! : () => getOperatorAllowlist();
  const spawn = deps.spawn ?? defaultSpawn;
  const resolveCredentials = deps.resolveCredentials ?? (() => resolveClawCredentials({ credFile }));

  const audit = (entry: OperatorAuditEntry): void => {
    try {
      deps.audit?.(entry);
    } catch (e) {
      console.warn('[operator-exec] audit write failed:', e instanceof Error ? e.message : String(e));
    }
  };

  const deny = (
    tool: OperatorAuditEntry['tool'],
    action: string,
    target: string | null,
    reason: string,
    startedAt: number,
    hint?: string,
  ) => {
    audit({
      caller: 'operator',
      tool,
      action,
      target: target ? sanitizeOutput(target, 300) : null,
      decision: 'deny',
      reason,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      resultSummary: null,
    });
    return { ok: false as const, error: reason, ...(hint ? { hint } : {}) };
  };

  async function executeSkill(input: { skillName: string; args?: string; timeoutMs?: number }) {
    const startedAt = Date.now();
    const { skillName } = input;
    const action = `skill:${skillName}`;

    if (!isValidSkillName(skillName)) {
      return deny('execute_skill', action, null, `invalid skill name: ${skillName}`, startedAt);
    }
    const entry = findSkillEntry(skillName, resolveAllowlist());
    if (!entry) {
      return deny(
        'execute_skill',
        action,
        null,
        `skill not in allowlist: ${skillName}`,
        startedAt,
        '仅白名单内技能可就地执行；其他操作请用 create_task 下发任务。',
      );
    }

    let tokens: string[];
    try {
      tokens = splitArgs(input.args ?? '');
    } catch (e) {
      return deny('execute_skill', action, null, e instanceof Error ? e.message : String(e), startedAt);
    }
    const subcommand = extractSubcommand(tokens);
    const actionFull = `${skillName}:${subcommand ?? '(none)'}`;
    if (!subcommand || !entry.allowed_subcommands.includes(subcommand)) {
      return deny(
        'execute_skill',
        actionFull,
        null,
        `subcommand not allowed for ${skillName}: ${subcommand ?? '(none)'} ` +
          `(allowed: ${entry.allowed_subcommands.join(', ')})`,
        startedAt,
      );
    }

    const skillDir = path.join(skillsRoot, skillName);
    const entryPath = path.join(skillDir, entry.entry);
    if (!fs.existsSync(entryPath)) {
      return deny('execute_skill', actionFull, skillDir, `skill entry not found: ${entryPath}`, startedAt);
    }

    // Credentials resolve at call instant and live only in the child env.
    let credentials: ClawCredentials;
    try {
      credentials = resolveCredentials();
    } catch (e) {
      return deny('execute_skill', actionFull, null, e instanceof Error ? e.message : String(e), startedAt);
    }

    const argv =
      entry.runner === 'uv' ? ['run', entryPath, ...tokens] : [entryPath, ...tokens];
    const result = await spawn(entry.runner, argv, {
      cwd: skillDir,
      env: { ...process.env, ...credentials },
      timeoutMs: clampTimeout(input.timeoutMs),
    });
    const durationMs = Date.now() - startedAt;
    const stdout = sanitizeOutput(result.stdout);
    const stderr = sanitizeOutput(result.stderr);
    const ok = result.code === 0;
    audit({
      caller: 'operator',
      tool: 'execute_skill',
      action: actionFull,
      target: sanitizeOutput(tokens.join(' '), 300) || null,
      decision: 'allow',
      reason: null,
      durationMs,
      exitCode: result.code,
      resultSummary: sanitizeOutput(stdout || stderr || result.error || '', AUDIT_SUMMARY_LEN),
    });
    return {
      ok,
      skill: skillName,
      subcommand,
      exitCode: result.code,
      durationMs,
      stdout,
      stderr,
      ...(result.error ? { error: sanitizeOutput(result.error) } : {}),
    };
  }

  async function workbench(input: {
    command: string;
    path?: string;
    src?: string;
    dst?: string;
    scriptPath?: string;
    args?: string;
    timeoutMs?: number;
  }) {
    const startedAt = Date.now();
    const command = input.command;
    const finish = (
      payload: Record<string, unknown>,
      target: string | null,
      summary: string,
      exitCode: number | null = null,
    ) => {
      audit({
        caller: 'operator',
        tool: 'workbench',
        action: command,
        target: target ? sanitizeOutput(target, 300) : null,
        decision: 'allow',
        reason: null,
        durationMs: Date.now() - startedAt,
        exitCode,
        resultSummary: sanitizeOutput(summary, AUDIT_SUMMARY_LEN),
      });
      return { ok: true as const, command, durationMs: Date.now() - startedAt, ...payload };
    };

    if (command === 'list') {
      if (!input.path) return deny('workbench', command, null, 'list requires `path`', startedAt);
      const target = resolveRealPath(input.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        return deny('workbench', command, target, `path not found: ${input.path}`, startedAt);
      }
      if (!stat.isDirectory()) {
        return deny('workbench', command, target, `not a directory: ${input.path}`, startedAt);
      }
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .slice(0, MAX_LIST_ENTRIES)
        .map((d) => ({
          name: sanitizeOutput(d.name, 200),
          type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
          size: d.isFile() ? fs.statSync(path.join(target, d.name)).size : null,
        }));
      return finish({ path: target, entries }, target, `${entries.length} entries`);
    }

    if (command === 'read') {
      if (!input.path) return deny('workbench', command, null, 'read requires `path`', startedAt);
      const target = resolveRealPath(input.path);
      // Never echo credential material back to the model/transcript.
      const credDir = path.dirname(resolveRealPath(credFile));
      if (target === credDir || target.startsWith(credDir + path.sep)) {
        return deny(
          'workbench',
          command,
          target,
          'reading credential files is not allowed',
          startedAt,
          '凭证文件不可通过 workbench 读取（防回显明文）。',
        );
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        return deny('workbench', command, target, `path not found: ${input.path}`, startedAt);
      }
      if (!stat.isFile()) {
        return deny('workbench', command, target, `not a file: ${input.path}`, startedAt);
      }
      const fd = fs.openSync(target, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
        fs.readSync(fd, buf, 0, buf.length, 0);
        const content = sanitizeOutput(buf.toString('utf8'));
        return finish({ path: target, content, truncated: stat.size > MAX_READ_BYTES }, target, content);
      } finally {
        fs.closeSync(fd);
      }
    }

    if (command === 'copy') {
      if (!input.src || !input.dst) {
        return deny('workbench', command, null, 'copy requires `src` and `dst`', startedAt);
      }
      const src = resolveRealPath(input.src);
      const dst = resolveRealPath(input.dst);
      const targetLabel = `${src} -> ${dst}`;
      if (!fs.existsSync(src)) {
        return deny('workbench', command, targetLabel, `copy source not found: ${input.src}`, startedAt);
      }
      if (!isWriteAllowed(dst, resolveAllowlist())) {
        return deny(
          'workbench',
          command,
          targetLabel,
          `copy destination outside allowed write prefixes: ${dst}`,
          startedAt,
          '跨出 Operator Home 的写操作请改用 create_task 下发任务到对应项目执行。',
        );
      }
      if (dst === src || dst.startsWith(src + path.sep)) {
        return deny('workbench', command, targetLabel, 'cannot copy a path into itself', startedAt);
      }
      try {
        fs.cpSync(src, dst, { recursive: true });
      } catch (e) {
        return deny('workbench', command, targetLabel, `copy failed: ${e instanceof Error ? e.message : String(e)}`, startedAt);
      }
      return finish({ src, dst }, targetLabel, 'copied');
    }

    if (command === 'run-script') {
      if (!input.scriptPath) {
        return deny('workbench', command, null, 'run-script requires `scriptPath`', startedAt);
      }
      const script = resolveRealPath(input.scriptPath);
      if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
        return deny('workbench', command, script, `script not found: ${input.scriptPath}`, startedAt);
      }
      if (!isWriteAllowed(script, resolveAllowlist())) {
        return deny(
          'workbench',
          command,
          script,
          `script outside allowed roots: ${script}`,
          startedAt,
          '脚本须放在 Operator Home（或白名单前缀）内才能执行。',
        );
      }
      let tokens: string[];
      try {
        tokens = splitArgs(input.args ?? '');
      } catch (e) {
        return deny('workbench', command, script, e instanceof Error ? e.message : String(e), startedAt);
      }
      const ext = path.extname(script).toLowerCase();
      let file: string;
      let argv: string[];
      if (ext === '.py') {
        file = 'uv';
        argv = ['run', script, ...tokens];
      } else if (ext === '.js' || ext === '.mjs') {
        file = 'node';
        argv = [script, ...tokens];
      } else if (ext === '.sh') {
        file = 'bash';
        argv = [script, ...tokens];
      } else {
        return deny('workbench', command, script, `unsupported script type: ${ext || '(none)'}`, startedAt);
      }
      const result = await spawn(file, argv, {
        cwd: home,
        env: { ...process.env },
        timeoutMs: clampTimeout(input.timeoutMs),
      });
      const stdout = sanitizeOutput(result.stdout);
      const stderr = sanitizeOutput(result.stderr);
      const durationMs = Date.now() - startedAt;
      audit({
        caller: 'operator',
        tool: 'workbench',
        action: command,
        target: sanitizeOutput(`${script} ${tokens.join(' ')}`.trim(), 300),
        decision: 'allow',
        reason: null,
        durationMs,
        exitCode: result.code,
        resultSummary: sanitizeOutput(stdout || stderr || result.error || '', AUDIT_SUMMARY_LEN),
      });
      return {
        ok: result.code === 0,
        command,
        script,
        exitCode: result.code,
        durationMs,
        stdout,
        stderr,
        ...(result.error ? { error: sanitizeOutput(result.error) } : {}),
      };
    }

    return deny(
      'workbench',
      command || '(missing)',
      null,
      `unknown workbench command: ${command || '(missing)'} (expected list|read|copy|run-script)`,
      startedAt,
    );
  }

  return { executeSkill, workbench };
}

export type OperatorExecService = ReturnType<typeof createOperatorExecService>;
