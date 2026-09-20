import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILLS_CAPABILITY,
  makeSkillsApplyParamsSchema,
  makeSkillsBundleParamsSchema,
  makeSkillsManifestParamsSchema,
} from '../protocol.js';

test('SKILLS_CAPABILITY is the versioned capability string', () => {
  assert.equal(SKILLS_CAPABILITY, 'skills/v1');
});

test('manifest params require a non-empty root', () => {
  assert.deepEqual(makeSkillsManifestParamsSchema().parse({ root: '~/.claude/skills' }), {
    root: '~/.claude/skills',
  });
  assert.throws(() => makeSkillsManifestParamsSchema().parse({ root: '' }));
  assert.throws(() => makeSkillsManifestParamsSchema().parse({}));
});

test('bundle params require root and name', () => {
  const schema = makeSkillsBundleParamsSchema();
  assert.deepEqual(schema.parse({ root: '/srv/.claude/skills', name: 'demo' }), {
    root: '/srv/.claude/skills',
    name: 'demo',
  });
  assert.throws(() => schema.parse({ root: '/srv/.claude/skills' }));
});

test('apply params accept a null expectedTargetHash and default force to false', () => {
  const parsed = makeSkillsApplyParamsSchema().parse({
    root: '/srv/.claude/skills',
    name: 'demo',
    contentHash: 'abc',
    files: [
      { relativePath: 'SKILL.md', content: 'hi', encoding: 'utf8', executable: false },
    ],
    expectedTargetHash: null,
  });
  assert.equal(parsed.expectedTargetHash, null);
  assert.equal(parsed.force, false);
});

test('apply params default encoding to utf8 and executable to false', () => {
  const parsed = makeSkillsApplyParamsSchema().parse({
    root: '/srv/.claude/skills',
    name: 'demo',
    contentHash: 'abc',
    files: [{ relativePath: 'SKILL.md', content: 'hi' }],
    expectedTargetHash: 'def',
  });
  assert.equal(parsed.files[0].encoding, 'utf8');
  assert.equal(parsed.files[0].executable, false);
});

test('apply params reject a relativePath that escapes the skill directory', () => {
  const schema = makeSkillsApplyParamsSchema();
  const base = { root: '/srv/.claude/skills', name: 'demo', contentHash: 'abc', expectedTargetHash: null };
  for (const bad of ['../evil.md', '/etc/passwd', 'a/../../evil.md', 'a\\..\\evil.md', '']) {
    assert.throws(
      () => schema.parse({ ...base, files: [{ relativePath: bad, content: 'x' }] }),
      (error: unknown) => error instanceof Error,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});
