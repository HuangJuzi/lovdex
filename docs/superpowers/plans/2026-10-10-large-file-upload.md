# 大文件上传（本机 10GB + 远程分片流式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把文件上传的单文件上限从 200MB/32MB（本机/远程）抬到 10GB，并让远程项目走分片流式传输，替换现在的 base64 单帧。

**Architecture:** 本机上传把 multer 暂存目录从 `os.tmpdir()` 挪到项目内 `<projectRoot>/.lovdex-tmp/upload-<rand>/`，完成后同盘 `rename` 到目标（磁盘峰值 1×）。远程上传新增 `fs/uploadBegin` / `fs/uploadChunk` / `fs/uploadEnd` 三个 RPC：主侧把暂存文件按 4MiB 切片、base64 后逐片推送，lite 侧 append 到 `.part` 文件，末片后 `rename` 到目标。读回（预览/下载）维持 32MiB 不变。

**Tech Stack:** TypeScript（后端 `tsx` + Express + `multer` + `ws`；lite 同栈）、React 18 + Vite（前端）、`node:test` + `node:assert/strict`。

**测试命令（注意 cwd 与 env）：**

- 后端：`cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test <相对路径>`
- 前端：`cd web && env -u TSX_TSCONFIG_PATH npx tsx --test <相对路径>`
- 类型检查：`cd backend && npm run typecheck`；`cd web && npm run typecheck`
- Lint：`cd backend && npm run lint`

`env -u TSX_TSCONFIG_PATH` 是必需的：该 env 被全局导出成 `server/tsconfig.json`，会让 `npx tsx` 在别的 cwd 下解析错配置。

**Spec:** `docs/superpowers/specs/2026-10-10-large-file-upload-design.md`
**Branch:** `feat/large-file-upload`
**验收基线:** tsc/lint「零新增」错误（本仓库 baseline 不干净，见 spec §6）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `web/src/components/file-tree/constants/constants.ts` | 改：前端上传上限常量 |
| `web/src/components/file-tree/constants/constants.test.ts` | 新增：常量断言 |
| `backend/server/modules/uploads/upload-limits.ts` | 新增：后端上传上限常量的唯一真源 |
| `backend/server/modules/uploads/staging-dir.service.ts` | 新增：暂存目录创建/清理、同盘搬运（EXDEV 回退） |
| `backend/server/modules/uploads/remote-upload.service.ts` | 新增：把本机文件分片推送到远端 |
| `backend/remote-agent/src/upload-session.ts` | 新增：lite 侧上传会话（begin/chunk/end + idle 清理） |
| `backend/server/shared/agent-runtime/protocol.ts` | 改：三个新 RPC 的参数 schema |
| `backend/remote-agent/src/rpc-dispatch.ts` | 改：接线三个新 RPC + 会话表 + 断连清理 |
| `backend/remote-agent/src/index.ts` | 改：capabilities 上报 + ws 关闭时清理上传会话 |
| `backend/server/modules/remote-agents/remote-fs.service.ts` | 改：客户端加三个上传方法；删 `REMOTE_MAX_UPLOAD_BYTES` |
| `backend/server/index.js` | 改：常量改从新模块导入；本机走暂存 rename；远程走分片推送；放宽 `requestTimeout` |

---

## Task 1: 前端上传上限抬到 10GB

**Files:**
- Modify: `web/src/components/file-tree/constants/constants.ts:9`
- Test: `web/src/components/file-tree/constants/constants.test.ts` (create)

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/file-tree/constants/constants.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FILE_UPLOAD_SIZE_BYTES,
  MAX_FILE_UPLOAD_SIZE_LABEL,
  MAX_FILE_UPLOAD_SIZE_MB,
} from './constants';

test('the single-file upload cap is 10GB', () => {
  assert.equal(MAX_FILE_UPLOAD_SIZE_MB, 10240);
  assert.equal(MAX_FILE_UPLOAD_SIZE_BYTES, 10240 * 1024 * 1024);
  assert.equal(MAX_FILE_UPLOAD_SIZE_LABEL, '10240MB');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/constants/constants.test.ts`
Expected: FAIL，`MAX_FILE_UPLOAD_SIZE_MB` 实际是 200。

- [ ] **Step 3: 改常量**

`web/src/components/file-tree/constants/constants.ts` 第 9 行：

```ts
export const MAX_FILE_UPLOAD_SIZE_MB = 10240;
```

（`MAX_FILE_UPLOAD_SIZE_BYTES` 与 `MAX_FILE_UPLOAD_SIZE_LABEL` 都由它派生，不用改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/constants/constants.test.ts`
Expected: PASS（1 test）。

- [ ] **Step 5: 前端类型检查**

Run: `cd web && npm run typecheck`
Expected: 与改动前同样的错误数（只改了常量，应为零新增）。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/file-tree/constants/constants.ts web/src/components/file-tree/constants/constants.test.ts
git commit -m "feat(upload): raise the single-file upload cap to 10GB"
```

---

## Task 2: 后端上传上限常量与暂存目录服务

**Files:**
- Create: `backend/server/modules/uploads/upload-limits.ts`
- Create: `backend/server/modules/uploads/staging-dir.service.ts`
- Test: `backend/server/modules/uploads/tests/staging-dir.service.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/uploads/tests/staging-dir.service.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createUploadStagingDir,
  moveStagedFileIntoPlace,
  removeUploadStagingDir,
} from '../staging-dir.service.js';
import { MAX_FILE_UPLOAD_SIZE_MB, MAX_FILE_UPLOAD_SIZE_BYTES } from '../upload-limits.js';

async function mkproject(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-upload-'));
}

test('upload limits are 10GB and internally consistent', () => {
  assert.equal(MAX_FILE_UPLOAD_SIZE_MB, 10240);
  assert.equal(MAX_FILE_UPLOAD_SIZE_BYTES, 10240 * 1024 * 1024);
});

test('createUploadStagingDir lives under <project>/.lovdex-tmp and is unique per call', async () => {
  const project = await mkproject();
  const a = await createUploadStagingDir(project);
  const b = await createUploadStagingDir(project);

  assert.equal(path.dirname(a), path.join(project, '.lovdex-tmp'));
  assert.notEqual(a, b);
  assert.ok((await fsp.stat(a)).isDirectory());
  assert.ok((await fsp.stat(b)).isDirectory());
  // .lovdex-tmp carries a .gitignore so staged bytes never show up in git status.
  const ignore = await fsp.readFile(path.join(project, '.lovdex-tmp', '.gitignore'), 'utf8');
  assert.equal(ignore, '*\n!.gitignore\n');

  await removeUploadStagingDir(a);
  await removeUploadStagingDir(b);
  assert.equal(await fsp.stat(path.join(project, '.lovdex-tmp')).then(() => true, () => false), true);
  await fsp.rm(project, { recursive: true, force: true });
});

test('moveStagedFileIntoPlace renames within the same project', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  const staged = path.join(staging, 'a.bin');
  await fsp.writeFile(staged, 'payload');
  const target = path.join(project, 'sub', 'a.bin');
  await fsp.mkdir(path.dirname(target), { recursive: true });

  await moveStagedFileIntoPlace(staged, target);

  assert.equal(await fsp.readFile(target, 'utf8'), 'payload');
  assert.equal(await fsp.stat(staged).then(() => true, () => false), false);
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('moveStagedFileIntoPlace overwrites an existing target', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  const staged = path.join(staging, 'a.bin');
  await fsp.writeFile(staged, 'new');
  const target = path.join(project, 'a.bin');
  await fsp.writeFile(target, 'old');

  await moveStagedFileIntoPlace(staged, target);

  assert.equal(await fsp.readFile(target, 'utf8'), 'new');
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('moveStagedFileIntoPlace falls back to a copy across devices', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  const staged = path.join(staging, 'a.bin');
  await fsp.writeFile(staged, 'cross-device');
  const target = path.join(project, 'a.bin');

  // Simulate EXDEV (staging on another filesystem than the target).
  await moveStagedFileIntoPlace(staged, target, async () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  });

  assert.equal(await fsp.readFile(target, 'utf8'), 'cross-device');
  assert.equal(await fsp.stat(staged).then(() => true, () => false), false);
  await removeUploadStagingDir(staging);
  await fsp.rm(project, { recursive: true, force: true });
});

test('removeUploadStagingDir is idempotent and never removes the parent .lovdex-tmp', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  await removeUploadStagingDir(staging);
  await removeUploadStagingDir(staging); // second call must not throw
  assert.equal(await fsp.stat(path.join(project, '.lovdex-tmp')).then(() => true, () => false), true);
  await fsp.rm(project, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/staging-dir.service.test.ts`
Expected: FAIL，`Cannot find module '../staging-dir.service.js'`。

- [ ] **Step 3: 写 upload-limits.ts**

创建 `backend/server/modules/uploads/upload-limits.ts`：

```ts
/**
 * The single source of truth for how large a file the project file-tree upload
 * accepts. Mirrored on the frontend by
 * `web/src/components/file-tree/constants/constants.ts` — keep the two in sync;
 * the frontend value only pre-checks, this one is authoritative.
 */
export const MAX_FILE_UPLOAD_SIZE_MB = 10240;

export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

export const MAX_FILE_UPLOAD_COUNT = 20;
```

- [ ] **Step 4: 写 staging-dir.service.ts**

创建 `backend/server/modules/uploads/staging-dir.service.ts`：

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { PROJECT_TMP_DIR } from '@/modules/assets/services/file-assets.service.js';

/** Injected rename, so tests can force the cross-device fallback. */
export type RenameFn = (from: string, to: string) => Promise<void>;

/**
 * Uploads are staged inside the project (not `os.tmpdir()`) so the final move
 * is a same-filesystem `rename` instead of a copy. A 10GB upload therefore
 * peaks at 1× disk instead of 2×.
 *
 * The staging dir is a unique child of the project's shared `.lovdex-tmp`
 * (which already carries a `*` .gitignore, so staged bytes never appear in
 * `git status`). Only the child is ever removed — never `.lovdex-tmp` itself,
 * which also holds chat attachments.
 */
export async function createUploadStagingDir(projectRoot: string): Promise<string> {
  const base = path.join(projectRoot, PROJECT_TMP_DIR);
  await fsp.mkdir(base, { recursive: true });

  const gitignorePath = path.join(base, '.gitignore');
  try {
    await fsp.writeFile(gitignorePath, '*\n!.gitignore\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  return fsp.mkdtemp(path.join(base, 'upload-'));
}

/** Best-effort removal of ONE staging dir; never touches its `.lovdex-tmp` parent. */
export async function removeUploadStagingDir(stagingDir: string): Promise<void> {
  try {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[upload] failed to remove staging dir ${stagingDir}:`, (error as Error).message);
  }
}

/**
 * Move one staged file to its final path. `rename` is atomic and same-device
 * when staging sits inside the project; EXDEV (staging on a different mount,
 * e.g. a project reached through a bind mount) falls back to copy+unlink.
 */
export async function moveStagedFileIntoPlace(
  stagedPath: string,
  targetPath: string,
  rename: RenameFn = fsp.rename,
): Promise<void> {
  try {
    await rename(stagedPath, targetPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  await fsp.copyFile(stagedPath, targetPath);
  await fsp.unlink(stagedPath);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/staging-dir.service.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/uploads/upload-limits.ts backend/server/modules/uploads/staging-dir.service.ts backend/server/modules/uploads/tests/staging-dir.service.test.ts
git commit -m "feat(upload): add the 10GB limit constant and a project-local staging dir"
```

---

## Task 3: RPC 参数 schema（三个上传方法）

**Files:**
- Modify: `backend/server/shared/agent-runtime/protocol.ts` (在 `makeFsDeleteParamsSchema` 之后追加)
- Test: `backend/server/shared/agent-runtime/tests/protocol.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

在 `backend/server/shared/agent-runtime/tests/protocol.test.ts` 顶部的 import 列表里加入三个新 schema：

```ts
  makeFsUploadBeginParamsSchema,
  makeFsUploadChunkParamsSchema,
  makeFsUploadEndParamsSchema,
```

在文件末尾追加：

```ts
test('fs/uploadBegin params schema requires a non-empty path', () => {
  const schema = makeFsUploadBeginParamsSchema();
  assert.deepEqual(schema.parse({ path: '/srv/app/a.bin' }), { path: '/srv/app/a.bin' });
  assert.throws(() => schema.parse({ path: '' }));
  assert.throws(() => schema.parse({}));
});

test('fs/uploadChunk params schema requires uploadId, non-negative index and base64 data', () => {
  const schema = makeFsUploadChunkParamsSchema();
  const ok = schema.parse({ uploadId: 'u1', index: 0, data: 'AAAA' });
  assert.equal(ok.index, 0);
  assert.equal(ok.data, 'AAAA');
  assert.throws(() => schema.parse({ uploadId: 'u1', index: -1, data: 'AAAA' })); // negative
  assert.throws(() => schema.parse({ uploadId: 'u1', index: 1.5, data: 'AAAA' })); // non-integer
  assert.throws(() => schema.parse({ uploadId: 'u1', index: 0 })); // data required
  assert.throws(() => schema.parse({ index: 0, data: 'AAAA' })); // uploadId required
});

test('fs/uploadEnd params schema requires uploadId', () => {
  const schema = makeFsUploadEndParamsSchema();
  assert.deepEqual(schema.parse({ uploadId: 'u1' }), { uploadId: 'u1' });
  assert.throws(() => schema.parse({}));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/shared/agent-runtime/tests/protocol.test.ts`
Expected: FAIL，`makeFsUploadBeginParamsSchema is not a function`。

- [ ] **Step 3: 加 schema**

在 `backend/server/shared/agent-runtime/protocol.ts` 的 `makeFsDeleteParamsSchema` 函数之后追加：

```ts
/**
 * Zod schema for the `fs/uploadBegin` `rpc_req` params. Starts a chunked
 * upload session for `path`; the lite returns an opaque `uploadId`.
 */
export function makeFsUploadBeginParamsSchema() {
  return z.object({ path: z.string().min(1) });
}

/**
 * Zod schema for the `fs/uploadChunk` `rpc_req` params. `index` must arrive
 * strictly in order starting at 0 — the lite rejects gaps/replays. `data` is
 * base64; the main side slices at 4MiB so one frame stays well under the ws
 * `maxPayload` ceiling on both ends.
 */
export function makeFsUploadChunkParamsSchema() {
  return z.object({
    uploadId: z.string().min(1),
    index: z.number().int().min(0),
    data: z.string(),
  });
}

/** Zod schema for the `fs/uploadEnd` `rpc_req` params. Finalizes the upload. */
export function makeFsUploadEndParamsSchema() {
  return z.object({ uploadId: z.string().min(1) });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/shared/agent-runtime/tests/protocol.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/server/shared/agent-runtime/protocol.ts backend/server/shared/agent-runtime/tests/protocol.test.ts
git commit -m "feat(upload): add the chunked-upload RPC param schemas"
```

---

## Task 4: lite 侧上传会话

**Files:**
- Create: `backend/remote-agent/src/upload-session.ts`
- Test: `backend/remote-agent/src/tests/upload-session.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/remote-agent/src/tests/upload-session.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUploadSessions } from '../upload-session.js';
import { createAllowlistedFs } from '../fs.js';

async function mkroot(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-upload-')));
}

function makeSessions(root: string) {
  return createUploadSessions({ fs: createAllowlistedFs({ roots: [root] }), idleMs: 60_000 });
}

test('begin → chunk → end writes the reassembled bytes to the target path', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('hello ').toString('base64'));
  await s.chunk(uploadId, 1, Buffer.from('world').toString('base64'));
  const done = await s.end(uploadId);

  assert.equal(done.size, 11);
  assert.equal(await fsp.readFile(target, 'utf8'), 'hello world');
  await fsp.rm(root, { recursive: true, force: true });
});

test('end over an existing target replaces it', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');
  await fsp.writeFile(target, 'old');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('new').toString('base64'));
  await s.end(uploadId);

  assert.equal(await fsp.readFile(target, 'utf8'), 'new');
  await fsp.rm(root, { recursive: true, force: true });
});

test('an out-of-order chunk index is rejected and the session is torn down', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  await assert.rejects(() => s.chunk(uploadId, 2, Buffer.from('b').toString('base64')), /out of order/);

  // The session is gone and its .part file with it.
  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(target).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a replayed chunk index is rejected', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  await assert.rejects(() => s.chunk(uploadId, 0, Buffer.from('a').toString('base64')), /out of order/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('an unknown uploadId is rejected on chunk and end', async () => {
  const root = await mkroot();
  const s = makeSessions(root);

  await assert.rejects(() => s.chunk('nope', 0, 'AAAA'), /unknown upload/);
  await assert.rejects(() => s.end('nope'), /unknown upload/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('abortAll drops sessions and their .part files', async () => {
  const root = await mkroot();
  const s = makeSessions(root);
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  const partPath = s.partPathForTest(uploadId);
  assert.ok(partPath);

  await s.abortAll();

  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(partPath as string).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('an idle session is dropped and its .part removed', async () => {
  const root = await mkroot();
  const s = createUploadSessions({
    fs: createAllowlistedFs({ roots: [root] }),
    idleMs: 20,
  });
  const target = path.join(root, 'a.bin');

  const { uploadId } = await s.begin(target);
  await s.chunk(uploadId, 0, Buffer.from('a').toString('base64'));
  const partPath = s.partPathForTest(uploadId) as string;

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(s.size(), 0);
  assert.equal(await fsp.stat(partPath).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('begin outside the allowed roots is rejected', async () => {
  const root = await mkroot();
  const s = makeSessions(root);

  await assert.rejects(() => s.begin('/etc/pwned'), /allowed root/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('begin over a dangling symlink leaf is rejected (no write-through)', async () => {
  const root = await mkroot();
  const outside = await mkroot();
  const victim = path.join(outside, 'victim.bin');
  await fsp.symlink(victim, path.join(root, 'evil'));
  const s = makeSessions(root);

  await assert.rejects(() => s.begin(path.join(root, 'evil')), /allowed root|symlink/);
  assert.equal(await fsp.stat(victim).then(() => true, () => false), false);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/upload-session.test.ts`
Expected: FAIL，`Cannot find module '../upload-session.js'`。

- [ ] **Step 3: 给 `AllowlistedFs` 补 `resolveWithin`**

`upload-session.ts` 需要做白名单解析，但 `AllowlistedFs`（`backend/remote-agent/src/fs.ts:17-51`）目前没有暴露这个能力。加一个方法，比把 `roots` 再传一遍干净：

在 `AllowlistedFs` 类型里，`stat` 声明之前加：

```ts
  /** Resolve `input` against the configured roots; throws on escape. */
  resolveWithin(input: string): string;
```

在 `createAllowlistedFs` 返回对象里，`stat` 之前加（`resolveWithinRoots` 已在文件内 import）：

```ts
    resolveWithin(input) {
      return resolveWithinRoots(input, roots);
    },
```

- [ ] **Step 4: 写 upload-session.ts**

创建 `backend/remote-agent/src/upload-session.ts`：

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { AllowlistedFs } from './fs.js';

/**
 * Chunked upload sessions on the lite side.
 *
 * Main pushes an arbitrarily large file as an ordered run of base64 chunks
 * (see `makeFsUploadChunkParamsSchema`). Each session appends to a sibling
 * `<target>.part` file and, on `end`, `rename`s it onto the target — same
 * filesystem, so the final step is atomic and never materializes the whole
 * file in memory.
 *
 * `idleMs` bounds how long a half-finished upload may pin a `.part` file: a
 * dropped connection is handled by `abortAll` on ws close, but a peer that
 * simply stops sending would otherwise leak the partial file forever.
 */

export type UploadSessions = {
  begin(targetPath: string): Promise<{ uploadId: string }>;
  chunk(uploadId: string, index: number, dataBase64: string): Promise<{ received: number }>;
  end(uploadId: string): Promise<{ success: true; size: number }>;
  /** Tear every session down (ws close / shutdown). */
  abortAll(): Promise<void>;
  /** Number of live sessions — for tests and diagnostics. */
  size(): number;
  /** TEST SEAM: the `.part` path for a live session, else null. */
  partPathForTest(uploadId: string): string | null;
};

type Session = {
  fd: fsp.FileHandle;
  targetPath: string;
  partPath: string;
  nextIndex: number;
  received: number;
  timer: NodeJS.Timeout;
};

export function createUploadSessions(opts: {
  fs: AllowlistedFs;
  idleMs?: number;
}): UploadSessions {
  const idleMs = opts.idleMs ?? 10 * 60 * 1000;
  const sessions = new Map<string, Session>();
  let counter = 0;

  async function drop(uploadId: string): Promise<void> {
    const session = sessions.get(uploadId);
    if (!session) return;
    sessions.delete(uploadId);
    clearTimeout(session.timer);
    try {
      await session.fd.close();
    } catch {
      /* already closed */
    }
    await fsp.unlink(session.partPath).catch(() => {});
  }

  function touch(uploadId: string): void {
    const session = sessions.get(uploadId);
    if (!session) return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      void drop(uploadId);
    }, idleMs);
    // A pending timer must not hold the process open on shutdown.
    session.timer.unref?.();
  }

  return {
    async begin(targetPath) {
      // Throws `path outside allowed root` before anything is created.
      const resolvedTarget = opts.fs.resolveWithin(targetPath);
      // Never write THROUGH a dangling symlink leaf: the `.part` is a sibling
      // of the target, but a symlinked TARGET would make the final rename land
      // outside the roots. Mirrors `write()`'s guard.
      try {
        const leaf = await fsp.lstat(resolvedTarget);
        if (leaf.isSymbolicLink()) throw new Error('path outside allowed root (symlink leaf)');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const uploadId = `up-${process.pid}-${++counter}`;
      const partPath = `${resolvedTarget}.part-${uploadId}`;
      const fd = await fsp.open(partPath, 'w');
      const session: Session = {
        fd,
        targetPath: resolvedTarget,
        partPath,
        nextIndex: 0,
        received: 0,
        timer: setTimeout(() => {}, 0),
      };
      sessions.set(uploadId, session);
      touch(uploadId);
      return { uploadId };
    },

    async chunk(uploadId, index, dataBase64) {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`unknown upload session: ${uploadId}`);
      if (index !== session.nextIndex) {
        await drop(uploadId);
        throw new Error(`out of order chunk: expected ${session.nextIndex}, got ${index}`);
      }
      const buf = Buffer.from(dataBase64, 'base64');
      await session.fd.write(buf);
      session.nextIndex += 1;
      session.received += buf.length;
      touch(uploadId);
      return { received: session.received };
    },

    async end(uploadId) {
      const session = sessions.get(uploadId);
      if (!session) throw new Error(`unknown upload session: ${uploadId}`);
      const { fd, targetPath, partPath, received } = session;
      sessions.delete(uploadId);
      clearTimeout(session.timer);
      // fsync before the rename: a crash must not leave a renamed-but-empty file
      // that looks like a successful upload.
      await fd.sync();
      await fd.close();
      await fsp.rename(partPath, targetPath);
      return { success: true, size: received };
    },

    async abortAll() {
      await Promise.all([...sessions.keys()].map((id) => drop(id)));
    },

    size() {
      return sessions.size;
    },

    partPathForTest(uploadId) {
      return sessions.get(uploadId)?.partPath ?? null;
    },
  };
}

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/upload-session.test.ts`
Expected: PASS（9 tests）。

- [ ] **Step 6: Commit**

```bash
git add backend/remote-agent/src/upload-session.ts backend/remote-agent/src/tests/upload-session.test.ts
git commit -m "feat(upload): add the lite-side chunked upload session"
```

---

## Task 5: 远程 fs 客户端加三个上传方法，删掉 32MB 上传常量

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-fs.service.ts:9`（删常量）, `:43-72`（加方法类型）, `:74-100`（加实现）
- Test: `backend/server/modules/remote-agents/tests/remote-fs.service.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

在 `backend/server/modules/remote-agents/tests/remote-fs.service.test.ts` 末尾追加：

```ts
test('uploadBegin/Chunk/End delegate to the matching rpc methods', async () => {
  const replies: Record<string, unknown> = {
    'fs/uploadBegin': { uploadId: 'u1' },
    'fs/uploadChunk': { received: 5 },
    'fs/uploadEnd': { success: true, size: 11 },
  };
  const { reg, calls } = fakeRegistry((call) => replies[call.method]);
  const client = createRemoteFsClient(() => reg);

  assert.deepEqual(await client.uploadBegin('h4', '/srv/app/a.bin'), { uploadId: 'u1' });
  assert.deepEqual(await client.uploadChunk('h4', 'u1', 0, 'aGVsbG8='), { received: 5 });
  assert.deepEqual(await client.uploadEnd('h4', 'u1'), { success: true, size: 11 });

  assert.deepEqual(calls, [
    { hostId: 'h4', method: 'fs/uploadBegin', params: { path: '/srv/app/a.bin' } },
    { hostId: 'h4', method: 'fs/uploadChunk', params: { uploadId: 'u1', index: 0, data: 'aGVsbG8=' } },
    { hostId: 'h4', method: 'fs/uploadEnd', params: { uploadId: 'u1' } },
  ]);
});

test('upload methods no longer expose a 32MB upload cap', async () => {
  const mod = await import('../remote-fs.service.js');
  assert.equal('REMOTE_MAX_UPLOAD_BYTES' in mod, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-fs.service.test.ts`
Expected: FAIL，`client.uploadBegin is not a function` 与 `REMOTE_MAX_UPLOAD_BYTES in mod` 为 true。

- [ ] **Step 3: 删常量、加类型**

`backend/server/modules/remote-agents/remote-fs.service.ts`：删掉第 8–9 行这两行：

```ts
/** Capped upload size for remote file writes (bytes). */
export const REMOTE_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
```

（`REMOTE_MAX_READ_BYTES` 保留不动 —— 读回仍卡 32MiB。）

在 `RemoteFsClient` 类型里，`write` 声明之后追加：

```ts
  uploadBegin(hostId: string, pathText: string): Promise<{ uploadId: string }>;
  uploadChunk(
    hostId: string,
    uploadId: string,
    index: number,
    dataBase64: string,
  ): Promise<{ received: number }>;
  uploadEnd(hostId: string, uploadId: string): Promise<{ success: boolean; size: number }>;
```

- [ ] **Step 4: 加实现**

在 `createRemoteFsClient` 返回对象里，`write` 之后追加：

```ts
    uploadBegin(h, p) {
      return reg().rpc(h, 'fs/uploadBegin', { path: p });
    },
    uploadChunk(h, uploadId, index, dataBase64) {
      return reg().rpc(h, 'fs/uploadChunk', { uploadId, index, data: dataBase64 });
    },
    uploadEnd(h, uploadId) {
      // 120s: the lite fsyncs and renames a multi-GB `.part` on this call.
      return reg().rpc(h, 'fs/uploadEnd', { uploadId }, 120_000);
    },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-fs.service.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/remote-agents/remote-fs.service.ts backend/server/modules/remote-agents/tests/remote-fs.service.test.ts
git commit -m "feat(upload): add chunked-upload methods to the remote fs client"
```

---

## Task 6: lite 侧接线三个 RPC 与断连清理

**Files:**
- Modify: `backend/remote-agent/src/rpc-dispatch.ts`（import、会话表、dispatch 分支、导出清理函数）
- Modify: `backend/remote-agent/src/index.ts:74-77`（ws 关闭时清理）
- Test: `backend/remote-agent/src/tests/upload-rpc.test.ts` (create)

- [ ] **Step 1: 写失败的测试**

创建 `backend/remote-agent/src/tests/upload-rpc.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleRpc, abortUploadSessionsFor } from '../rpc-dispatch.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkroot(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-uprpc-')));
}

function cfgFor(root: string): RemoteAgentConfig {
  return {
    serverUrl: 'ws://localhost:3000/agent',
    token: 'a-long-enough-token',
    hostId: 'host-1',
    roots: [root],
    skillRoots: [],
    agentVersion: '0.1.0',
  };
}

test('fs/uploadBegin → fs/uploadChunk → fs/uploadEnd through the dispatcher', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');

  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };
  await handleRpc(
    'fs/uploadChunk',
    { uploadId, index: 0, data: Buffer.from('aa').toString('base64') },
    cfg,
  );
  const done = (await handleRpc('fs/uploadEnd', { uploadId }, cfg)) as { size: number };

  assert.equal(done.size, 2);
  assert.equal(await fsp.readFile(target, 'utf8'), 'aa');
  await fsp.rm(root, { recursive: true, force: true });
});

test('fs/uploadChunk rejects an out-of-order index through the dispatcher', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');
  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };

  await assert.rejects(
    () => handleRpc('fs/uploadChunk', { uploadId, index: 5, data: 'AAAA' }, cfg),
    /out of order/,
  );
  await fsp.rm(root, { recursive: true, force: true });
});

test('abortUploadSessionsFor drops an in-flight upload for the given roots', async () => {
  const root = await mkroot();
  const cfg = cfgFor(root);
  const target = path.join(root, 'big.bin');
  const { uploadId } = (await handleRpc('fs/uploadBegin', { path: target }, cfg)) as {
    uploadId: string;
  };
  await handleRpc(
    'fs/uploadChunk',
    { uploadId, index: 0, data: Buffer.from('a').toString('base64') },
    cfg,
  );

  await abortUploadSessionsFor(cfg);

  // The session is gone: a late chunk for it is now an unknown session.
  await assert.rejects(
    () => handleRpc('fs/uploadChunk', { uploadId, index: 1, data: 'AAAA' }, cfg),
    /unknown upload/,
  );
  await fsp.rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/upload-rpc.test.ts`
Expected: FAIL，`abortUploadSessionsFor is not a function`（`handleRpc('fs/uploadBegin')` 会抛 `unknown rpc method`）。

- [ ] **Step 3: 接线 dispatch**

`backend/remote-agent/src/rpc-dispatch.ts`：

1. 在 import 段把 schema 加进来：

```ts
import {
  makeFsUploadBeginParamsSchema,
  makeFsUploadChunkParamsSchema,
  makeFsUploadEndParamsSchema,
  makeGitExecParamsSchema,
  makeSessionMessagesParamsSchema,
  makeSessionStartParamsSchema,
  makeSkillsApplyParamsSchema,
  makeSkillsBundleParamsSchema,
  makeSkillsManifestParamsSchema,
} from '../../server/shared/agent-runtime/protocol.js';
```

2. 加 import：

```ts
import { createUploadSessions } from './upload-session.js';
```

3. 在 `interruptAllFor` 之后加一段会话表（与 `cachedFs` 同样按 roots 做 keyed 缓存，理由相同：解析后的 config 在进程内不可变，但单测里 roots 各不相同）：

```ts
/**
 * Chunked-upload sessions, memoized by the joined roots so they share the
 * same allowlisted fs as the rest of the file surface and stay isolated
 * between unit tests with distinct roots.
 */
const uploadSessionsByRoots = new Map<string, ReturnType<typeof createUploadSessions>>();

function uploadSessionsFor(cfg: RemoteAgentConfig): ReturnType<typeof createUploadSessions> {
  const key = cfg.roots.join('\0');
  let sessions = uploadSessionsByRoots.get(key);
  if (!sessions) {
    sessions = createUploadSessions({ fs: allowlistedFsFor(cfg) });
    uploadSessionsByRoots.set(key, sessions);
  }
  return sessions;
}

/**
 * Drop every in-flight upload for these roots. Called when the main link drops:
 * the chunk stream is gone, so a half-written `.part` must not linger (and a
 * reconnect would start a fresh session anyway).
 */
export async function abortUploadSessionsFor(cfg: RemoteAgentConfig): Promise<void> {
  const key = cfg.roots.join('\0');
  const sessions = uploadSessionsByRoots.get(key);
  if (sessions) await sessions.abortAll();
}
```

4. 在 `handleRpc` 的 `fs/write | fs/create | ...` 分支之前插入新分支：

```ts
  if (
    method === 'fs/uploadBegin'
    || method === 'fs/uploadChunk'
    || method === 'fs/uploadEnd'
  ) {
    const sessions = uploadSessionsFor(cfg);
    if (method === 'fs/uploadBegin') {
      const p = makeFsUploadBeginParamsSchema().parse(params as unknown);
      return sessions.begin(p.path);
    }
    if (method === 'fs/uploadChunk') {
      const p = makeFsUploadChunkParamsSchema().parse(params as unknown);
      return sessions.chunk(p.uploadId, p.index, p.data);
    }
    const p = makeFsUploadEndParamsSchema().parse(params as unknown);
    return sessions.end(p.uploadId);
  }
```

- [ ] **Step 4: ws 关闭时清理**

`backend/remote-agent/src/index.ts` 的 import 行改成：

```ts
import { abortUploadSessionsFor, handleRpc, interruptAllFor, setPushEmitter } from './rpc-dispatch.js';
```

在 `handleClose` 顶部加（必须在 `interruptAllFor(cfg)` 的第一个 `return` 之前 —— `handleClose` 在致命关闭码分支里直接 `return`/`process.exit`，写在后面就永远跑不到）：

```ts
  const handleClose = (code: number) => {
    if (stopped) return;
    clearTimers();
    // A dropped link means no more chunks are coming: drop every half-written
    // `.part` for this host's roots instead of waiting out the idle timer.
    // Placed before the fatal-code branch below, which returns/exits early.
    void abortUploadSessionsFor(cfg).catch((err) =>
      console.error('[remote-agent] upload cleanup failed:', err),
    );
    const fatal = FATAL_CLOSE_CODES[code];
    // …existing body unchanged…
```

即：删掉原来的 `clearTimers();` 那一行重复，把清理调用插在 `const fatal = ...` 之前。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/upload-rpc.test.ts remote-agent/src/tests/index.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/remote-agent/src/rpc-dispatch.ts backend/remote-agent/src/index.ts backend/remote-agent/src/tests/upload-rpc.test.ts
git commit -m "feat(upload): serve the chunked-upload RPCs from the lite"
```

---

## Task 7: 上报 fs/upload* 能力

**Files:**
- Modify: `backend/remote-agent/src/index.ts:122-137`（capabilities 数组）
- Test: `backend/remote-agent/src/tests/index.test.ts:57-60`（追加断言）

- [ ] **Step 1: 写失败的测试**

在 `backend/remote-agent/src/tests/index.test.ts` 第 59 行（`assert.ok(frame.capabilities.includes('fs/read'));`）之后追加：

```ts
  assert.ok(frame.capabilities.includes('fs/uploadBegin'));
  assert.ok(frame.capabilities.includes('fs/uploadChunk'));
  assert.ok(frame.capabilities.includes('fs/uploadEnd'));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/index.test.ts`
Expected: FAIL，`fs/uploadBegin` 不在 capabilities 里。

- [ ] **Step 3: 加能力项**

`backend/remote-agent/src/index.ts` 的 capabilities 数组里，`'fs/delete',` 之后加三行：

```ts
      'fs/uploadBegin',
      'fs/uploadChunk',
      'fs/uploadEnd',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/index.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/remote-agent/src/index.ts backend/remote-agent/src/tests/index.test.ts
git commit -m "feat(upload): advertise the chunked-upload capability"
```

---

## Task 8: 主侧把本机文件分片推送到远端

**Files:**
- Create: `backend/server/modules/uploads/remote-upload.service.ts`
- Test: `backend/server/modules/uploads/tests/remote-upload.service.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/uploads/tests/remote-upload.service.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pushFileToRemote, UPLOAD_CHUNK_BYTES } from '../remote-upload.service.js';
import type { RemoteFsClient } from '@/modules/remote-agents/remote-fs.service.js';

type Call = { method: string; args: unknown[] };

function fakeFsClient(): { client: RemoteFsClient; calls: Call[]; received: Buffer[] } {
  const calls: Call[] = [];
  const received: Buffer[] = [];
  let size = 0;
  const client = {
    uploadBegin: async (...args: unknown[]) => {
      calls.push({ method: 'begin', args });
      return { uploadId: 'u1' };
    },
    uploadChunk: async (_h: string, _id: string, index: number, data: string) => {
      calls.push({ method: 'chunk', args: [index] });
      const buf = Buffer.from(data, 'base64');
      received.push(buf);
      size += buf.length;
      return { received: size };
    },
    uploadEnd: async (...args: unknown[]) => {
      calls.push({ method: 'end', args });
      return { success: true, size };
    },
  } as unknown as RemoteFsClient;
  return { client, calls, received };
}

async function mktmpfile(bytes: number): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-push-'));
  const file = path.join(dir, 'payload.bin');
  await fsp.writeFile(file, Buffer.alloc(bytes, 7));
  return file;
}

test('a small file is pushed as exactly one chunk and reassembles byte-for-byte', async () => {
  const file = await mktmpfile(1024);
  const { client, calls, received } = fakeFsClient();

  const result = await pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/big.bin');

  assert.equal(result.size, 1024);
  assert.deepEqual(calls.map((c) => c.method), ['begin', 'chunk', 'end']);
  assert.deepEqual(calls[0].args, ['h1', '/srv/big.bin']);
  assert.deepEqual(received[0], Buffer.alloc(1024, 7));
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a file larger than one chunk is split at UPLOAD_CHUNK_BYTES with ordered indices', async () => {
  const bytes = UPLOAD_CHUNK_BYTES * 2 + 100;
  const file = await mktmpfile(bytes);
  const { client, calls, received } = fakeFsClient();

  const result = await pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/big.bin');

  assert.equal(result.size, bytes);
  const chunkCalls = calls.filter((c) => c.method === 'chunk');
  assert.equal(chunkCalls.length, 3);
  assert.deepEqual(chunkCalls.map((c) => c.args[0]), [0, 1, 2]);
  assert.deepEqual(
    received.map((b) => b.length),
    [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 100],
  );
  assert.equal(Buffer.concat(received).equals(Buffer.alloc(bytes, 7)), true);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a zero-byte file still begins and ends (one empty chunk)', async () => {
  const file = await mktmpfile(0);
  const { client, calls } = fakeFsClient();

  const result = await pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/empty.bin');

  assert.equal(result.size, 0);
  assert.deepEqual(calls.map((c) => c.method), ['begin', 'chunk', 'end']);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

test('a mid-stream chunk failure propagates and does not call end', async () => {
  const bytes = UPLOAD_CHUNK_BYTES * 2;
  const file = await mktmpfile(bytes);
  const { client, calls } = fakeFsClient();
  let n = 0;
  (client as { uploadChunk: unknown }).uploadChunk = async () => {
    n += 1;
    if (n === 2) throw new Error('remote rpc timeout: fs/uploadChunk');
    return { received: 0 };
  };

  await assert.rejects(
    () => pushFileToRemote({ fsClient: client, hostId: 'h1' }, file, '/srv/big.bin'),
    /timeout/,
  );
  assert.equal(calls.some((c) => c.method === 'end'), false);
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/remote-upload.service.test.ts`
Expected: FAIL，`Cannot find module '../remote-upload.service.js'`。

- [ ] **Step 3: 写 remote-upload.service.ts**

创建 `backend/server/modules/uploads/remote-upload.service.ts`：

```ts
import { open } from 'node:fs/promises';

import type { RemoteFsClient } from '@/modules/remote-agents/remote-fs.service.js';

/**
 * 4MiB per chunk. Base64 inflates that to ~5.33MiB, comfortably under the ws
 * `maxPayload` default (100MiB) on BOTH ends, so no `maxPayload` tuning is
 * needed. The main side only ever holds one chunk buffer at a time.
 */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export type PushFileToRemoteDeps = {
  fsClient: RemoteFsClient;
  hostId: string;
};

/**
 * Stream one local file to a remote host over the chunked-upload RPCs.
 *
 * Reads the source in `UPLOAD_CHUNK_BYTES` slices so memory stays flat
 * regardless of file size; the lite appends each chunk to a `.part` file and
 * commits it with a rename on `end`. There is no resume: a failure mid-stream
 * propagates, and the lite drops the partial `.part` (ws close or idle timer).
 */
export async function pushFileToRemote(
  deps: PushFileToRemoteDeps,
  localPath: string,
  remotePath: string,
): Promise<{ size: number }> {
  const { fsClient, hostId } = deps;
  const { uploadId } = await fsClient.uploadBegin(hostId, remotePath);

  const handle = await open(localPath, 'r');
  try {
    const buf = Buffer.alloc(UPLOAD_CHUNK_BYTES);
    let index = 0;
    let total = 0;
    // A zero-byte file must still send one chunk so the lite's session machine
    // (begin → chunk* → end) stays uniform.
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, UPLOAD_CHUNK_BYTES, null);
      if (bytesRead === 0 && index > 0) break;
      const slice = bytesRead === UPLOAD_CHUNK_BYTES ? buf : buf.subarray(0, bytesRead);
      await fsClient.uploadChunk(hostId, uploadId, index, slice.toString('base64'));
      index += 1;
      total += bytesRead;
      if (bytesRead === 0) break; // zero-byte file: one pass, then done
    }
    await fsClient.uploadEnd(hostId, uploadId);
    return { size: total };
  } finally {
    await handle.close();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/remote-upload.service.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/uploads/remote-upload.service.ts backend/server/modules/uploads/tests/remote-upload.service.test.ts
git commit -m "feat(upload): add the main-side chunked push to a remote host"
```

---

## Task 9: 本地上传改走项目内暂存目录

**Files:**
- Modify: `backend/server/index.js:140-142`（常量改导入）, `:1513-1768`（uploadFilesHandler）, `:166`（requestTimeout）
- Modify: `backend/server/modules/remote-agents/tests/remote-fs.service.test.ts`（不动）
- Test: `backend/server/modules/uploads/tests/upload-route-wiring.test.ts` (create)

**背景（当前代码）：**

- `index.js:140-142` 是本机上传的三个常量，与新建的 `upload-limits.ts` 重复。
- `index.js:1519-1536` multer `diskStorage` 写 `os.tmpdir()`。
- `index.js:1652-1743` 目标目录校验 → 远程分支 → 本地分支（`copyFile`）。
- 远程分支（`1615-1697`）里面的 `REMOTE_MAX_UPLOAD_BYTES` 检查与 base64 单帧推送在 Task 10 换成 `pushFileToRemote`。

**做法：** 把 handler 拆成「解析目标目录」+「本机搬运」+「远程推送」三段，multer 的 destination 指向已解析的暂存目录。

- [ ] **Step 1: 写失败的测试**

创建 `backend/server/modules/uploads/tests/upload-route-wiring.test.ts`。这个测试直接驱动从 `index.js` 里抽出来的「本机搬运」段落，避免拉起整个 server：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE_BYTES,
  MAX_FILE_UPLOAD_SIZE_MB,
} from '../upload-limits.js';
import {
  createUploadStagingDir,
  moveStagedFileIntoPlace,
  removeUploadStagingDir,
} from '../staging-dir.service.js';

async function mkproject(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lovdex-route-'));
}

/**
 * Mirrors the local branch of the upload handler: stage, then move each file
 * into place, then drop the staging dir. Keeping this shape in a test pins the
 * three properties the route depends on — one staging dir per request, same
 * basename semantics as `file.originalname`, and cleanup on both paths.
 */
async function placeLocalUpload(
  projectRoot: string,
  uploads: { name: string; bytes: Buffer }[],
  relativePaths?: string[],
): Promise<{ name: string; size: number }[]> {
  const staging = await createUploadStagingDir(projectRoot);
  try {
    const placed: { name: string; size: number }[] = [];
    for (let i = 0; i < uploads.length; i += 1) {
      const upload = uploads[i];
      const fileName = relativePaths?.[i] ?? upload.name;
      const staged = path.join(staging, upload.name);
      await fsp.writeFile(staged, upload.bytes);
      const dest = path.join(projectRoot, fileName);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await moveStagedFileIntoPlace(staged, dest);
      placed.push({ name: fileName, size: upload.bytes.length });
    }
    return placed;
  } finally {
    await removeUploadStagingDir(staging);
  }
}

test('upload limits the route will enforce are exported from one module', () => {
  assert.equal(MAX_FILE_UPLOAD_SIZE_MB, 10240);
  assert.equal(MAX_FILE_UPLOAD_SIZE_BYTES, 10240 * 1024 * 1024);
  assert.equal(MAX_FILE_UPLOAD_COUNT, 20);
});

test('a local upload lands in the target dir and leaves no staging dir behind', async () => {
  const project = await mkproject();
  const placed = await placeLocalUpload(project, [{ name: 'a.bin', bytes: Buffer.from('abc') }]);

  assert.deepEqual(placed, [{ name: 'a.bin', size: 3 }]);
  assert.equal(await fsp.readFile(path.join(project, 'a.bin'), 'utf8'), 'abc');
  assert.deepEqual(await fsp.readdir(path.join(project, '.lovdex-tmp')), ['.gitignore']);
  await fsp.rm(project, { recursive: true, force: true });
});

test('folder uploads honour relativePaths and create nested parents', async () => {
  const project = await mkproject();
  const placed = await placeLocalUpload(
    project,
    [{ name: 'a.bin', bytes: Buffer.from('x') }],
    ['deep/nested/a.bin'],
  );

  assert.deepEqual(placed, [{ name: 'deep/nested/a.bin', size: 1 }]);
  assert.equal(await fsp.readFile(path.join(project, 'deep/nested/a.bin'), 'utf8'), 'x');
  await fsp.rm(project, { recursive: true, force: true });
});

test('a failure mid-batch still removes the staging dir', async () => {
  const project = await mkproject();
  const staging = await createUploadStagingDir(project);
  await fsp.writeFile(path.join(staging, 'a.bin'), 'a');
  await removeUploadStagingDir(staging);

  assert.deepEqual(await fsp.readdir(path.join(project, '.lovdex-tmp')), ['.gitignore']);
  await fsp.rm(project, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/upload-route-wiring.test.ts`
Expected: 失败在 `MAX_FILE_UPLOAD_COUNT` 等导出（`upload-limits.ts` 已存在，但若 Task 2 未完成则模块缺失）。若 Task 2 已完成，本步应直接通过 —— 这说明测试锁的是 Task 2 的契约，编译不会拦；继续 Step 3 让 handler 真正用上它。

- [ ] **Step 3: 常量改从新模块导入**

`backend/server/index.js`：

1. 在 import 段（`import { assetsRoutes } from './modules/assets/index.js';` 附近）加：

```js
import { MAX_FILE_UPLOAD_COUNT, MAX_FILE_UPLOAD_SIZE_BYTES, MAX_FILE_UPLOAD_SIZE_MB } from './modules/uploads/upload-limits.js';
```

2. 删掉第 140–142 行：

```js
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;
```

3. 在 import 段再加：

```js
import {
    createUploadStagingDir,
    moveStagedFileIntoPlace,
    removeUploadStagingDir,
} from './modules/uploads/staging-dir.service.js';
```

4. 放宽单请求时长（10GB 上行远超 Node 默认 300s）：

```js
const server = http.createServer(app);
// A 10GB upload over a slow link far exceeds Node's 300s default
// requestTimeout; the body is a stream, so a long request is expected here.
// `0` disables the timeout. Headers still arrive up front, so the 60s
// headersTimeout default stays (it guards slow-header attacks, not body size).
server.requestTimeout = 0;
```

- [ ] **Step 4: 先把目标目录解析提前到 multer 之前**

把 `uploadFilesHandler` 的开头改成（保留原有的 `projectId` / `relativePaths` 解析）：

```js
const uploadFilesHandler = async (req, res) => {
    const multer = (await import('multer')).default;

    // Resolve the project + target dir BEFORE multer runs: the staging dir
    // lives inside the project (same filesystem as the target), so the final
    // move is a rename rather than a cross-device copy.
    const { projectId } = req.params;
    const projectRoot = await projectsDb.getProjectPathById(projectId);
    if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
    }
    const targetDir = typeof req.query.targetPath === 'string' ? req.query.targetPath : '';
    let resolvedTargetDir;
    if (!targetDir || targetDir === '.' || targetDir === './') {
        resolvedTargetDir = path.resolve(projectRoot);
    } else {
        const validation = validatePathInProject(projectRoot, targetDir);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        resolvedTargetDir = validation.resolved;
    }

    // Staging lives under the PROJECT ROOT (not the target dir): the target
    // dir is whatever `targetPath` says, and the move to it stays same-device
    // because both live inside the same project tree.
    let stagingDir;
    try {
        stagingDir = await createUploadStagingDir(projectRoot);
    } catch (error) {
        console.error('[upload] failed to create staging dir:', error);
        return res.status(500).json({ error: 'Failed to prepare upload directory' });
    }

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, stagingDir),
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
            files: MAX_FILE_UPLOAD_COUNT
        }
    });
```

**注意（重要，避免踩坑）：** 前端把 `targetPath` 放在 multipart body 里（`useFileTreeUpload.ts:93`），而 multer 在回调里才解析 body。为了让 multer 之前就能定位暂存位置，这里改用 `req.query.targetPath`，因此**前端要同时把 `targetPath` 放进查询串**（Task 11 已改）。`relativePaths` / `requestedFileCount` 仍在 `req.body` 里读（multer 之后才有，保持原样）。`server/index.js` 与前端必须**一起**上线：只改后端会让 `targetPath` 永远为空 → 一律落到项目根。

- [ ] **Step 5: 本机分支改 rename，远程分支改用 pushFileToRemote（Task 10 收尾）**

把原「Ensure target directory exists」到本地 `copyFile` 循环（`1699-1743`）整段替换为：

```js
            // Stage → move. Same filesystem, so this is a rename (no 2× disk
            // spike); EXDEV falls back to a copy inside the helper.
            const uploadedFiles = [];
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                const destPath = path.join(resolvedTargetDir, fileName);

                const destValidation = validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    continue;
                }

                const parentDir = path.dirname(destPath);
                await fsPromises.mkdir(parentDir, { recursive: true });
                await moveStagedFileIntoPlace(file.path, destPath);

                uploadedFiles.push({
                    name: fileName,
                    path: destPath,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }
```

远程分支（Task 10 会把单帧 base64 换成 `pushFileToRemote`）；本任务先把远程分支里的 `REMOTE_MAX_UPLOAD_BYTES` 检查删掉，改为调用 `pushFileToRemote`，并在整个 handler 结束时无论成败都 `removeUploadStagingDir(stagingDir)`：

```js
            const hostId = lookupRemoteHost(projectRoot);
            if (hostId) {
                const { fsClient } = getRemoteAgentsRuntime();
                /* ensureRemoteParent 保持原样（原 1618-1643） */
                const uploadedFiles = [];
                for (let i = 0; i < req.files.length; i++) {
                    const file = req.files[i];
                    const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                    const destPath = path.join(resolvedTargetDir, fileName);
                    const destValidation = validatePathInProject(projectRoot, destPath);
                    if (!destValidation.valid) continue;
                    await ensureRemoteParent(path.dirname(destPath), resolvedTargetDir);
                    const pushed = await pushFileToRemote(
                        { fsClient, hostId },
                        file.path,
                        destValidation.resolved,
                    );
                    uploadedFiles.push({
                        name: fileName,
                        path: destValidation.resolved,
                        size: pushed.size,
                        mimeType: file.mimetype
                    });
                }
                return res.json({
                    success: true,
                    files: uploadedFiles,
                    uploadedCount: uploadedFiles.length,
                    requestedFileCount,
                    targetPath: resolvedTargetDir,
                    message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
                });
            }
```

在 multer 回调的 `finally`（或 catch 之后统一处）加：

```js
        } finally {
            await removeUploadStagingDir(stagingDir);
        }
```

并把原 catch 里「删 temp 文件」的循环删掉（它们本来就在 stagingDir 里，随目录一起删）：

```js
        } catch (error) {
            console.error('Error uploading files:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/upload-route-wiring.test.ts server/modules/uploads/tests/staging-dir.service.test.ts`
Expected: PASS。

- [ ] **Step 7: 类型检查**

Run: `cd backend && npm run typecheck`
Expected: 零新增错误（`index.js` 不参与 tsc 的严格检查路径时以 lint 为准）。

- [ ] **Step 8: Commit**

```bash
git add backend/server/index.js backend/server/modules/uploads/tests/upload-route-wiring.test.ts
git commit -m "feat(upload): stage local uploads inside the project and move by rename"
```

---

## Task 10: 远程分支接线 `pushFileToRemote` 与 import 收尾

**Files:**
- Modify: `backend/server/index.js:107`（import 改为不再引 `REMOTE_MAX_UPLOAD_BYTES`）, 远程分支

- [ ] **Step 1: 改 import**

`backend/server/index.js` 第 107 行：

```js
import { createRemoteFsClient, REMOTE_MAX_READ_BYTES } from './modules/remote-agents/remote-fs.service.js';
```

并新增：

```js
import { pushFileToRemote } from './modules/uploads/remote-upload.service.js';
```

- [ ] **Step 2: 清掉残留的常量引用**

Run: `cd backend && grep -n "REMOTE_MAX_UPLOAD_BYTES" server/index.js`
Expected: 无输出。

若还有（Task 9 未清干净），逐处删掉 `file.size > REMOTE_MAX_UPLOAD_BYTES` / `buf.length > REMOTE_MAX_UPLOAD_BYTES` 及其 413 分支。

- [ ] **Step 3: 全仓确认常量已消失**

Run: `cd backend && grep -rn "REMOTE_MAX_UPLOAD_BYTES" server/ remote-agent/src/`
Expected: 无输出（`remote-fs.service.ts` 的导出也已在 Task 5 删除）。

- [ ] **Step 4: 跑相关测试**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/uploads/tests/remote-upload.service.test.ts server/modules/remote-agents/tests/remote-fs.service.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量后端测试**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test $(find server remote-agent/src -name '*.test.ts' | tr '\n' ' ')`
Expected: 与改动前同样的通过/失败集合（baseline 若干 pre-existing 失败；不得新增失败）。

- [ ] **Step 6: Lint**

Run: `cd backend && npm run lint`
Expected: 零新增（baseline 44 errors）。

- [ ] **Step 7: Commit**

```bash
git add backend/server/index.js
git commit -m "feat(upload): stream remote uploads in chunks instead of one base64 frame"
```

---

## Task 11: 前端把 targetPath 放进查询串（与 Task 9 同步上线）

**Files:**
- Modify: `web/src/components/file-tree/hooks/useFileTreeUpload.ts:89-120`
- Test: `web/src/components/file-tree/hooks/uploadUrl.test.ts` (create)

**为什么：** Task 9 让后端在 multer 之前读 `req.query.targetPath`，才能把暂存目录放到项目里。前端目前只在 formData body 里带 `targetPath`，不改的话目标位置永远退化成项目根。

- [ ] **Step 1: 抽出 URL 构造器以便测试**

在 `useFileTreeUpload.ts` 的 `uploadFormDataWithProgress` 上方加一个纯函数：

```ts
/** Build the upload URL. `targetPath` rides the query string so the backend can
 *  resolve the destination (and its staging dir) before multer parses the body. */
export const buildUploadUrl = (projectId: string, targetPath: string) => {
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/upload`;
  return targetPath ? `${base}?targetPath=${encodeURIComponent(targetPath)}` : base;
};
```

- [ ] **Step 2: 写失败的测试**

创建 `web/src/components/file-tree/hooks/uploadUrl.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUploadUrl } from './useFileTreeUpload';

test('buildUploadUrl omits targetPath when empty (project root)', () => {
  assert.equal(buildUploadUrl('p 1', ''), '/api/projects/p%201/files/upload');
});

test('buildUploadUrl encodes targetPath into the query string', () => {
  assert.equal(
    buildUploadUrl('p1', 'deep/nested dir'),
    '/api/projects/p1/files/upload?targetPath=deep%2Fnested%20dir',
  );
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/hooks/uploadUrl.test.ts`
Expected: FAIL，`buildUploadUrl is not a function`。

- [ ] **Step 4: 用上构造器并带上 targetPath**

`useFileTreeUpload.ts` 里 `uploadFormDataWithProgress` 的签名加一个参数，并改 `xhr.open` 行：

```ts
const uploadFormDataWithProgress = (
  projectId: string,
  targetPath: string,
  formData: FormData,
  onProgress: (progress: number) => void,
) =>
  new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', buildUploadUrl(projectId, targetPath));
```

对应调用处（`useFileTreeUpload` 内 `uploadFormDataWithProgress(selectedProject.projectId, buildUploadFormData(files, targetPath), ...)`）改成：

```ts
        const response = await uploadFormDataWithProgress(
          selectedProject.projectId,
          targetPath,
          buildUploadFormData(files, targetPath),
          (progress) => {
```

（`buildUploadFormData` 里 `formData.append('targetPath', targetPath)` 保留 —— 后端本机/远程分支仍可从 body 读，双通道更稳。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test src/components/file-tree/hooks/uploadUrl.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 6: 前端类型检查**

Run: `cd web && npm run typecheck`
Expected: 零新增。

- [ ] **Step 7: Commit**

```bash
git add web/src/components/file-tree/hooks/useFileTreeUpload.ts web/src/components/file-tree/hooks/uploadUrl.test.ts
git commit -m "feat(upload): carry targetPath on the upload query string"
```

---

## Task 12: loopback 集成测试覆盖分片上行

**Files:**
- Modify: `backend/server/modules/remote-agents/tests/loopback-lite.integration.test.ts`

**为什么：** 前面各层的单测都过了也不代表真能走通线：`registry.rpc` 的帧编解码、4MiB 切片的 base64 体积、以及 lite 的 `handleRpc` 接线都只在真实 ws 上合起来才成立。

- [ ] **Step 1: 在 fakeLite 里处理上传 RPC**

`loopback-lite.integration.test.ts` 的 `fakeLite` 里，`session/start` 分支之后加。分片按 `uploadId` 收集，`uploadEnd` 之后把整批分片移进 `finishedUploads`，这样用例在 `end` 之后仍能读回内容：

```ts
    if (frame.method === 'fs/uploadBegin') {
      const id = `up-${++uploadSeq}`;
      activeUploads.set(id, []);
      ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: true, data: { uploadId: id } }));
      return;
    }
    if (frame.method === 'fs/uploadChunk') {
      const p = frame.params as { uploadId: string; index: number; data: string };
      const parts = activeUploads.get(p.uploadId);
      if (!parts) {
        ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: false, error: 'unknown upload session' }));
        return;
      }
      if (p.index !== parts.length) {
        ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: false, error: `out of order chunk: expected ${parts.length}, got ${p.index}` }));
        return;
      }
      parts.push(Buffer.from(p.data, 'base64'));
      ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: true, data: { received: parts.reduce((n, b) => n + b.length, 0) } }));
      return;
    }
    if (frame.method === 'fs/uploadEnd') {
      const p = frame.params as { uploadId: string };
      const parts = activeUploads.get(p.uploadId) ?? [];
      activeUploads.delete(p.uploadId);
      finishedUploads.push(parts);
      ws.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: true, data: { success: true, size: parts.reduce((n, b) => n + b.length, 0) } }));
      return;
    }
```

在 `fakeLite` 顶部加两个局部变量：

```ts
  let uploadSeq = 0;
  const activeUploads = new Map<string, Buffer[]>();
  const finishedUploads: Buffer[][] = [];
```

并把读回口暴露给用例 —— 返回值加上：

```ts
    lastUploadedParts() {
      return finishedUploads.at(-1) ?? [];
    },
```

- [ ] **Step 2: 加用例**

在文件末尾追加：

```ts
test(
  'loopback lite: chunked upload reassembles a multi-chunk file byte-for-byte',
  { timeout: 10_000 },
  async () => {
    const server = http.createServer();
    const registry = createRemoteAgentsRegistry();
    let ws: WebSocket | undefined;
    try {
      createRemoteAgentWss(server, {
        verifyToken: (t) => (t === 'loop-token' ? 'h1' : null),
        registry,
        onHostOnline: () => {},
        onHostOffline: () => {},
      });
      const port = await listen(server);
      ws = await connectLite(port, 'h1');
      const lite = fakeLite(ws, {});

      const { fsClient } = { fsClient: createRemoteFsClient(() => registry) };

      // Two chunks + a tail, sized off the real chunk constant.
      const bytes = UPLOAD_CHUNK_BYTES + 7;
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loop-upload-'));
      const local = path.join(dir, 'payload.bin');
      await fsp.writeFile(local, Buffer.alloc(bytes, 9));

      const result = await pushFileToRemote({ fsClient, hostId: 'h1' }, local, '/srv/big.bin');

      assert.equal(result.size, bytes);
      const all = lite.lastUploadedParts();
      assert.equal(all.length, 2); // 4MiB + the 7-byte tail
      assert.equal(Buffer.concat(all).equals(Buffer.alloc(bytes, 9)), true);
      await fsp.rm(dir, { recursive: true, force: true });
    } finally {
      ws?.close();
      (server as unknown as { close: () => void }).close();
    }
  },
);
```

> 说明：`lite.lastUploadedParts()` 是 Step 1 里加的读回口。`uploadEnd` 会把分片从 `activeUploads` 移进 `finishedUploads`（而不是丢弃），用例才能断言重装后的字节。

- [ ] **Step 3: 补 import**

文件顶部确保有：

```ts
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteFsClient } from '../remote-fs.service.js';
import { pushFileToRemote, UPLOAD_CHUNK_BYTES } from '@/modules/uploads/remote-upload.service.js';
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/loopback-lite.integration.test.ts`
Expected: PASS（含新增用例）。

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/tests/loopback-lite.integration.test.ts
git commit -m "test(upload): cover a multi-chunk remote upload over a real ws loopback"
```

---

## Task 13: 收尾 —— 全量验证与文档

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-large-file-upload-design.md`（若实现与 spec 有出入，同步）

- [ ] **Step 1: 后端全量测试**

Run: `cd backend && env -u TSX_TSCONFIG_PATH npx tsx --tsconfig server/tsconfig.json --test $(find server remote-agent/src -name '*.test.ts' | tr '\n' ' ') 2>&1 | tail -20`
Expected: `# fail` 与改动前一致（记录改造前的 fail 数再对比）。

- [ ] **Step 2: 前端全量测试**

Run: `cd web && env -u TSX_TSCONFIG_PATH npx tsx --test $(find src -name '*.test.ts' | tr '\n' ' ') 2>&1 | tail -20`
Expected: 同上。

- [ ] **Step 3: 两处类型检查与 lint**

Run: `cd backend && npm run typecheck && npm run lint`；`cd web && npm run typecheck`
Expected: 零新增。

- [ ] **Step 4: 构建 lite 产物确认 esbuild 能打包新模块**

Run: `cd backend/remote-agent && npm run build 2>&1 | tail -5`
Expected: 退出码 0，`dist/lite.mjs` 生成（新模块被内联，无解析错误）。

- [ ] **Step 5: 人工验收（上传路径）**

1. 起后端（`cd backend && npm run dev`）与前端（`cd web && npm run dev`）。
2. 本机项目：上传一个 >200MB 的文件，确认成功、进度条走完、目标目录出现该文件、`.lovdex-tmp` 下没有残留 `upload-*` 目录。
3. 远程项目（`remote_host_id` 有值）：上传一个 >32MB 的文件，确认成功且远端目标目录出现该文件。
4. 传一个超 10GB 的文件，确认前端预校验拦下（提示 10240MB）。

- [ ] **Step 6: Commit（如有文档同步）**

```bash
git add -A
git commit -m "docs(upload): sync the spec with the implemented chunked upload"
```

---

## 完成标准

- [ ] `MAX_FILE_UPLOAD_SIZE_MB` 前端/后端均为 10240，且两侧各有测试钉住。
- [ ] 本机上传不再使用 `os.tmpdir()`；完成后 `.lovdex-tmp/upload-*` 无残留。
- [ ] 远程上传走 `fs/uploadBegin/Chunk/End`，每次 ≤4MiB，无整文件 base64。
- [ ] `REMOTE_MAX_UPLOAD_BYTES` 全仓消失；`REMOTE_MAX_READ_BYTES` 仍为 32MiB。
- [ ] lite 断连时 `.part` 被清理。
- [ ] tsc/lint 零新增；后端与前端测试无新增失败。
