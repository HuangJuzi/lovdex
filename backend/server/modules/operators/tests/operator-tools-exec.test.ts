import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOperatorTools } from '@/modules/operators/operator.tools.js';

const fakeTasks = {
  createTask: () => ({}),
  listTasks: () => [],
  getTask: () => null,
  writeSummary: () => ({}),
  startExecution: () => null,
  updateTask: async () => ({}),
  moveTask: () => ({}),
};

test('execute_skill / workbench are registered and delegate to injected deps', async () => {
  const calls: { skill?: unknown; bench?: unknown } = {};
  const tools = buildOperatorTools({
    tasks: fakeTasks as never,
    skillExec: async (i) => {
      calls.skill = i;
      return { ok: true };
    },
    workbench: async (i) => {
      calls.bench = i;
      return { ok: true };
    },
  });

  assert.ok(tools.execute_skill, 'execute_skill registered');
  assert.ok(tools.workbench, 'workbench registered');
  assert.deepEqual(tools.workbench.inputSchema.required, ['command']);
  assert.deepEqual(tools.execute_skill.inputSchema.required, ['skillName']);

  await tools.execute_skill.handler({ skillName: 'claw-agent-get-send', args: 'groups' });
  assert.deepEqual(calls.skill, { skillName: 'claw-agent-get-send', args: 'groups' });

  await tools.workbench.handler({ command: 'list', path: '/tmp' });
  assert.deepEqual(calls.bench, { command: 'list', path: '/tmp' });
});

test('execute_skill / workbench fail loudly when deps are not wired', async () => {
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await assert.rejects(() => tools.execute_skill.handler({ skillName: 'x' }), /not wired/);
  await assert.rejects(() => tools.workbench.handler({ command: 'list' }), /not wired/);
});
