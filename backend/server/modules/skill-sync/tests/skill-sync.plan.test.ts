import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeSkillHash, type SkillFileEntry } from '@/shared/skill-hash.js';
import { createSkillStore } from '@/shared/skill-store.js';

import { createSkillSyncService } from '../skill-sync.service.js';
import type { SkillNode } from '../types.js';

async function mkRoot(tag: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sync-${tag}-`));
  return fsp.realpath(dir);
}

async function putSkill(root: string, name: string, content: string): Promise<string> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content);
  const files: SkillFileEntry[] = [{ relativePath: 'SKILL.md', content, encoding: 'utf8', executable: false }];
  return computeSkillHash(files);
}

/** 两个本地目录伪装成两个节点，让 plan 的编排逻辑可测且不碰网络。 */
function serviceForRoots(fromRoot: string, toRoot: string, clock = { t: 1000 }) {
  return createSkillSyncService({
    getRegistry: () => {
      throw new Error('remote nodes are not exercised in this test');
    },
    getProjectById: () => null,
    audit: () => {},
    now: () => clock.t,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });
}

const LOCAL: SkillNode = { kind: 'local' };

test('plan classifies create / update / same / onlyTarget', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');
  await putSkill(fromRoot, 'changed', 'new');
  await putSkill(fromRoot, 'identical', 'same');
  await putSkill(toRoot, 'changed', 'old');
  await putSkill(toRoot, 'identical', 'same');
  await putSkill(toRoot, 'extra', 'x');

  const svc = serviceForRoots(fromRoot, toRoot);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName.fresh.action, 'create');
  assert.equal(byName.changed.action, 'update');
  assert.equal(byName.identical.action, 'same');
  assert.equal(byName.extra.action, 'onlyTarget');
  assert.deepEqual(plan.summary, { create: 1, update: 1, same: 1, onlyTarget: 1 });
});

test('plan records both hashes and the source size for each entry', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'changed', 'new');
  await putSkill(toRoot, 'changed', 'old');

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const entry = plan.entries[0];
  assert.match(entry.fromHash ?? '', /^[0-9a-f]{64}$/);
  assert.match(entry.toHash ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(entry.fromHash, entry.toHash);
  assert.equal(entry.bytes, Buffer.byteLength('new'));
});

test('plan leaves toHash undefined for a create and fromHash undefined for onlyTarget', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');
  await putSkill(toRoot, 'extra', 'x');

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName.fresh.toHash, undefined);
  assert.equal(byName.extra.fromHash, undefined);
});

test('plan handles a target root that does not exist yet', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = path.join(await mkRoot('to'), 'never-created');
  await putSkill(fromRoot, 'fresh', 'a');

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  assert.deepEqual(plan.summary, { create: 1, update: 0, same: 0, onlyTarget: 0 });
});

test('plan returns a planId and stashes the plan server-side', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const clock = { t: 1000 };
  const svc = serviceForRoots(fromRoot, toRoot, clock);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  assert.match(plan.planId, /^[0-9a-f-]{36}$/);
  const cached = svc.takePlan(plan.planId);
  assert.equal(cached?.planId, plan.planId);
  // 取出即失效：一个 plan 只能 apply 一次
  assert.equal(svc.takePlan(plan.planId), null);
});

test('a plan older than the TTL is rejected', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const clock = { t: 1000 };
  const svc = serviceForRoots(fromRoot, toRoot, clock);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  clock.t += 10 * 60 * 1000 + 1;
  assert.equal(svc.takePlan(plan.planId), null);
});

test('plan rejects a project scope without both project ids', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const svc = serviceForRoots(fromRoot, toRoot);

  await assert.rejects(() => svc.plan({ from: LOCAL, to: LOCAL, scope: 'project' }), /projectId/);
  await assert.rejects(
    () => svc.plan({ from: LOCAL, to: LOCAL, scope: 'project', projectId: 1 }),
    /targetProjectId/,
  );
});

test('plan refuses a node whose host does not own the given project', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const svc = createSkillSyncService({
    getRegistry: () => {
      throw new Error('unused');
    },
    // 项目在远程 h1 上，但源节点给的是 local
    getProjectById: () => ({ project_path: '/srv/app', remote_host_id: 'h1' }),
    audit: () => {},
    now: () => 1000,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });

  await assert.rejects(
    () => svc.plan({ from: LOCAL, to: LOCAL, scope: 'project', projectId: 1, targetProjectId: 1 }),
    /lives on h1 but node local/,
  );
});

test('plan surfaces an unreadable skill as a blocked entry instead of dropping it', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'good', 'a');
  const huge = path.join(fromRoot, 'huge');
  await fsp.mkdir(huge, { recursive: true });
  await fsp.writeFile(path.join(huge, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.match(byName.huge.error ?? '', /skill file too large/);
  assert.equal(byName.huge.fromHash, undefined);
  assert.equal(byName.good.error, undefined);
});
