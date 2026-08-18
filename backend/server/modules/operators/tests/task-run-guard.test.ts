import assert from 'node:assert/strict';
import test from 'node:test';

import {
  guardTaskRunToolInput,
  resolveWorkflowsEnabled,
} from '@/modules/operators/task-run-guard.js';

test('strips worktree/remote isolation from subagent tool calls so the cwd stays in the registered project', () => {
  const result = guardTaskRunToolInput('Task', {
    description: 'research sub-agent',
    prompt: 'look up X',
    run_in_background: true,
    isolation: 'worktree',
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.updatedInput?.isolation, undefined);
  assert.equal(result.updatedInput?.run_in_background, false);

  const remote = guardTaskRunToolInput('Agent', { isolation: 'remote' });
  assert.equal(remote.decision, 'allow');
  assert.equal(remote.updatedInput?.isolation, undefined);
  assert.equal(remote.updatedInput?.run_in_background, false);
});

test('forces subagent run_in_background=false so the parent waits for results', () => {
  // Omitted run_in_background still means "background" in the SDK — pin it.
  const omitted = guardTaskRunToolInput('Task', { prompt: 'do it' });
  assert.equal(omitted.decision, 'allow');
  assert.equal(omitted.updatedInput?.run_in_background, false);

  const explicit = guardTaskRunToolInput('Task', { prompt: 'do it', run_in_background: true });
  assert.equal(explicit.decision, 'allow');
  assert.equal(explicit.updatedInput?.run_in_background, false);

  // Already-synchronous calls are untouched (no updatedInput needed).
  const alreadySync = guardTaskRunToolInput('Agent', { prompt: 'do it', run_in_background: false });
  assert.equal(alreadySync.decision, 'allow');
  assert.equal(alreadySync.updatedInput, undefined);
});

test('denies the Workflow tool with a readable error (no detached background fan-out)', () => {
  const result = guardTaskRunToolInput('Workflow', { script: '...' });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /Workflow/);
});

test('leaves non-subagent tools alone', () => {
  const result = guardTaskRunToolInput('Bash', { command: 'ls', run_in_background: true });
  assert.equal(result.decision, 'allow');
  assert.equal(result.updatedInput, undefined);
});

test('resolveWorkflowsEnabled disables Workflow for task runs, keeps config default otherwise', () => {
  assert.equal(resolveWorkflowsEnabled({ isTaskRun: true }, { server: { workflowsEnabled: true } }), false);
  assert.equal(resolveWorkflowsEnabled({}, { server: { workflowsEnabled: true } }), true);
  assert.equal(resolveWorkflowsEnabled({}, { server: { workflowsEnabled: false } }), false);
  assert.equal(resolveWorkflowsEnabled(undefined, undefined), true);
});
