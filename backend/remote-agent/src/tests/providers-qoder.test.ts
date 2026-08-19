import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildQoderArgs,
  buildQoderControlResponse,
  isQoderInteractivePermissionMode,
  parseQoderControlRequest,
  readQoderSessionId,
  resolveQoderPermissionOptions,
} from '../providers/qoder-runner.js';

test('parseQoderControlRequest recognizes a can_use_tool control frame', () => {
  const parsed = parseQoderControlRequest({
    type: 'control_request',
    request_id: 'req-123',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'ls' },
      description: 'Run ls',
    },
  });
  assert.ok(parsed);
  assert.equal(parsed?.requestId, 'req-123');
  assert.equal(parsed?.toolName, 'Bash');
  assert.deepEqual(parsed?.input, { command: 'ls' });
  assert.equal(parsed?.description, 'Run ls');
});

test('parseQoderControlRequest rejects non-control / non-can_use_tool frames', () => {
  assert.equal(parseQoderControlRequest({ type: 'message', message: {} }), null);
  assert.equal(parseQoderControlRequest({ type: 'control_request', request_id: 'r', request: { subtype: 'other' } }), null);
  assert.equal(parseQoderControlRequest({ type: 'control_request', request_id: '', request: { subtype: 'can_use_tool' } }), null);
  assert.equal(parseQoderControlRequest(null), null);
});

test('parseQoderControlRequest falls back to display_name and args', () => {
  const parsed = parseQoderControlRequest({
    type: 'control_request',
    request_id: 'r2',
    request: { subtype: 'can_use_tool', display_name: 'MyTool', args: { x: 1 } },
  });
  assert.equal(parsed?.toolName, 'MyTool');
  assert.deepEqual(parsed?.input, { x: 1 });
});

test('buildQoderControlResponse builds the control_response shape for allow', () => {
  const frame = buildQoderControlResponse('req-1', { allow: true, updatedInput: { command: 'ls -la' } });
  assert.equal(frame.type, 'control_response');
  assert.deepEqual(frame.response, {
    subtype: 'success',
    request_id: 'req-1',
    response: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
  });
});

test('buildQoderControlResponse drops empty updatedInput', () => {
  const frame = buildQoderControlResponse('req-2', { allow: true, updatedInput: {} });
  assert.deepEqual((frame.response as { response: Record<string, unknown> }).response, { behavior: 'allow' });
});

test('buildQoderControlResponse builds the deny shape with a default message', () => {
  const frame = buildQoderControlResponse('req-3', { allow: false });
  const inner = (frame.response as { response: Record<string, unknown> }).response;
  assert.equal(inner.behavior, 'deny');
  assert.equal(inner.message, 'User denied tool use');
});

test('buildQoderControlResponse preserves a custom deny message', () => {
  const frame = buildQoderControlResponse('req-4', { allow: false, message: 'no thanks' });
  assert.equal((frame.response as { response: { message: string } }).response.message, 'no thanks');
});

test('permission-mode maps to qoder --permission-mode flags', () => {
  assert.deepEqual(resolveQoderPermissionOptions('plan'), { args: ['--permission-mode', 'plan'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('bypassPermissions'), { args: ['--permission-mode', 'bypass_permissions'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('acceptEdits'), { args: ['--permission-mode', 'accept_edits'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('default'), { args: [], env: {} });
});

test('isQoderInteractivePermissionMode matches the local semantics', () => {
  assert.equal(isQoderInteractivePermissionMode('default'), true);
  assert.equal(isQoderInteractivePermissionMode('acceptEdits'), true);
  assert.equal(isQoderInteractivePermissionMode('bypassPermissions'), false);
  assert.equal(isQoderInteractivePermissionMode('plan'), false);
});

test('readQoderSessionId reads session_id with camelCase fallback', () => {
  assert.equal(readQoderSessionId({ session_id: 's1' }), 's1');
  assert.equal(readQoderSessionId({ sessionId: 's2' }), 's2');
  assert.equal(readQoderSessionId({}), null);
  assert.equal(readQoderSessionId(null), null);
});

test('buildQoderArgs wires the interactive control protocol', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp',
    providerSessionId: null,
    prompt: 'hi',
    interactive: true,
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('-o'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--cwd'));
  assert.ok(args.includes('/tmp'));
  assert.ok(args.includes('--input-format'));
  assert.ok(args.includes('--permission-prompt-tool'));
  // Interactive: prompt is NOT a positional arg (avoids double-seeding).
  assert.ok(!args.includes('hi'));
});

test('buildQoderArgs resumes, models, and passes the prompt positionally when non-interactive', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp',
    providerSessionId: 'prov-9',
    model: 'qoder-max',
    permissionMode: 'bypassPermissions',
    prompt: 'do the thing',
    interactive: false,
  });
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('prov-9'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('qoder-max'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('bypass_permissions'));
  assert.ok(!args.includes('--input-format'));
  assert.ok(args[args.length - 1] === 'do the thing');
});