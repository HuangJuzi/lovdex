import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';

test('listSkills discovers SKILL.md under both dsh skill roots', async () => {
  const provider = new DshSkillsProvider();
  const sources = await (provider as unknown as {
    getSkillSources: (w: string) => Promise<Array<{ rootDir: string; scope: string }>>;
  }).getSkillSources(process.cwd());

  const userRoots = sources.filter((s) => s.scope === 'user').map((s) => s.rootDir);
  // dsh-skill-filesystem scans four default roots: project `.dsh/skills`,
  // project `.agents/skills`, `~/.dsh/skills`, and `~/.agents/skills`
  // (agentsHome). The user scope must declare both user roots.
  assert.ok(
    userRoots.includes(path.join(os.homedir(), '.dsh', 'skills')),
    'a ~/.dsh/skills user source must be declared',
  );
  assert.ok(
    userRoots.includes(path.join(os.homedir(), '.agents', 'skills')),
    'a ~/.agents/skills user source must be declared',
  );

  const projectRoots = sources.filter((s) => s.scope === 'project').map((s) => s.rootDir);
  assert.ok(
    projectRoots.includes(path.join(process.cwd(), '.dsh', 'skills')),
    'a project .dsh/skills source must be declared',
  );
  assert.ok(
    projectRoots.includes(path.join(process.cwd(), '.agents', 'skills')),
    'a project .agents/skills source must be declared',
  );
});

test('listSkills discovers a skill bundle under a workspace .agents/skills dir', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `dsh-skills-${Date.now()}`));
  try {
    const skillDir = path.join(tmp, '.agents', 'skills', 'demo-agent-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-agent-skill\ndescription: A demo skill.\n---\n\nDo the thing.\n',
      'utf8',
    );

    const skills = await new DshSkillsProvider().listSkills({ workspacePath: tmp });
    assert.ok(
      skills.some((s) => s.command === '/demo-agent-skill'),
      'the .agents/skills bundle must be discovered',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('listSkills returns [] for a workspace with no dsh skills', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `dsh-skills-${Date.now()}`));
  try {
    const skills = await new DshSkillsProvider().listSkills({ workspacePath: tmp });
    assert.ok(Array.isArray(skills));
    assert.equal(skills.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
