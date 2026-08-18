import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAgentFrameOut,
  isAgentFrameIn,
  encodeRpcRequest,
  makeRpcCancel,
  makePing,
  decodeAgentFrameIn,
  makeSessionStartParamsSchema,
} from '../protocol.js';

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

test('isAgentFrameOut accepts fully-formed outbound frames', () => {
  assert.ok(isAgentFrameOut({ type: 'rpc_req', id: 'a', method: 'm', params: {} }));
  assert.ok(isAgentFrameOut({ type: 'rpc_cancel', id: 'a' }));
  assert.ok(isAgentFrameOut({ type: 'ping', at: 123 }));
});

test('isAgentFrameOut rejects non-frames', () => {
  assert.equal(isAgentFrameOut(null), false);
  assert.equal(isAgentFrameOut(undefined), false);
  assert.equal(isAgentFrameOut({}), false);
  assert.equal(isAgentFrameOut(42), false); // primitive
  assert.equal(isAgentFrameOut('ping'), false); // primitive string
});

test('isAgentFrameOut rejects inbound-only types and frames with missing fields', () => {
  assert.equal(isAgentFrameOut({ type: 'pong', at: 1 }), false); // inbound-only type
  assert.equal(isAgentFrameOut({ type: 'rpc_req' }), false); // missing id/method/params
  assert.equal(isAgentFrameOut({ type: 'rpc_req', id: 'a', method: 'm' }), false); // missing params
  assert.equal(isAgentFrameOut({ type: 'rpc_cancel' }), false); // missing id
  assert.equal(isAgentFrameOut({ type: 'ping' }), false); // missing at
  assert.equal(isAgentFrameOut({ type: 'ping', at: 'now' }), false); // at must be a number
});

test('isAgentFrameIn accepts fully-formed inbound frames', () => {
  assert.ok(
    isAgentFrameIn({
      type: 'hello',
      hostId: 'h1',
      agentVersion: '1.0',
      nodeVersion: '20',
      os: 'linux',
      roots: ['/srv/app'],
      capabilities: ['filesystem'],
    }),
  );
  assert.ok(isAgentFrameIn({ type: 'rpc_res', id: 'a', ok: true, data: { n: 1 } }));
  assert.ok(isAgentFrameIn({ type: 'rpc_res', id: 'a', ok: false, error: 'boom' }));
  assert.ok(isAgentFrameIn({ type: 'push', topic: 'logs', payload: { line: 'x' } }));
  assert.ok(isAgentFrameIn({ type: 'pong', at: 1 }));
});

test('isAgentFrameIn rejects non-frames and malformed inbound frames', () => {
  assert.equal(isAgentFrameIn(null), false);
  assert.equal(isAgentFrameIn(undefined), false);
  assert.equal(isAgentFrameIn({}), false);
  assert.equal(isAgentFrameIn(7), false);
  assert.equal(isAgentFrameIn({ type: 'hello' }), false); // missing fields
  assert.equal(
    isAgentFrameIn({
      type: 'hello',
      hostId: 'h',
      agentVersion: '1',
      nodeVersion: '20',
      os: 'linux',
      roots: 'not-an-array',
      capabilities: [],
    }),
    false,
  );
  assert.equal(isAgentFrameIn({ type: 'rpc_res', id: 'a' }), false); // missing ok
  assert.equal(isAgentFrameIn({ type: 'rpc_res', id: 'a', ok: true, error: 42 }), false); // error must be string
  assert.equal(isAgentFrameIn({ type: 'push', topic: 'logs' }), false); // missing payload
  assert.equal(isAgentFrameIn({ type: 'pong' }), false); // missing at
  assert.equal(
    isAgentFrameIn({ type: 'rpc_req', id: 'a', method: 'm', params: {} }),
    false,
  ); // outbound-only type
});

test('decodeAgentFrameIn returns null on malformed / non-object input', () => {
  assert.equal(decodeAgentFrameIn(null), null);
  assert.equal(decodeAgentFrameIn('hello'), null);
  assert.equal(decodeAgentFrameIn({}), null);
  assert.equal(decodeAgentFrameIn({ type: 'hello' }), null);
  assert.equal(decodeAgentFrameIn({ type: 'rpc_req', id: 'a', method: 'm', params: {} }), null); // outbound type
});

test('decodeAgentFrameIn returns the parsed frame on a valid hello', () => {
  const hello = decodeAgentFrameIn({
    type: 'hello',
    hostId: 'h1',
    agentVersion: '1.0.0',
    nodeVersion: '20.0.0',
    os: 'linux',
    roots: ['/srv/app'],
    capabilities: ['filesystem', 'writes'],
  });
  assert.notEqual(hello, null);
  assert.equal(hello?.type, 'hello');
  if (hello?.type === 'hello') {
    assert.equal(hello.hostId, 'h1');
    assert.deepEqual(hello.roots, ['/srv/app']);
    assert.deepEqual(hello.capabilities, ['filesystem', 'writes']);
  }
});

test('decodeAgentFrameIn returns the parsed frame on a valid rpc_res', () => {
  const res = decodeAgentFrameIn({ type: 'rpc_res', id: 'req-9', ok: false, error: 'no such session' });
  assert.notEqual(res, null);
  assert.equal(res?.type, 'rpc_res');
  if (res?.type === 'rpc_res') {
    assert.equal(res.id, 'req-9');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no such session');
  }
});

test('decodeAgentFrameIn preserves success data on rpc_res', () => {
  const res = decodeAgentFrameIn({ type: 'rpc_res', id: 'req-1', ok: true, data: { n: 1 } });
  if (res?.type === 'rpc_res') {
    assert.deepEqual(res.data, { n: 1 });
  }
});

test('makePing() produces a ping frame with a numeric ms epoch timestamp', () => {
  const ping = makePing();
  assert.equal(ping.type, 'ping');
  assert.equal(typeof ping.at, 'number');
  assert.ok(ping.at > 0);
  assert.ok(isAgentFrameOut(ping));
});

test('makeRpcCancel() produces a valid rpc_cancel frame', () => {
  const cancel = makeRpcCancel('req-42');
  assert.equal(cancel.type, 'rpc_cancel');
  assert.equal(cancel.id, 'req-42');
  assert.ok(isAgentFrameOut(cancel));
});