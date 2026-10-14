import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAllowlistedFs } from '../fs.js';
import { handleRpc } from '../rpc-dispatch.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkroot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-move-'));
  return fsp.realpath(dir);
}

test('move: relocates files and directories into target', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'dst'));
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');
  await fsp.mkdir(path.join(root, 'src'));
  await fsp.writeFile(path.join(root, 'src', 'b.ts'), 'y');

  const r = await api.move(path.join(root, 'dst'), [
    { path: path.join(root, 'a.ts'), type: 'file' },
    { path: path.join(root, 'src'), type: 'directory' },
  ]);
  assert.equal(r.success, true);
  assert.equal(r.movedCount, 2);
  await fsp.access(path.join(root, 'dst', 'a.ts'));
  await fsp.access(path.join(root, 'dst', 'src', 'b.ts'));
});

test('move: conflict aborts the whole batch before any rename', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'dst'));
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');
  await fsp.writeFile(path.join(root, 'dst', 'a.ts'), 'EXISTS');

  await assert.rejects(
    api.move(path.join(root, 'dst'), [{ path: path.join(root, 'a.ts'), type: 'file' }]),
    /already exists/,
  );
  // 原文件未被移动（整批不落盘）
  await fsp.access(path.join(root, 'a.ts'));
});

test('move: rejects target inside a moved directory', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.mkdir(path.join(root, 'docs'));
  await fsp.mkdir(path.join(root, 'docs', 'sub'));

  await assert.rejects(
    api.move(path.join(root, 'docs', 'sub'), [{ path: path.join(root, 'docs'), type: 'directory' }]),
    /into itself/,
  );
});

test('move: no-op when destination equals source; path outside roots rejected', async () => {
  const root = await mkroot();
  const api = createAllowlistedFs({ roots: [root] });
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');

  const r = await api.move(root, [{ path: path.join(root, 'a.ts'), type: 'file' }]);
  assert.equal(r.success, true);
  assert.equal(r.movedCount, 0);
  assert.equal(r.skippedCount, 1);
  await fsp.access(path.join(root, 'a.ts'));

  await assert.rejects(
    api.move('/etc', [{ path: '/etc/passwd', type: 'file' }]),
    /outside|escape|allowed root/i,
  );
});

test('rpc dispatch: fs/move routes to allowlisted fs with zod-validated params', async () => {
  const root = await mkroot();
  const cfg = { roots: [root] } as unknown as RemoteAgentConfig;
  await fsp.mkdir(path.join(root, 'dst'));
  await fsp.writeFile(path.join(root, 'a.ts'), 'x');

  const r = (await handleRpc(
    'fs/move',
    { targetDir: path.join(root, 'dst'), items: [{ path: path.join(root, 'a.ts'), type: 'file' }] },
    cfg,
  )) as { success: boolean; movedCount: number };
  assert.equal(r.success, true);
  assert.equal(r.movedCount, 1);
});
