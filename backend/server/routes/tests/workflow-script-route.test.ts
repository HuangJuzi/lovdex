import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { readWorkflowScript } from '@/routes/sessions.js';

test('readWorkflowScript returns content when path is under session dir', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-script-'));
  const wfPath = path.join(tmp, 'wf.js');
  await fs.writeFile(wfPath, "export const meta = { name: 'spec' };\n", 'utf8');

  const result = await readWorkflowScript({
    path: wfPath,
    sessionDir: tmp, // whitelist root = session transcript dir
  });
  assert.equal(result.status, 200);
  assert.match(result.body.content, /export const meta/);
  assert.equal(result.body.path, wfPath);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('readWorkflowScript rejects path traversal outside session dir (403)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-script-'));
  const outside = path.join(os.tmpdir(), 'secret.txt');
  await fs.writeFile(outside, 'secret', 'utf8');

  const result = await readWorkflowScript({
    path: outside,
    sessionDir: tmp,
  });
  assert.equal(result.status, 403);
  assert.match(result.body.error.message, /outside/i);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('readWorkflowScript rejects missing path (400)', async () => {
  const result = await readWorkflowScript({ path: '', sessionDir: '/tmp' });
  assert.equal(result.status, 400);
});

test('readWorkflowScript returns 404 when file does not exist', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-script-'));
  const result = await readWorkflowScript({
    path: path.join(tmp, 'nope.js'),
    sessionDir: tmp,
  });
  assert.equal(result.status, 404);
  await fs.rm(tmp, { recursive: true, force: true });
});
