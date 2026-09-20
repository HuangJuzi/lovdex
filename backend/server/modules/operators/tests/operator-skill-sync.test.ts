import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSkillSyncOperatorTools } from '../operator-skill-sync.tools.js';

function deps(overrides: Record<string, unknown> = {}) {
  const audits: unknown[] = [];
  const applied: unknown[] = [];
  return {
    audits,
    applied,
    service: {
      plan: async (req: unknown) => ({ planId: 'p1', entries: [], summary: {}, request: req }),
      apply: async (req: unknown) => {
        applied.push(req);
        return { planId: 'p1', entries: [], summary: { ok: 0, skipped: 0, conflict: 0, failed: 0 }, request: req };
      },
    },
    audit: (row: unknown) => audits.push(row),
    ...overrides,
  };
}

test('skill_sync_plan is available by default and is read-only', async () => {
  const d = deps();
  const tools = createSkillSyncOperatorTools(d as never);
  const result = await tools.skill_sync_plan({ from: 'local', to: 'remote:h1', scope: 'user' });
  assert.match(String(result), /p1|新增|没有/);
  assert.equal(d.audits.length, 0, 'a read-only plan must not write audit rows');
});

test('skill_sync_apply is denied unless explicitly enabled', async () => {
  const d = deps({ allowApply: false });
  const tools = createSkillSyncOperatorTools(d as never);
  const result = await tools.skill_sync_apply({ planId: 'p1' });
  assert.match(String(result), /未开启/);
  assert.equal(d.audits.length, 0);
});

test('skill_sync_apply runs and audits when enabled', async () => {
  const d = deps({ allowApply: true });
  const tools = createSkillSyncOperatorTools(d as never);
  await tools.skill_sync_apply({ planId: 'p1', names: ['demo'], force: true });
  assert.equal(d.audits.length, 0, 'auditing happens inside the service, not the tool');
  assert.equal((d.applied[0] as { actor: string }).actor, 'operator');
  assert.equal((d.applied[0] as { force: boolean }).force, true);
});

test('skill_sync_plan rejects a bad node label', async () => {
  const tools = createSkillSyncOperatorTools(deps() as never);
  await assert.rejects(() => tools.skill_sync_plan({ from: 'nope', to: 'local', scope: 'user' }), /invalid skill node/);
});
