import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSessionMessagesDir, resolveProviderTranscriptDir } from '../transcript.js';

/**
 * Lite-side transcript reading: the lite owns the ONLY copy of a remote
 * session's transcript (the provider CLI writes it on the host), so the
 * `session/messages` RPC reads the JSONL files here and ships the raw CONTENT
 * back to main, which decodes it with the shared parser. These cases pin the
 * claude/qoder directory layout + the empty-file behavior.
 */

test('claude transcript dir encodes the project path like Claude Code', () => {
  const dir = resolveProviderTranscriptDir('claude', '/home/sophgo/workpath/dockerfile_2204', '/root');
  assert.equal(dir, path.join('/root', '.claude', 'projects', '-home-sophgo-workpath-dockerfile-2204'));
});

test('qoder transcript dir encodes only slashes (qoder layout)', () => {
  const dir = resolveProviderTranscriptDir('qoder', '/home/sophgo/workpath', '/root');
  assert.equal(dir, path.join('/root', '.qoder', 'projects', '-home-sophgo-workpath'));
});

test('unknown provider has no resolvable transcript dir', () => {
  const dir = resolveProviderTranscriptDir('opencode', '/p', '/root');
  assert.equal(dir, null);
});

test('readSessionMessagesDir returns main + agent file contents', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'lite-home-'));
  try {
    const dir = resolveProviderTranscriptDir('claude', '/mnt/proj', home)!;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'sid-1.jsonl'), '{"a":1}\n', 'utf8');
    await writeFile(path.join(dir, 'agent-xyz.jsonl'), '{"b":2}\n', 'utf8');
    await writeFile(path.join(dir, 'sid-1-watcher.jsonl'), '{"c":3}\n', 'utf8');

    const result = readSessionMessagesDir('claude', '/mnt/proj', 'sid-1', home);

    assert.equal(result.exists, true);
    assert.equal(result.transcript, '{"a":1}\n');
    assert.deepEqual(Object.keys(result.agentFiles), ['xyz']);
    assert.equal(result.agentFiles.xyz, '{"b":2}\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readSessionMessagesDir reports exists=false when the main file is missing', () => {
  const home = path.join(tmpdir(), 'lite-home-missing');
  const result = readSessionMessagesDir('claude', '/mnt/proj', 'side', home);
  assert.equal(result.exists, false);
  assert.equal(result.transcript, '');
  assert.deepEqual(result.agentFiles, {});
});