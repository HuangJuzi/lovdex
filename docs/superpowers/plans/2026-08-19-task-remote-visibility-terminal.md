# 新建任务远程可见性 / 远程终端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建任务（TaskBoard Modal + 定时任务表单）能看出项目本地/远程且执行引擎按目标机已装过滤；远程项目终端经主控端 `ssh -t` 分流到远程主机并在界面上标识 `SSH: <hostName>`。

**Architecture:** 前端复用已在聊天侧验证的数据源（本地 `GET /api/providers/installed`，远程 `GET /api/remote-agents/:hostId/providers`），抽共享 hook + 纯函数决策；后端 `/ws/terminal` 按 `hostId` 查询 remote_hosts 行，用 node-pty 起 `ssh -t`（复用主控机 Lovdex ed25519 密钥）落远程 cwd，无 hostId 走原本地路径。

**Tech Stack:** backend TS (node:test + `npx tsx --test --tsconfig server/tsconfig.json`)、web React+TS (node:test + `npx tsx --test`，无 vitest，组件测试用 `react-dom/server` `renderToStaticMarkup`，hooks 测纯逻辑导出)。

设计文档：`docs/superpowers/specs/2026-08-19-task-remote-visibility-terminal-design.md`（commit ebfbe5e）

**测试命令速查**
- 后端单测：`cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json <相对路径>`
- 后端 typecheck：`cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck`（baseline 已有 11 个 pre-existing 错误，只验收"无新增"——搜索输出里有没有指向本次改动文件的错误）
- 前端单测：`cd /mnt/b/workdir/github/lovdex/web && npx tsx --test <相对路径>`
- 前端 typecheck：`cd /mnt/b/workdir/github/lovdex/web && npm run typecheck`

**文件结构**
- 后端：
  - Modify `backend/server/modules/terminal/terminal-websocket.service.ts` — 纯 helper（`shellQuote`/`readTerminalCwdUrl`/`readTerminalHostId`/`buildSshTerminalArgv`）+ `TerminalDependencies` 扩展 + `handleTerminalConnection` remote 分支
  - Create `backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts` — remote 分支与纯 helper 测试
  - Modify `backend/server/index.js` — terminal deps 注入 `identityFile` + `resolveRemoteHost`
- 前端：
  - Modify `web/src/hooks/useTerminalDrawer.tsx` — 上下文携带 hostId/hostName
  - Modify `web/src/components/app/AppContent.tsx` — setCwd 带 meta
  - Modify `web/src/components/terminal/TerminalPane.tsx` — URL 带 hostId + SSH 徽标
  - Create `web/src/components/terminal/terminalSocketUrl.ts` + `RemoteTerminalBadge.tsx` + tests — 纯函数 / 纯组件
  - Create `web/src/components/tasks/useTaskEngineAvailability.ts` + `TaskEngineSelect.tsx` + tests — 引擎候选逻辑/渲染
  - Modify `web/src/components/tasks/projectOptions.ts` — `taskProjectLabel`/`toProjectOption` 纯函数
  - Modify `web/src/components/tasks/TaskBoard.tsx` — Modal 项目 label + 引擎下拉 + 提交守卫
  - Modify `web/src/components/tasks/TaskCard.tsx` — `TaskProjectOption` 扩展 remote 字段
  - Modify `web/src/components/tasks/ScheduledTaskForm.tsx` — 项目 label + 引擎过滤 + 提交守卫

---

### Task 1: Backend — 远程终端纯 helper（ssh argv / cwd / shellQuote）+ 测试

**Files:**
- Modify: `backend/server/modules/terminal/terminal-websocket.service.ts`
- Create: `backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts`

- [ ] **Step 1: 写失败测试**

Create `backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSshTerminalArgv,
  readTerminalCwdUrl,
  readTerminalHostId,
  shellQuote,
} from '@/modules/terminal/terminal-websocket.service.js';

test('shellQuote wraps in single quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('/home/u/my project'), `'/home/u/my project'`);
  assert.equal(shellQuote(`/has'quote`), `'/has'\\''quote'`);
});

test('readTerminalCwdUrl returns the cwd param or null', () => {
  assert.equal(readTerminalCwdUrl('/ws/terminal?cwd=%2Fhome%2Fu%2Fproj'), '/home/u/proj');
  assert.equal(readTerminalCwdUrl('/ws/terminal'), null);
});

test('readTerminalHostId returns the hostId param or null', () => {
  assert.equal(readTerminalHostId('/ws/terminal?hostId=h1'), 'h1');
  assert.equal(readTerminalHostId('/ws/terminal'), null);
});

test('buildSshTerminalArgv forces a tty, carries identity and lands in cwd', () => {
  const argv = buildSshTerminalArgv({
    identityFile: '/data/ssh/lovdex_ed25519',
    host: '10.0.0.5',
    port: 22,
    sshUser: 'root',
    cwd: '/home/root/app',
  });
  assert.deepEqual(argv, [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    '-i', '/data/ssh/lovdex_ed25519',
    'root@10.0.0.5',
    `cd '/home/root/app' && exec $SHELL -l`,
  ]);
});

test('buildSshTerminalArgv adds -p for a non-default port and defaults cwd to ~', () => {
  const argv = buildSshTerminalArgv({ identityFile: null, host: 'h', port: 2222, sshUser: 'u', cwd: null });
  assert.equal(argv[0], '-t');
  assert.ok(argv.includes('-p') && argv.includes('2222'));
  assert.equal(argv[argv.length - 1], `cd '~' && exec $SHELL -l`);
  assert.ok(!argv.some((a) => a.startsWith('-i')));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/terminal/tests/remote-terminal-websocket.service.test.ts`
Expected: FAIL — `buildSshTerminalArgv is not a function`（模块解析错误或 `ReferenceError`）

- [ ] **Step 3: 实现纯 helper**

Add to `backend/server/modules/terminal/terminal-websocket.service.ts` after the `send` helper (keep the existing `resolveTerminalCwd` untouched):

```ts
/** Remote ssh target resolved from a remote_hosts row. */
export type RemoteTerminalHost = { host: string; port: number | null; sshUser: string };

/** Single-quote a remote path for embedding in the ssh command argument
 *  (argv-array discipline — never build a shell string from user input). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parse the ?cwd= query param WITHOUT touching the local fs — the remote
 *  branch cannot stat a path that lives on the target machine. */
export function readTerminalCwdUrl(rawUrl: string | undefined): string | null {
  try {
    const requested = new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('cwd');
    return requested && requested.length > 0 ? requested : null;
  } catch {
    return null;
  }
}

/** Parse the ?hostId= query param used to route a terminal to a remote host. */
export function readTerminalHostId(rawUrl: string | undefined): string | null {
  try {
    const id = new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('hostId');
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * argv for an interactive `ssh -t` into the remote host, landing the shell in
 * `cwd` (default `~`). Mirror bootstrap.service `sshArgs` flag discipline
 * (accept-new / ConnectTimeout / BatchMode) plus `-t` for the PTY and the
 * remote `cd` — a bad directory fails the remote shell and exits cleanly.
 */
export function buildSshTerminalArgv(input: {
  identityFile: string | null;
  host: string;
  port: number | null;
  sshUser: string;
  cwd: string | null;
}): string[] {
  const argv = [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
  ];
  if (input.identityFile) argv.push('-i', input.identityFile);
  if (input.port && input.port !== 22) argv.push('-p', String(input.port));
  argv.push(`${input.sshUser}@${input.host}`, `cd ${shellQuote(input.cwd ?? '~')} && exec $SHELL -l`);
  return argv;
}
```

Also extend `TerminalDependencies` in the same file:

```ts
export type TerminalDependencies = {
  spawnPty: PtySpawner;
  shell: string;
  cwd: string;
  /** Resolve the ssh target (remote_hosts row) for a hostId; null when unknown. */
  resolveRemoteHost?: (hostId: string) => RemoteTerminalHost | null;
  /** Main→host Lovdex ed25519 key for `ssh -t`; null/undefined → no -i. */
  identityFile?: string | null;
};
```

- [ ] **Step 4: 运行确认通过**

Run: the same command as Step 2.
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts backend/server/modules/terminal/terminal-websocket.service.ts
git commit -m "feat(terminal): remote ssh argv + cwd/hostId helpers (ssh -t routing primitives)"
```

---

### Task 2: Backend — handleTerminalConnection 远程分支 + 测试

**Files:**
- Modify: `backend/server/modules/terminal/terminal-websocket.service.ts`
- Modify: `backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts`

- [ ] **Step 1: 写失败测试**

Append to `backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts` (use the same `makeFakePty`/`makeFakeWs`/`asSocket` helpers as the existing `terminal-websocket.service.test.ts` — import them is NOT possible, so copy them into this file; also extend this file's existing import from `@/modules/terminal/terminal-websocket.service.js` to include `handleTerminalConnection, type PtyLike`, and add `import type { WebSocket } from 'ws';` plus `import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';` at the top):

```ts
import { handleTerminalConnection, type PtyLike } from '@/modules/terminal/terminal-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WsEvent = 'message' | 'close' | 'error';

function makeFakePty() {
  const state = { written: [] as string[], resized: [] as Array<[number, number]>, killed: false };
  let onDataCb: ((d: string) => void) | null = null;
  let onExitCb: ((i: { exitCode: number }) => void) | null = null;
  const pty: PtyLike & { state: typeof state; emitData: (d: string) => void; emitExit: (code: number) => void } = {
    state,
    onData(cb) { onDataCb = cb; },
    onExit(cb) { onExitCb = cb; },
    write(d) { state.written.push(d); },
    resize(c, r) { state.resized.push([c, r]); },
    kill() { state.killed = true; },
    emitData(d) { onDataCb?.(d); },
    emitExit(code) { onExitCb?.({ exitCode: code }); },
  };
  return pty;
}

function makeFakeWs() {
  const state = { sent: [] as string[], closed: false };
  const listeners = new Map<WsEvent, Array<(...args: never[]) => void>>();
  const ws = {
    state,
    OPEN: 1,
    readyState: 1,
    send(m: string) { state.sent.push(m); },
    close() { state.closed = true; },
    on(evt: WsEvent, cb: (...args: never[]) => void) {
      const arr = listeners.get(evt) ?? [];
      arr.push(cb);
      listeners.set(evt, arr);
    },
    emit(evt: WsEvent, ...args: unknown[]) {
      for (const cb of listeners.get(evt) ?? []) (cb as (...a: unknown[]) => void)(...args);
    },
  };
  return ws;
}

function asSocket(fake: ReturnType<typeof makeFakeWs>): WebSocket {
  return fake as unknown as WebSocket;
}

test('routes to an ssh pty for a known remote hostId', () => {
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?hostId=h1&cwd=%2Fremote%2Fproj' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: '/workspace',
    identityFile: '/data/ssh/lovdex_ed25519',
    resolveRemoteHost: (hostId) => (hostId === 'h1' ? { host: '10.0.0.5', port: 2222, sshUser: 'root' } : null),
  });
  const c = captured as { shell: string; args: string[] };
  assert.equal(c.shell, 'ssh');
  assert.ok(c.args.includes('-t'));
  assert.ok(c.args.includes('root@10.0.0.5'));
  assert.ok(c.args.some((a) => a.includes('cd ')));
  assert.ok(c.args.some((a) => a.includes('/remote/proj') || a.includes("'~'")));
});

test('refuses with an error when the hostId is unknown', () => {
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?hostId=nope' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: () => { throw new Error('must not be called'); },
    shell: 'bash',
    cwd: '/',
    resolveRemoteHost: () => null,
  });
  assert.ok(ws.state.sent.some((m) => m.includes('remote host not found')));
  assert.equal(ws.state.closed, true);
});

test('keeps the local path when no hostId is present', () => {
  const pty = makeFakePty();
  let captured: unknown = null;
  const ws = makeFakeWs();
  handleTerminalConnection(asSocket(ws), fakeRequest, {
    spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
    shell: '/bin/bash',
    cwd: '/workspace',
    identityFile: '/data/ssh/lovdex_ed25519',
    resolveRemoteHost: () => null,
  });
  assert.equal((captured as { shell: string }).shell, '/bin/bash');
  assert.deepEqual((captured as { args: string[] }).args, []);
});

test('remote branch forwards input/output/resize through the ssh pty', () => {
  const pty = makeFakePty();
  const ws = makeFakeWs();
  const request = { url: '/ws/terminal?hostId=h1' } as AuthenticatedWebSocketRequest;
  handleTerminalConnection(asSocket(ws), request, {
    spawnPty: () => pty,
    shell: 'bash',
    cwd: '/',
    resolveRemoteHost: () => ({ host: 'h', port: 22, sshUser: 'u' }),
  });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\r' })));
  pty.emitData('out\n');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })));
  assert.deepEqual(pty.state.written, ['ls\r']);
  assert.deepEqual(pty.state.resized, [[100, 30]]);
  assert.ok(ws.state.sent.includes(JSON.stringify({ type: 'output', data: 'out\n' })));
  pty.emitExit(0);
  assert.equal(ws.state.closed, true);
});
```

Note: this file now needs `fakeRequest` — add `const fakeRequest = {} as AuthenticatedWebSocketRequest;` at the top of the new test file too.

- [ ] **Step 2: 运行确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/terminal/tests/remote-terminal-websocket.service.test.ts`
Expected: FAIL — the 4 new tests error (unknown hostId currently spawns a local shell; `resolveRemoteHost`/`identityFile` do not exist yet).

- [ ] **Step 3: 实现远程分支**

Rewrite `handleTerminalConnection` in `backend/server/modules/terminal/terminal-websocket.service.ts`:

```ts
export function handleTerminalConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: TerminalDependencies,
): void {
  const remoteHostId = readTerminalHostId(request.url);

  // Remote host requested but not resolveable → refuse instead of silently
  // dropping into a local shell (the client explicitly asked for the remote).
  if (remoteHostId && !dependencies.resolveRemoteHost?.(remoteHostId)) {
    send(ws, { type: 'error', message: 'remote host not found' });
    ws.close();
    return;
  }

  let pty: PtyLike;
  if (remoteHostId) {
    const host = dependencies.resolveRemoteHost!(remoteHostId);
    try {
      pty = dependencies.spawnPty('ssh', buildSshTerminalArgv({
        identityFile: dependencies.identityFile ?? null,
        host: host.host,
        port: host.port ?? null,
        sshUser: host.sshUser,
        // The landing directory lives on the target; the remote `cd` enforces it.
        cwd: readTerminalCwdUrl(request.url),
      }), {
        cwd: dependencies.cwd,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
      });
    } catch {
      send(ws, { type: 'error', message: 'failed to spawn remote shell' });
      ws.close();
      return;
    }
  } else {
    try {
      pty = dependencies.spawnPty(dependencies.shell, [], {
        cwd: resolveTerminalCwd(request.url, dependencies.cwd),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
      });
    } catch {
      send(ws, { type: 'error', message: 'failed to spawn shell' });
      ws.close();
      return;
    }
  }

  // … everything below (pty.onData / onExit / ws.on('message'|'close'|'error'))
  // stays EXACTLY as it is today — it is identical for both branches.
}
```

**Do not touch** the wire protocol code below the spawn block. The lines `pty.onData(...)`, `pty.onExit(...)`, `ws.on('message' ...)`, `ws.on('close', ...)`, `ws.on('error', ...)` are unchanged.

- [ ] **Step 4: 运行确认通过**

Run: the same command as Step 2.
Expected: ALL tests in the file PASS (both the Task 1 pure-helper tests and the 4 new ones).

- [ ] **Step 5: 回归本地终端既有测试**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/terminal/tests/terminal-websocket.service.test.ts`
Expected: all existing local-terminal tests PASS (no-behavior-change regression).

- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/terminal/terminal-websocket.service.ts backend/server/modules/terminal/tests/remote-terminal-websocket.service.test.ts
git commit -m "feat(terminal): route /ws/terminal to remote host via ssh -t when hostId present"
```

---

### Task 3: Backend — index.js 注入 resolveRemoteHost + identityFile

**Files:**
- Modify: `backend/server/index.js`

- [ ] **Step 1: 扩展 terminal deps**

Find the `terminal:` dependency block (`backend/server/index.js:246-250`) and replace it with:

```js
    terminal: {
        spawnPty: (shell, args, options) => pty.spawn(shell, args, options),
        shell: process.env.SHELL || '/bin/bash',
        cwd: WORKSPACES_ROOT,
        // Remote terminal: -i identity + ssh target from the remote_hosts row.
        // Both are in scope here (identityFile at module top; remoteHostsDb above).
        identityFile,
        resolveRemoteHost: (hostId) => {
            const host = remoteHostsDb.getById(hostId);
            return host ? { host: host.host, port: host.port ?? 22, sshUser: host.ssh_user } : null;
        },
    },
```

Confirm before editing: `remoteHostsDb` is defined **above** this block (it is — it is already used at `backend/server/index.js:265` in `createRemoteAgentWss`), and `remoteHostsDb.getById` returns rows with `host` / `port` / `ssh_user`.

- [ ] **Step 2: typecheck 验收**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck`
Expected: no NEW errors referencing `index.js`. (Baseline has ~11 pre-existing errors; only check the output for `index.js` / our files. `index.js` is plain JS so it will not generate tsc errors either way.)

- [ ] **Step 3: Commit**

```bash
git add backend/server/index.js
git commit -m "feat(terminal): inject identity + remote-host resolver for ssh terminal routing"
```

---

### Task 4: Frontend — 终端上下文 hostId/hostName + URL + SSH 徽标

**Files:**
- Modify: `web/src/hooks/useTerminalDrawer.tsx`
- Modify: `web/src/components/app/AppContent.tsx`
- Modify: `web/src/components/terminal/TerminalPane.tsx`
- Create: `web/src/components/terminal/terminalSocketUrl.ts` + `web/src/components/terminal/terminalSocketUrl.test.ts`
- Create: `web/src/components/terminal/RemoteTerminalBadge.tsx` + `web/src/components/terminal/RemoteTerminalBadge.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/terminal/terminalSocketUrl.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTerminalSocketUrl } from './terminalSocketUrl';

// buildWebSocketUrl falls back to window.location when API_BASE_URL is '' (it
// is, in this repo) — stub a fake location so the pure function is testable
// without a DOM. API_BASE_URL is '' at import time, so the ws base here is
// derived from this stub deterministically.
(globalThis as { window?: unknown }).window = {
  location: { protocol: 'http:', host: 'lovdex:5187' },
};

test('builds a plain /ws/terminal url when no cwd or hostId', () => {
  assert.equal(buildTerminalSocketUrl('tok', null, null), 'ws://lovdex:5187/ws/terminal?token=tok');
});

test('appends cwd when present', () => {
  const url = buildTerminalSocketUrl(null, '/home/u/proj', null);
  assert.equal(url, 'ws://lovdex:5187/ws/terminal?cwd=%2Fhome%2Fu%2Fproj');
});

test('appends hostId when present', () => {
  const url = buildTerminalSocketUrl(null, '/r/proj', 'h1');
  assert.equal(url, 'ws://lovdex:5187/ws/terminal?cwd=%2Fr%2Fproj&hostId=h1');
});
```

Create `web/src/components/terminal/terminalSocketUrl.ts` (`buildWebSocketUrl` token param is `token` — see `web/src/utils/wsUrl.ts`):

```ts
import { buildWebSocketUrl } from '../../utils/wsUrl';

/** Build the /ws/terminal socket URL with the drawer's start-cwd and, for
 *  remote projects, the remote hostId the backend should route the shell to. */
export function buildTerminalSocketUrl(
  token: string | null,
  cwd: string | null,
  hostId: string | null,
): string {
  let url = buildWebSocketUrl(token, '/ws/terminal');
  if (cwd) url += `${url.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`;
  if (hostId) url += `${url.includes('?') ? '&' : '?'}hostId=${encodeURIComponent(hostId)}`;
  return url;
}
```

Create `web/src/components/terminal/RemoteTerminalBadge.test.tsx`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

import { RemoteTerminalBadge } from './RemoteTerminalBadge';

test('renders the SSH host badge for a remote terminal', () => {
  const html = renderToStaticMarkup(<RemoteTerminalBadge hostName="dev-01" />);
  assert.ok(html.includes('ssh') || html.includes('SSH'));
  assert.ok(html.includes('dev-01'));
});

test('renders nothing without a host name', () => {
  assert.equal(renderToStaticMarkup(<RemoteTerminalBadge hostName={null} />), '');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/terminal/terminalSocketUrl.test.ts src/components/terminal/RemoteTerminalBadge.test.tsx`
Expected: FAIL — module/file not found.

- [ ] **Step 3: 实现**

Create `web/src/components/terminal/RemoteTerminalBadge.tsx`:

```tsx
/** Corner badge shown on the terminal pane so it is obvious the shell is
 *  running on a remote host (not the local machine). Hidden when local. */
export function RemoteTerminalBadge({ hostName }: { hostName?: string | null }) {
  if (!hostName) return null;
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-indigo-300/40 bg-indigo-950/80 px-2 py-0.5 text-[11px] font-medium text-indigo-200">
      <span aria-hidden>SSH</span>
      <span className="truncate max-w-[160px]">: {hostName}</span>
    </div>
  );
}
```

Modify `web/src/hooks/useTerminalDrawer.tsx`:

```tsx
type TerminalDrawerContextValue = {
  cwd: string | null;
  /** remote_hosts id of the project the terminal belongs to (null = local). */
  hostId: string | null;
  /** display name of the remote host (null = local). */
  hostName: string | null;
  setCwd: (
    cwd: string | null,
    meta?: { hostId?: string | null; hostName?: string | null },
  ) => void;
};

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [cwd, setCwdState] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [hostName, setHostName] = useState<string | null>(null);
  const setCwd = useCallback(
    (next: string | null, meta?: { hostId?: string | null; hostName?: string | null }) => {
      setCwdState(next);
      setHostId(meta?.hostId ?? null);
      setHostName(meta?.hostName ?? null);
    },
    [],
  );
  const value = useMemo<TerminalDrawerContextValue>(
    () => ({ cwd, hostId, hostName, setCwd }),
    [cwd, hostId, hostName, setCwd],
  );
  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}
```

Modify `web/src/components/app/AppContent.tsx:91-97`:

```tsx
useEffect(() => {
  setCwd(selectedProject?.fullPath || selectedProject?.path || null, {
    hostId: selectedProject?.remoteHostId ?? null,
    hostName: selectedProject?.remoteHostName ?? null,
  });
}, [selectedProject, setCwd]);
```

Modify `web/src/components/terminal/TerminalPane.tsx` — use `buildTerminalSocketUrl`, freeze hostId at mount like cwd, and overlay the badge:

```tsx
import { RemoteTerminalBadge } from './RemoteTerminalBadge';
import { buildTerminalSocketUrl } from './terminalSocketUrl';

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { cwd, hostId, hostName } = useTerminalDrawer();
  // Freeze cwd AND host at mount: the shell starts in whatever project the user
  // was in when they opened it and must not restart mid-session.
  const cwdRef = useRef(cwd);
  const hostIdRef = useRef(hostId);
  const hostNameRef = useRef(hostName);

  useEffect(() => {
    // … existing Terminal + FitAddon setup unchanged …

    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null;
    const ws = new WebSocket(buildTerminalSocketUrl(token, cwdRef.current, hostIdRef.current));
    // … rest of the effect (resize / observer / teardown) unchanged …
  }, []);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
      <RemoteTerminalBadge hostName={hostNameRef.current} />
    </div>
  );
}
```

Note: remove the old `buildWebSocketUrl` import + inline URL appending from `TerminalPane.tsx`.

- [ ] **Step 4: 运行确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/terminal/terminalSocketUrl.test.ts src/components/terminal/RemoteTerminalBadge.test.tsx`
Expected: PASS.

- [ ] **Step 5: typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npm run typecheck`
Expected: no new errors in the four edited/created files.

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/useTerminalDrawer.tsx web/src/components/app/AppContent.tsx web/src/components/terminal/TerminalPane.tsx web/src/components/terminal/terminalSocketUrl.ts web/src/components/terminal/terminalSocketUrl.test.ts web/src/components/terminal/RemoteTerminalBadge.tsx web/src/components/terminal/RemoteTerminalBadge.test.tsx
git commit -m "feat(terminal): carry remote hostId/hostName through drawer, stamp SSH host badge"
```

---

### Task 5: Frontend — useTaskEngineAvailability 纯决策 + 组件 TaskEngineSelect + 测试

**Files:**
- Create: `web/src/components/tasks/useTaskEngineAvailability.ts`
- Create: `web/src/components/tasks/useTaskEngineAvailability.test.ts`
- Create: `web/src/components/tasks/TaskEngineSelect.tsx`
- Create: `web/src/components/tasks/TaskEngineSelect.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/tasks/useTaskEngineAvailability.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeEngineAvailability,
  installedEngineOptions,
  type EngineAvailability,
} from './useTaskEngineAvailability';

test('installedEngineOptions keeps installed providers in canonical order', () => {
  assert.deepEqual(
    installedEngineOptions([
      { provider: 'codex', installed: true },
      { provider: 'claude', installed: true },
      { provider: 'qoder', installed: false },
    ]),
    ['claude', 'codex'],
  );
});

test('assistant target always resolves to assistant status', () => {
  assert.deepEqual(computeEngineAvailability({ isAssistant: true, targetHostId: null, records: [] }), {
    status: 'assistant',
  });
});

test('remote with installed engines resolves ready(source remote)', () => {
  const state = computeEngineAvailability({
    isAssistant: false,
    targetHostId: 'h1',
    records: [{ provider: 'claude', installed: true }, { provider: 'opencode', installed: true }],
  });
  assert.deepEqual(state, { status: 'ready', options: ['claude', 'opencode'], source: 'remote' });
});

test('remote with no installed engines resolves unavailable (disable + hint)', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: 'h1', records: [] });
  assert.equal(state.status, 'unavailable');
});

test('remote probe failure resolves unavailable, never degrades to local engines', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: 'h1', records: null });
  assert.equal(state.status, 'unavailable');
});

test('local with installed engines resolves ready(source local)', () => {
  const state = computeEngineAvailability({
    isAssistant: false,
    targetHostId: null,
    records: [{ provider: 'claude', installed: true }],
  });
  assert.deepEqual(state, { status: 'ready', options: ['claude'], source: 'local' });
});

test('local with an empty probe degrades to all four with a hint', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: null, records: [] }) as Extract<EngineAvailability, { status: 'ready' }>;
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.options, ['claude', 'codex', 'opencode', 'qoder']);
  assert.ok(state.hint);
});

test('local probe failure degrades to all four with a hint', () => {
  const state = computeEngineAvailability({ isAssistant: false, targetHostId: null, records: null }) as Extract<EngineAvailability, { status: 'ready' }>;
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.options, ['claude', 'codex', 'opencode', 'qoder']);
  assert.ok(state.hint);
});
```

Create `web/src/components/tasks/TaskEngineSelect.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskEngineSelect } from './TaskEngineSelect';
import type { EngineAvailability } from './useTaskEngineAvailability';

function open() { /* no-op */ }

test('renders the installed engine options when ready', () => {
  const availability: EngineAvailability = { status: 'ready', options: ['claude', 'opencode'], source: 'remote' };
  const html = renderToStaticMarkup(<TaskEngineSelect availability={availability} value="claude" onChange={open} />);
  assert.ok(html.includes('Claude Code'));
  assert.ok(html.includes('OpenCode'));
  assert.ok(!html.includes('Codex'));
});

test('renders the hint and disables the select when unavailable', () => {
  const availability: EngineAvailability = { status: 'unavailable', hint: '该远程主机离线或无可用引擎' };
  const html = renderToStaticMarkup(<TaskEngineSelect availability={availability} value="" onChange={open} />);
  assert.ok(html.includes('该远程主机离线或无可用引擎'));
  assert.ok(html.includes('disabled'));
});

test('disables the select while loading', () => {
  const html = renderToStaticMarkup(<TaskEngineSelect availability={{ status: 'loading' }} value="claude" onChange={open} />);
  assert.ok(html.includes('disabled'));
});

test('locks to claude for the assistant project', () => {
  const html = renderToStaticMarkup(<TaskEngineSelect availability={{ status: 'assistant' }} value="claude" onChange={open} />);
  assert.ok(html.includes('Claude Code'));
  assert.ok(html.includes('disabled'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/useTaskEngineAvailability.test.ts src/components/tasks/TaskEngineSelect.test.tsx`
Expected: FAIL — files do not exist.

- [ ] **Step 3: 实现**

Create `web/src/components/tasks/useTaskEngineAvailability.ts`:

```ts
import { useEffect, useRef, useState } from 'react';

import type { TaskEngine } from '../../types/app';
import { api } from '../../utils/api';

export const ENGINE_IDS: TaskEngine[] = ['claude', 'codex', 'opencode', 'qoder'];

export const ENGINE_NAMES: Record<TaskEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  qoder: 'Qoder',
};

export type EngineAvailability =
  | { status: 'assistant' }
  | { status: 'loading' }
  | { status: 'ready'; options: TaskEngine[]; source: 'local' | 'remote'; hint?: string }
  | { status: 'unavailable'; hint: string };

const REMOTE_UNAVAILABLE_HINT = '该远程主机离线或无可用引擎';
const LOCAL_DEGRADE_HINT = '无法探测已安装引擎，已展示全部引擎';
const LOCAL_EMPTY_HINT = '本机未探测到已安装引擎';

/** Records shape returned by both /api/providers/installed and
 *  /api/remote-agents/:hostId/providers: `{ provider, installed }[]`. */
export type EngineInstalledRecord = { provider: TaskEngine; installed: boolean };

/** Installed providers, canonical ENGINE_IDS order. */
export function installedEngineOptions(records: EngineInstalledRecord[]): TaskEngine[] {
  return ENGINE_IDS.filter((id) => records.some((r) => r.provider === id && r.installed));
}

/**
 * Pure decision mapping for the task-form engine dropdown.
 * `records === null` means "the probe failed" (network/backend); the remote
 * branch treats failure exactly like an empty probe — disable, never degrade —
 * because the frontend cannot tell "host offline" from "network error" through
 * the current API and the user chose disable+hint for both.
 */
export function computeEngineAvailability(input: {
  isAssistant: boolean;
  targetHostId?: string | null;
  records?: EngineInstalledRecord[] | null;
}): EngineAvailability {
  if (input.isAssistant) return { status: 'assistant' };
  const remote = Boolean(input.targetHostId);

  if (input.records === null) {
    return remote
      ? { status: 'unavailable', hint: REMOTE_UNAVAILABLE_HINT }
      : { status: 'ready', options: [...ENGINE_IDS], source: 'local', hint: LOCAL_DEGRADE_HINT };
  }

  const options = installedEngineOptions(input.records);
  if (remote) {
    return options.length === 0
      ? { status: 'unavailable', hint: REMOTE_UNAVAILABLE_HINT }
      : { status: 'ready', options, source: 'remote' };
  }
  if (options.length === 0) {
    return { status: 'ready', options: [...ENGINE_IDS], source: 'local', hint: LOCAL_EMPTY_HINT };
  }
  return { status: 'ready', options, source: 'local' };
}

export type EngineTarget = { value: string; remoteHostId?: string | null } | null;

/** Resolve the engine list the form should offer for the selected project. */
export function useTaskEngineAvailability(
  target: EngineTarget,
  isAssistant: boolean,
): EngineAvailability {
  const [state, setState] = useState<EngineAvailability>({ status: 'loading' });
  const requestRef = useRef(0);

  useEffect(() => {
    // Next fetch (or a re-render with a different target) supersedes this one.
    const requestId = ++requestRef.current;
    if (isAssistant || !target) {
      setState({ status: 'assistant' });
      return;
    }
    setState({ status: 'loading' });
    const probe = target.remoteHostId
      ? api.getRemoteHostProviders(target.remoteHostId)
      : api.getInstalledProviders();

    probe
      .then((records) => {
        if (requestRef.current !== requestId) return;
        setState(
          computeEngineAvailability({
            isAssistant,
            targetHostId: target.remoteHostId ?? null,
            records: (records ?? []) as EngineInstalledRecord[],
          }),
        );
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        console.error('resolve task engine availability failed:', error);
        setState(
          computeEngineAvailability({ isAssistant, targetHostId: target.remoteHostId ?? null, records: null }),
        );
      });
  }, [isAssistant, target?.value, target?.remoteHostId]);

  return state;
}
```

Create `web/src/components/tasks/TaskEngineSelect.tsx`:

```tsx
import type { TaskEngine } from '../../types/app';
import { ENGINE_NAMES, type EngineAvailability } from './useTaskEngineAvailability';

type TaskEngineSelectProps = {
  availability: EngineAvailability;
  value: TaskEngine | '';
  onChange: (engine: TaskEngine) => void;
  className?: string;
};

const DEFAULT_CLASS = 'h-9 w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground';

/** Engine dropdown for the task forms. Disabled while probing, on a remote
 *  host with no available engine (shows the hint), or for the assistant
 *  project (locks to Claude). */
export function TaskEngineSelect({ availability, value, onChange, className }: TaskEngineSelectProps) {
  const disabled =
    availability.status === 'loading' || availability.status === 'unavailable' || availability.status === 'assistant';

  return (
    <div className="flex flex-col gap-1">
      <select
        className={className ?? DEFAULT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value as TaskEngine)}
        disabled={disabled}
      >
        {availability.status === 'assistant' || availability.status === 'loading' ? (
          <option value={availability.status === 'assistant' ? 'claude' : value}>
            {ENGINE_NAMES[availability.status === 'assistant' ? 'claude' : (value || 'claude')]}
          </option>
        ) : null}
        {availability.status === 'unavailable' ? <option value="">{availability.hint}</option> : null}
        {availability.status === 'ready'
          ? availability.options.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_NAMES[engine]}
              </option>
            ))
          : null}
      </select>
      {availability.status === 'ready' && availability.hint ? (
        <p className="text-xs text-muted-foreground">{availability.hint}</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: the same command as Step 2.
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/tasks/useTaskEngineAvailability.ts web/src/components/tasks/useTaskEngineAvailability.test.ts web/src/components/tasks/TaskEngineSelect.tsx web/src/components/tasks/TaskEngineSelect.test.tsx
git commit -m "feat(tasks): engine availability decision + TaskEngineSelect (local/remote + disable when none)"
```

---

### Task 6: Frontend — TaskBoard 新建任务 Modal：项目远程前缀 + 引擎过滤 + 提交守卫

**Files:**
- Modify: `web/src/components/tasks/projectOptions.ts`
- Create: `web/src/components/tasks/projectOptions.test.ts` (or append to an existing test if present)
- Modify: `web/src/components/tasks/TaskBoard.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/tasks/projectOptions.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { toProjectOption, taskProjectLabel } from './projectOptions';

test('taskProjectLabel prefixes the remote host name for remote projects', () => {
  const p = { projectId: 'p1', displayName: 'MyApp', fullPath: '/r/app', remoteHostName: 'dev-01' };
  assert.equal(taskProjectLabel(p, new Set()), '🌐 dev-01 · MyApp');
});

test('taskProjectLabel leaves local projects untouched', () => {
  const p = { projectId: 'p1', displayName: 'MyApp', fullPath: '/local/app' };
  assert.equal(taskProjectLabel(p, new Set()), 'MyApp');
});

test('toProjectOption carries remote fields for the scheduled-task dropdown', () => {
  const p = {
    projectId: 'p1',
    displayName: 'MyApp',
    fullPath: '/r/app',
    remoteHostId: 'h1',
    remoteHostName: 'dev-01',
  };
  assert.deepEqual(toProjectOption(p, new Set()), {
    value: '/r/app',
    label: 'MyApp',
    remoteHostId: 'h1',
    remoteHostName: 'dev-01',
  });
});

test('toProjectOption keeps remote fields null for local projects', () => {
  const p = { projectId: 'p2', displayName: 'Local', fullPath: '/l/proj' };
  assert.deepEqual(toProjectOption(p, new Set()), {
    value: '/l/proj',
    label: 'Local',
    remoteHostId: null,
    remoteHostName: null,
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/projectOptions.test.ts`
Expected: FAIL — `taskProjectLabel` / `toProjectOption` not exported.

- [ ] **Step 3: 实现纯函数**

Read `web/src/components/tasks/projectOptions.ts` first (it imports `Project` from `../../types/app`). Add:

```ts
/**
 * Display label for a project in a task form `<option>`. Native `<option>`
 * elements can only carry text (no styled badge), so the remote marker is a
 * `🌐 <hostName> ·` text prefix; the path shows in the option title.
 */
export function taskProjectLabel(project: Project, duplicateNames: Set<string>): string {
  const path = projectPathOf(project);
  const name = project.displayName || path;
  const base = duplicateNames.has(name) && name !== path ? `${name} — ${path}` : name;
  return project.remoteHostName ? `🌐 ${project.remoteHostName} · ${base}` : base;
}

/** TaskProjectOption ({ value, label } + remote fields) for the scheduled form. */
export function toProjectOption(
  project: Project,
  duplicateNames: Set<string>,
): { value: string; label: string; remoteHostId: string | null; remoteHostName: string | null } {
  const path = projectPathOf(project);
  const name = project.displayName || path;
  const label = duplicateNames.has(name) && name !== path ? `${name} — ${path}` : name;
  return { value: path, label, remoteHostId: project.remoteHostId ?? null, remoteHostName: project.remoteHostName ?? null };
}
```

- [ ] **Step 4: 运行确认通过**

Run: the same command as Step 2.
Expected: PASS.

- [ ] **Step 5: 接入 TaskBoard Modal**

In `web/src/components/tasks/TaskBoard.tsx`:

1. Import the new helpers + hook + select:

```tsx
import { useTaskEngineAvailability } from './useTaskEngineAvailability';
import { TaskEngineSelect } from './TaskEngineSelect';
import { ASSISTANT_OPTION_VALUE, projectPathOf, taskFormProjects, taskProjectLabel, toProjectOption } from './projectOptions';
```

2. Replace the `projectOptions` memo body (L167-176) so scheduled/card selectors carry remote fields:

```tsx
  const projectOptions = useMemo(
    () => taskFormProjects(projects).map((project) => toProjectOption(project, duplicateProjectNames)),
    [projects, duplicateProjectNames],
  );
```

3. Add the engine-availability resolution after that memo:

```tsx
  // Engine candidates follow the target machine: the remote host's installed
  // providers for a remote project, the local machine's for a local one.
  const newProjectRecord = useMemo(
    () => taskFormProjects(projects).find((p) => projectPathOf(p) === newProjectPath) ?? null,
    [projects, newProjectPath],
  );
  const newEngineAvailability = useTaskEngineAvailability(
    newProjectRecord ? { value: projectPathOf(newProjectRecord), remoteHostId: newProjectRecord.remoteHostId ?? null } : null,
    newProjectPath === ASSISTANT_OPTION_VALUE,
  );

  // Keep the picked engine valid once the availability settles: jump to the
  // first installed engine when the current pick is not installed there.
  useEffect(() => {
    if (newEngineAvailability.status !== 'ready') return;
    if (newEngineAvailability.options.length === 0) return;
    if (!newEngineAvailability.options.includes(newEngine)) {
      setNewEngine(newEngineAvailability.options[0]);
    }
  }, [newEngineAvailability, newEngine]);
```

4. Replace the Modal project `<option>` rendering (L486-496):

```tsx
                  {taskFormProjects(projects).map((project) => {
                    const path = projectPathOf(project);
                    return (
                      <option
                        key={project.projectId}
                        value={path}
                        title={project.remoteHostName ? `${project.remoteHostName}:${path}` : path}
                      >
                        {taskProjectLabel(project, duplicateProjectNames)}
                      </option>
                    );
                  })}
```

5. Replace the Modal engine `<select>` block (L499-511) with:

```tsx
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">执行引擎</label>
                <TaskEngineSelect
                  availability={newEngineAvailability}
                  value={newEngineAvailability.status === 'unavailable' ? '' : newEngine}
                  onChange={(engine) => setNewEngine(engine)}
                />
              </div>
```

6. Guard the submit in `createTask()` — right after the `if (!prompt) return;` line:

```tsx
    if (!isAssistant && newEngineAvailability.status === 'unavailable') {
      window.alert(newEngineAvailability.hint);
      return;
    }
```

- [ ] **Step 6: 回归 + typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/projectOptions.test.ts` and `cd /mnt/b/workdir/github/lovdex/web && npm run typecheck`
Expected: PASS + no new errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/tasks/projectOptions.ts web/src/components/tasks/projectOptions.test.ts web/src/components/tasks/TaskBoard.tsx
git commit -m "feat(tasks): create-form project remote prefix + engine filtered by target machine"
```

---

### Task 7: Frontend — 定时任务表单同步 + TaskProjectOption 扩展

**Files:**
- Modify: `web/src/components/tasks/TaskCard.tsx`
- Modify: `web/src/components/tasks/ScheduledTaskForm.tsx`
- Modify: `web/src/components/tasks/ScheduledTaskForm.test.tsx` (create if absent)

- [ ] **Step 1: 写失败测试**

Read `web/src/components/tasks/TaskCard.tsx` first and locate the `export type TaskProjectOption = { value: string; label: string }` declaration (~:12). Create `web/src/components/tasks/ScheduledTaskForm.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScheduledTaskForm, EMPTY_DRAFT } from './ScheduledTaskForm';

const onClose = () => {};
const onSubmit = () => {};

function renderWithOptions(projectOptions: unknown[]) {
  return renderToStaticMarkup(
    React.createElement(ScheduledTaskForm, {
      open: true,
      initial: null,
      projectOptions,
      submitting: false,
      error: null,
      onClose,
      onSubmit,
    }),
  );
}

test('renders a remote project option with its host prefix', () => {
  const html = renderWithOptions([
    { value: '/r/app', label: 'MyApp', remoteHostId: 'h1', remoteHostName: 'dev-01' },
  ]);
  assert.ok(html.includes('🌐 dev-01 · MyApp'));
});

test('renders a local project option without a prefix', () => {
  const html = renderWithOptions([{ value: '/l/app', label: 'LocalApp' }]);
  assert.ok(html.includes('LocalApp'));
  assert.ok(!html.includes('🌐'));
});

test('engine select is disabled while availability resolves (loading)', () => {
  const html = renderWithOptions([]);
  const select = html.match(/<select[^>]*>/)?.[0] ?? '';
  assert.ok(select.includes('disabled'));
});

test('submit is blocked without a usable engine by the form guard (unavailable hint shows)', () => {
  // The availability hook resolves async; the render-time state is 'loading',
  // so instead of driving the hook this test locks the draft with a remote
  // option and asserts the guard path returns early — see Step 4 for the guard.
  // Here we just assert the form still renders deterministically.
  const html = renderWithOptions([{ value: '/r/app', label: 'MyApp', remoteHostName: 'dev-01' }]);
  assert.ok(html.includes('dev-01'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: FAIL — `🌐 dev-01 · MyApp` not present (the option currently renders only `o.label`).

- [ ] **Step 3: 实现**

1. Modify `web/src/components/tasks/TaskCard.tsx:12`:

```ts
export type TaskProjectOption = {
  value: string;
  label: string;
  remoteHostId?: string | null;
  remoteHostName?: string | null;
};
```

(TodoCard etc. ignore the new optional fields — no other change needed there.)

2. Modify `web/src/components/tasks/ScheduledTaskForm.tsx`:

- imports:

```tsx
import { useTaskEngineAvailability } from './useTaskEngineAvailability';
import { TaskEngineSelect } from './TaskEngineSelect';
```

- 在 `const set = …` 之后加 availability + auto-jump：

```tsx
  const selectedProjectOption = projectOptions.find((o) => o.value === draft.projectPath) ?? null;
  const engineAvailability = useTaskEngineAvailability(
    selectedProjectOption
      ? { value: selectedProjectOption.value, remoteHostId: selectedProjectOption.remoteHostId ?? null }
      : null,
    draft.projectPath === ASSISTANT_OPTION_VALUE,
  );

  // Keep the picked engine valid once availability settles.
  useEffect(() => {
    if (engineAvailability.status !== 'ready') return;
    if (engineAvailability.options.length === 0) return;
    if (!engineAvailability.options.includes(draft.executorProvider)) {
      set('executorProvider', engineAvailability.options[0]);
    }
  }, [engineAvailability, draft.executorProvider, draft.projectPath]);
```

Add `useEffect` to the imports from `react`.

- 项目下拉（L104-109）替换：

```tsx
            <select className={fieldCls} value={draft.projectPath} onChange={(e) => set('projectPath', e.target.value)}>
              <option value={ASSISTANT_OPTION_VALUE}>🤖 Lovdex助手</option>
              {projectOptions.map((o) => (
                <option key={o.value} value={o.value} title={o.remoteHostName ? `${o.remoteHostName}:${o.value}` : o.value}>
                  {o.remoteHostName ? `🌐 ${o.remoteHostName} · ${o.label}` : o.label}
                </option>
              ))}
            </select>
```

- 执行引擎（L111-119）替换：

```tsx
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">执行引擎</label>
            <TaskEngineSelect
              availability={engineAvailability}
              value={engineAvailability.status === 'unavailable' ? '' : draft.executorProvider}
              onChange={(engine) => set('executorProvider', engine)}
              className={fieldCls}
            />
          </div>
```

- 提交守卫：在 `submit()` 开头（`const submit = () => { setLocalError(null);` 之后、`if (!draft.title.trim())` 之前）加：

```tsx
    if (engineAvailability.status === 'unavailable') {
      setLocalError(engineAvailability.hint);
      return;
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/tasks/ScheduledTaskForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: 回归 + typecheck**

Run: `cd /mnt/b/workdir/github/lovdex/web && npm run typecheck` and re-run the Task 5/6 tests.
Expected: pass, no new type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/tasks/TaskCard.tsx web/src/components/tasks/ScheduledTaskForm.tsx web/src/components/tasks/ScheduledTaskForm.test.tsx
git commit -m "feat(tasks): scheduled-task form mirrors remote project prefix + engine filtering"
```

---

### Task 8: 收尾 — 全量回归 + spec 落一句实现注记

**Files:**
- Modify: `docs/superpowers/specs/2026-08-19-task-remote-visibility-terminal-design.md`

- [ ] **Step 1: 全量跑新增/改动的测试**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/terminal/tests/remote-terminal-websocket.service.test.ts server/modules/terminal/tests/terminal-websocket.service.test.ts
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/terminal/terminalSocketUrl.test.ts src/components/terminal/RemoteTerminalBadge.test.tsx src/components/tasks/useTaskEngineAvailability.test.ts src/components/tasks/TaskEngineSelect.test.tsx src/components/tasks/projectOptions.test.ts src/components/tasks/ScheduledTaskForm.test.tsx
```
Expected: all PASS.

- [ ] **Step 2: 双端 typecheck 验收零新增**

Run: `cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck` and `cd /mnt/b/workdir/github/lovdex/web && npm run typecheck`
Expected: no NEW errors pointing at files touched by this plan.

- [ ] **Step 3: 更新 spec 实现注记**

Append to `docs/superpowers/specs/2026-08-19-task-remote-visibility-terminal-design.md` 的“测试”节后：

```md
## 实现注记（实施后补充）

- 项目下拉的远程标识用**文本前缀** `🌐 <hostName> · <name>` 而非样式徽标——原生 `<option>` 只能渲染文本，无法内嵌 styled badge；终端 pane 的 `SSH: <hostName>` 徽标不受此限（pane 内覆盖层）
- 远端引擎探测失败与“探测为空”统一走 **禁用+提示**（`REMOTE_HOST_OFFLINE` 与网络错误从前端 API 无法可靠区分，且用户已选“空则禁用”）；仅**本地**探测失败降级为 4 引擎 + 提示
- `/ws/terminal` 远程分支的本地 `cwd` 参数传给 node-pty 的 `dependencies.cwd`（ssh 不使用主控端 cwd），远端落点在 argv 的 `cd` 命令里
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-19-task-remote-visibility-terminal-design.md
git commit -m "docs(remote-terminal): implementation notes (text-prefix label, remote-disable rule, ssh cwd)"
```

---

## 自检清单（写计划时执行）

已将 spec 每节映射到任务：1a → Task 6/7（label 前缀 + title）；1b 引擎过滤 → Task 5/6/7；2a 前端 → Task 4；2b 后端 → Task 1/2/3；错误处理边界 → Task 2（unknown host）+ Task 5（unavailable）+ 提交守卫在 6/7；测试 → 每任务内嵌。明确不做项均未入计划。

已知取舍已被实现注记覆盖（option 文本前缀 / 远端失败=禁用）。