import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentFrameOut, encodeRpcRequest, makeSessionStartParamsSchema } from '../protocol.js';
import { z } from 'zod';

test('rpc request frame encodes/decodes round-trip', () => {
  const id = 'req-1';
  const frame = encodeRpcRequest(id, 'session/start', {
    appSessionId: 's1',
    providerSessionId: null,
    command: 'fix tests',
    cwd: '/srv/app',
  });
  assert.equal(frame.type, 'rpc_req');
  assert.equal(frame.method, 'session/start');
  assert.ok(isAgentFrameOut(frame));
});

test('session/start params schema validates required fields and defaults providerSessionId to null', () => {
  const schema = makeSessionStartParamsSchema();
  const ok = schema.parse({ appSessionId: 's1', command: 'hi', cwd: '/s' });
  assert.equal(ok.providerSessionId, null);
  assert.equal(ok.cwd, '/s');
  assert.throws(() => schema.parse({ appSessionId: 's1', command: 'hi' })); // cwd required
});
