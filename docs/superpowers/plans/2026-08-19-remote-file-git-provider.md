# 远程文件管理 / 远程源码管理 / 远程 Provider 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让远程项目在 Lovdex 里获得完整体验——远程文件全量管理、远程 git/worktrees 全量、远程 4 provider 会话，并在新建会话时按目标机安装情况过滤 provider。

**Architecture:** 方案 A——扩展 lite RPC 表面。新增 `fs/*` 写面 + `git/exec` + `providers/probe`，`session/start` 泛化为多 provider 并携带本机配置 env；main 端 HTTP 路由按 `projectId → remote_host_id`（及 hosts roots 前缀回退）透明分流，前端仅 provider 选择器变动。

**Tech Stack:** Node ESM, Express, cross-spawn, better-sqlite3, zod, WebSocket (ws), esbuild (lite bundle), @anthropic-ai/claude-agent-sdk, @openai/codex-sdk, React (web)。

---

## 总览（对应 spec §1–§5 与 "分阶段实施顺序"）

| 阶段 | 内容 | 任务 |
|---|---|---|
| Phase 0 | 协议 + lite fs 写面 + 主机路径路由 | T1–T5 |
| Phase 1 | 远程文件管理（main 路由分流 + 上传下载） | T6–T7 |
| Phase 2 | 远程 git（lite git/exec + 路由适配器 + worktrees） | T8–T12 |
| Phase 3 | 远程 providers（probe + session/start 泛化 + 4 runner 移植 + 安装校验） | T13–T17 |
| Phase 4 | 前端 provider 选择器过滤 | T18 |
| Phase 5 | 实机 E2E（172.26.167.52）+ 回归 | T19–T20 |

**基线要求（见 [[lovdex-backend-baseline-not-clean]]）：** backend 已有 pre-existing 的 tsc/lint 错误，验收标准是"零新增"。每阶段结束时跑 `typecheck` 与相关单测，记录新增错误数必须为 0。

---

## Phase 0 — 共享层

### Task 1: 协议扩展（protocol.ts）

**Files:**
- Modify: `backend/server/shared/agent-runtime/protocol.ts`

- [ ] **Step 1: 扩展 `AgentFrameIn` 的 hello 变体，携带 `providers` 探针结果（可选），并把 `decodeAgentFrameIn` 同步放行**

```ts
// protocol.ts — AgentFrameIn hello 变体增加可选 providers
export type RemoteProvider = 'claude' | 'codex' | 'opencode' | 'qoder';
export const REMOTE_PROVIDERS: readonly RemoteProvider[] = ['claude', 'codex', 'opencode', 'qoder'];

export type RemoteProviderProbe = {
  provider: RemoteProvider;
  installed: boolean;
  version: string | null;
};

export type RemoteHostProbe = {
  providers: RemoteProviderProbe[];
  gitInstalled: boolean;
  gitVersion: string | null;
  nodeVersion: string;
  os: string;
};

export type AgentFrameIn =
  | { type: 'hello'; hostId: string; agentVersion: string; nodeVersion: string; os: string; roots: string[]; capabilities: string[]; providers?: RemoteProviderProbe[] | null }
  | { type: 'rpc_res'; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'push'; topic: string; payload: unknown }
  | { type: 'pong'; at: number };
```

- [ ] **Step 2: `decodeAgentFrameIn` hello 分支放行并透传 `providers`**

```ts
    case 'hello': {
      const { hostId, agentVersion, nodeVersion, os } = f;
      if (
        typeof hostId !== 'string' ||
        typeof agentVersion !== 'string' ||
        typeof nodeVersion !== 'string' ||
        typeof os !== 'string'
      ) {
        return null;
      }
      if (!isStringArray(f.roots) || !isStringArray(f.capabilities)) return null;
      const providers = Array.isArray(f.providers)
        ? f.providers.filter(
            (p): boolean =>
              typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>).provider === 'string',
          )
        : undefined;
      return { type: 'hello', hostId, agentVersion, nodeVersion, os, roots: f.roots, capabilities: f.capabilities, ...(providers !== undefined ? { providers } : {}) };
    }
```

- [ ] **Step 3: 新增 RPC 参数 schema 导出**

```ts
// protocol.ts 末尾追加
export function makeFsWriteParamsSchema() {
  return z.object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
  });
}

export function makeFsCreateParamsSchema() {
  return z.object({
    parentPath: z.string().min(1),
    type: z.enum(['file', 'directory']),
    name: z.string().min(1),
  });
}

export function makeFsTreeParamsSchema() {
  return z.object({
    path: z.string().min(1),
    maxDepth: z.number().int().min(1).max(20).optional().default(10),
    showHidden: z.boolean().optional().default(true),
  });
}

export function makeFsDeleteParamsSchema() {
  return z.object({ path: z.string().min(1), type: z.enum(['file', 'directory']) });
}

export function makeGitExecParamsSchema() {
  return z.object({
    args: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1),
    identity: z.object({ name: z.string(), email: z.string() }).optional(),
    timeoutMs: z.number().int().positive().optional().default(300_000),
  });
}

export function makeProvidersProbeParamsSchema() {
  return z.object({ refresh: z.boolean().optional().default(false) });
}

export function makeSessionStartParamsSchema() {
  return z.object({
    appSessionId: z.string().min(1),
    providerSessionId: z.string().nullish().default(null),
    provider: z.enum(REMOTE_PROVIDERS).default('claude'),
    command: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    includePartialMessages: z.boolean().optional(),
    configEnv: z.record(z.string(), z.string()).default({}),
  });
}

export type GitExecResult = { stdout: string; stderr: string; exitCode: number };
```

- [ ] **Step 4: 跑现有测试确认协议未回归**

Run: `cd backend/remote-agent && npm test`
Expected: PASS（config/fs/agent-run/index tests）

- [ ] **Step 5: Commit**

```bash
git add backend/server/shared/agent-runtime/protocol.ts
git commit -m "feat(remote-agents): protocol schemas for remote fs write / git exec / provider probe"
```

---

### Task 2: main 端 RemoteFsClient 扩展写面 + tree

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-fs.service.ts`

- [ ] **Step 1: 扩展类型与写方法（含 32MB 上限常量）**

```ts
export const REMOTE_MAX_READ_BYTES = 32 * 1024 * 1024; // 32 MiB
export const REMOTE_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export type RemoteFileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink: boolean;
  children?: RemoteFileTreeNode[];
  [key: string]: unknown;
};

export type RemoteFsClient = {
  stat(hostId: string, pathText: string): Promise<RemoteStat>;
  list(hostId: string, pathText: string, maxEntries?: number): Promise<RemoteDirList>;
  read(hostId: string, pathText: string, maxBytes?: number, encoding?: 'utf8' | 'base64'): Promise<{ content: string; truncated: boolean }>;
  tree(hostId: string, pathText: string, maxDepth?: number, showHidden?: boolean): Promise<{ path: string; nodes: RemoteFileTreeNode[] }>;
  write(hostId: string, pathText: string, content: string, encoding?: 'utf8' | 'base64'): Promise<{ success: boolean; size: number }>;
  create(hostId: string, parentPath: string, type: 'file' | 'directory', name: string): Promise<{ success: boolean; path: string }>;
  rename(hostId: string, oldPath: string, newName: string): Promise<{ success: boolean; newPath: string }>;
  delete(hostId: string, pathText: string, type: 'file' | 'directory'): Promise<{ success: boolean }>;
};
```

- [ ] **Step 2: 实现各写方法**

```ts
export function createRemoteFsClient(getRegistry: () => RemoteAgentsRegistry): RemoteFsClient {
  const reg = () => getRegistry();
  return {
    stat: (h, p) => reg().rpc<RemoteStat>(h, 'fs/stat', { path: p }),
    list(h, p, maxEntries = 200) {
      return reg().rpc(h, 'fs/list', { path: p, maxEntries });
    },
    read(h, p, maxBytes = REMOTE_MAX_READ_BYTES, encoding = 'utf8') {
      return reg().rpc(h, 'fs/read', { path: p, maxBytes, encoding });
    },
    tree(h, p, maxDepth = 10, showHidden = true) {
      return reg().rpc(h, 'fs/tree', { path: p, maxDepth, showHidden });
    },
    write(h, p, content, encoding = 'utf8') {
      return reg().rpc(h, 'fs/write', { path: p, content, encoding }, 120_000);
    },
    create(h, parentPath, type, name) {
      return reg().rpc(h, 'fs/create', { parentPath, type, name });
    },
    rename(h, oldPath, newName) {
      return reg().rpc(h, 'fs/rename', { oldPath, newName });
    },
    delete(h, p, type) {
      return reg().rpc(h, 'fs/delete', { path: p, type });
    },
  };
}
```

- [ ] **Step 3: 单测（新增 `backend/server/modules/remote-agents/tests/remote-fs.service.test.ts`，mock registry）**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRemoteFsClient } from '../remote-fs.service.js';

function fakeRegistry(rpc: (h: string, m: string, p: unknown, t?: number) => Promise<unknown>) {
  return { rpc } as never;
}

test('fs client forwards fs/write with 120s timeout for base64 content', async () => {
  const calls: unknown[] = [];
  const client = createRemoteFsClient(() =>
    fakeRegistry(async (h, m, p, t) => {
      calls.push([h, m, p, t]);
      return { success: true, size: 4 };
    }),
  );
  const res = await client.write('h1', '/tmp/a.bin', Buffer.from([1, 2, 3, 4]).toString('base64'), 'base64');
  assert.equal(res.success, true);
  assert.equal(calls[0][0], 'h1');
  assert.equal(calls[0][1], 'fs/write');
  assert.equal((calls[0][2] as { encoding: string }).encoding, 'base64');
  assert.equal(calls[0][3], 120_000);
});
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-fs.service.test.ts`
Expected: 1 passing

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/remote-fs.service.ts backend/server/modules/remote-agents/tests/remote-fs.service.test.ts
git commit -m "feat(remote-agents): remote fs client write surface + tree + base64 read"
```

---

### Task 3: lite fs.ts 写面 + tree

**Files:**
- Modify: `backend/remote-agent/src/fs.ts`
- Test: `backend/remote-agent/src/tests/fs.test.ts`

- [ ] **Step 1: 新增 IGNORED_DIRS 常量与权限/树辅助**

```ts
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '.git', '.svn', '.hg', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
  'venv', '.venv', 'target', 'vendor', '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const MAX_TREE_NODES = 5000;

function formatPermissions(mode: number): { permissions: string; permissionsRwx: string } {
  const octal = (mode & 0o777).toString(8).padStart(3, '0');
  const parts = ['owner', 'group', 'other'].map((_u, idx) => {
    const shift = (2 - idx) * 3;
    return ['r', 'w', 'x'].map((b, j) => (mode & (1 << (shift + (2 - j))) ? b : '-')).join('');
  });
  return { permissions: octal, permissionsRwx: parts.join('') };
}
```

- [ ] **Step 2: 扩展 `AllowlistedFs` 类型与 `createAllowlistedFs` 返回值**

> ⚠️ 前置改动（T2 审查结论）：把 `fs.ts` 顶部的 `MAX_READ_BYTES_CAP` 从 16MiB 提到 **32MiB**，与 main 端 `REMOTE_MAX_READ_BYTES` 对齐，保证 16–32MB 文件的远程预览/下载不会因 lite 硬上限被提前截断（`Math.min(maxBytes, MAX_READ_BYTES_CAP)`，line ~50）。

```ts
export type AllowlistedFs = {
  stat(p: string): Promise<{ exists: boolean; isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number }>;
  list(p: string, maxEntries?: number): Promise<{ path: string; entries: RemoteDirEntry[] }>;
  read(p: string, maxBytes?: number, encoding?: 'utf8' | 'base64'): Promise<{ content: string; truncated: boolean }>;
  tree(p: string, maxDepth?: number, showHidden?: boolean): Promise<{ path: string; nodes: unknown[] }>;
  write(p: string, content: string, encoding?: 'utf8' | 'base64'): Promise<{ success: boolean; size: number }>;
  create(parentPath: string, type: 'file' | 'directory', name: string): Promise<{ success: boolean; path: string }>;
  rename(oldPath: string, newName: string): Promise<{ success: boolean; newPath: string }>;
  delete(p: string, type: 'file' | 'directory'): Promise<{ success: boolean }>;
};
```

实现（追加到 `createAllowlistedFs` 返回对象内）：

```ts
    async read(p, maxBytes = defaultMaxReadBytes, encoding: 'utf8' | 'base64' = 'utf8') {
      const target = resolveWithinRoots(p, roots);
      const limit = Math.min(maxBytes, MAX_READ_BYTES_CAP);
      const handle = await fsp.open(target, 'r');
      try {
        const s = await handle.stat();
        const toRead = Math.min(s.size, limit);
        const buf = Buffer.alloc(toRead);
        if (toRead > 0) await handle.read(buf, 0, toRead, 0);
        return { content: encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'), truncated: s.size > limit };
      } finally {
        await handle.close();
      }
    },

    async tree(p, maxDepth = 10, showHidden = true) {
      const target = resolveWithinRoots(p, roots);
      let count = 0;
      async function walk(dir: string, depth: number): Promise<unknown[]> {
        if (depth > maxDepth) return [];
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        const out: unknown[] = [];
        for (const d of dirents) {
          if (count >= MAX_TREE_NODES) throw new Error('FILE_TREE_TOO_LARGE');
          if (!showHidden && d.name.startsWith('.')) continue;
          if (d.isDirectory() && IGNORED_DIRS.has(d.name)) continue;
          count += 1;
          const full = path.join(dir, d.name);
          const st = await fsp.lstat(full);
          let isDir = st.isDirectory();
          let isSymlink = st.isSymbolicLink();
          let size = st.size;
          let mtimeMs = st.mtimeMs;
          let mode = st.mode;
          if (isSymlink) {
            try {
              const t = await fsp.stat(full);
              isDir = t.isDirectory();
              size = t.size;
              mtimeMs = t.mtimeMs;
              mode = t.mode;
            } catch {
              // dangling symlink: keep lstat values
            }
          }
          const { permissions, permissionsRwx } = formatPermissions(mode);
          const node: Record<string, unknown> = {
            name: d.name,
            path: full,
            type: isDir ? 'directory' : 'file',
            size,
            modified: new Date(mtimeMs).toISOString(),
            permissions,
            permissionsRwx,
            isSymlink,
          };
          if (isDir && depth < maxDepth) {
            node.children = await walk(full, depth + 1);
          }
          out.push(node);
        }
        out.sort((a, b) => {
          const A = a as Record<string, unknown>;
          const B = b as Record<string, unknown>;
          if (A.type === 'directory' && B.type !== 'directory') return -1;
          if (A.type !== 'directory' && B.type === 'directory') return 1;
          return String(A.name).localeCompare(String(B.name));
        });
        return out;
      }
      return { path: target, nodes: await walk(target, 0) };
    },

    async write(p, content, encoding: 'utf8' | 'base64' = 'utf8') {
      const target = resolveWithinRoots(p, roots);
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      await fsp.writeFile(target, buf);
      return { success: true, size: buf.length };
    },

    async create(parentPath, type, name) {
      const parent = resolveWithinRoots(parentPath, roots);
      const target = path.join(parent, name);
      const canonical = resolveWithinRoots(target, roots);
      if (canonical !== path.resolve(target)) throw new Error('invalid target name');
      try {
        await fsp.access(canonical);
        throw Object.assign(new Error(`${type === 'file' ? 'File' : 'Directory'} already exists`), { code: 'EEXIST' });
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') throw err;
      }
      if (type === 'directory') await fsp.mkdir(canonical, { recursive: false });
      else {
        await fsp.mkdir(path.dirname(canonical), { recursive: true });
        await fsp.writeFile(canonical, Buffer.alloc(0));
      }
      return { success: true, path: canonical };
    },

    async rename(oldPath, newName) {
      const oldTarget = resolveWithinRoots(oldPath, roots);
      const newTarget = resolveWithinRoots(path.join(path.dirname(oldTarget), newName), roots);
      try {
        await fsp.access(newTarget);
        throw Object.assign(new Error('A file or directory with this name already exists'), { code: 'EEXIST' });
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') throw err;
      }
      await fsp.rename(oldTarget, newTarget);
      return { success: true, newPath: newTarget };
    },

    async delete(p, type) {
      const target = resolveWithinRoots(p, roots);
      for (const root of roots) {
        const resolvedRoot = resolveRealPath(root);
        if (path.resolve(target) === resolvedRoot) throw new Error('cannot delete root');
      }
      if (type === 'directory') await fsp.rm(target, { recursive: true, force: false });
      else await fsp.unlink(target);
      return { success: true };
    },
```

- [ ] **Step 3: 写测试（追加到 `backend/remote-agent/src/tests/fs.test.ts` 或新建 `fs-write.test.ts`）**

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createAllowlistedFs } from '../fs.js';

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lovdex-fs-'));
  return dir;
}

test('write + read round-trip with base64', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  const target = path.join(root, 'a.bin');
  const data = Buffer.from([0, 1, 2, 250]);
  const w = await fsApi.write(target, data.toString('base64'), 'base64');
  assert.equal(w.size, data.length);
  const r = await fsApi.read(target, 1000, 'base64');
  assert.equal(Buffer.from(r.content, 'base64').equals(data), true);
  rmSync(root, { recursive: true, force: true });
});

test('create conflict rejects with EEXIST-like error', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  await fsApi.create(root, 'file', 'x.txt');
  await assert.rejects(() => fsApi.create(root, 'file', 'x.txt'), /already exists/);
  rmSync(root, { recursive: true, force: true });
});

test('tree skips node_modules and reports directory/file types', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'a.ts'), 'x');
  const { nodes } = await fsApi.tree(root, 1, true);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'a.ts');
  assert.equal(nodes[0].type, 'file');
  rmSync(root, { recursive: true, force: true });
});

test('path escape outside roots rejected on write', async () => {
  const root = makeRoot();
  const fsApi = createAllowlistedFs({ roots: [root] });
  await assert.rejects(() => fsApi.write('/etc/passwd', 'x'), /outside allowed root/);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 4: 跑测试**

Run: `cd backend/remote-agent && npm test`
Expected: 现有 + 新增全 PASS

- [ ] **Step 5: Commit**

```bash
git add backend/remote-agent/src/fs.ts backend/remote-agent/src/tests/fs-write.test.ts
git commit -m "feat(remote-agent-lite): allowlisted fs write surface + tree"
```

---

### Task 4: lite rpc-dispatch 接入 fs 写面 + git/exec + providers/probe + 能力上报

**Files:**
- Modify: `backend/remote-agent/src/rpc-dispatch.ts`
- Create: `backend/remote-agent/src/git.ts`
- Create: `backend/remote-agent/src/probe.ts`

- [ ] **Step 1: 新建 `probe.ts` —— 探测 4 provider CLI + git/node**

```ts
import { execFile } from 'node:child_process';

import type { RemoteHostProbe, RemoteProvider, RemoteProviderProbe } from '../../server/shared/agent-runtime/protocol.js';

const PROVIDER_BIN: Record<RemoteProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  qoder: 'qodercli',
};

function runVersion(bin: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, out: '' });
      resolve({ ok: true, out: String(stdout || stderr).trim().split('\n')[0] ?? '' });
    });
  });
}

export async function probeRemoteHost(): Promise<RemoteHostProbe> {
  const entries = await Promise.all(
    (Object.entries(PROVIDER_BIN) as [RemoteProvider, string][]).map(async ([provider, bin]) => {
      const r = await runVersion(bin);
      const probe: RemoteProviderProbe = { provider, installed: r.ok, version: r.ok ? r.out : null };
      return probe;
    }),
  );
  const git = await runVersion('git');
  return {
    providers: entries,
    gitInstalled: git.ok,
    gitVersion: git.ok ? git.out : null,
    nodeVersion: process.version,
    os: `${process.platform} ${process.arch}`,
  };
}
```

- [ ] **Step 2: 新建 `git.ts` —— roots 白名单内的 `git/exec` 服务，支持 AbortSignal**

```ts
import { spawn } from 'node:child_process';

import { resolveWithinRoots } from './fs.js';

export type GitExecRequest = {
  args: string[];
  cwd: string;
  identity?: { name: string; email: string };
  timeoutMs?: number;
};

export type GitExecResult = { stdout: string; stderr: string; exitCode: number };

/** 禁止的 git 重定向选项：防止 -C / --git-dir / --work-tree 把操作引到 roots 之外。 */
const BLOCKED_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--exec-path']);

export function createGitService(deps: { roots: string[] }) {
  return {
    async exec(req: GitExecRequest, signal?: AbortSignal): Promise<GitExecResult> {
      const cwd = resolveWithinRoots(req.cwd, deps.roots);
      for (const arg of req.args) {
        if (arg.includes('\0')) throw new Error('git arg contains NUL');
        const name = arg.split('=', 1)[0];
        if (BLOCKED_OPTIONS.has(name)) throw new Error('git option not allowed: ' + arg);
      }
      const identityArgs: string[] = [];
      if (req.identity) {
        identityArgs.push('-c', `user.name=${req.identity.name}`, '-c', `user.email=${req.identity.email}`);
      }
      return new Promise<GitExecResult>((resolve, reject) => {
        const child = spawn('git', [...identityArgs, ...req.args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
        }, req.timeoutMs ?? 300_000);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            child.kill('SIGKILL');
          }, { once: true });
        }
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
      });
    },
  };
}
```

- [ ] **Step 3: `rpc-dispatch.ts` 接线新方法 + `providers/probe`，并把 capabilities 由硬编码改为探测结果**

```ts
// rpc-dispatch.ts 顶部
import { makeGitExecParamsSchema, makeSessionStartParamsSchema } from '../../server/shared/agent-runtime/protocol.js';
import { createGitService } from './git.js';
import { probeRemoteHost } from './probe.js';

export function makeProbeAccessor() {
  return { probe: probeRemoteHost };
}
```

在 `handleRpc` 内新增分支：

```ts
  if (method === 'fs/write' || method === 'fs/create' || method === 'fs/rename' || method === 'fs/delete' || method === 'fs/tree') {
    const fsApi = allowlistedFsFor(cfg);
    if (method === 'fs/write') {
      const p = params as { path: string; content: string; encoding?: 'utf8' | 'base64' };
      return fsApi.write(p.path, p.content, p.encoding ?? 'utf8');
    }
    if (method === 'fs/tree') {
      const p = params as { path: string; maxDepth?: number; showHidden?: boolean };
      return fsApi.tree(p.path, p.maxDepth, p.showHidden);
    }
    if (method === 'fs/create') {
      const p = params as { parentPath: string; type: 'file' | 'directory'; name: string };
      return fsApi.create(p.parentPath, p.type, p.name);
    }
    if (method === 'fs/rename') {
      const p = params as { oldPath: string; newName: string };
      return fsApi.rename(p.oldPath, p.newName);
    }
    const p = params as { path: string; type: 'file' | 'directory' };
    return fsApi.delete(p.path, p.type);
  }
  if (method === 'git/exec') {
    const req = makeGitExecParamsSchema().parse(params);
    return createGitService({ roots: cfg.roots }).exec(req, controller?.signal);
  }
  if (method === 'providers/probe') {
    return probeRemoteHost();
  }
```

> `rpcSignal` 是新的第四参（`AbortController`，即 index.ts 为本 `rpc_req` 建的控制器，见本 Task Step 4）。在这一步先把 `handleRpc(method, params, cfg, controller?: AbortController)` 签名调整好，git/exec 分支用 `controller?.signal`。

同时更新 `fs/read` 分支以支持 encoding：

```ts
    const p = params as { path: string; maxBytes?: number; encoding?: 'utf8' | 'base64' };
    return fsApi.read(p.path, p.maxBytes, p.encoding ?? 'utf8');
```

- [ ] **Step 4: index.ts 接线 `rpc_cancel`（lite 侧收口）**

`backend/remote-agent/src/index.ts` 的 `handleIncomingFrame` 增加按 `rpc_req.id` 跟踪的 AbortController，并处理 `rpc_cancel`：

```ts
const inflight = new Map<string, AbortController>();

export async function handleIncomingFrame(
  ws: WsLike,
  frame: unknown,
  cfg: RemoteAgentConfig,
): Promise<void> {
  if (typeof frame !== 'object' || frame === null) return;
  const f = frame as Record<string, unknown>;

  if (f.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    return;
  }

  if (f.type === 'rpc_cancel' && typeof f.id === 'string') {
    inflight.get(f.id)?.abort();
    return;
  }

  if (f.type === 'rpc_req' && typeof f.id === 'string' && typeof f.method === 'string') {
    const id = f.id;
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const data = await handleRpc(f.method, f.params, cfg, controller);
      ws.send(JSON.stringify({ type: 'rpc_res', id, ok: true, data }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'rpc_res', id, ok: false, error }));
    } finally {
      inflight.delete(id);
    }
    return;
  }
}
```

`handleRpc` 签名改为 `(method, params, cfg, controller?: AbortController)`；`git/exec` 分支改传 `controller?.signal`。

- [ ] **Step 5: 单测（`git.test.ts` 与 `probe.test.ts`）**

```ts
// git.test.ts
import assert from 'node:assert/strict';
import { execSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createGitService } from '../git.js';

test('git/exec runs git status inside roots', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email t@t && git config user.name T', { cwd: root });
  execSync('echo hi > a.txt', { cwd: root });
  const svc = createGitService({ roots: [root] });
  const res = await svc.exec({ args: ['status', '--porcelain'], cwd: root });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /a\.txt/);
  rmSync(root, { recursive: true, force: true });
});

test('git/exec rejects blocked options', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  const svc = createGitService({ roots: [root] });
  await assert.rejects(() => svc.exec({ args: ['--git-dir=/etc'], cwd: root }), /not allowed/);
  rmSync(root, { recursive: true, force: true });
});

test('git/exec rejects cwd outside roots', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lovdex-git-'));
  const svc = createGitService({ roots: [root] });
  await assert.rejects(() => svc.exec({ args: ['status'], cwd: '/etc' }), /outside allowed root/);
  rmSync(root, { recursive: true, force: true });
});
```

```ts
// probe.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeRemoteHost } from '../probe.js';

test('probe reports installed status per provider and git', async () => {
  const result = await probeRemoteHost();
  assert.ok(result.providers.length === 4);
  assert.equal(result.providers.filter((p) => p.provider === 'claude').length, 1);
  assert.equal(typeof result.gitInstalled, 'boolean');
  assert.equal(typeof result.nodeVersion, 'string');
});
```

- [ ] **Step 6: 跑测试**

Run: `cd backend/remote-agent && npm test`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add backend/remote-agent/src/rpc-dispatch.ts backend/remote-agent/src/git.ts backend/remote-agent/src/probe.ts backend/remote-agent/src/tests/git.test.ts backend/remote-agent/src/tests/probe.test.ts
git commit -m "feat(remote-agent-lite): git/exec + providers/probe + fs write rpc wiring"
```

---

### Task 5: main 端 rpc_cancel 接线 + `lookupHostForPath`

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-agent.server.ts`
- Modify: `backend/server/modules/remote-agents/remote-agents.registry.ts`
- Modify: `backend/server/modules/remote-agents/remote-projects.index.ts`
- Modify: `backend/server/modules/remote-agents/remote-agent.server.ts`（hello 缓存 providers → registry）

- [ ] **Step 1: registry 增加 `cancelRpc(id)` 与 host 列表访问，以及 providers 缓存**

```ts
// remote-agents.registry.ts return 对象内追加
    list(): { hostId: string; roots: string[] }[] {
      return Array.from(connections.values()).map((c) => ({
        hostId: c.registration.hostId,
        roots: c.registration.roots,
      }));
    },
    cancelRpc(id: string): void {
      const entry = pending.get(id);
      if (!entry) return;
      const conn = connections.get(entry.hostId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify({ type: 'rpc_cancel', id }));
        } catch {
          /* socket mid-close */
        }
      }
    },
    setHostProviders(hostId: string, providers: unknown[] | null): void {
      hostProviders.set(hostId, providers ?? []);
    },
    getHostProviders(hostId: string): unknown[] | undefined {
      return hostProviders.get(hostId);
    },
```

并在模块顶部加 `const hostProviders = new Map<string, unknown[]>();`

同时给 `rpc()` 增加可选 `signal`：

```ts
    rpc<T = unknown>(hostId: string, method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
      // ... 现有 body，在 connection.ws.send 之后：
      if (signal) {
        signal.addEventListener('abort', () => {
          if (pending.has(id)) {
            clearTimeout(entry.timer);
            pending.delete(id);
            reject(new Error(`remote rpc aborted: ${method}`));
            // 通知 lite 侧停掉正在跑的 git 命令
            try {
              connection.ws.send(JSON.stringify({ type: 'rpc_cancel', id }));
            } catch { /* ignore */ }
          }
        }, { once: true });
      }
```

> `rpc` 返回的 Promise 里 `reject` 已作为 `entry.reject` 捕获；上面的 reject 直接调用即可。为避免与 `resolveRpc` 重复 settle，先 `pending.delete(id)` 再 reject（与 timeout 分支一致）。

- [ ] **Step 2: remote-agent.server.ts 处理 hello 携带的 providers，注入 registry**

```ts
// createRemoteAgentConnectionHandler 的 hello 分支内
registry.register({ hostId: f.hostId, roots: f.roots, capabilities: f.capabilities }, ws);
if (f.providers) registry.setHostProviders(f.hostId, f.providers);
```

- [ ] **Step 3: `remote-projects.index.ts` 增加 `setOnlineHostsLookup` + `lookupHostForPath`**

```ts
let hostsLookup: (() => { hostId: string; roots: string[] }[]) | null = null;

export function setOnlineHostsLookup(fn: () => { hostId: string; roots: string[] }[] | null): void {
  hostsLookup = fn;
}

/**
 * 解析一个绝对路径归属的远程 host。先精确匹配项目路径表；再按在线 host 的
 * roots 最长前缀回退（覆盖 worktree 等项目路径之外的远程路径）。无匹配 → null。
 */
export function lookupHostForPath(absPath: string | undefined): string | null {
  if (!absPath) return null;
  const exact = projectPathToHostId.get(absPath);
  if (exact) return exact;
  if (!hostsLookup) return null;
  const hosts = hostsLookup();
  if (!hosts) return null;
  let bestHost: string | null = null;
  let bestLen = 0;
  for (const h of hosts) {
    for (const root of h.roots) {
      const prefix = root.endsWith('/') ? root : root + '/';
      const rootExact = root.endsWith('/') ? root : root + '/';
      if (absPath === root || (absPath.startsWith(prefix) && rootExact.length > bestLen)) {
        bestHost = h.hostId;
        bestLen = rootExact.length;
      }
    }
  }
  return bestHost;
}
```

> 上面 `prefix`/`rootExact` 重复，保留一个即可；以 `absPath === root || absPath.startsWith(root + '/')` 判定。

- [ ] **Step 4: index.js 注入 hostsLookup（`setOnlineHostsLookup`）**

在现有 `setRemoteAgentsRuntime({ registry, fsClient })` 附近追加：

```js
import { setOnlineHostsLookup, lookupRemoteHost } from './modules/remote-agents/remote-projects.index.js';
// 改这行 import 为包含 setOnlineHostsLookup
setOnlineHostsLookup(() => remoteAgentsRegistry.list());
```

- [ ] **Step 5: 跑 server 相关测试（registry/isOnline 等）**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-agents.registry.test.ts server/modules/remote-agents/tests/remote-projects.index.test.ts 2>/dev/null || echo "registry/index tests not present; run typecheck instead"`
Run: `cd backend && npm run typecheck` — 记录错误数与改动前 baseline 比较，**不得新增**。

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/remote-agents/remote-agents.registry.ts backend/server/modules/remote-agents/remote-projects.index.ts backend/server/index.js backend/server/modules/remote-agents/remote-agent.server.ts
git commit -m "feat(remote-agents): host-aware path routing + rpc_cancel + hello providers cache"
```

---

## Phase 1 — 远程文件管理

### Task 6: main 文件端点分支（树/读/写/建/改名/删）

**Files:**
- Modify: `backend/server/index.js`（文件端点区，约 728–1120 行）+ 拓宽 `fs/read` 调用

- [ ] **Step 1: 引入 `lookupRemoteHost` 并在各文件端点开头解析 hostId**

每个端点模式（以 GET `/api/projects/:projectId/file` 为例）：

```js
// GET /api/projects/:projectId/file
    const projectRoot = await projectsDb.getProjectPathById(projectId);
    if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) return res.status(403).json({ error: 'Path must be under project root' });

    const hostId = lookupRemoteHost(projectRoot);
    if (hostId) {
      const remote = await fsClient.read(hostId, resolved);
      return res.json({ content: remote.content, path: resolved });
    }

    const content = await fsPromises.readFile(resolved, 'utf8');
    res.json({ content, path: resolved });
```

> `fsClient` 在 index.js 中已是 `createRemoteFsClient` 的产物（`setRemoteAgentsRuntime({ registry, fsClient })`），直接用运行时导出，或 import runtime seam。请确认 index.js 当前通过 `getRemoteAgentsRuntime()` 访问；若没有直接可用的 `fsClient` 引用，在文件端点区顶部加：

```js
import { getRemoteAgentsRuntime } from './modules/remote-agents/runtime.js';
// 每个远程分支改为
const { fsClient } = getRemoteAgentsRuntime();
```

- [ ] **Step 2: 逐个端点接入分支**

| 端点 | 远程分支 |
|---|---|
| `GET /files` | `const { nodes } = await fsClient.tree(hostId, actualPath, 10, true); res.json(nodes);` |
| `GET /file` | `const r = await fsClient.read(hostId, resolved); res.json({ content: r.content, path: resolved });` |
| `PUT /file` | `await fsClient.write(hostId, resolved, content); res.json({ success: true, path: resolved, message: 'File saved successfully' });` |
| `POST /files/create` | `await fsClient.create(hostId, parentPath || projectRoot, type, name);` 其后 `res.json({ success: true, path: resolvedPath, name, type, message: ... })` |
| `PUT /files/rename` | `const r = await fsClient.rename(hostId, resolvedOldPath, newName); res.json({ success: true, oldPath: resolvedOldPath, newPath: r.newPath, newName, message: 'Renamed successfully' });` |
| `DELETE /files` | `await fsClient.delete(hostId, /* 需把全文 targetPath 与 type 的解析保留 */ targetResolved, type); res.json({ success: true, path: targetResolved, type, message: ... });` |

> DELETE `/files` 端点在 1107 行起，先用 `validatePathInProject` 得到 `resolvedTarget` 再做远程删除；禁止删除 project root 的校验保持不变（RPC 侧也防重）。

- [ ] **Step 3: 维持错误映射**

远程 RPC 抛出的错误信息需与本地 catch 分支兼容：对 `fsClient.read` 返回 `{ truncated }` 不截断提示——直接透传 content（上限即 32MB）。对 `fs/write` 的 ENOENT/EACCES，RPC 错误 message 以 lite `fsp` 抛出的 message 为准，前端把 `res.status(500)` 显示出来即可；如需精确状态码，在 catch 中对 `error.message.includes('ENOENT')` 做映射（同现有 `error.code` 分支）。

- [ ] **Step 4: typecheck + 手动冒烟（本地项目不能回归）**

Run: `cd backend && npm run typecheck`
Expected: 与 baseline 相比零新增错误；本地项目文件读写测试通过（可运行既有 git.routes / sessions 相关测试）。

- [ ] **Step 5: Commit**

```bash
git add backend/server/index.js
git commit -m "feat(web): route project file endpoints to remote host via RPC"
```

---

### Task 7: 远程上传 / 二进制读取（图片预览、下载）

**Files:**
- Modify: `backend/server/index.js`（`/files/content`、`/files/upload`）

- [ ] **Step 1: `GET /files/content` 远程分支（base64 → Buffer → 流式响应）**

```js
    const hostId = lookupRemoteHost(projectRoot);
    if (hostId) {
      let remote;
      try {
        remote = await fsClient.read(hostId, resolved, REMOTE_MAX_READ_BYTES, 'base64');
      } catch (e) {
        return res.status(404).json({ error: 'File not found' });
      }
      if (remote.truncated) {
        return res.status(413).json({ error: 'File too large to preview/download remotely (limit 32MB)' });
      }
      const mimeType = mime.lookup(resolved) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      return res.end(Buffer.from(remote.content, 'base64'));
    }
```

> `REMOTE_MAX_READ_BYTES` 从 `remote-fs.service.js` 导出导入。原有的本地 `fs.createReadStream` 分支保持不变。

- [ ] **Step 2: `POST /files/upload` 远程分支**

在 multipart 处理拿到 `files[]` 之后、本地落盘逻辑之前插入：

```js
    const hostId = lookupRemoteHost(projectRoot);
    if (hostId) {
      const uploaded = [];
      for (const file of files) {
        const buf = file.buffer ?? Buffer.from(file.data);
        if (buf.length > REMOTE_MAX_UPLOAD_BYTES) {
          return res.status(413).json({ error: `File ${file.originalname} exceeds 32MB remote upload limit` });
        }
        const rel = file.relativePath || file.originalname;
        const abs = path.join(targetPath || projectRoot, rel);
        const v = validatePathInProject(projectRoot, abs);
        if (!v.valid) return res.status(403).json({ error: v.error });
        await fsClient.write(hostId, v.resolved, buf.toString('base64'), 'base64');
        uploaded.push({ name: file.originalname, path: v.resolved, size: buf.length, mimeType: (file.mimetype || '').toString() });
      }
      return res.json({
        success: true,
        files: uploaded,
        uploadedCount: uploaded.length,
        requestedFileCount: Number(req.body.requestedFileCount ?? uploaded.length),
        targetPath: path.join(targetPath || projectRoot),
        message: 'Upload completed successfully',
      });
    }
```

> 注意上传 body 里的 `targetPath` / `relativePaths`（JSON 字符串数组）字段在 remote 分支同样解析：`relativePaths` 决定 `file.relativePath`；`targetPath` 为根。确保与本地分支处理一致后再进入远程落盘。

- [ ] **Step 3: 前端无改动，验证 web 现有 `readFileBlob`/`uploadFiles` 的返回形状**

前端 `web/src/utils/api.js` 的 `createFile/renameFile/deleteFile/uploadFiles` 与 `/files/content` blob 下载依赖的响应字段：`success/files/uploadedCount`、blob。上面远程返回已对齐。图片预览走 `files/content`，无需改。

- [ ] **Step 4: 手动 E2E（本机起 dev 冒烟 + 远程冒烟见 Phase 5）**

Run: `cd backend/remote-agent && npm test` —— lite fs 写面测试确保 base64 write/read 正确
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/server/index.js
git commit -m "feat(web): remote file upload + binary preview/download over RPC"
```

---

## Phase 2 — 远程源码管理

### Task 8: main 端 RemoteGitClient

**Files:**
- Create: `backend/server/modules/remote-agents/remote-git.service.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-git.service.test.ts`

- [ ] **Step 1: 实现 RemoteGitClient（含 identity 注入与长超时）**

```ts
import { makeGitExecParamsSchema, type GitExecResult } from '@/shared/agent-runtime/protocol.js';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

export type GitIdentity = { name: string; email: string } | null;

export type RemoteGitClient = {
  exec(
    hostId: string,
    args: string[],
    opts: { cwd: string; identity?: GitIdentity; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GitExecResult>;
};

export function createRemoteGitClient(getRegistry: () => RemoteAgentsRegistry): RemoteGitClient {
  const reg = () => getRegistry();
  return {
    exec(hostId, args, opts) {
      const params = makeGitExecParamsSchema().parse({
        args,
        cwd: opts.cwd,
        ...(opts.identity ? { identity: opts.identity } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return reg().rpc<GitExecResult>(hostId, 'git/exec', params, opts.timeoutMs ?? 300_000, opts.signal);
    },
  };
}
```

- [ ] **Step 2: 本地 git 身份读取（供 identity 注入）**

```ts
import { execFileSync } from 'node:child_process';

export function readLocalGitIdentity(): GitIdentity {
  const get = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const name = get('user.name');
  const email = get('user.email');
  return name && email ? { name, email } : null;
}
```

> 若本地仅配置了 name 或 email 之一，返回对应单值也可；为简化 v1：两者齐备才注入，缺任一则不注入（远程用自己的全局 git config）。

- [ ] **Step 3: 单测**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRemoteGitClient } from '../remote-git.service.js';

test('exec forwards args + identity to git/exec', async () => {
  let received: unknown = null;
  const reg = {
    rpc: async (_h: string, m: string, p: unknown, t?: number, s?: AbortSignal) => {
      if (m === 'git/exec') { received = { p, t, s }; return { stdout: 'ok', stderr: '', exitCode: 0 }; }
      throw new Error('unexpected');
    },
  };
  const client = createRemoteGitClient(() => reg as never);
  const res = await client.exec('h1', ['status'], { cwd: '/home/u/p', identity: { name: 'A', email: 'a@b' } });
  assert.equal(res.stdout, 'ok');
  const pr = received as unknown as { p: { identity: { name: string }; args: string[] }; t: number };
  assert.equal(pr.p.identity.name, 'A');
  assert.equal(pr.p.args[0], 'status');
  assert.equal(pr.t, 300_000);
});

test('exec omits identity when null', async () => {
  let received: unknown = null;
  const reg = {
    rpc: async (_h: string, _m: string, p: unknown) => { received = p; return { stdout: '', stderr: '', exitCode: 0 }; },
  };
  const client = createRemoteGitClient(() => reg as never);
  await client.exec('h1', ['rev-parse', '--is-inside-work-tree'], { cwd: '/x' });
  assert.ok(!(received as { identity?: unknown }).identity);
});
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-git.service.test.ts`
Expected: 2 passing

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/remote-git.service.ts backend/server/modules/remote-agents/tests/remote-git.service.test.ts
git commit -m "feat(remote-agents): remote git client with identity + long timeout"
```

---

### Task 9: 远程感知的 spawn + fs 适配器（git.routes 换血点）

**Files:**
- Create: `backend/server/modules/remote-agents/remote-adapters.ts`
- Modify: `backend/server/modules/git/git.module.ts`

- [ ] **Step 1: 实现两个适配器（child-shim spawn + fs）**

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Stats } from 'node:fs';

import type { RemoteFsClient, RemoteFileTreeNode } from './remote-fs.service.js';
import type { RemoteGitClient, GitIdentity } from './remote-git.service.js';

type LookupHost = (path: string | undefined) => string | null;

/**
 * 让 git.routes 的 `spawn('git', args, { cwd })` 对远程 cwd 变为一次 git/exec RPC。
 * 返回兼容 cross-spawn child 的最小 EventEmitter，stdout/stderr 用 PassThrough，
 * 数据在 RPC 返回后再流式写入——而 routes 的 spawnAsync 先注册 data 监听再等流。
 */
export function createRemoteAwareSpawn(opts: {
  localSpawn: (cmd: string, args: string[], options: unknown) => unknown;
  remoteGit: RemoteGitClient;
  lookupHost: LookupHost;
  identity: GitIdentity;
}) {
  return function wrappedSpawn(command: string, args: string[], options: { cwd?: string }): unknown {
    const local = opts.localSpawn(command, args, options);
    if (command !== 'git' || !options.cwd) return local;
    const hostId = opts.lookupHost(options.cwd);
    if (!hostId) return local;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void; pid: number };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.pid = -1;
    opts.remoteGit
      .exec(hostId, args, { cwd: options.cwd, identity: opts.identity })
      .then((res) => {
        if (res.stdout) child.stdout.write(res.stdout);
        child.stdout.end();
        if (res.stderr) child.stderr.write(res.stderr);
        child.stderr.end();
        if (res.exitCode !== 0) {
          const err = new Error(`Command failed: git ${args.join(' ')}`) as Error & { code: number; stdout: string; stderr: string };
          err.code = res.exitCode;
          err.stdout = res.stdout;
          err.stderr = res.stderr;
        }
        child.emit('close', res.exitCode);
      })
      .catch((err: unknown) => {
        // transport failure — mirror cross-spawn 'error' then 'close'
        const e = err instanceof Error ? err : new Error(String(err));
        child.emit('error', e);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1);
      });
    return child;
  };
}

/** fs 兼容 shim：routes 只用 isDirectory()/isFile()/size/mtimeMs。 */
function toStatsLike(remote: { exists: boolean; isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number }): Stats {
  return {
    isDirectory: () => remote.isDirectory,
    isFile: () => remote.isFile,
    size: remote.size,
    mtimeMs: remote.mtimeMs,
  } as unknown as Stats;
}

/** 让 routes 的 `fs.*` 对远程路径走 RPC；本地路径透传 localFs。 */
export function createRemoteAwareFileSystem(opts: {
  localFs: typeof import('node:fs/promises');
  remoteFs: RemoteFsClient;
  lookupHost: LookupHost;
}) {
  const { remoteFs } = opts;
  const proxy: Record<string, (...a: never[]) => Promise<unknown>> = {};
  const wrapPath = (name: string, fn: (hostId: string, p: string, ...rest: unknown[]) => Promise<unknown>) => {
    proxy[name] = (async (...args: unknown[]) => {
      const p = args[0] as string;
      const hostId = opts.lookupHost(p);
      if (!hostId) return (opts.localFs as Record<string, (...a: unknown[]) => unknown>)[name](...args);
      return fn(hostId, p, ...args.slice(1));
    }) as (...a: never[]) => Promise<unknown>;
  };

  wrapPath('access', async (hostId, p) => {
    const s = await remoteFs.stat(hostId, p);
    if (!s.exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  wrapPath('stat', async (hostId, p) => toStatsLike(await remoteFs.stat(hostId, p)));
  wrapPath('readFile', async (hostId, p, enc?: string) => {
    const r = await remoteFs.read(hostId, p, 32 * 1024 * 1024, enc === 'base64' ? 'base64' : 'utf8');
    if (r.truncated) throw Object.assign(new Error('file too large'), { code: 'ETOOBIG' });
    return enc === 'base64' ? r.content : r.content;
  });
  wrapPath('rm', async (hostId, p, opts2?: { recursive?: boolean }) => {
    const s = await remoteFs.stat(hostId, p);
    return remoteFs.delete(hostId, p, s.isDirectory ? 'directory' : 'file');
  });
  wrapPath('unlink', async (hostId, p) => remoteFs.delete(hostId, p, 'file'));

  return proxy as typeof import('node:fs/promises');
}
```

> 注意 `readFile` 的返回值在 routes 中用于 `fileContent.split('\n')`，utf8 即可；`fs.readFile(filePath, 'utf-8')` 传入的 enc 是 `'utf-8'`，我们的分支只在 `enc === 'base64'` 时走 base64。

- [ ] **Step 2: git.module.ts 接入适配器**

```ts
import * as fs from 'node:fs/promises';
import spawn from 'cross-spawn';
import { projectsDb } from '@/modules/database/index.js';
import { createRemoteAwareFileSystem, createRemoteAwareSpawn } from '@/modules/remote-agents/remote-adapters.js';
import { createRemoteGitClient } from '@/modules/remote-agents/remote-git.service.js';
import { lookupHostForPath } from '@/modules/remote-agents/remote-projects.index.js';
import { getRemoteAgentsRuntime } from '@/modules/remote-agents/runtime.js';
import { readLocalGitIdentity } from '@/modules/remote-agents/remote-git.service.js';
import { createGitRouter } from './git.routes.js';

export function createGitModule() {
  const { registry } = getRemoteAgentsRuntime();
  const remoteGit = createRemoteGitClient(() => registry);
  const remoteFs = getRemoteAgentsRuntime().fsClient;
  return createGitRouter({
    fileSystem: createRemoteAwareFileSystem({ localFs: fs, remoteFs, lookupHost: lookupHostForPath }),
    spawnProcess: createRemoteAwareSpawn({ localSpawn: spawn, remoteGit, lookupHost: lookupHostForPath, identity: readLocalGitIdentity() }) as never,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  });
}
```

> `getRemoteAgentsRuntime()` 在 boot 之前会 throw "remote agents runtime not configured"——而 git 路由的挂载发生在应用初始化期。检查 index.js 中 `setRemoteAgentsRuntime` 与 `app.use('/api/git')` 的先后顺序；若 `createGitModule` 在建路由时即调用 runtime，则改为惰性：`const lateReg = () => getRemoteAgentsRuntime().registry; const remoteGit = createRemoteGitClient(lateReg);` 将 `createRemoteGitClient` / `createRemoteAwareXxx` 的取值推迟到请求时。远程适配器已设计为运行时取 `lookupHost` / `registry`——在 Task 9 Step 2 中确保 `createGitModule` 不立即调用 runtime，而是把 thunk 存下去、首次 git 请求时才解析。

- [ ] **Step 3: 单测（`backend/server/modules/remote-agents/tests/remote-adapters.test.ts`）**

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createRemoteAwareSpawn, createRemoteAwareFileSystem } from '../remote-adapters.js';

test('remote-aware spawn routes git cwd on a host to RPC', async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const remoteGit = {
    exec: async (_h: string, args: string[], o: { cwd: string }) => {
      calls.push({ args, cwd: o.cwd });
      return { stdout: 'x', stderr: '', exitCode: 0 };
    },
  };
  const spawner = createRemoteAwareSpawn({
    localSpawn: (() => {
      return new EventEmitter() as never;
    }) as never,
    remoteGit: remoteGit as never,
    lookupHost: (p) => (p === '/home/u/p' ? 'h1' : null),
    identity: null,
  });
  const child = spawner('git', ['rev-parse', '--show-toplevel'], { cwd: '/home/u/p' }) as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  const chunks: string[] = [];
  child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
  const closed = new Promise<void>((r) => child.on('close', () => r()));
  await closed;
  assert.equal(chunks.join(''), 'x');
  assert.equal(calls.length, 1);
});

test('remote-aware spawn falls through to local for non-host path', async () => {
  let local = false;
  const spawner = createRemoteAwareSpawn({
    localSpawn: ((cmd: never, args: never, o: never) => { local = true; return {}; }) as never,
    remoteGit: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as never,
    lookupHost: () => null,
    identity: null,
  });
  spawner('git', ['status'], { cwd: '/local/p' });
  assert.equal(local, true);
});

test('remote-aware fs stat routes to RPC when path has a host', async () => {
  const calls: string[] = [];
  const remoteFs = {
    stat: async (h: string, p: string) => {
      calls.push(p);
      return { exists: true, isDirectory: true, isFile: false, size: 0, mtimeMs: 1 };
    },
  };
  const fsAsync = createRemoteAwareFileSystem({
    localFs: (() => { throw new Error('should not touch local'); }) as never,
    remoteFs: remoteFs as never,
    lookupHost: (p) => (p?.startsWith('/home/u/') ? 'h1' : null),
  });
  const res = await fsAsync.stat('/home/u/p/x');
  assert.equal((res as { isDirectory: () => boolean }).isDirectory(), true);
});
```

- [ ] **Step 4: 跑测试**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-adapters.test.ts`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/remote-adapters.ts backend/server/modules/remote-agents/tests/remote-adapters.test.ts backend/server/modules/git/git.module.ts
git commit -m "feat(remote-agents): remote-aware git spawn + fs adapters for git.routes"
```

---

### Task 10: worktrees 远程化

**Files:**
- Modify: `backend/server/modules/worktrees/services/worktree-git.service.ts`
- Modify: `backend/server/modules/worktrees/worktrees.module.ts`

- [ ] **Step 1: `runGitCommand` 改为 host-aware**

```ts
// worktree-git.service.ts 顶部
import { createRemoteGitClient } from '@/modules/remote-agents/remote-git.service.js';
import { createRemoteAwareFileSystem } from '@/modules/remote-agents/remote-adapters.js';
import { lookupHostForPath } from '@/modules/remote-agents/remote-projects.index.js';
import { getRemoteAgentsRuntime } from '@/modules/remote-agents/runtime.js';

// 惰性 resolve：避免模块加载期触碰 runtime
let remoteGitRef: ReturnType<typeof createRemoteGitClient> | null = null;
function remoteGitFor(cwd: string): ReturnType<typeof createRemoteGitClient> | null {
  if (!lookupHostForPath(cwd)) return null;
  if (!remoteGitRef) remoteGitRef = createRemoteGitClient(() => getRemoteAgentsRuntime().registry);
  return remoteGitRef;
}

export function runGitCommand(args: string[], cwd: string): Promise<GitCommandResult> {
  const remoteGit = remoteGitFor(cwd);
  if (remoteGit) {
    const hostId = lookupHostForPath(cwd) as string;
    return remoteGit.exec(hostId, args, { cwd }).then((res) => {
      if (res.exitCode === 0) return { stdout: res.stdout, stderr: res.stderr };
      throw new AppError(`git ${args.join(' ')} failed`, {
        code: 'GIT_COMMAND_FAILED',
        statusCode: 500,
        details: (res.stderr || res.stdout).trim(),
      });
    });
  }
  // … 现有本地 spawn 逻辑不变
}
```

- [ ] **Step 2: worktrees.module.ts 的 `pathExists` host-aware**

```ts
// worktrees.module.ts
import { access } from 'node:fs/promises';
import { getRemoteAgentsRuntime } from '@/modules/remote-agents/runtime.js';
import { lookupHostForPath } from '@/modules/remote-agents/remote-projects.index.js';

const worktreeFileSystem: WorktreeFileSystem = {
  async pathExists(candidatePath: string): Promise<boolean> {
    const hostId = lookupHostForPath(candidatePath);
    if (hostId) {
      try {
        const stat = await getRemoteAgentsRuntime().fsClient.stat(hostId, candidatePath);
        return stat.exists;
      } catch {
        return false;
      }
    }
    try {
      await access(candidatePath);
      return true;
    } catch {
      return false;
    }
  },
};
```

> worktree 服务的 `merge`/`remove`/`open` 都通过 `runGit` 与 `projects.createProject`（open 一个新 worktree 为项目，会走 `createProject`——无 remote_host_id）。远程 open-worktree 后的新项目行应带 remote_host_id（task 计划内后续小改：`worktreeCreate.open` 在目标 host 非空时用 `createProjectWithRemote`）。此行为 Phase 2 边界内最小实现：先支持远程 repo 的 list/create/merge/remove，远程 open-worktree 建项目时若主机在线则把 remote_host_id 带到新项目；若实现复杂度超限，open 按钮对远程项目先返回提示"远程 worktree 打开暂不支持"，并记录为已知边界。

- [ ] **Step 3: 现有 worktree 测试回归**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/worktrees/**/*.test.ts 2>/dev/null; npm run typecheck`
Expected: 零新增错误

- [ ] **Step 4: Commit**

```bash
git add backend/server/modules/worktrees/services/worktree-git.service.ts backend/server/modules/worktrees/worktrees.module.ts
git commit -m "feat(remote-agents): remote-aware worktrees git + pathExists"
```

---

## Phase 3 — 远程 Providers

### Task 11: lite `session/start` 泛化 — provider 分派 + configEnv 注入

**Files:**
- Modify: `backend/remote-agent/src/agent-run.ts`
- Modify: `backend/remote-agent/src/rpc-dispatch.ts`

- [ ] **Step 1: 抽象 run manager 接口，按 provider 分发**

在 `agent-run.ts` 中将现有 `querySdk` 使用点包装为可扩展：

```ts
export type RunManager = {
  start(params: SessionStartParams): Promise<{ providerSessionId: string; provider: import('../../server/shared/agent-runtime/protocol.js').RemoteProvider }>;
  respond(requestId: string, decision: unknown): boolean;
  whenDone(appSessionId: string): Promise<void>;
  interrupt(appSessionId: string): boolean;
  interruptAll(): number;
};
```

`createAgentRunManager` 保持 claude 实现，导出为 `createClaudeRunManager`（对外接口不变，加 `provider` 返回）。新增 `backend/remote-agent/src/providers/registry.ts`：

```ts
import { createClaudeRunManager } from '../agent-run.js';
import { createCodexRunManager } from './codex-runner.js';
import { createOpenCodeRunManager } from './opencode-runner.js';
import { createQoderRunManager } from './qoder-runner.js';
import type { RemoteProvider } from '../../../server/shared/agent-runtime/protocol.js';

export function createRunManagerFor(provider: RemoteProvider, deps: unknown): ReturnType<typeof createClaudeRunManager> {
  switch (provider) {
    case 'codex': return createCodexRunManager(deps);
    case 'opencode': return createOpenCodeRunManager(deps);
    case 'qoder': return createQoderRunManager(deps);
    case 'claude':
    default:
      return createClaudeRunManager(deps);
  }
}
```

- [ ] **Step 2: rpc-dispatch 的 `session/start` 组装 configEnv**

```ts
  if (method === 'session/start') {
    const params = makeSessionStartParamsSchema().parse(params as unknown);
    // configEnv 只注入到本次 run 的 process env 视图中，不写全局 process.env。
    return createRunManagerFor(params.provider, {
      push: (topic, payload) => pushEmitter(topic, payload),
      roots: cfg.roots,
      env: params.configEnv ?? {},
    }).start(params);
  }
```

> claude run manager 需要接受 `env` 并传给 SDK。`defaultQuerySdk` 用 `query({ prompt, options })`——SDK 的 `Options` 支持 `env`。在 `createClaudeRunManager` 的 `sdkOptions` 中加 `...(env ? { env } : {})`；codex/opencode/qoder manager 把 env 传给各自 spawn。

- [ ] **Step 3: 单测**

```ts
// backend/remote-agent/src/tests/session-provider.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunManagerFor } from '../providers/registry.js';

test('registry defaults unknown provider to claude', () => {
  const mgr = createRunManagerFor('claude' as never, { push: () => {}, roots: ['/tmp'] });
  assert.ok(typeof mgr.start === 'function');
});
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd backend/remote-agent && npm test`；`cd backend && npm run typecheck`
Expected: PASS；零新增错误

- [ ] **Step 5: Commit**

```bash
git add backend/remote-agent/src/agent-run.ts backend/remote-agent/src/rpc-dispatch.ts backend/remote-agent/src/providers/registry.ts backend/remote-agent/src/tests/session-provider.test.ts
git commit -m "feat(remote-agent-lite): provider-dispatched session/start with per-session env"
```

---

### Task 12: lite 移植 codex / opencode / qoder runner

**Files:**
- Create: `backend/remote-agent/src/providers/codex-runner.ts`
- Create: `backend/remote-agent/src/providers/opencode-runner.ts`
- Create: `backend/remote-agent/src/providers/qoder-runner.ts`
- Test: `backend/remote-agent/src/tests/providers-opencode.test.ts`（协议解析部分）

**移植契约（每 runner）：** 以本地实现为语义唯一来源，改造三处：`sendMessage(ws, normalizedMsg)` → `deps.push('session:'+sid, { _remoteNorm: true, message: normalizedMsg })`；approval 推送 → `deps.push('approval:'+requestId, { appSessionId, approval })`；结束时推 `{ type: 'complete' }`。`SessionStartParams` 复用。

- [ ] **Step 1: `codex-runner.ts`** —— 镜像 `backend/server/openai-codex.js` 的 `queryCodex`（SDK：`@openai/codex-sdk`），env 来自 `params.configEnv`

```ts
import type { RunManager } from '../agent-run.js';
import type { SessionStartParams } from '../agent-run.js';

export function createCodexRunManager(deps: { push: (t: string, p: unknown) => void; roots?: string[]; env?: Record<string, string> }): RunManager {
  // 语义源：backend/server/openai-codex.js queryCodex。
  // 保持 SDK 驱动循环：for await (event of codex.iter()) → push normalized；
  // approval 透传采用与 claude canUseTool 相同的响应模型（见本地 openai-codex.js
  // 的 canUseTool 接线）；终止条件与 resume/model/permissionMode 的映射照抄本地。
  // 说明：本文件第 3 步用单独测试文件覆盖其协议；此处不留 TODO。
  throw new Error('implemented in step 3 — see session-provider.test.ts coverage');
}
```

> ⚠️ **执行要求（杜绝占位实现）：** Step 1–3 必须把本地 `openai-codex.js` 的 `queryCodex` 完整搬到 `codex-runner.ts`（约 200 行），只改 sink/env。计划文档不逐行重复本地文件，**执行时直接读本地文件照搬**，wiring 差异只有：该方法无 ws writer，把 `sendMessage` 改为上述 push 形状。以下两文件同规则。

- [ ] **Step 2: `opencode-runner.ts`** —— 镜像 `backend/server/opencode-runner.js`

移植 `resolveOpenCodeBinary`、`resolveOpenCodeCwd`、`parseOpenCodeJsonLine`、`resolveOpenCodePermissionOptions`、`queryOpenCode`（spawn `opencode run --format json --dir <cwd>` + `--help` 无，
`permissionMode` 用 `--permission-mode` 家族：见本地 49-62 行的 switch）。env 用 `deps.env`。

- [ ] **Step 3: `qoder-runner.ts`** —— 镜像 `backend/server/qoder-runner.js` 的 stdio 审批协议

移植 `buildQoderArgs`（`-p -o stream-json` + `--permission-mode` + `--input-format stream-json --permission-prompt-tool stdio`）、`parseQoderControlRequest`、`buildQoderControlResponse`、`registerQoderApproval`（stdin 写 `control_response`），approval 向外推 `approval:<requestId>`。注意本地 `queryQoder` 的 `can_use_tool ≈ control_request` 流程照搬，`isQoderInteractivePermissionMode` 逻辑保留。

- [ ] **Step 4: 调研依赖打包**

codex runner 依赖 `@openai/codex-sdk`。把它加入 `backend/remote-agent/package.json` dependencies 并 `npm install`（在 backend/remote-agent 目录）。opencode/qoder 只 spawn CLI、无新依赖。
build 验证：`cd backend/remote-agent && npm run build && node dist/lite.mjs --help >/dev/null 2>&1 || true`——构建不应报错。

- [ ] **Step 5: 单测（协议解析）**

```ts
// backend/remote-agent/src/tests/providers-opencode.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOpenCodeJsonLine } from '../providers/opencode-runner.js';

test('parses opencode NDJSON text frame', () => {
  const line = JSON.stringify({ type: 'message', subtype: 'text', body: 'hi', sessionID: 's1' });
  const msg = parseOpenCodeJsonLine(line, {} as never);
  assert.ok(msg);
});
```

- [ ] **Step 6: 跑测试 + build**

Run: `cd backend/remote-agent && npm test && npm run build`
Expected: PASS；build 成功

- [ ] **Step 7: Commit**

```bash
git add backend/remote-agent/src/providers/ backend/remote-agent/src/tests/providers-opencode.test.ts backend/remote-agent/package.json backend/remote-agent/package-lock.json
git commit -m "feat(remote-agent-lite): port codex/opencode/qoder run managers"
```

---

### Task 13: main 端 probe 缓存 + 接口 + 会话安装校验 + spawn 全 provider 包裹

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-agents.routes.ts`
- Modify: `backend/server/modules/providers/provider.routes.ts`
- Modify: `backend/server/modules/providers/services/provider-auth.service.ts`
- Modify: `backend/server/modules/remote-agents/remote-spawn.ts`
- Modify: `backend/server/modules/websocket/services/chat-websocket.service.ts`
- Modify: `backend/server/index.js`

- [ ] **Step 1: `GET /:hostId/providers`（routes）+ 探针兜底**

```ts
// remote-agents.routes.ts 内追加（在 dirs 路由之后）
  router.get(
    '/:hostId/providers',
    asyncHandler(async (req, res) => {
      const hostId = typeof req.params.hostId === 'string' ? req.params.hostId : '';
      const host = deps.repo.getById(hostId);
      if (!host) {
        throw new AppError('remote host not found', { code: 'REMOTE_HOST_NOT_FOUND', statusCode: 404 });
      }
      const refresh = readQueryString(req.query.refresh) === '1';
      let providers = deps.registry.getHostProviders(hostId);
      if (refresh || !providers || providers.length === 0) {
        if (!deps.registry.isOnline(hostId)) {
          throw new AppError('remote host is offline', { code: 'REMOTE_HOST_OFFLINE', statusCode: 409 });
        }
        const result = await deps.registry.rpc(hostId, 'providers/probe', { refresh: true });
        providers = (result as { providers: unknown[] }).providers ?? [];
        deps.registry.setHostProviders(hostId, providers);
      }
      res.json(createApiSuccessResponse({ providers, refresh }));
    }),
  );
```

> `RemoteAgentsRouterDeps` 需要暴露 `registry.getHostProviders/setHostProviders`（已加）。`deps.registry.rpc` 已有。

- [ ] **Step 2: 本机 installed 接口（60s TTL 缓存）**

`provider-auth.service.ts` 增加：

```ts
let installedCache: { at: number; data: { provider: string; installed: boolean }[] } | null = null;
const INSTALLED_TTL_MS = 60_000;

export async function getInstalledProviders(): Promise<{ provider: string; installed: boolean }[]> {
  if (installedCache && Date.now() - installedCache.at < INSTALLED_TTL_MS) return installedCache.data;
  const providers = ['claude', 'codex', 'opencode', 'qoder'] as const;
  const data = await Promise.all(
    providers.map(async (p) => {
      try {
        const status = await providerAuthService.getProviderAuthStatus(p);
        return { provider: p, installed: status.installed !== false };
      } catch {
        return { provider: p, installed: true };
      }
    }),
  );
  installedCache = { at: Date.now(), data };
  return data;
}
```

> 复用现有 `getProviderAuthStatus`（内部 `isProviderInstalled` 已"安装乐观回退"）。注意 `getProviderAuthStatus` 可能是异步 `spawn.sync`；单请求内串行 4 次可接受，加上 TTL 缓存后不会频繁触发。

`provider.routes.ts` 追加：

```ts
router.get(
  '/installed',
  asyncHandler(async (_req: Request, res: Response) => {
    const providers = await getInstalledProviders();
    res.json(createApiSuccessResponse({ providers }));
  }),
);
```

> ⚠️ 路由挂载顺序：`/installed` 必须注册在 `/:provider/...` 之前，否则会被 `/:provider` 吞掉。`provider.routes.ts` 中 `installed` 路由加在文件靠前位置（如 auth/status 路由之前）。

- [ ] **Step 3: `POST /api/providers/sessions` 该校验目标安装情况**

在 `provider.routes.ts` `/sessions` handler 中，operator 分支之后、非 operator 分支创建前插入：

```ts
    // 目标归属：项目远程 → 远程 host 探针；否则本机
    let targetInstalled = false;
    const hostId = lookupRemoteHost(normalizeProjectPath(projectPath));
    if (hostId) {
      const hostProviders = remoteRegistry.getHostProviders(hostId);
      if (hostProviders && hostProviders.some((p) => (p as { provider?: string }).provider === provider)) {
        targetInstalled = true;
      }
    } else {
      const installed = await getInstalledProviders();
      targetInstalled = installed.some((p) => p.provider === provider && p.installed);
    }
    if (!targetInstalled) {
      throw new AppError(`Provider "${provider}" is not installed on the target machine`, {
        code: 'PROVIDER_NOT_INSTALLED',
        statusCode: 400,
      });
    }
```

> `lookupRemoteHost` 需要在 `provider-routes` 侧导入（`@/modules/remote-agents/remote-projects.index.js`）；`remoteRegistry` 从 runtime seam 取。主机离线（探针缓存空）时 `hostProviders` 为空 → `targetInstalled=false` → 400。这一行为可接受：离线主机开不了会话。若需要离线也放行，按 `REMOTE_HOST_OFFLINE` 单独提示（记录为后续优化）。

- [ ] **Step 4: spawnFns 全 provider 包裹 + session/start 带 provider/configEnv**

`remote-spawn.ts`：`wrapSpawn(localSpawn)` 变体改为 `wrapSpawn(provider, localSpawn)`，并在 params 构建处加：

```ts
      const params = makeSessionStartParamsSchema().parse({
        appSessionId,
        providerSessionId,
        provider,
        command,
        cwd: projectPath,
        model: options.model,
        permissionMode: (options.permissionMode as string | undefined) ?? 'default',
        includePartialMessages: options.includePartialMessages === true,
        configEnv: options.configEnv ?? {},
      });
```

`index.js`：

```js
const spawnFns = {
  claude: remoteRouting.wrapSpawn('claude', queryClaudeSDK),
  codex: remoteRouting.wrapSpawn('codex', queryCodex),
  opencode: remoteRouting.wrapSpawn('opencode', queryOpenCode),
  qoder: remoteRouting.wrapSpawn('qoder', queryQoder),
};
```

以及给每个 remote 会话组装 `configEnv`。注入点：`backend/server/modules/websocket/services/chat-websocket.service.ts` 的 `handleChatSend`，在组 `runtimeOptions` 后、调 `spawnFn(command, runtimeOptions, writer)` 前，为 `runtimeOptions.configEnv` 赋值：

```js
import { buildProviderConfigEnv } from '../../modules/config/env-sync.js';

// runtimeOptions 构建后：
runtimeOptions.configEnv = buildProviderConfigEnv(getAppConfig().get(), runtimeOptions.provider);
```

> `runtimeOptions.provider` 需确认已存在于该处（DB session 行有 provider 字段，通常已在 options 里）；若没有，从 session row 取 `provider`。`configEnv` 只在 `remoteRouting.wrapSpawn` 命中远程 host 时被消费；本地项目走 `localSpawn`，该字段被忽略。

- [ ] **Step 5: 单测**

`backend/server/modules/remote-agents/tests/remote-spawn.test.ts` 若已存在，补充：`wrapSpawn(provider)` 把 provider 传进 `session/start` 参数。跑既有测试。

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/remote-spawn.test.ts 2>/dev/null || echo "no spawn test file"; npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/remote-agents/remote-agents.routes.ts backend/server/modules/remote-agents/remote-spawn.ts backend/server/modules/providers/provider.routes.ts backend/server/modules/providers/services/provider-auth.service.ts backend/server/index.js backend/server/modules/config/env-sync.ts
git commit -m "feat(remote-agents): provider probe cache, installed guard, spawn wrapping for all providers"
```

---

### Task 14: 本机配置 → 远程 `configEnv` 组装

**Files:**
- Modify: `backend/server/modules/config/env-sync.ts`

- [ ] **Step 1: 新增 `buildProviderConfigEnv(cfg, provider)`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

import type { LLMProvider } from '@/shared/types.js';

/**
 * 从本机 app.config 组装发给远程 lite 的 provider 配置 env。
 * 与 syncProviderEnv 同源（同一批字段），只是返回 Record 而非写 process.env。
 * 仅含 `providers.<id>` 明确的配置项，隐藏未配置的字段。
 */
export function buildProviderConfigEnv(cfg: AppConfig, provider: LLMProvider): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string | undefined) => {
    if (value && value.trim()) out[key] = value.trim();
  };
  const { providers } = cfg;
  switch (provider) {
    case 'claude': {
      const c = providers.claude;
      put('ANTHROPIC_BASE_URL', c.baseUrl);
      put('ANTHROPIC_API_KEY', c.apiKey);
      put('ANTHROPIC_AUTH_TOKEN', c.apiKey || c.authToken);
      put('ANTHROPIC_MODEL', c.defaultModel);
      put('ANTHROPIC_DEFAULT_HAIKU_MODEL', c.haikuModel);
      put('ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', c.haikuModel);
      put('ANTHROPIC_DEFAULT_OPUS_MODEL', c.opusModel);
      put('ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', c.opusModel);
      put('ANTHROPIC_DEFAULT_SONNET_MODEL', c.sonnetModel);
      put('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', c.sonnetModel);
      put('CLAUDE_CLI_PATH', c.cliPath && c.cliPath !== 'claude' ? c.cliPath : undefined);
      break;
    }
    case 'codex': {
      put('CODEX_PATH_OVERRIDE', providers.codex.binPath);
      // 复用本机 codex auth.json 的 OPENAI_API_KEY（若存在），否则远程需自理认证
      const home = process.env.HOME ?? os.homedir();
      const authPath = `${home}/.codex/auth.json`;
      if (existsSync(authPath)) {
        try {
          const auth = JSON.parse(readFileSync(authPath, 'utf8')) as { OPENAI_API_KEY?: unknown };
          if (typeof auth.OPENAI_API_KEY === 'string') put('OPENAI_API_KEY', auth.OPENAI_API_KEY);
        } catch {
          /* 不可解析的 auth 文件——忽略，远程自理 */
        }
      }
      break;
    }
    case 'opencode': {
      const o = providers.opencode;
      put('OPENCODE_BIN', o.binPath);
      for (const [key, value] of Object.entries(o.apiKeys ?? {})) put(key, value);
      break;
    }
    case 'qoder': {
      put('QODER_PERSONAL_ACCESS_TOKEN', providers.qoder.personalAccessToken);
      break;
    }
  }
  return out;
}
```

- [ ] **Step 2: 单测（纯 config 组装，不含 fs 分支的 codex）**

```ts
// backend/server/modules/config/tests/env-sync.test.ts（若不存在则新建）
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProviderConfigEnv } from '../env-sync.js';
import { getAppConfig } from '../config.js';

test('claude config env carries apiKey + baseUrl + model from app.config', () => {
  const cfg = getAppConfig().get();
  const env = buildProviderConfigEnv(cfg, 'claude');
  assert.equal(typeof env.ANTHROPIC_API_KEY, 'string');
  if (env.ANTHROPIC_API_KEY) assert.ok(env.ANTHROPIC_API_KEY.length > 0);
});
```

- [ ] **Step 3: 跑测试 + typecheck**

Run: `cd backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/env-sync.test.ts 2>/dev/null || echo "no existing env-sync test"; npm run typecheck`
Expected: PASS；零新增错误

- [ ] **Step 4: Commit**

```bash
git add backend/server/modules/config/env-sync.ts
git commit -m "feat(remote-agents): build per-provider configEnv from local app.config"
```

---

## Phase 4 — 前端 provider 选择器

### Task 15: 本地+远程安装感知的 provider 选择器

**Files:**
- Modify: `web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- Modify: `web/src/components/chat/hooks/useChatProviderState.ts`（or 直接在空态组件拉取）
- Modify: `web/src/utils/api.js`（新增二接口封装）

- [ ] **Step 1: api.js 封装**

```js
  async getInstalledProviders() {
    const res = await authenticatedFetch('/api/providers/installed');
    return (await res.json()).data?.providers ?? [];
  },
  async getRemoteHostProviders(hostId, { refresh = false } = {}) {
    const q = refresh ? '?refresh=1' : '';
    const res = await authenticatedFetch(`/api/remote-agents/${hostId}/providers${q}`);
    return (await res.json()).data?.providers ?? [];
  },
```

- [ ] **Step 2: ProviderSelectionEmptyState 增加 `installedProviders` 过滤**

新增 prop：`installedProviders: Record<LLMProvider, boolean> | null`（null = 加载中）。`visibleProviderGroups`：

```ts
const visibleProviderGroups = useMemo<ProviderGroup[]>(() => {
  if (installedProviders === null) return [];
  return PROVIDER_META
    .filter((m) => installedProviders[m.id] !== false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: providerModelCatalog[p.id]?.OPTIONS ?? [],
    }));
}, [installedProviders, providerModelCatalog]);
```

若过滤后为空 → 渲染空态文案（`t("providerSelection.noneInstalled")`，"本机/远程主机尚未安装可用 provider"）。

- [ ] **Step 3: 在 ChatMessagesPane 组装 URL → 选择器数据流**

`ChatMessagesPane.tsx` 调用 `<ProviderSelectionEmptyState>` 处（约 188 行）已有 `selectedProject`。新增 `useRemoteProviders(selectedProject)` hook 或内联 `useEffect`：

```ts
// 目标：本地 4 个的 installed 映射；远程项目则取该 host 探针。
const ALL_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode', 'qoder'];
const [installedProviders, setInstalledProviders] = useState<Record<LLMProvider, boolean> | null>(null);

useEffect(() => {
  let cancelled = false;
  setInstalledProviders(null);
  (async () => {
    const resolveHost = selectedProject?.remoteHostId
      ? await api.getRemoteHostProviders(selectedProject.remoteHostId)
      : await api.getInstalledProviders();
    if (cancelled) return;
    const map = Object.fromEntries(resolveHost.map((p: { provider: LLMProvider; installed: boolean }) => [p.provider, p.installed]));
    setInstalledProviders(ALL_PROVIDERS.reduce((acc, p) => ({ ...acc, [p]: map[p] === true }), {}));
  })();
  return () => { cancelled = true; };
}, [selectedProject?.remoteHostId]);
```

> `selectedProject.remoteHostId` 需要在 web `Project` 类型中补充（`web/src/types/app.ts`，`remoteHostId?: string | null`；后端 `/api/projects` 返回里加上 `remote_host_id`——检查 `projects.routes.ts` 的 payload 投影，在 2026-08-18 remote-projects 实现里它已经暴露 `remote_host_name`，若 `remote_host_id` 未暴露则补上）。

- [ ] **Step 4: 已选 provider 不可用时弹回**

在 `useChatProviderState` 的初始化/selected-provider 读取处，若 `installedProviders` 非 null 且当前 `provider` 不可用 → 重置回第一个可用（无可用则不重置，UI 显示空态）。具体落在 ProviderSelectionEmptyState 的 `useEffect`：`setProvider(firstAvailableId)`，并同步 localStorage。

- [ ] **Step 5: 前端测试**

Run: `cd web && npx vitest run src/components/chat/view/subcomponents/ProviderSelectionEmptyState.test.tsx 2>/dev/null || echo "no dedicated test — run full frontend suite"`
Run: `cd web && npx vitest run`（若仓库前端 test 已配 vitest）
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx web/src/components/chat/hooks/useChatProviderState.ts web/src/components/chat/view/subcomponents/ChatMessagesPane.tsx web/src/utils/api.js web/src/types/app.ts backend/server/modules/projects/projects.routes.ts
git commit -m "feat(web): filter provider picker by install availability (local + remote host)"
```

---

## Phase 5 — 实机 E2E 与回归

### Task 16: lite 新 bundle 构建 + 部署（172.26.167.52）

**Files:**
- （无源文件改动）

- [ ] **Step 1: 构建 server + lite**

Run:
```bash
cd backend/remote-agent && npm run build
cd backend && npm run build 2>/dev/null || true   # server 编译（prod 走 tsx，构建可能失败——见 [[lovdex-supervisor]]，用 dev 跑即可）
```

Expected: lite bundle 生成 `backend/remote-agent/dist/lite.mjs`（.gitignore 内）。server 构建失败不影响（supervisor 用 tsx）。

- [ ] **Step 2: 重启后端（先问用户）**

**⚠️ 必须先用 AskUserQuestion 征得用户同意**（见 [[lovdex-backend-restart-requires-confirm]]）：`kill` 后端 npm/tsx 子进程让 supervisor 拉起，或 `systemctl --user restart lovdex`。

- [ ] **Step 3: 重新部署目标宿主**

通过 Web UI（远程主机设置页 → Redeploy，2bec576 已修 reinstall 使新 bundle 生效），或 API：
```bash
curl -X POST http://<main>/api/remote-agents/<hostId>/deploy -H "Authorization: Bearer $TOKEN"
```
Expected: 状态 online，logs 显示新版本。

- [ ] **Step 4: 探针抽查**

```bash
curl -s http://<main>/api/remote-agents/<hostId>/providers?refresh=1
```
Expected: `providers` 数组里对应该机实际安装情况（claude 必然 true——bootstrap 强制；codex/opencode/qoder 按实）。

### Task 17: 功能冒烟

- [ ] **Step 1: 远程项目文件操作**
在 Web UI 打开远程项目（已有 remote project 或先 `POST /api/projects/create-remote-project`）：建目录→建文件→编辑保存→重命名→删除；图片预览、下载、上传小文件。Expected: 均成功并落盘在远程真实路径。

- [ ] **Step 2: 远程 git**
远程项目里 `git init` → 建文件 → status 显示 untracked → stage → commit（身份来自本机 git config 注入）→ log 可见。Expected: 与本地 git 面板交互一致。

- [ ] **Step 3: 远程 provider 会话**
目标机装过的 provider 出现在选择器；未装的被过滤。发一条消息 → 会话在远程跑、事件回流、approval 正常。codex（若装了）单独冒烟。

- [ ] **Step 4: 本地回归**
本机开本地项目：文件树/编辑器/git 面板/4 provider 会话——确认全不受影响。
Expected: 与改动前一致。

- [ ] **Step 5: 记录结论**
把 E2E 结果（通过/失败项）与任何发现的缺陷写进 commit message 或新 issue docs。

---

## 自检记录（计划 vs spec）

- spec §1（RPC 协议）→ T1（schemas）、T3–T5（lite fs/git/probe）、T11–T12（session/start 泛化）✓
- spec §2（lite 端）→ T3（fs 写面）、T4（git/probe 接线）、T12（runner 移植）✓
- spec §3（main 端）→ T2（RemoteFsClient）、T6–T7（文件分流）、T8–T10（git/worktrees）、T13（probe 缓存/校验/spawn 包裹）、T14（configEnv）✓
- spec §4（选择器）→ T15 ✓
- spec §5（验证）→ T16–T17 ✓
- 已知边界（写进 spec 风险节）：远程 open-worktree 建项目默认不带 remote_host_id（Task 10 已记录失败回退）；codex 远程 auth 靠 `~/.codex/auth.json` 的 OPENAI_API_KEY 转 env，否则远程需自理认证；离线 host 的 sessions 创建返回 400（探针缓存空）。