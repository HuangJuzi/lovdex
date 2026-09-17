import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAgentFrameIn, decodeAgentFrameOut } from '../protocol.js';

test('decodeAgentFrameIn accepts llm_req', () => {
  const f = decodeAgentFrameIn({
    type: 'llm_req', id: 'r1', method: 'POST', path: '/v1/messages',
    headers: { 'content-type': 'application/json' }, bodyBase64: 'aGk=',
  });
  assert.deepEqual(f, {
    type: 'llm_req', id: 'r1', method: 'POST', path: '/v1/messages',
    headers: { 'content-type': 'application/json' }, bodyBase64: 'aGk=',
  });
});

test('decodeAgentFrameIn rejects llm_req with missing fields', () => {
  assert.equal(decodeAgentFrameIn({ type: 'llm_req', id: 'r1' }), null);
  assert.equal(decodeAgentFrameIn({ type: 'llm_req', id: 'r1', method: 'POST', path: '/x', headers: {}, bodyBase64: 7 }), null);
});

test('decodeAgentFrameOut accepts llm_res', () => {
  const f = decodeAgentFrameOut({
    type: 'llm_res', id: 'r1', status: 200, headers: { 'content-type': 'text/event-stream' }, chunkBase64: '', done: false,
  });
  assert.equal(f?.type, 'llm_res');
});

test('decodeAgentFrameOut rejects llm_res with missing fields', () => {
  assert.equal(decodeAgentFrameOut({ type: 'llm_res', id: 'r1' }), null);
});
