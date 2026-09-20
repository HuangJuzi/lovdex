import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleRpc } from '../rpc-dispatch.js';
import { __resetSkillStoreForTests } from '../skills.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-skills-rpc-'));
  return fsp.realpath(dir);
}

function cfgFor(roots: string[]): RemoteAgentConfig {
  return {
    serverUrl: 'ws://localhost:3188/api/remote-agents/ws',
    token: 'a'.repeat(8),
    hostId: 'h1',
    roots,
    skillRoots: roots,
    agentVersion: '0.1.0',
  };
}

test('handleRpc skills/manifest lists skills under the configured skill root', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');

  const result = (await handleRpc('skills/manifest', { root }, cfgFor([root]))) as {
    entries: { name: string }[];
  };
  assert.deepEqual(result.entries.map((e) => e.name), ['demo']);
});

test('handleRpc skills/bundle returns files for one skill', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');

  const result = (await handleRpc('skills/bundle', { root, name: 'demo' }, cfgFor([root]))) as {
    files: unknown[];
    contentHash: string;
  };
  assert.equal(result.files.length, 1);
  assert.match(result.contentHash, /^[0-9a-f]{64}$/);
});

test('handleRpc skills/apply round-trips a bundle into a second skill', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const cfg = cfgFor([root]);
  const src = path.join(root, 'demo');
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(src, 'SKILL.md'), 'hello');

  const bundle = (await handleRpc('skills/bundle', { root, name: 'demo' }, cfg)) as {
    contentHash: string;
    files: unknown[];
  };
  const result = (await handleRpc(
    'skills/apply',
    { root, name: 'copy', contentHash: bundle.contentHash, files: bundle.files, expectedTargetHash: null },
    cfg,
  )) as { action: string };

  assert.equal(result.action, 'created');
  assert.equal(await fsp.readFile(path.join(root, 'copy', 'SKILL.md'), 'utf8'), 'hello');
});

test('handleRpc skills/* rejects params that fail the schema', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  await assert.rejects(() => handleRpc('skills/manifest', {}, cfgFor([root])));
  await assert.rejects(() => handleRpc('skills/bundle', { root }, cfgFor([root])));
});

test('handleRpc skills/* enforces the allowlist', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const outside = await mkRoot();
  await assert.rejects(
    () => handleRpc('skills/manifest', { root: outside }, cfgFor([root])),
    /path outside allowed root/,
  );
});

test('handleRpc skills/* degrades to cfg.roots when skillRoots is absent', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  // 模拟老的/未类型化的 cfg（仓库里多处用 as unknown as RemoteAgentConfig 造）
  const cfg = {
    serverUrl: 'ws://x/y',
    token: 'a'.repeat(8),
    hostId: 'h1',
    roots: [root],
    agentVersion: '0.1.0',
  } as unknown as RemoteAgentConfig;

  const result = (await handleRpc('skills/manifest', { root }, cfg)) as { exists: boolean };
  assert.equal(result.exists, true);
});
