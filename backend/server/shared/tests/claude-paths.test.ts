import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { getClaudeHomePath, getClaudeSkillsDir } from '../claude-paths.js';

test('getClaudeHomePath is ~/.claude', () => {
  assert.equal(getClaudeHomePath(), path.join(os.homedir(), '.claude'));
});

test('getClaudeSkillsDir is ~/.claude/skills', () => {
  assert.equal(getClaudeSkillsDir(), path.join(os.homedir(), '.claude', 'skills'));
});
