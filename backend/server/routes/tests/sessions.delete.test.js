import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteAppSession } from '../sessions.js';
import { AppError } from '../../shared/utils.js';

function deps(deleteSession) {
  return {
    sessionsDb: {},
    chatRunRegistry: {},
    forkSession: async () => ({}),
    gitRewind: {},
    deleteSession,
  };
}

test('deleteAppSession returns 200 with the delete result', async () => {
  const d = deps(async ({ sessionId, cascade }) => ({
    sessionId,
    action: 'deleted',
    deletedFromDisk: true,
    linkedTaskId: cascade ? 't1' : null,
  }));
  const { status, body } = await deleteAppSession(d, 's1', { cascade: true });
  assert.equal(status, 200);
  assert.equal(body.sessionId, 's1');
  assert.equal(body.linkedTaskId, 't1');
});

test('deleteAppSession maps an AppError to its status + code', async () => {
  const d = deps(async () => {
    throw new AppError('session not found: nope', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  });
  const { status, body } = await deleteAppSession(d, 'nope', {});
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SESSION_NOT_FOUND');
  assert.equal(body.error.message, 'session not found: nope');
});

test('deleteAppSession maps a non-AppError to 500 INTERNAL_ERROR', async () => {
  const d = deps(async () => {
    throw new Error('boom');
  });
  const { status, body } = await deleteAppSession(d, 's1', {});
  assert.equal(status, 500);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, 'boom');
});
