import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('opencode sessions normalizes a text part event', () => {
  const provider = new OpenCodeSessionsProvider();
  const raw = { type: 'text', part: { type: 'text', text: 'hello', messageID: 'msg1', sessionID: 'ses1' } };
  const msgs = provider.normalizeMessage(raw, 'ses1');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'text');
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, 'hello');
});

test('opencode sessions fetchHistory reads message/part JSON data from opencode.db', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sessions-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    INSERT INTO message (id, session_id, time_created, data) VALUES
      ('msg_user', 'ses1', 1, '{"role":"user","time":{"created":1}}'),
      ('msg_assistant', 'ses1', 2, '{"role":"assistant","time":{"created":2}}');
    INSERT INTO part (id, message_id, session_id, time_created, data) VALUES
      ('prt_1', 'msg_user', 'ses1', 1, '{"type":"text","text":"\\"quoted user text\\""}'),
      ('prt_2', 'msg_assistant', 'ses1', 2, '{"type":"text","text":"assistant reply"}');
  `);
  db.close();

  const restore = patchHomeDir(tempRoot);
  try {
    const result = await new OpenCodeSessionsProvider().fetchHistory('ses1');
    assert.equal(result.total, 2);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'quoted user text');
    assert.equal(result.messages[1].role, 'assistant');
    assert.equal(result.messages[1].content, 'assistant reply');
  } finally {
    restore();
  }
});

test('opencode sessions fetchHistory queries opencode.db with options.providerSessionId, not the app session id', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sessions-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    INSERT INTO message (id, session_id, time_created, data) VALUES
      ('msg_user', 'ses1', 1, '{"role":"user","time":{"created":1}}'),
      ('msg_assistant', 'ses1', 2, '{"role":"assistant","time":{"created":2}}');
    INSERT INTO part (id, message_id, session_id, time_created, data) VALUES
      ('prt_1', 'msg_user', 'ses1', 1, '{"type":"text","text":"user text"}'),
      ('prt_2', 'msg_assistant', 'ses1', 2, '{"type":"text","text":"assistant reply"}');
  `);
  db.close();

  const restore = patchHomeDir(tempRoot);
  try {
    // The app session id is a lovdex UUID; the provider-native id lives in
    // options.providerSessionId. Querying opencode.db with the app id must not
    // silently return nothing.
    const result = await new OpenCodeSessionsProvider().fetchHistory('app-session-uuid', {
      providerSessionId: 'ses1',
    });
    assert.equal(result.total, 2);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'user text');
    // Returned messages are remapped to the app session id, never the provider id.
    assert.equal(result.messages[0].sessionId, 'app-session-uuid');
  } finally {
    restore();
  }
});