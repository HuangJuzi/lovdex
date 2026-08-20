import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleRpc } from '../rpc-dispatch.js';
import { loadConfig } from '../config.js';

const cfg = loadConfig({
  serverUrl: 'ws://localhost:1',
  token: 'secret-token',
  hostId: 'host-1',
  roots: ['/srv/proj'],
});

test('session/messages returns the raw transcript + agent file contents', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(path.join(tmpdir(), 'lite-rpc-home-'));
  process.env.HOME = home;
  try {
    const dir = path.join(home, '.claude', 'projects', '-mnt-proj');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'sid-1.jsonl'), '{"type":"user","sessionId":"sid-1"}\n', 'utf8');
    await writeFile(path.join(dir, 'agent-abc.jsonl'), '{"type":"assistant"}\n', 'utf8');

    const result = await handleRpc(
      'session/messages',
      { provider: 'claude', providerSessionId: 'sid-1', projectPath: '/mnt/proj' },
      cfg,
    );

    assert.deepEqual(result, {
      transcript: '{"type":"user","sessionId":"sid-1"}\n',
      agentFiles: { abc: '{"type":"assistant"}\n' },
    });
  } finally {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('session/messages returns empty payload when the transcript is missing', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(path.join(tmpdir(), 'lite-rpc-missing-'));
  process.env.HOME = home;
  try {
    const result = await handleRpc(
      'session/messages',
      { provider: 'qoder', providerSessionId: 'nope', projectPath: '/mnt/proj' },
      cfg,
    );

    assert.deepEqual(result, { transcript: '', agentFiles: {} });
  } finally {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('session/messages rejects params without a provider session id', async () => {
  await assert.rejects(
    handleRpc('session/messages', { provider: 'claude', projectPath: '/p' }, cfg),
  );
});