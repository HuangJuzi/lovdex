import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeCustomNameToDisk } from '@/modules/providers/services/write-custom-name-to-disk.js';

test('claude write appends a custom-title line to the transcript', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'write-cn-'));
  const file = path.join(dir, 'sess.jsonl');
  await writeFile(file, JSON.stringify({ sessionId: 'p1', cwd: '/p', type: 'user' }) + '\n', 'utf8');
  await writeCustomNameToDisk({
    provider: 'claude', provider_session_id: 'p1', jsonl_path: file, custom_name: 'New Name',
  });
  const content = await readFile(file, 'utf8');
  const last = content.trim().split('\n').pop()!;
  const parsed = JSON.parse(last);
  assert.equal(parsed.type, 'custom-title');
  assert.equal(parsed.sessionId, 'p1');
  assert.equal(parsed.customTitle, 'New Name');
  await rm(dir, { recursive: true, force: true });
});

test('codex write updates thread_name in session_index.jsonl', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'write-cn-'));
  const index = path.join(dir, 'session_index.jsonl');
  await writeFile(index, JSON.stringify({ id: 'p1', thread_name: 'old' }) + '\n', 'utf8');
  await writeCustomNameToDisk({
    provider: 'codex', provider_session_id: 'p1', jsonl_path: null, custom_name: 'New Name',
  }, index);
  const content = await readFile(index, 'utf8');
  const line = content.trim().split('\n').find((l) => JSON.parse(l).id === 'p1')!;
  const parsed = JSON.parse(line);
  assert.equal(parsed.thread_name, 'New Name');
  await rm(dir, { recursive: true, force: true });
});

test('codex write appends a new entry when id not found', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'write-cn-'));
  const index = path.join(dir, 'session_index.jsonl');
  await writeFile(index, JSON.stringify({ id: 'other', thread_name: 'x' }) + '\n', 'utf8');
  await writeCustomNameToDisk({
    provider: 'codex', provider_session_id: 'p1', jsonl_path: null, custom_name: 'New Name',
  }, index);
  const content = await readFile(index, 'utf8');
  const line = content.trim().split('\n').find((l) => JSON.parse(l).id === 'p1')!;
  const parsed = JSON.parse(line);
  assert.equal(parsed.thread_name, 'New Name');
  await rm(dir, { recursive: true, force: true });
});

test('no-op when custom_name is empty or provider_session_id is null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'write-cn-'));
  const file = path.join(dir, 'sess.jsonl');
  await writeFile(file, 'existing\n', 'utf8');
  await writeCustomNameToDisk({ provider: 'claude', provider_session_id: 'p1', jsonl_path: file, custom_name: '' });
  await writeCustomNameToDisk({ provider: 'claude', provider_session_id: null, jsonl_path: file, custom_name: 'x' });
  const content = await readFile(file, 'utf8');
  assert.equal(content, 'existing\n');
  await rm(dir, { recursive: true, force: true });
});
