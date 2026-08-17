import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkflowState } from '../workflowState';

import { WorkflowContainer } from './WorkflowContainer';

const STATE_RUNNING: WorkflowState = {
  status: 'running',
  workflowName: 'spec',
  agents: [
    { taskId: 'T1', description: 'agent:Explore', lastToolName: 'Grep', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 }, tools: [{ toolUseId: 'TL', toolName: 'Read', elapsedTimeSeconds: 0.5 }] },
  ],
};

const STATE_DONE: WorkflowState = {
  status: 'completed',
  workflowName: 'spec',
  agents: [],
  notification: { status: 'completed', summary: 'all good', usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 } },
};

const STATE_MULTI: WorkflowState = {
  status: 'running',
  workflowName: 'multi',
  agents: [
    { taskId: 'A', description: 'agent:One', tools: [{ toolUseId: 'a1', toolName: 'Read', elapsedTimeSeconds: 1 }, { toolUseId: 'a2', toolName: 'Bash', elapsedTimeSeconds: 2 }] },
    { taskId: 'B', description: 'agent:Two', tools: [{ toolUseId: 'b1', toolName: 'Grep', elapsedTimeSeconds: 3 }] },
  ],
};

test('renders workflow name + agent + leaf tool', () => {
  const html = renderToStaticMarkup(
    <WorkflowContainer
      toolInput={{ name: 'spec' }}
      workflowState={STATE_RUNNING}
      scriptPath="/p/wf.js"
      onRerun={() => {}}
      onResume={() => {}}
      onEdit={() => {}}
    />,
  );
  assert.match(html, /Workflow/);
  assert.match(html, /spec/);
  assert.match(html, /agent:Explore/);
  assert.match(html, /Read/);
});

test('renders terminal summary when completed', () => {
  const html = renderToStaticMarkup(
    <WorkflowContainer toolInput={{}} workflowState={STATE_DONE} scriptPath="/p/wf.js" onRerun={() => {}} onResume={() => {}} onEdit={() => {}} />,
  );
  assert.match(html, /all good/);
});

test('disables rerun + edit buttons when scriptPath missing', () => {
  const html = renderToStaticMarkup(
    <WorkflowContainer toolInput={{}} workflowState={STATE_DONE} onRerun={() => {}} onResume={() => {}} onEdit={() => {}} />,
  );
  const disabledCount = (html.match(/<button[^>]*disabled/g) || []).length;
  assert.ok(disabledCount >= 2, `expected at least 2 disabled buttons, got ${disabledCount}`);
});

test('disables resume button when runId missing', () => {
  const html = renderToStaticMarkup(
    <WorkflowContainer toolInput={{}} workflowState={STATE_DONE} scriptPath="/p/wf.js" onRerun={() => {}} onResume={() => {}} onEdit={() => {}} />,
  );
  // resume is disabled (no runId); rerun/edit are enabled (scriptPath present)
  const htmlWithRunId = renderToStaticMarkup(
    <WorkflowContainer toolInput={{}} workflowState={STATE_DONE} scriptPath="/p/wf.js" runId="wf_1" onRerun={() => {}} onResume={() => {}} onEdit={() => {}} />,
  );
  assert.ok((html.match(/<button[^>]*disabled/g) || []).length >= 1, 'resume disabled without runId');
  assert.equal((htmlWithRunId.match(/<button[^>]*disabled/g) || []).length, 0, 'nothing disabled with scriptPath + runId');
});

test('renders name + terminal summary from toolResult when workflowState undefined', () => {
  const html = renderToStaticMarkup(
    <WorkflowContainer
      toolInput={{ name: 'inline-flow' }}
      toolResult={{ status: 'completed', summary: 'finished ok' }}
      scriptPath="/p/wf.js"
      onRerun={() => {}}
      onResume={() => {}}
      onEdit={() => {}}
    />,
  );
  assert.match(html, /inline-flow/);
  assert.match(html, /finished ok/);
});

test('renders multiple agents + multiple leaves per agent', () => {
  const html = renderToStaticMarkup(
    <WorkflowContainer toolInput={{}} workflowState={STATE_MULTI} onRerun={() => {}} onResume={() => {}} onEdit={() => {}} />,
  );
  assert.match(html, /agent:One/);
  assert.match(html, /agent:Two/);
  assert.match(html, /Read/);
  assert.match(html, /Bash/);
  assert.match(html, /Grep/);
});
