import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createOperatorExecService,
  resolveRealPath,
  splitArgs,
  type OperatorAuditEntry,
  type SpawnFn,
} from '@/modules/operators/operator-exec.service.js';
import type { OperatorAllowlist } from '@/modules/operators/operator-allowlist.js';

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1OTk5In0.dummy-signature-value';
const FAKE_CREDENTIALS = { CLAW_JWT: FAKE_JWT, APP_AGENT_ID: 'agent-secret-1', CLAW_USER_ID: 'user-secret-1' };

type SpawnCall = { file: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number } };

function makeHarness(opts: {
  spawnResult?: { code: number | null; stdout: string; stderr: string };
  spawnError?: string;
  withSkillEntry?: boolean;
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-exec-'));
  const home = path.join(tmp, 'home');
  const skillsRoot = path.join(tmp, 'skills');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });

  const skillDir = path.join(skillsRoot, 'claw-agent-get-send');
  const entryPath = path.join(skillDir, 'scripts', 'appia_claw.py');
  if (opts.withSkillEntry !== false) {
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '# fake skill entry\n');
  }

  const allowlist: OperatorAllowlist = {
    enabled_skills: [
      {
        name: 'claw-agent-get-send',
        entry: 'scripts/appia_claw.py',
        runner: 'uv',
        allowed_subcommands: ['groups', 'verify-target', 'send', 'send-md', 'send-file'],
        readonly_subcommands: ['groups', 'verify-target'],
      },
    ],
    workbench_write_prefixes: [fs.realpathSync(home), fs.realpathSync(skillsRoot)],
  };

  const spawnCalls: SpawnCall[] = [];
  const spawn: SpawnFn = async (file, args, options) => {
    spawnCalls.push({ file, args, options });
    return {
      code: opts.spawnResult?.code ?? 0,
      stdout: opts.spawnResult?.stdout ?? 'ok',
      stderr: opts.spawnResult?.stderr ?? '',
      error: opts.spawnError,
    };
  };

  const audits: OperatorAuditEntry[] = [];
  const service = createOperatorExecService({
    home,
    skillsRoot,
    credFile: path.join(tmp, 'claw', 'cred.json'),
    allowlist,
    resolveCredentials: () => ({ ...FAKE_CREDENTIALS }),
    spawn,
    audit: (e) => audits.push(e),
  });

  return { tmp, home, skillsRoot, skillDir, entryPath, service, spawnCalls, audits };
}

// --- splitArgs -------------------------------------------------------------

test('splitArgs handles quotes/escapes without a shell', () => {
  assert.deepEqual(splitArgs('groups'), ['groups']);
  assert.deepEqual(splitArgs('send --text "hello world" --rid r123'), ['send', '--text', 'hello world', '--rid', 'r123']);
  assert.deepEqual(splitArgs("send --text 'a b'"), ['send', '--text', 'a b']);
  // Shell metacharacters stay literal inside a token — never interpreted.
  assert.deepEqual(splitArgs('send --text "a; rm -rf / | cat"'), ['send', '--text', 'a; rm -rf / | cat']);
  assert.throws(() => splitArgs('send --text "unterminated'), /unterminated/);
});

// --- execute_skill ---------------------------------------------------------

test('execute_skill: allowlist hit spawns entry with subcommand + injected credentials', async () => {
  const h = makeHarness();
  const result = await h.service.executeSkill({ skillName: 'claw-agent-get-send', args: 'groups' });
  assert.equal(result.ok, true);
  assert.equal(h.spawnCalls.length, 1);
  const call = h.spawnCalls[0];
  assert.equal(call.file, 'uv');
  assert.deepEqual(call.args, ['run', h.entryPath, 'groups']);
  assert.equal(call.options.cwd, h.skillDir);
  // Credentials are injected into the child env at call instant…
  assert.equal(call.options.env.CLAW_JWT, FAKE_JWT);
  assert.equal(call.options.env.APP_AGENT_ID, 'agent-secret-1');
  // …but never appear in the returned payload or the audit record.
  const serialized = JSON.stringify(result) + JSON.stringify(h.audits);
  assert.ok(!serialized.includes(FAKE_JWT), 'JWT must not leak into result/audit');
  assert.ok(!serialized.includes('agent-secret-1'), 'agentId must not leak into result/audit');
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].decision, 'allow');
  assert.equal(h.audits[0].tool, 'execute_skill');
  assert.equal(h.audits[0].action, 'claw-agent-get-send:groups');
});

test('execute_skill: unknown skill is denied before any spawn', async () => {
  const h = makeHarness();
  const result = await h.service.executeSkill({ skillName: 'not-allowlisted', args: 'groups' });
  assert.equal(result.ok, false);
  assert.match(result.error!, /not in allowlist/);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].decision, 'deny');
});

test('execute_skill: undeclared subcommand is denied before any spawn', async () => {
  const h = makeHarness();
  const result = await h.service.executeSkill({ skillName: 'claw-agent-get-send', args: 'delete-everything' });
  assert.equal(result.ok, false);
  assert.match(result.error!, /subcommand not allowed/);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.audits[0].decision, 'deny');
});

test('execute_skill: traversal skill name is rejected', async () => {
  const h = makeHarness();
  const result = await h.service.executeSkill({ skillName: '../etc', args: 'groups' });
  assert.equal(result.ok, false);
  assert.match(result.error!, /invalid skill name/);
  assert.equal(h.spawnCalls.length, 0);
});

test('execute_skill: credential failure denies loudly without spawning', async () => {
  const h = makeHarness();
  const service = createOperatorExecService({
    home: h.home,
    skillsRoot: h.skillsRoot,
    allowlist: {
      enabled_skills: [
        { name: 'claw-agent-get-send', entry: 'scripts/appia_claw.py', runner: 'uv', allowed_subcommands: ['groups'] },
      ],
      workbench_write_prefixes: [fs.realpathSync(h.home)],
    },
    resolveCredentials: () => {
      throw new Error('credentials unavailable: missing CLAW_JWT');
    },
    spawn: async () => {
      throw new Error('must not spawn');
    },
    audit: (e) => h.audits.push(e),
  });
  const result = await service.executeSkill({ skillName: 'claw-agent-get-send', args: 'groups' });
  assert.equal(result.ok, false);
  assert.match(result.error!, /credentials unavailable/);
  assert.equal(h.audits.at(-1)!.decision, 'deny');
});

test('execute_skill: stdout is sanitized (JWT/agentId/userId masked)', async () => {
  const h = makeHarness({
    spawnResult: {
      code: 0,
      stdout: `{"rid":"r1","agentId":"agent-secret-1","userId":"user-secret-1","jwt":"${FAKE_JWT}"}`,
      stderr: '',
    },
  });
  const result = await h.service.executeSkill({ skillName: 'claw-agent-get-send', args: 'groups --json' });
  assert.equal(result.ok, true);
  assert.ok(!result.stdout!.includes(FAKE_JWT));
  assert.ok(!result.stdout!.includes('agent-secret-1'));
  assert.ok(!result.stdout!.includes('user-secret-1'));
  assert.ok(result.stdout!.includes('***REDACTED***'));
  // The audit summary is sanitized too.
  assert.ok(!JSON.stringify(h.audits).includes(FAKE_JWT));
});

test('execute_skill: non-zero exit surfaces as ok=false with exit code', async () => {
  const h = makeHarness({ spawnResult: { code: 2, stdout: '', stderr: 'boom' }, spawnError: 'exit 2' });
  const result = await h.service.executeSkill({ skillName: 'claw-agent-get-send', args: 'groups' });
  assert.equal(result.ok, false);
  assert.equal('exitCode' in result ? result.exitCode : null, 2);
  assert.equal(h.audits[0].exitCode, 2);
});

// --- workbench -------------------------------------------------------------

test('workbench list: lists a directory', async () => {
  const h = makeHarness();
  fs.writeFileSync(path.join(h.home, 'a.txt'), 'hello');
  const result = await h.service.workbench({ command: 'list', path: h.home });
  assert.equal(result.ok, true);
  const entries = (result as unknown as { entries: { name: string }[] }).entries;
  assert.ok(entries.some((e) => e.name === 'a.txt'));
});

test('workbench read: reads a file with sanitization', async () => {
  const h = makeHarness();
  const f = path.join(h.home, 'note.txt');
  fs.writeFileSync(f, `report ok, token=${FAKE_JWT}`);
  const result = await h.service.workbench({ command: 'read', path: f });
  assert.equal(result.ok, true);
  const content = (result as unknown as { content: string }).content;
  assert.ok(!content.includes(FAKE_JWT));
  assert.ok(content.includes('report ok'));
});

test('workbench read: credential files are never echoed', async () => {
  const h = makeHarness();
  const credDir = path.join(h.tmp, 'claw');
  fs.mkdirSync(credDir, { recursive: true });
  const credFile = path.join(credDir, 'cred.json');
  fs.writeFileSync(credFile, JSON.stringify({ jwt: FAKE_JWT }));
  const result = await h.service.workbench({ command: 'read', path: credFile });
  assert.equal(result.ok, false);
  assert.match(result.error!, /credential/);
  assert.equal(h.audits.at(-1)!.decision, 'deny');
});

test('workbench copy: into Operator Home is allowed (from anywhere)', async () => {
  const h = makeHarness();
  const outside = path.join(h.tmp, 'outside.txt');
  fs.writeFileSync(outside, 'payload');
  const dst = path.join(h.home, 'inbox', 'outside.txt');
  const result = await h.service.workbench({ command: 'copy', src: outside, dst });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(dst, 'utf8'), 'payload');
  assert.equal(h.audits.at(-1)!.decision, 'allow');
});

test('workbench copy: escaping Operator Home is denied with a dispatch hint', async () => {
  const h = makeHarness();
  const src = path.join(h.home, 'a.txt');
  fs.writeFileSync(src, 'x');
  const dst = path.join(h.tmp, 'other-project', 'a.txt');
  const result = await h.service.workbench({ command: 'copy', src, dst });
  assert.equal(result.ok, false);
  assert.match(result.error!, /outside allowed write prefixes/);
  assert.match((result as { hint?: string }).hint ?? '', /create_task/);
  assert.equal(fs.existsSync(dst), false);
  assert.equal(h.audits.at(-1)!.decision, 'deny');
});

test('workbench copy: symlink escape is caught by realpath resolution', async () => {
  const h = makeHarness();
  const outsideDir = path.join(h.tmp, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 's');
  // A symlink INSIDE home pointing OUT — dst resolves outside → deny.
  fs.symlinkSync(outsideDir, path.join(h.home, 'link-out'));
  const src = path.join(h.home, 'a.txt');
  fs.writeFileSync(src, 'x');
  const result = await h.service.workbench({
    command: 'copy',
    src,
    dst: path.join(h.home, 'link-out', 'copied.txt'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /outside allowed write prefixes/);
});

test('workbench run-script: script outside allowed roots is denied', async () => {
  const h = makeHarness();
  const script = path.join(h.tmp, 'evil.js');
  fs.writeFileSync(script, 'console.log("hi")');
  const result = await h.service.workbench({ command: 'run-script', scriptPath: script });
  assert.equal(result.ok, false);
  assert.match(result.error!, /outside allowed roots/);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.audits.at(-1)!.decision, 'deny');
});

test('workbench run-script: unsupported script type is denied', async () => {
  const h = makeHarness();
  const script = path.join(h.home, 'x.exe');
  fs.writeFileSync(script, 'bin');
  const result = await h.service.workbench({ command: 'run-script', scriptPath: script });
  assert.equal(result.ok, false);
  assert.match(result.error!, /unsupported script type/);
});

test('workbench run-script: real node script runs end-to-end (no shell, argv literal)', async () => {
  const h = makeHarness();
  // Real service without the spawn seam: exercises the execFile default path.
  const service = createOperatorExecService({
    home: h.home,
    skillsRoot: h.skillsRoot,
    credFile: path.join(h.tmp, 'claw', 'cred.json'),
    allowlist: {
      enabled_skills: [],
      workbench_write_prefixes: [fs.realpathSync(h.home)],
    },
    resolveCredentials: () => ({ ...FAKE_CREDENTIALS }),
    audit: (e) => h.audits.push(e),
  });
  const script = path.join(h.home, 'argv.js');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const result = await service.workbench({
    command: 'run-script',
    scriptPath: script,
    args: 'hello "a; rm -rf /" --flag',
  });
  assert.equal(result.ok, true);
  const printed = JSON.parse((result as { stdout: string }).stdout.trim()) as string[];
  // The metacharacter string arrived as ONE literal argv token — no shell
  // ever saw it, so nothing executed beyond the script itself.
  assert.deepEqual(printed, ['hello', 'a; rm -rf /', '--flag']);
  assert.equal(h.audits.at(-1)!.decision, 'allow');
});

test('workbench: unknown command is denied', async () => {
  const h = makeHarness();
  const result = await h.service.workbench({ command: 'rm -rf /' });
  assert.equal(result.ok, false);
  assert.match(result.error!, /unknown workbench command/);
});

// --- path resolution -------------------------------------------------------

test('resolveRealPath expands ~ and resolves .. lexically', () => {
  assert.equal(resolveRealPath('~/x'), path.join(os.homedir(), 'x'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-rr-'));
  const resolved = resolveRealPath(path.join(tmp, 'a', '..', 'b'));
  assert.equal(resolved, path.join(fs.realpathSync(tmp), 'b'));
});
