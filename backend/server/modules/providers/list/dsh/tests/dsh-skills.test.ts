import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, rm } from 'node:fs/promises';

import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';

test('listSkills discovers SKILL.md under the user skill root', async () => {
  const provider = new DshSkillsProvider();
  const sources = await (provider as unknown as {
    getSkillSources: (w: string) => Promise<Array<{ rootDir: string; scope: string }>>;
  }).getSkillSources(process.cwd());

  const userSource = sources.find((s) => s.scope === 'user');
  assert.ok(userSource, 'a user-scope source must be declared');
  assert.equal(userSource.rootDir, path.join(os.homedir(), '.dsh', 'skills'));
});

test('listSkills returns [] for a workspace with no dsh skills', async () => {
  const tmp = path.join(os.tmpdir(), `dsh-skills-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const skills = await new DshSkillsProvider().listSkills({ workspacePath: tmp });
    assert.ok(Array.isArray(skills));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
