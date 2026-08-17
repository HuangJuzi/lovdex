# Lovdex 侧滑终端抽屉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lovdex 加一个全局侧滑终端抽屉（xterm.js + node-pty + 现有 ws），让用户在新建任务前能手动 `git pull` 等 shell 操作。

**Architecture:** 前端 `@xterm/xterm` + `@xterm/addon-fit` 渲染终端，后端 `node-pty` 起真 PTY shell；复用现有 `ws` 网关新增 `/ws/terminal` 通道（认证复用统一 `verifyClient`，零新增鉴权）。抽屉挂载在 App 顶层，打开时挂载 `TerminalPane` 连 WS，关闭时卸载并断开（后端杀 PTY）。

**Tech Stack:** React + Vite + Tailwind（前端）；Express + ws + node-pty + tsx / node:test（后端）。

**设计文档：** `docs/superpowers/specs/2026-08-13-terminal-drawer-design.md`

---

## 仓库与命令约定

- 两个独立 git 仓库，都在 `main` 分支、工作区干净。
  - 后端：`/mnt/b/workdir/github/lovdex/lovdex-backend`
  - 前端：`/mnt/b/workdir/github/lovdex/lovdex-cli`
- **后端测试**（node:test + tsx，`@/` 路径由 server/tsconfig.json 解析）：

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/terminal/tests/terminal-websocket.service.test.ts
  ```

- **前端测试**（node:test + tsx；必须 `unset TSX_TSCONFIG_PATH`，否则会误用后端的 tsconfig）：

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/utils/wsUrl.test.ts src/hooks/useTerminalDrawer.test.ts src/components/terminal/terminalSession.test.ts src/components/terminal/TerminalToggleButton.test.tsx src/components/terminal/TerminalDrawerPanel.test.tsx
  ```

- **类型检查：**
  - 后端：`cd lovdex-backend && TSX_TSCONFIG_PATH=server/tsconfig.json npm run typecheck`（存量已有 TS 错误，只确保**不新增**错误）
  - 前端：`cd lovdex-cli && env -u TSX_TSCONFIG_PATH npm run typecheck`

---

## 后端（lovdex-backend）

### Task 1: 安装 node-pty 并冒烟验证

**Files:**
- Modify: `lovdex-backend/package.json`

- [ ] **Step 1: 安装依赖**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  npm install node-pty
  ```

  node-pty 是原生模块：Linux x64 会下载预编译二进制；若编译失败，错误信息会给出需要 `python3`/`make`/`g++` 的提示。

- [ ] **Step 2: 冒烟验证 node-pty 能 spawn**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  node -e "const pty=require('node-pty'); const p=pty.spawn('echo',['node-pty-ok'],{name:'xterm-color',env:process.env}); p.onData(d=>process.stdout.write(d)); p.onExit(()=>process.exit(0));"
  ```

  预期输出包含 `node-pty-ok`。若输出为空或报错，停止并排查原生模块编译。

- [ ] **Step 3: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  git add package.json package-lock.json
  git commit -m "chore(terminal): add node-pty dependency

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 2: 终端 WebSocket 连接服务（TDD）

**Files:**
- Create: `lovdex-backend/server/modules/terminal/terminal-websocket.service.ts`
- Create: `lovdex-backend/server/modules/terminal/index.ts`
- Test: `lovdex-backend/server/modules/terminal/tests/terminal-websocket.service.test.ts`

- [ ] **Step 1: 写失败测试**

  创建 `server/modules/terminal/tests/terminal-websocket.service.test.ts`：

  ```ts
  import assert from 'node:assert/strict';
  import test from 'node:test';

  import { handleTerminalConnection, type PtyLike } from '@/modules/terminal/terminal-websocket.service.js';
  import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

  const fakeRequest = {} as AuthenticatedWebSocketRequest;

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

  type WsEvent = 'message' | 'close' | 'error';

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

  test('spawns a PTY with the configured shell and cwd', () => {
    const pty = makeFakePty();
    let captured: unknown = null;
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, {
      spawnPty: (shell, args, options) => { captured = { shell, args, options }; return pty; },
      shell: '/bin/zsh',
      cwd: '/workspace',
    });
    assert.deepEqual(captured, {
      shell: '/bin/zsh',
      args: [],
      options: { cwd: '/workspace', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' } },
    });
  });

  test('forwards input messages to the pty', () => {
    const pty = makeFakePty();
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\r' })));
    assert.deepEqual(pty.state.written, ['ls\r']);
  });

  test('sends pty output to the client', () => {
    const pty = makeFakePty();
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
    pty.emitData('hello\n');
    assert.deepEqual(ws.state.sent, [JSON.stringify({ type: 'output', data: 'hello\n' })]);
  });

  test('forwards resize and ignores invalid sizes', () => {
    const pty = makeFakePty();
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 0, rows: -5 })));
    assert.deepEqual(pty.state.resized, [[120, 40]]);
  });

  test('sends exit and closes the socket when the pty exits', () => {
    const pty = makeFakePty();
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
    pty.emitExit(0);
    assert.ok(ws.state.sent.includes(JSON.stringify({ type: 'exit', code: 0 })));
    assert.equal(ws.state.closed, true);
  });

  test('kills the pty when the socket closes', () => {
    const pty = makeFakePty();
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, { spawnPty: () => pty, shell: 'bash', cwd: '/' });
    ws.emit('close');
    assert.equal(pty.state.killed, true);
  });

  test('sends an error and closes when spawn fails', () => {
    const ws = makeFakeWs();
    handleTerminalConnection(ws, fakeRequest, {
      spawnPty: () => { throw new Error('boom'); },
      shell: 'bash',
      cwd: '/',
    });
    assert.ok(ws.state.sent.some((m) => m.includes('failed to spawn shell')));
    assert.equal(ws.state.closed, true);
  });
  ```

- [ ] **Step 2: 运行测试，确认失败（模块不存在）**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/terminal/tests/terminal-websocket.service.test.ts
  ```

  预期：FAIL，错误为找不到 `@/modules/terminal/terminal-websocket.service.js`。

- [ ] **Step 3: 实现服务**

  创建 `server/modules/terminal/terminal-websocket.service.ts`：

  ```ts
  import type { WebSocket } from 'ws';

  import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

  /** Minimal surface of node-pty's spawned process this module depends on. */
  export type PtyLike = {
    onData: (cb: (data: string) => void) => void;
    onExit: (cb: (info: { exitCode: number }) => void) => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
  };

  export type PtySpawner = (
    shell: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; env: Record<string, string> },
  ) => PtyLike;

  export type TerminalDependencies = {
    spawnPty: PtySpawner;
    shell: string;
    cwd: string;
  };

  const INITIAL_COLS = 80;
  const INITIAL_ROWS = 24;

  type ClientMessage = { type: string; data?: unknown; cols?: unknown; rows?: unknown };

  function parseMessage(raw: WebSocket.RawData): ClientMessage | null {
    try {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      return {
        type: typeof parsed.type === 'string' ? parsed.type : '',
        data: parsed.data,
        cols: parsed.cols,
        rows: parsed.rows,
      };
    } catch {
      return null;
    }
  }

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  /**
   * Handles a single /ws/terminal connection: spawns one PTY, pipes the client's
   * input/resize frames into it and its output back out. Closing the socket kills
   * the PTY; PTY exit closes the socket.
   */
  export function handleTerminalConnection(
    ws: WebSocket,
    _request: AuthenticatedWebSocketRequest,
    dependencies: TerminalDependencies,
  ): void {
    let pty: PtyLike;
    try {
      pty = dependencies.spawnPty(dependencies.shell, [], {
        cwd: dependencies.cwd,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
      });
    } catch {
      send(ws, { type: 'error', message: 'failed to spawn shell' });
      ws.close();
      return;
    }

    pty.onData((data) => {
      send(ws, { type: 'output', data });
    });

    pty.onExit(({ exitCode }) => {
      send(ws, { type: 'exit', code: exitCode });
      ws.close();
    });

    ws.on('message', (raw) => {
      const message = parseMessage(raw);
      if (!message) return;
      if (message.type === 'input' && typeof message.data === 'string') {
        pty.write(message.data);
      } else if (message.type === 'resize') {
        const cols = Number(message.cols);
        const rows = Number(message.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
          pty.resize(cols, rows);
        }
      }
    });

    ws.on('close', () => pty.kill());
    ws.on('error', () => pty.kill());
  }
  ```

  创建 `server/modules/terminal/index.ts`：

  ```ts
  export { handleTerminalConnection } from './terminal-websocket.service.js';
  export type { TerminalDependencies, PtyLike, PtySpawner } from './terminal-websocket.service.js';
  ```

- [ ] **Step 4: 运行测试，确认通过**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/terminal/tests/terminal-websocket.service.test.ts
  ```

  预期：`pass 7`，`fail 0`。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  git add server/modules/terminal/
  git commit -m "feat(terminal): add terminal websocket connection handler

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 3: 把 `/ws/terminal` 路由接入 WS 网关

**Files:**
- Modify: `lovdex-backend/server/modules/websocket/services/websocket-server.service.ts`
- Modify: `lovdex-backend/server/index.js`

- [ ] **Step 1: 修改 `websocket-server.service.ts` 的路由**

  在文件顶部 import 区加入：

  ```ts
  import { handleTerminalConnection } from '@/modules/terminal/index.js';
  ```

  把 `WebSocketServerDependencies` 类型改为：

  ```ts
  type WebSocketServerDependencies = {
    verifyClient: Parameters<typeof verifyWebSocketClient>[1];
    chat: Parameters<typeof handleChatConnection>[2];
    terminal: Parameters<typeof handleTerminalConnection>[2];
  };
  ```

  在 `connection` 处理器中、`/ws` 分支之后加入：

  ```ts
  if (pathname === '/ws/terminal') {
    handleTerminalConnection(ws, incomingRequest, dependencies.terminal);
    return;
  }
  ```

- [ ] **Step 2: 在 `server/index.js` 装配 terminal 依赖**

  在文件顶部 import 区加入（在已有 `import * as pty` 之前/之后皆可）：

  ```js
  import * as pty from 'node-pty';
  ```

  修改 `createWebSocketServer(server, {...})` 调用，在 `chat` 配置后新增 `terminal`：

  ```js
  const wss = createWebSocketServer(server, {
      verifyClient: {
          isPlatform: IS_PLATFORM,
          authenticateWebSocket,
      },
      chat: {
          spawnFns,
          abortFns: {
              claude: abortClaudeSDKSession,
              codex: abortCodexSession,
              sophcode: abortSophcodeSession,
          },
          resolveToolApproval,
          getPendingApprovalsForSession,
      },
      terminal: {
          spawnPty: (shell, args, options) => pty.spawn(shell, args, options),
          shell: process.env.SHELL || '/bin/bash',
          cwd: WORKSPACES_ROOT,
      },
  });
  ```

  `WORKSPACES_ROOT` 已在 `server/index.js:15` 从 `@/shared/utils.js` 导入。

- [ ] **Step 3: 重启后端并手工验证路由可达**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx server/index.js &
  sleep 2
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/ws/terminal" || true
  kill %1
  ```

  预期：WebSocket 升级路径会返回 400/404 之类的非 200 即说明 HTTP 层已路由到该路径（浏览器/ws 客户端升级才能建立连接，curl 不能完成握手是正常的）。关键是无 "Unknown WebSocket path" 告警指向 `/ws/terminal` 被兜底关闭——用真实 ws 客户端验证（见 Step 4）。

- [ ] **Step 4: 用脚本验证一次真实终端往返**

  创建临时脚本 `/tmp/terminal-smoke.mjs`：

  ```js
  import WebSocket from 'ws';

  const url = 'ws://localhost:3001/ws/terminal';
  const ws = new WebSocket(url);
  const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 5000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'input', data: 'echo terminal-ok\r' }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'output' && String(msg.data).includes('terminal-ok')) {
      console.log('SMOKE OK');
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
  });
  ws.on('error', (err) => { console.error('WS ERROR', err.message); process.exit(1); });
  ```

  先启动后端：

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx server/index.js &
  sleep 2
  node /tmp/terminal-smoke.mjs
  kill %1
  ```

  预期输出：`SMOKE OK`。`/tmp/terminal-smoke.mjs` 是临时文件，测试后可删。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  git add server/modules/websocket/services/websocket-server.service.ts server/index.js
  git commit -m "feat(terminal): wire /ws/terminal into websocket gateway

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 4: 后端类型检查确认不新增错误

> 前置情况：Task 2 的测试文件 `terminal-websocket.service.test.ts` 里 fake ws 不满足 `ws.WebSocket` 类型，会报 7 个 TS2345。本任务先把这些修掉（只改测试文件），使 `server/modules/terminal/` 类型干净，再跑 typecheck 验收。

**Files:**
- Modify: `lovdex-backend/server/modules/terminal/tests/terminal-websocket.service.test.ts`

- [ ] **Step 1: 修掉测试文件的 fake-ws 类型错误**

  在 `terminal-websocket.service.test.ts` 顶部 import 区加：

  ```ts
  import type { WebSocket } from 'ws';
  ```

  在 `makeFakeWs` 函数定义之后加：

  ```ts
  /** The fake exposes extra helpers (emit/state); cast to ws.WebSocket for the handler param. */
  function asSocket(fake: ReturnType<typeof makeFakeWs>): WebSocket {
    return fake as unknown as WebSocket;
  }
  ```

  把全部 7 处 `handleTerminalConnection(ws,` 调用改为 `handleTerminalConnection(asSocket(ws),`（保留其余参数不变）。

- [ ] **Step 2: 跑测试确认行为不变**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/terminal/tests/terminal-websocket.service.test.ts
  ```

  预期：`pass 7`，`fail 0`。

- [ ] **Step 3: 跑 typecheck 验收**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json npx tsc --noEmit -p server/tsconfig.json 2>&1
  ```

  **验收标准：没有任何指向 `server/modules/terminal/` 或 `server/modules/websocket/services/websocket-server.service.ts` 的错误**。允许残留的只有存量错误（如 `server/modules/operators/tests/` 下的 2 个，与本任务无关，不要修）。

- [ ] **Step 4: 跑后端相关测试确认无回归**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/terminal/tests/terminal-websocket.service.test.ts server/modules/websocket/tests/headless-task-run.test.ts
  ```

  预期：全部 pass。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend
  git add server/modules/terminal/tests/terminal-websocket.service.test.ts
  git commit -m "test(terminal): make fake ws type-clean for tsc

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

---

## 前端（lovdex-cli）

### Task 5: 安装 xterm 依赖

**Files:**
- Modify: `lovdex-cli/package.json`

- [ ] **Step 1: 安装**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  npm install @xterm/xterm @xterm/addon-fit
  ```

- [ ] **Step 2: 验证能在 Node 下 import（测试依赖此行为）**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx -e "import('@xterm/xterm').then(() => import('@xterm/addon-fit')).then(() => { console.log('xterm imports ok'); }).catch((e) => { console.error('FAIL', e.message); process.exit(1); })"
  ```

  预期输出：`xterm imports ok`。若失败，停下来报告——不要跳过。

- [ ] **Step 3: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add package.json package-lock.json
  git commit -m "chore(terminal): add @xterm/xterm and @xterm/addon-fit

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 6: `buildWebSocketUrl` 支持自定义路径（TDD）

**Files:**
- Modify: `lovdex-cli/src/utils/wsUrl.ts`
- Test: `lovdex-cli/src/utils/wsUrl.test.ts`

- [ ] **Step 1: 在 `wsUrl.test.ts` 追加两个测试**

  ```ts
  test('custom pathname is honored', () => {
    assert.equal(buildWebSocketUrl('abc', '/ws/terminal'), 'wss://lovdex.example.com/ws/terminal?token=abc');
  });

  test('pathname defaults to /ws', () => {
    assert.equal(buildWebSocketUrl('abc'), 'wss://lovdex.example.com/ws?token=abc');
  });
  ```

- [ ] **Step 2: 运行测试，确认失败**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/utils/wsUrl.test.ts
  ```

  预期：`custom pathname is honored` 失败（当前函数硬编码 `/ws`）。

- [ ] **Step 3: 修改 `src/utils/wsUrl.ts`**

  把签名与两个分支的 URL 拼接改为接收 `pathname`：

  ```ts
  export function buildWebSocketUrl(token?: string | null, pathname = '/ws'): string {
    const wsBase = API_BASE_URL
      ? (() => {
          const httpUrl = new URL(API_BASE_URL);
          const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
          return `${protocol}//${httpUrl.host}${pathname}`;
        })()
      : (() => {
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          return `${protocol}//${window.location.host}${pathname}`;
        })();
    return token ? `${wsBase}?token=${encodeURIComponent(token)}` : wsBase;
  }
  ```

- [ ] **Step 4: 运行测试，确认通过**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/utils/wsUrl.test.ts
  ```

  预期：`pass 5`。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/utils/wsUrl.ts src/utils/wsUrl.test.ts
  git commit -m "feat(terminal): let buildWebSocketUrl target a custom path

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 7: 终端抽屉 context + 快捷键（TDD）

**Files:**
- Create: `lovdex-cli/src/hooks/useTerminalDrawer.tsx`
- Test: `lovdex-cli/src/hooks/useTerminalDrawer.test.ts`

- [ ] **Step 1: 写失败测试（纯函数 `isTerminalShortcut`）**

  创建 `src/hooks/useTerminalDrawer.test.ts`：

  ```ts
  import assert from 'node:assert/strict';
  import test from 'node:test';

  import { isTerminalShortcut } from './useTerminalDrawer';

  test('matches Ctrl+`', () => {
    assert.equal(isTerminalShortcut({ ctrlKey: true, altKey: false, metaKey: false, key: '`' }), true);
  });

  test('rejects a plain backtick without Ctrl', () => {
    assert.equal(isTerminalShortcut({ ctrlKey: false, altKey: false, metaKey: false, key: '`' }), false);
  });

  test('rejects Ctrl+Shift+` (key becomes ~)', () => {
    assert.equal(isTerminalShortcut({ ctrlKey: true, altKey: false, metaKey: false, key: '~' }), false);
  });
  ```

- [ ] **Step 2: 运行测试，确认失败**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/hooks/useTerminalDrawer.test.ts
  ```

  预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现**

  创建 `src/hooks/useTerminalDrawer.tsx`：

  ```tsx
  import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

  export function isTerminalShortcut(event: { ctrlKey: boolean; altKey: boolean; metaKey: boolean; key: string }): boolean {
    return event.ctrlKey && !event.altKey && !event.metaKey && event.key === '`';
  }

  type TerminalDrawerContextValue = {
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
  };

  const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

  export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const toggle = useCallback(() => setOpen((prev) => !prev), []);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (isTerminalShortcut(event)) {
          event.preventDefault();
          setOpen((prev) => !prev);
        }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    const value = useMemo<TerminalDrawerContextValue>(() => ({ open, setOpen, toggle }), [open, toggle]);
    return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
  }

  export function useTerminalDrawer(): TerminalDrawerContextValue {
    const context = useContext(TerminalDrawerContext);
    if (!context) throw new Error('useTerminalDrawer must be used within TerminalDrawerProvider');
    return context;
  }
  ```

- [ ] **Step 4: 运行测试，确认通过**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/hooks/useTerminalDrawer.test.ts
  ```

  预期：`pass 3`。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/hooks/useTerminalDrawer.tsx src/hooks/useTerminalDrawer.test.ts
  git commit -m "feat(terminal): add terminal drawer context and shortcut

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 8: 终端会话控制器（TDD）

**Files:**
- Create: `lovdex-cli/src/components/terminal/terminalSession.ts`
- Test: `lovdex-cli/src/components/terminal/terminalSession.test.ts`

- [ ] **Step 1: 写失败测试**

  创建 `src/components/terminal/terminalSession.test.ts`：

  ```ts
  import assert from 'node:assert/strict';
  import test from 'node:test';

  import { createTerminalSession } from './terminalSession';

  function makeFakeTerm(writes: string[]) {
    let onDataCb: ((d: string) => void) | null = null;
    return {
      disposed: false,
      onData(cb: (d: string) => void) { onDataCb = cb; },
      write(d: string) { writes.push(d); },
      dispose() { this.disposed = true; },
      emitData(d: string) { onDataCb?.(d); },
    };
  }

  function makeFakeWs(sent: string[]) {
    const listeners = new Map<string, Array<(evt: { data: unknown }) => void>>();
    return {
      readyState: 1,
      send(d: string) { sent.push(d); },
      close() {},
      addEventListener(type: string, cb: (evt: { data: unknown }) => void) {
        const arr = listeners.get(type) ?? [];
        arr.push(cb);
        listeners.set(type, arr);
      },
      removeEventListener(type: string, cb: (evt: { data: unknown }) => void) {
        const arr = listeners.get(type) ?? [];
        listeners.set(type, arr.filter((x) => x !== cb));
      },
      emitMessage(raw: string) {
        for (const cb of listeners.get('message') ?? []) cb({ data: raw });
      },
    };
  }

  test('forwards terminal input to the socket as input frames', () => {
    const writes: string[] = [];
    const sent: string[] = [];
    const term = makeFakeTerm(writes);
    const ws = makeFakeWs(sent);
    const session = createTerminalSession(term, ws as never);
    term.emitData('echo hi\r');
    assert.deepEqual(sent, [JSON.stringify({ type: 'input', data: 'echo hi\r' })]);
    session.dispose();
  });

  test('writes output frames into the terminal', () => {
    const writes: string[] = [];
    const sent: string[] = [];
    const term = makeFakeTerm(writes);
    const ws = makeFakeWs(sent);
    createTerminalSession(term, ws as never);
    ws.emitMessage(JSON.stringify({ type: 'output', data: 'hi\n' }));
    assert.deepEqual(writes, ['hi\n']);
  });

  test('resize sends a resize frame', () => {
    const sent: string[] = [];
    const term = makeFakeTerm([]);
    const ws = makeFakeWs(sent);
    const session = createTerminalSession(term, ws as never);
    session.resize(120, 40);
    assert.deepEqual(sent, [JSON.stringify({ type: 'resize', cols: 120, rows: 40 })]);
    session.dispose();
  });

  test('dispose closes the socket and disposes the terminal', () => {
    const sent: string[] = [];
    const term = makeFakeTerm([]);
    const ws = makeFakeWs(sent);
    const session = createTerminalSession(term, ws as never);
    session.dispose();
    session.dispose(); // idempotent
    assert.equal(term.disposed, true);
  });
  ```

- [ ] **Step 2: 运行测试，确认失败**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/terminalSession.test.ts
  ```

  预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现**

  创建 `src/components/terminal/terminalSession.ts`：

  ```ts
  export type XtermLike = {
    onData: (cb: (data: string) => void) => void;
    write: (data: string) => void;
    dispose: () => void;
  };

  export type WebSocketLike = {
    readyState: number;
    send: (data: string) => void;
    close: () => void;
    addEventListener: (type: 'message', cb: (evt: { data: unknown }) => void) => void;
    removeEventListener: (type: 'message', cb: (evt: { data: unknown }) => void) => void;
  };

  export type TerminalSession = {
    resize: (cols: number, rows: number) => void;
    dispose: () => void;
  };

  const OPEN = 1;

  /**
   * Wires an xterm-like terminal to a WebSocket speaking the /ws/terminal
   * protocol: terminal input -> {type:'input'}, {type:'output'} -> terminal.write,
   * resize -> {type:'resize'}. dispose() tears both sides down idempotently.
   */
  export function createTerminalSession(term: XtermLike, ws: WebSocketLike): TerminalSession {
    const onData = (data: string): void => {
      if (ws.readyState === OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    };

    const onMessage = (event: { data: unknown }): void => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: string; data?: unknown };
        if (parsed.type === 'output' && typeof parsed.data === 'string') {
          term.write(parsed.data);
        }
      } catch {
        // ignore malformed frames
      }
    };

    term.onData(onData);
    ws.addEventListener('message', onMessage);

    let disposed = false;
    return {
      resize(cols: number, rows: number): void {
        if (disposed || ws.readyState !== OPEN) return;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        term.dispose();
        ws.removeEventListener('message', onMessage);
        ws.close();
      },
    };
  }
  ```

- [ ] **Step 4: 运行测试，确认通过**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/terminalSession.test.ts
  ```

  预期：`pass 4`。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/components/terminal/terminalSession.ts src/components/terminal/terminalSession.test.ts
  git commit -m "feat(terminal): add terminal session controller

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 9: `TerminalPane` 组件（xterm + WS 装配）

**Files:**
- Create: `lovdex-cli/src/components/terminal/TerminalPane.tsx`
- Modify: `lovdex-cli/src/main.jsx`（引入 xterm CSS）

- [ ] **Step 1: 在 `main.jsx` 引入 xterm 样式**

  ```js
  import '@xterm/xterm/css/xterm.css'
  ```

  放在 `import 'katex/dist/katex.min.css'` 之后。（不在组件里引 CSS，避免 node:test 加载 .css 报错。）

- [ ] **Step 2: 创建 `TerminalPane.tsx`**

  ```tsx
  import { useEffect, useRef } from 'react';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';

  import { buildWebSocketUrl } from '../../utils/wsUrl';
  import { createTerminalSession } from './terminalSession';

  /**
   * Mounts an xterm.js terminal and a dedicated /ws/terminal WebSocket. The
   * socket is opened on mount and torn down on unmount (closing the drawer
   * therefore exits the remote shell — a fresh shell spawns next open).
   */
  export function TerminalPane() {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        theme: { background: '#141414' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);

      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('auth-token') : null;
      const ws = new WebSocket(buildWebSocketUrl(token, '/ws/terminal'));
      const session = createTerminalSession(term, ws);

      const sendResize = () => {
        try {
          fitAddon.fit();
          session.resize(term.cols, term.rows);
        } catch {
          // container not measurable yet (e.g. drawer animating in); next tick will retry
        }
      };
      sendResize();
      const observer = new ResizeObserver(sendResize);
      observer.observe(container);

      return () => {
        observer.disconnect();
        session.dispose();
      };
    }, []);

    return <div ref={containerRef} className="h-full w-full bg-[#141414]" />;
  }
  ```

- [ ] **Step 3: 类型检查该文件**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "TerminalPane" || echo "no TerminalPane errors"
  ```

  预期：`no TerminalPane errors`。（此任务无单测：TerminalPane 是纯装配层，逻辑都在 `terminalSession` 已覆盖。本任务不提交；与 Task 11 一起提交更合理，但也可单独提交。）

- [ ] **Step 4: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/components/terminal/TerminalPane.tsx src/main.jsx
  git commit -m "feat(terminal): add TerminalPane component

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 10: `TerminalToggleButton`（TDD render）

**Files:**
- Create: `lovdex-cli/src/components/terminal/TerminalToggleButton.tsx`
- Test: `lovdex-cli/src/components/terminal/TerminalToggleButton.test.tsx`

- [ ] **Step 1: 写失败测试**

  创建 `src/components/terminal/TerminalToggleButton.test.tsx`：

  ```tsx
  import assert from 'node:assert/strict';
  import test from 'node:test';
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';

  import { TerminalToggleButton } from './TerminalToggleButton';
  import { TerminalDrawerProvider } from '../../hooks/useTerminalDrawer';

  function renderToggle() {
    return renderToStaticMarkup(
      React.createElement(TerminalDrawerProvider, null, React.createElement(TerminalToggleButton)),
    );
  }

  test('renders a terminal button with a label', () => {
    const html = renderToggle();
    assert.match(html, /终端/);
  });
  ```

- [ ] **Step 2: 运行测试，确认失败**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/TerminalToggleButton.test.tsx
  ```

  预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现**

  创建 `src/components/terminal/TerminalToggleButton.tsx`：

  ```tsx
  import { Terminal as TerminalIcon } from 'lucide-react';

  import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
  import { cn } from '../../lib/utils';

  export function TerminalToggleButton({ className }: { className?: string }) {
    const { open, toggle } = useTerminalDrawer();
    return (
      <button
        type="button"
        onClick={toggle}
        title="终端 (Ctrl+`)"
        aria-pressed={open}
        className={cn(
          'flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors',
          open
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border/60 bg-card text-foreground hover:bg-accent',
          className,
        )}
      >
        <TerminalIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">终端</span>
      </button>
    );
  }
  ```

- [ ] **Step 4: 运行测试，确认通过**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/TerminalToggleButton.test.tsx
  ```

  预期：`pass 1`。

- [ ] **Step 5: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/components/terminal/TerminalToggleButton.tsx src/components/terminal/TerminalToggleButton.test.tsx
  git commit -m "feat(terminal): add terminal toggle button

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 11: 抽屉面板 + 抽屉（TDD render）

**Files:**
- Create: `lovdex-cli/src/components/terminal/TerminalDrawerPanel.tsx`
- Create: `lovdex-cli/src/components/terminal/TerminalDrawer.tsx`
- Test: `lovdex-cli/src/components/terminal/TerminalDrawerPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

  创建 `src/components/terminal/TerminalDrawerPanel.test.tsx`：

  ```tsx
  import assert from 'node:assert/strict';
  import test from 'node:test';
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';

  import { TerminalDrawerPanel } from './TerminalDrawerPanel';

  test('renders nothing interactive when closed and hides the pane', () => {
    const html = renderToStaticMarkup(
      React.createElement(TerminalDrawerPanel, { open: false, onClose: () => {} }),
    );
    assert.match(html, /translate-x-full/);
    assert.doesNotMatch(html, /pane-stub/);
  });

  test('renders the pane when open', () => {
    const html = renderToStaticMarkup(
      React.createElement(TerminalDrawerPanel, {
        open: true,
        onClose: () => {},
        pane: React.createElement('div', null, 'pane-stub'),
      }),
    );
    assert.match(html, /translate-x-0/);
    assert.match(html, /pane-stub/);
  });
  ```

- [ ] **Step 2: 运行测试，确认失败**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/TerminalDrawerPanel.test.tsx
  ```

  预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现 `TerminalDrawerPanel.tsx`（纯展示，不依赖 xterm）**

  ```tsx
  import type { ReactNode } from 'react';
  import { Terminal as TerminalIcon } from 'lucide-react';

  import { cn } from '../../lib/utils';

  type TerminalDrawerPanelProps = {
    open: boolean;
    onClose: () => void;
    /** The terminal pane to mount while open; injectable for tests. */
    pane?: ReactNode;
  };

  /**
   * Presentational slide-out terminal drawer. The pane is only mounted while
   * `open` so its WebSocket (and the remote PTY) exists exactly for the drawer's
   * lifetime — closing the drawer exits the shell.
   */
  export function TerminalDrawerPanel({ open, onClose, pane }: TerminalDrawerPanelProps) {
    return (
      <div className={cn('fixed inset-0 z-50', open ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!open}>
        <div
          className={cn(
            'absolute inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150',
            open ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onClose}
        />
        <div
          className={cn(
            'absolute right-0 top-0 flex h-full w-[min(72vw,720px)] flex-col border-l border-border/60 bg-card shadow-2xl transition-transform duration-200 ease-out',
            open ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-2">
            <TerminalIcon className="h-4 w-4 text-emerald-500" />
            <span className="text-sm font-semibold">终端</span>
            <span className="ml-auto text-[11px] text-muted-foreground">关闭即退出会话</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭终端"
              className="ml-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>
          {open && <div className="min-h-0 flex-1">{pane}</div>}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 4: 创建 `TerminalDrawer.tsx`（接 context + 真实 pane）**

  ```tsx
  import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
  import { TerminalDrawerPanel } from './TerminalDrawerPanel';
  import { TerminalPane } from './TerminalPane';

  export function TerminalDrawer() {
    const { open, setOpen } = useTerminalDrawer();
    return (
      <TerminalDrawerPanel
        open={open}
        onClose={() => setOpen(false)}
        pane={<TerminalPane />}
      />
    );
  }
  ```

- [ ] **Step 5: 运行测试，确认通过**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/components/terminal/TerminalDrawerPanel.test.tsx
  ```

  预期：`pass 2`。

- [ ] **Step 6: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/components/terminal/TerminalDrawerPanel.tsx src/components/terminal/TerminalDrawer.tsx src/components/terminal/TerminalDrawerPanel.test.tsx
  git commit -m "feat(terminal): add terminal drawer

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 12: 接入 App 与三个顶栏

**Files:**
- Modify: `lovdex-cli/src/App.tsx`
- Modify: `lovdex-cli/src/components/main-content/view/MainContent.tsx`
- Modify: `lovdex-cli/src/components/tasks/TaskBoard.tsx`
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: App.tsx 挂 Provider + 抽屉**

  顶部 import 区加：

  ```tsx
  import { TerminalDrawer } from './components/terminal/TerminalDrawer';
  import { TerminalDrawerProvider } from './hooks/useTerminalDrawer';
  ```

  把 `<Routes>…</Routes>` 包进 Provider，并在其后渲染抽屉：

  ```tsx
  <Router basename={routerBasename}>
    <TerminalDrawerProvider>
      <Routes>
        <Route path="/" element={<AppContent />} />
        <Route path="/session/:sessionId" element={<AppContent />} />
        <Route path="/tasks" element={<TaskBoardPage />} />
        <Route path="/task/:taskId" element={<TaskDetailPage />} />
        <Route path="/assistant" element={<AssistantPanel />} />
        <Route path="/settings/operator" element={<OperatorSettingsPage />} />
      </Routes>
      <TerminalDrawer />
    </TerminalDrawerProvider>
  </Router>
  ```

- [ ] **Step 2: MainContent.tsx 顶栏加按钮**

  import 区加：

  ```tsx
  import { TerminalToggleButton } from '../../terminal/TerminalToggleButton';
  ```

  在 header 内、`查看任务` 按钮块之后（即 `</header>` 之前）加：

  ```tsx
  <TerminalToggleButton />
  ```

- [ ] **Step 3: TaskBoard.tsx 顶栏加按钮**

  import 区加：

  ```tsx
  import { TerminalToggleButton } from '../terminal/TerminalToggleButton';
  ```

  在 header 内 `＋ 新建任务` 按钮之后加：

  ```tsx
  <TerminalToggleButton />
  ```

- [ ] **Step 4: TaskDetail.tsx 顶栏加按钮**

  import 区加：

  ```tsx
  import { TerminalToggleButton } from '../terminal/TerminalToggleButton';
  ```

  在 header 内 `<TaskBackNav className="ml-auto flex-shrink-0" />` 之后加：

  ```tsx
  <TerminalToggleButton />
  ```

- [ ] **Step 5: 前端类型检查**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH npm run typecheck
  ```

  预期：无新增错误（若存量有错，只确认没有指向本次新增/修改文件的错误）。

- [ ] **Step 6: 前端全量单测**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  env -u TSX_TSCONFIG_PATH node --import tsx --test src/utils/wsUrl.test.ts src/hooks/useTerminalDrawer.test.ts src/components/terminal/terminalSession.test.ts src/components/terminal/TerminalToggleButton.test.tsx src/components/terminal/TerminalDrawerPanel.test.tsx
  ```

  预期：全部 pass。

- [ ] **Step 7: 提交**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-cli
  git add src/App.tsx src/components/main-content/view/MainContent.tsx src/components/tasks/TaskBoard.tsx src/components/tasks/TaskDetail.tsx
  git commit -m "feat(terminal): mount drawer and header toggle across views

  Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

### Task 13: 端到端手工验收

- [ ] **Step 1: 重启 Lovdex 整栈**

  ```bash
  cd /mnt/b/workdir/github/lovdex/supervisor
  node supervisor.mjs stop 2>/dev/null || true
  node supervisor.mjs
  ```

  （或按日常习惯用 `systemctl --user restart lovdex`。）

- [ ] **Step 2: 浏览器验证**

  打开 Lovdex 前端（默认 `http://localhost:5187`）：
  1. 聊天页顶栏右侧出现「终端」按钮。
  2. 点击按钮 → 抽屉从右滑出，终端提示符出现，停在工作区根目录（`~` 或 `WORKSPACES_ROOT`）。
  3. `cd <项目> && git pull` 能正常执行并显示输出。
  4. 按 `Ctrl+\`` 关闭抽屉 → 再打开 → 是全新 shell（提示符回到初始目录）。
  5. 任务页 / 任务详情页顶栏也能打开抽屉。
  6. 关闭抽屉后，后端无残留 shell 进程（可选：`ps aux | grep -v grep | grep -c 'node-pty\|bash'` 观察）。

- [ ] **Step 3: 确认两个仓库均为干净工作区**

  ```bash
  cd /mnt/b/workdir/github/lovdex/lovdex-backend && git status --short
  cd /mnt/b/workdir/github/lovdex/lovdex-cli && git status --short
  ```

  预期：无未提交改动（临时 `/tmp/terminal-smoke.mjs` 与 `docs/` 不在此列，`docs/` 在 git 之外）。

---

## Self-Review 备注（已核对）

- **Spec 覆盖**：抽屉形式（Task 11）、成熟方案 xterm.js/node-pty（Task 1/5/9）、初始目录 WORKSPACES_ROOT（Task 3 `cwd`）、顶栏按钮 + Ctrl+`（Task 7/10/12）、单会话关闭即退出（Task 9 生命周期 + Task 11 仅 open 时挂载 pane）、复用现有 WS/认证（Task 3）。
- **占位符**：全部步骤含具体代码与命令。
- **类型一致性**：`PtyLike`/`PtySpawner`/`TerminalDependencies`（Task 2）与 `websocket-server.service.ts` 的 `Parameters<typeof handleTerminalConnection>[2]`（Task 3）一致；`buildWebSocketUrl(token, pathname)`（Task 6）被 `TerminalPane`（Task 9）以 `buildWebSocketUrl(token, '/ws/terminal')` 调用；`createTerminalSession(term, ws)`（Task 8）被 `TerminalPane`（Task 9）调用；`TerminalDrawerPanel({open,onClose,pane})`（Task 11）被 `TerminalDrawer`（Task 11）调用。
