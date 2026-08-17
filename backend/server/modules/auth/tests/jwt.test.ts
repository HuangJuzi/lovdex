import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTokenFromRequest, signToken, verifyToken } from '../jwt.js';

const EMAIL = 'zhiju.huang@sophgo.com';

test('signToken returns a three-segment JWT', () => {
  const token = signToken({ sub: 1, username: EMAIL });
  assert.equal(token.split('.').length, 3);
});

test('verifyToken returns the payload for a freshly signed token', () => {
  const token = signToken({ sub: 1, username: EMAIL });
  const payload = verifyToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, 1);
  assert.equal(payload.username, EMAIL);
  assert.ok(payload.exp >= payload.iat);
});

test('verifyToken rejects a tampered token', () => {
  const token = signToken({ sub: 1, username: EMAIL });
  const [header, body] = token.split('.');
  assert.equal(verifyToken(`${header}.${body}.AAAA`), null);
});

test('verifyToken rejects an expired token', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signToken({ sub: 1, username: EMAIL, iat: now - 100, exp: now - 10 });
  assert.equal(verifyToken(token), null);
});

test('verifyToken returns null for non-string input', () => {
  assert.equal(verifyToken(null as unknown as string), null);
  assert.equal(verifyToken(undefined as unknown as string), null);
});

test('extractTokenFromRequest reads Authorization Bearer first', () => {
  const req = { headers: { authorization: 'Bearer abc.def.ghi' }, query: { token: 'query-token' } };
  assert.equal(extractTokenFromRequest(req), 'abc.def.ghi');
});

test('extractTokenFromRequest falls back to the ?token= query param', () => {
  const req = { headers: {}, query: { token: 'query-token' } };
  assert.equal(extractTokenFromRequest(req), 'query-token');
});

test('extractTokenFromRequest returns null when neither is present', () => {
  const req = { headers: {}, query: {} };
  assert.equal(extractTokenFromRequest(req), null);
});
