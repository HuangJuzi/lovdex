import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQoderArgs,
  buildQoderControlResponse,
  isQoderInteractivePermissionMode,
  parseQoderControlRequest,
  readQoderSessionId,
  resolveQoderPermissionOptions,
} from '../../../qoder-runner.js';

test('buildQoderArgs assembles qodercli resume + model + permission vector', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp/work',
    providerSessionId: 'sess-1',
    model: 'auto',
    effort: 'high',
    permissionMode: 'acceptEdits',
    attachments: ['/tmp/a.png'],
    prompt: 'hello',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--cwd') && args.includes('/tmp/work'));
  assert.ok(args.includes('--resume') && args.includes('sess-1'));
  assert.ok(args.includes('--model') && args.includes('auto'));
  assert.ok(args.includes('--permission-mode') && args.includes('accept_edits'));
  assert.ok(args.includes('--reasoning-effort') && args.includes('high'));
  assert.ok(args.includes('--attachment') && args.includes('/tmp/a.png'));
  assert.equal(args[args.length - 1], 'hello');
});

test('resolveQoderPermissionOptions maps modes to qoder flags', () => {
  assert.deepEqual(resolveQoderPermissionOptions('bypassPermissions'), { args: ['--permission-mode', 'bypass_permissions'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('plan'), { args: ['--permission-mode', 'plan'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('acceptEdits'), { args: ['--permission-mode', 'accept_edits'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('default'), { args: [], env: {} });
});

test('readQoderSessionId reads snake then camelCase session id', () => {
  assert.equal(readQoderSessionId({ session_id: 's1' }), 's1');
  assert.equal(readQoderSessionId({ sessionId: 's2' }), 's2');
  assert.equal(readQoderSessionId({}), null);
});

test('buildQoderArgs enables the stdio control protocol in interactive mode', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp/work',
    providerSessionId: 'sess-1',
    permissionMode: 'default',
    prompt: 'hello',
    interactive: true,
  });
  assert.ok(args.includes('--input-format') && args.includes('stream-json'));
  assert.ok(args.includes('--permission-prompt-tool') && args.includes('stdio'));
  assert.ok(!args.includes('hello'), 'positional prompt must be omitted in interactive mode');
});

test('buildQoderArgs keeps the positional prompt in plain print mode', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp/work',
    permissionMode: 'default',
    prompt: 'hello',
    interactive: false,
  });
  assert.ok(!args.includes('--input-format'));
  assert.equal(args[args.length - 1], 'hello');
});

test('isQoderInteractivePermissionMode enables approvals outside bypass/plan', () => {
  assert.equal(isQoderInteractivePermissionMode('default'), true);
  assert.equal(isQoderInteractivePermissionMode('acceptEdits'), true);
  assert.equal(isQoderInteractivePermissionMode(undefined), true);
  assert.equal(isQoderInteractivePermissionMode('bypassPermissions'), false);
  assert.equal(isQoderInteractivePermissionMode('plan'), false);
});

test('buildQoderControlResponse builds allow/deny decision bodies', () => {
  assert.deepEqual(buildQoderControlResponse('req-1', { allow: true }), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow' } },
  });

  assert.deepEqual(buildQoderControlResponse('req-2', { allow: false, message: 'nope' }), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req-2',
      response: { behavior: 'deny', message: 'nope' },
    },
  });

  assert.deepEqual(buildQoderControlResponse('req-3', { allow: true, updatedInput: { command: 'git pull' } }), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req-3',
      response: { behavior: 'allow', updatedInput: { command: 'git pull' } },
    },
  });

  // An empty updatedInput is dropped so the CLI does not run the tool with {}.
  assert.deepEqual(buildQoderControlResponse('req-4', { allow: true, updatedInput: {} }), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'req-4', response: { behavior: 'allow' } },
  });

  // Omitted message falls back to a generic denial reason.
  const denied = buildQoderControlResponse('req-5', { allow: false });
  assert.equal(denied.response.response.behavior, 'deny');
  assert.ok(typeof denied.response.response.message === 'string' && denied.response.response.message.length > 0);
});

test('parseQoderControlRequest extracts can_use_tool prompts only', () => {
  const event = {
    type: 'control_request',
    request_id: 'rid-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      tool_use_id: 'call-1',
      input: { command: 'git pull' },
      description: 'Run git pull',
    },
  };
  assert.deepEqual(parseQoderControlRequest(event), {
    requestId: 'rid-1',
    toolName: 'Bash',
    input: { command: 'git pull' },
    description: 'Run git pull',
  });

  assert.equal(
    parseQoderControlRequest({ type: 'control_request', request_id: 'x', request: { subtype: 'set_model' } }),
    null,
  );
  assert.equal(parseQoderControlRequest({ type: 'result' }), null);
  assert.equal(parseQoderControlRequest(null), null);
});