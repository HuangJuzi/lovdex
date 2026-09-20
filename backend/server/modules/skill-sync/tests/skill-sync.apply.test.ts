import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeSkillHash, type SkillFileEntry } from '@/shared/skill-hash.js';
import { createSkillStore } from '@/shared/skill-store.js';

import { createSkillSyncService } from '../skill-sync.service.js';
import type { SkillNode } from '../types.js';
import type { SkillSyncAuditInput } from '../skill-sync.db.js';

async function mkRoot(tag: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `apply-${tag}-`));
  return fsp.realpath(dir);
}

async function putSkill(root: string, name: string, content: string): Promise<string> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content);
  const files: SkillFileEntry[] = [{ relativePath: 'SKILL.md', content, encoding: 'utf8', executable: false }];
  return computeSkillHash(files);
}

const LOCAL: SkillNode = { kind: 'local' };

function serviceFor(fromRoot: string, toRoot: string, audits: SkillSyncAuditInput[]) {
  return createSkillSyncService({
    getRegistry: () => {
      throw new Error('remote nodes are not exercised in this test');
    },
    getProjectById: () => null,
    audit: (input) => audits.push(input),
    now: () => 1000,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });
}

test('apply creates and updates, and reports per-entry status', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');
  await putSkill(fromRoot, 'changed', 'new');
  await putSkill(toRoot, 'changed', 'old');
  await putSkill(toRoot, 'extra', 'x');

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, actor: 'user' });

  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName.fresh.status, 'ok');
  assert.equal(byName.changed.status, 'ok');
  assert.equal(byName.extra.status, 'skipped');
  assert.equal(await fsp.readFile(path.join(toRoot, 'fresh', 'SKILL.md'), 'utf8'), 'a');
  assert.equal(await fsp.readFile(path.join(toRoot, 'changed', 'SKILL.md'), 'utf8'), 'new');
  assert.equal(await fsp.readFile(path.join(toRoot, 'extra', 'SKILL.md'), 'utf8'), 'x');
  assert.deepEqual(result.summary, { ok: 2, failed: 0, conflict: 0, skipped: 1 });
});

test('apply refuses a skill it could not fingerprint on the source side', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const huge = path.join(fromRoot, 'huge');
  await fsp.mkdir(huge, { recursive: true });
  await fsp.writeFile(path.join(huge, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, actor: 'user' });

  assert.equal(result.entries[0].status, 'failed');
  assert.match(result.entries[0].error ?? '', /无法读取/);
  assert.equal(audits[0].status, 'failed');
  await assert.rejects(() => fsp.stat(path.join(toRoot, 'huge')), /ENOENT/);
});

test('apply writes one audit row per transferred skill', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  await svc.apply({ planId: plan.planId, actor: 'operator' });

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'operator');
  assert.equal(audits[0].skill_name, 'fresh');
  assert.equal(audits[0].action, 'create');
  assert.equal(audits[0].status, 'ok');
  assert.equal(audits[0].from_node, 'local');
  assert.equal(audits[0].to_node, 'local');
  assert.equal(audits[0].scope, 'user');
});

test('apply honours the names subset', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'a-skill', 'a');
  await putSkill(fromRoot, 'b-skill', 'b');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, names: ['a-skill'], actor: 'user' });

  assert.deepEqual(result.entries.filter((e) => e.status === 'ok').map((e) => e.name), ['a-skill']);
  await assert.rejects(() => fsp.stat(path.join(toRoot, 'b-skill')), /ENOENT/);
});

test('a source that changed after planning is reported as a conflict, not overwritten', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'demo', 'v1');

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  // 源在 plan 之后被改了
  await putSkill(fromRoot, 'demo', 'v2');

  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  assert.equal(result.entries[0].status, 'conflict');
  assert.match(result.entries[0].error ?? '', /源/);
  await assert.rejects(() => fsp.stat(path.join(toRoot, 'demo')), /ENOENT/);
  assert.equal(audits[0].status, 'failed');
});

test('a target that changed after planning is reported as a conflict', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'demo', 'v1');
  await putSkill(toRoot, 'demo', 'v0');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  // 目标在 plan 之后被改了
  await putSkill(toRoot, 'demo', 'edited-locally');

  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  assert.equal(result.entries[0].status, 'conflict');
  assert.equal(await fsp.readFile(path.join(toRoot, 'demo', 'SKILL.md'), 'utf8'), 'edited-locally');
});

test('force overrides a drifted target', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'demo', 'v1');
  await putSkill(toRoot, 'demo', 'v0');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  await putSkill(toRoot, 'demo', 'edited-locally');

  const result = await svc.apply({ planId: plan.planId, actor: 'user', force: true });
  assert.equal(result.entries[0].status, 'ok');
  assert.equal(await fsp.readFile(path.join(toRoot, 'demo', 'SKILL.md'), 'utf8'), 'v1');
});

test('one failing entry does not abort the rest of the batch', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'a-broken', 'v1');
  await putSkill(fromRoot, 'b-good', 'v1');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  await putSkill(fromRoot, 'a-broken', 'v2'); // 只有 a 漂移

  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName['a-broken'].status, 'conflict');
  assert.equal(byName['b-good'].status, 'ok');
  assert.equal(await fsp.readFile(path.join(toRoot, 'b-good', 'SKILL.md'), 'utf8'), 'v1');
});

test('apply rejects an unknown or already-used planId', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const svc = serviceFor(fromRoot, toRoot, []);

  await assert.rejects(() => svc.apply({ planId: 'nope', actor: 'user' }), /plan not found or expired/);
});

test('a failing audit write does not turn a successful transfer into a failure', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const svc = createSkillSyncService({
    getRegistry: () => {
      throw new Error('unused');
    },
    getProjectById: () => null,
    audit: () => {
      throw new Error('disk full');
    },
    now: () => 1000,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });

  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  assert.equal(result.entries[0].status, 'ok');
  assert.equal(await fsp.readFile(path.join(toRoot, 'fresh', 'SKILL.md'), 'utf8'), 'a');
});
