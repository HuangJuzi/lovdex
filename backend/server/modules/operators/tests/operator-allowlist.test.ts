import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_OPERATOR_ALLOWLIST,
  findSkillEntry,
  getOperatorAllowlist,
  isValidSkillName,
  isWriteAllowed,
  normalizeAllowlist,
  resetOperatorAllowlistCache,
  type OperatorAllowlist,
} from '@/modules/operators/operator-allowlist.js';

const LIST: OperatorAllowlist = {
  enabled_skills: [
    {
      name: 'claw-agent-get-send',
      entry: 'scripts/appia_claw.py',
      runner: 'uv',
      allowed_subcommands: ['groups', 'send'],
    },
  ],
  workbench_write_prefixes: ['/tmp/operator-home', '/tmp/skills'],
};

test('skill name validation rejects traversal and separators', () => {
  assert.equal(isValidSkillName('claw-agent-get-send'), true);
  assert.equal(isValidSkillName('../etc'), false);
  assert.equal(isValidSkillName('a/b'), false);
  assert.equal(isValidSkillName('a\\b'), false);
  assert.equal(isValidSkillName(''), false);
});

test('findSkillEntry hits allowlisted skills and misses others', () => {
  assert.equal(findSkillEntry('claw-agent-get-send', LIST)?.runner, 'uv');
  assert.equal(findSkillEntry('not-a-skill', LIST), null);
  assert.equal(findSkillEntry('../evil', LIST), null);
});

test('isWriteAllowed enforces the prefix boundary', () => {
  assert.equal(isWriteAllowed('/tmp/operator-home', LIST), true);
  assert.equal(isWriteAllowed('/tmp/operator-home/a/b.txt', LIST), true);
  assert.equal(isWriteAllowed('/tmp/operator-home-evil/x', LIST), false);
  assert.equal(isWriteAllowed('/tmp/other', LIST), false);
  assert.equal(isWriteAllowed('/tmp/skills/some-skill/s.py', LIST), true);
});

test('normalizeAllowlist expands ~ and rejects malformed input', () => {
  const normalized = normalizeAllowlist({
    enabled_skills: [],
    workbench_write_prefixes: ['~/x'],
  });
  assert.equal(normalized.workbench_write_prefixes[0], path.join(os.homedir(), 'x'));
  assert.throws(() => normalizeAllowlist({ enabled_skills: [] }), /workbench_write_prefixes/);
  assert.throws(
    () =>
      normalizeAllowlist({
        enabled_skills: [{ name: '../bad', entry: 'e', runner: 'uv', allowed_subcommands: ['x'] }],
        workbench_write_prefixes: [],
      }),
    /malformed/,
  );
});

test('env override (inline JSON) wins and resets via cache seam', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-allowlist-'));
  process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON = JSON.stringify({
    enabled_skills: [],
    workbench_write_prefixes: [dir],
  });
  try {
    resetOperatorAllowlistCache();
    const list = getOperatorAllowlist();
    assert.deepEqual(list.enabled_skills, []);
    assert.equal(list.workbench_write_prefixes[0], fs.realpathSync(dir));
  } finally {
    delete process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON;
    resetOperatorAllowlistCache();
  }
});

test('malformed env override falls back to defaults with a warning', () => {
  process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON = '{broken';
  try {
    resetOperatorAllowlistCache();
    const list = getOperatorAllowlist();
    assert.equal(list.enabled_skills.length, DEFAULT_OPERATOR_ALLOWLIST.enabled_skills.length);
  } finally {
    delete process.env.LOVDEX_OPERATOR_ALLOWLIST_JSON;
    resetOperatorAllowlistCache();
  }
});
