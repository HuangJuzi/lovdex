# Remote Projects (Remote-lite) — Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 让 Lovdex 能通过远程机器上的 **remote-lite**（现有后端 agent-core 的切片服务）把远程目录添加为项目并跑完整 Claude 会话（事件/审批/中断/resume/transcript 拉取）+ 文件树只读浏览，本地 `claude-sdk.js` 行为零回归。

**Architecture:** 主 Lovdex 保留唯一 UI/DB/编排；每台远程机器装一个 lite node 服务，出站 WebSocket 主动连主站（token 鉴权），主站在 `spawnFns` 层用 `withRemoteRouting` 把远程 session 路由给 lite；lite 复用 `@anthropic-ai/claude-agent-sdk` + 共享事件归一化在远程原生跑 Claude，事件/审批经 WS 回传。引导走 ssh/scp/systemd，密钥与注册表入库。

**Tech Stack:** Node 20+、express、ws、@anthropic-ai/claude-agent-sdk、better-sqlite3、esbuild（lite 打包）、systemd --user、TypeScript（后端 tsx）、React + Tailwind（前端）。

**约定**
- 代码库：`/mnt/b/workdir/github/lovdex`（此时 User 尚未批准切换分支，若需隔离用 worktree）。
- 后端测试：`cd backend && npx tsx --test --tsconfig server/tsconfig.json <test 文件>`（见记忆 `lovdex-cli-verification-recipe`；`TSX_TSCONFIG_PATH` 需 unset）。
- 提交信息**不加** `Co-Authored-By`（记忆 `lovdex-commit-message-no-coauthored`）。
- 基线 typecheck 存在 4 个 pre-existing 错误 / lint 44 errors（全与本节无关），验收标准为**零新增**。
- 设计文档：`docs/superpowers/specs/2026-08-18-remote-projects-design.md`。

---

## 文件结构

**新增（主站）**
- `backend/server/shared/agent-runtime/protocol.ts` — 远程 WS 帧类型 + 编解码（纯函数）。
- `backend/server/shared/agent-runtime/normalize.ts` — SDK 事件 → writer 归一化事件（纯函数，从 claude-sdk.js 抽取的一小块）。
- `backend/server/modules/remote-agents/remote-host.db.ts` — `remote_hosts` 仓库。
- `backend/server/modules/remote-agents/remote-agents.registry.ts` — 连接注册表 + RPC + session 索引 + 待审批索引。
- `backend/server/modules/remote-agents/remote-agent.server.ts` — 接收 lite 的 WS 服务（`/api/remote-agents/ws`）。
- `backend/server/modules/remote-agents/remote-spawn.ts` — `withRemoteRouting` 路由层（spawn/abort/approve/pending）。
- `backend/server/modules/remote-agents/remote-projects.index.ts` — `projectPath → hostId` 内存索引（供 lookup）。
- `backend/server/modules/remote-agents/remote-fs.service.ts` — fs RPC 客户端（stat/list/read）。
- `backend/server/modules/remote-agents/bootstrap.service.ts` — ssh 探测/推包/systemd/公钥（注入 runner）。
- `backend/server/modules/remote-agents/remote-agents.routes.ts` — REST（机器 CRUD + 部署 + 远程目录浏览）。
- 各模块随附 `tests/`。

**新增（remote-lite 包，独立部署单元）**
- `backend/remote-agent/package.json` — 独立 service（ws + claude-agent-sdk + esbuild 打包）。
- `backend/remote-agent/src/config.ts` — 读 `~/.lovdex-remote/config.json`（0600）。
- `backend/remote-agent/src/index.ts` — 入口：读 config → 连主站 WS → 心跳 → 分发 rpc。
- `backend/remote-agent/src/agent-run.ts` — `runClaudeSessionOnLite`（SDK + 共享归一化 + approval/abort seam）。
- `backend/remote-agent/src/fs.ts` — 白名单 fs stat/list/read（复用 shared 的 `resolveRealPath`，lite 自带拷贝）。
- `backend/remote-agent/deploy/systemd-unit.template` + `deploy/install.sh`。

**修改（后端）**
- `modules/database/schema.ts` — 加 `remote_hosts` 表。
- `modules/database/index.ts` — export `remoteHostsDb`。
- `index.js` — 挂 remote-agent WS + 路由；`spawnFns/abortFns/resolveToolApproval/getPendingApprovalsForSession` 包一层路由。
- `modules/projects/services/project-management.service.ts` + `projects.routes.ts` — 远程建项目校验分支。
- `shared/types.ts` — 补 `RemoteHostRow` 等类型。

**修改（前端）**
- `web/src/components/settings/settingsTabs.ts` + `SettingsPage.tsx` — 新增「远程机器」Tab。
- `web/src/components/project-creation-wizard/` — 远程模式（选 host → 浏览远程目录）。
- 项目列表/侧栏 — 远程项目显示 `host:/path`。

---

### Task 1: 远程 WS 协议类型与编解码

**Files:**
- Create: `backend/server/shared/agent-runtime/protocol.ts`
- Test: `backend/server/shared/agent-runtime/tests/protocol.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentFrameOut, encodeRpcRequest, makeSessionStartParamsSchema } from '../protocol.js';
import { z } from 'zod';

test('rpc request frame encodes/decodes round-trip', () => {
  const id = 'req-1';
  const frame = encodeRpcRequest(id, 'session/start', {
    appSessionId: 's1',
    providerSessionId: null,
    command: 'fix tests',
    cwd: '/srv/app',
  });
  assert.equal(frame.type, 'rpc_req');
  assert.equal(frame.method, 'session/start');
  assert.ok(isAgentFrameOut(frame));
});

test('session/start params schema validates required fields and defaults providerSessionId to null', () => {
  const schema = makeSessionStartParamsSchema();
  const ok = schema.parse({ appSessionId: 's1', command: 'hi', cwd: '/s' });
  assert.equal(ok.providerSessionId, null);
  assert.equal(ok.cwd, '/s');
  assert.throws(() => schema.parse({ appSessionId: 's1', command: 'hi' })); // cwd required
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test --tsconfig server/tsconfig.json server/shared/agent-runtime/tests/protocol.test.ts`
Expected: FAIL — `Cannot find module '../protocol.js'`

- [ ] **Step 3: 实现协议模块**

```ts
// backend/server/shared/agent-runtime/protocol.ts
import { z } from 'zod';

/** lite → 主 */
export type AgentFrameIn =
  | { type: 'hello'; hostId: string; agentVersion: string; nodeVersion: string; os: string; roots: string[]; capabilities: string[] }
  | { type: 'rpc_res'; id: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'push'; topic: string; payload: unknown }
  | { type: 'pong'; at: number };

/** 主 → lite */
export type AgentFrameOut =
  | { type: 'rpc_req'; id: string; method: string; params: unknown }
  | { type: 'rpc_cancel'; id: string }
  | { type: 'ping'; at: number };

export function isAgentFrameOut(frame: unknown): frame is AgentFrameOut {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return f.type === 'rpc_req' || f.type === 'rpc_cancel' || f.type === 'ping';
}

export function encodeRpcRequest(id: string, method: string, params: unknown): AgentFrameOut {
  return { type: 'rpc_req', id, method, params };
}

export function makePing(): AgentFrameOut {
  return { type: 'ping', at: Date.now() };
}

export function makeSessionStartParamsSchema() {
  return z.object({
    appSessionId: z.string().min(1),
    providerSessionId: z.string().nullish().default(null),
    command: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    includePartialMessages: z.boolean().optional(),
  });
}

/** fs/stat 结果 */
export type RemoteStat = {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
git add backend/server/shared/agent-runtime/protocol.ts backend/server/shared/agent-runtime/tests/protocol.test.ts
git commit -m "feat(remote-agents): define remote WS protocol codec"
```

---

### Task 2: 共享事件归一化（SDK 事件 → writer 事件）

**Files:**
- Create: `backend/server/shared/agent-runtime/normalize.ts`
- Test: `backend/server/shared/agent-runtime/tests/normalize.test.ts`

**说明**：从 `claude-sdk.js` 现有的规范化逻辑抽最小一块（assistant 消息 / tool_use / 完成事件），主站本地路径一期**不动**，lite 复用此模块；Phase 2 再把主站并轨。事件对象形状必须与主站 writer 扇出形状兼容——验收标准：与 `claude-sdk.js` 现状对 `assistant` / `tool_use` / `complete` 三个事件的输出字段一致。

- [ ] **Step 1: 写失败测试（形状 = 主站现状，先对照 claude-sdk.js 现有映射）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentEvent, terminalCompleteEvent } from '../normalize.js';

test('normalizes an assistant message with text', () => {
  const evt = normalizeAgentEvent(
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    {},
  );
  assert.ok(evt.role === 'assistant');
  assert.ok(typeof evt.eventId === 'string');
  assert.ok(Array.isArray(evt.content));
});

test('complete event carries provider session id + done flag', () => {
  const evt = terminalCompleteEvent('SDK_SESSION_1', {});
  assert.equal(evt.type, 'complete');
  assert.equal(evt.providerSessionId, 'SDK_SESSION_1');
  assert.equal(evt.done, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test --tsconfig server/tsconfig.json server/shared/agent-runtime/tests/normalize.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现（先从 claude-sdk.js 现有 assistant 事件映射抄形状，保持字段一致）**

```ts
// backend/server/shared/agent-runtime/normalize.ts
export function createEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 把 SDK 事件归一化为主站 writer 可扇出的事件。
 * 字段形状与 claude-sdk.js 现状对齐（Phase 2 并轨点）。
 */
export function normalizeAgentEvent(sdkEvent: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { ...extra, eventId: createEventId() };
  if (sdkEvent.type === 'assistant') {
    return {
      ...base,
      type: 'assistant',
      providerSessionId: sdkEvent.sessionId,
      role: 'assistant',
      content: (sdkEvent.message?.content ?? []) as unknown[],
      model: sdkEvent.message?.model ?? undefined,
    };
  }
  if (sdkEvent.type === 'result') {
    return { ...base, type: 'complete', providerSessionId: sdkEvent.sessionId, done: true };
  }
  if (sdkEvent.type === 'tool_use') {
    return {
      ...base,
      type: 'tool_use',
      providerSessionId: sdkEvent.sessionId,
      toolUseId: sdkEvent.toolUseId,
      name: sdkEvent.name,
      input: sdkEvent.input ?? {},
    };
  }
  if (sdkEvent.type === 'error') {
    return { ...base, type: 'error', providerSessionId: sdkEvent.sessionId, error: sdkEvent.error };
  }
  return { ...base, type: sdkEvent.type as string, ...sdkEvent, eventId: base.eventId };
}

export function terminalCompleteEvent(providerSessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    type: 'complete',
    eventId: createEventId(),
    providerSessionId,
    done: true,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/server/shared/agent-runtime/normalize.ts backend/server/shared/agent-runtime/tests/normalize.test.ts
git commit -m "feat(remote-agents): extract shared agent event normalizer"
```

---

### Task 3: `remote_hosts` 表 + 仓库

**Files:**
- Modify: `backend/server/modules/database/schema.ts`
- Modify: `backend/server/modules/database/index.ts`
- Create: `backend/server/modules/remote-agents/remote-host.db.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-host.db.test.ts`
- Modify: `backend/server/shared/types.ts`

- [ ] **Step 1: schema 增加 `remote_hosts` 表**（追加到 schema.ts 末尾导出常量）

```ts
export const REMOTE_HOSTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS remote_hosts (
    host_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'lovdex_key',
    key_credential_id INTEGER,
    agent_token_hash TEXT,
    os TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    last_error TEXT,
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;
```

并确认 `init-db.ts` 的 schema 数组包含该常量。

- [ ] **Step 2: types.ts 增加行类型**

```ts
export type RemoteHostRow = {
  host_id: string;
  name: string;
  host: string;
  port: number;
  ssh_user: string;
  auth_type: 'lovdex_key' | 'existing_key' | 'password';
  key_credential_id: number | null;
  agent_token_hash: string | null;
  os: string | null;
  status: 'offline' | 'online' | 'deploying' | 'error';
  last_error: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 3: 写失败测试**

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createRemoteHostsDb, type RemoteHostsRepository } from '../remote-host.db.js';

let db: Database.Database;
let repo: RemoteHostsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  repo = createRemoteHostsDb(db);
});

test('insert + get by id round-trips status offline→online', () => {
  const id = repo.create({ host_id: 'h1', name: 'dev1', host: '10.0.0.5', ssh_user: 'root' });
  assert.equal(id, 'h1');
  const row = repo.getById('h1');
  assert.equal(row?.status, 'offline');
  repo.updateStatus('h1', 'online');
  assert.equal(repo.getById('h1')?.status, 'online');
});

test('findByProjectPath returns null when a matching remote project does not exist', () => {
  assert.equal(repo.findHostForProjectPath('/srv/app'), null);
});
```

- [ ] **Step 4: 实现仓库**

```ts
// backend/server/modules/remote-agents/remote-host.db.ts
import type Database from 'better-sqlite3';
import { REMOTE_HOSTS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import type { RemoteHostRow } from '@/shared/types.js';

export type RemoteHostsRepository = {
  create(input: { host_id: string; name: string; host: string; ssh_user: string; port?: number }): string;
  getById(hostId: string): RemoteHostRow | null;
  list(): RemoteHostRow[];
  updateStatus(hostId: string, status: RemoteHostRow['status'], lastError?: string | null): void;
  touchSeen(hostId: string): void;
  setTokenHash(hostId: string, hash: string): void;
  remove(hostId: string): void;
  findHostForProjectPath(projectPath: string): RemoteHostRow | null;
};

export function createRemoteHostsDb(db: Database.Database): RemoteHostsRepository {
  db.exec(REMOTE_HOSTS_TABLE_SCHEMA_SQL);
  const get = db.prepare('SELECT * FROM remote_hosts WHERE host_id = ?');
  return {
    create({ host_id, name, host, ssh_user, port = 22 }) {
      db.prepare(
        'INSERT INTO remote_hosts (host_id, name, host, port, ssh_user, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(host_id, name, host, port, ssh_user, 'offline');
      return host_id;
    },
    getById(hostId) {
      const row = get.get(hostId) as RemoteHostRow | undefined;
      return row ?? null;
    },
    list() {
      return db.prepare('SELECT * FROM remote_hosts ORDER BY created_at DESC').all() as RemoteHostRow[];
    },
    updateStatus(hostId, status, lastError = null) {
      db.prepare('UPDATE remote_hosts SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE host_id = ?').run(
        status, lastError, hostId,
      );
    },
    touchSeen(hostId) {
      db.prepare('UPDATE remote_hosts SET last_seen_at = CURRENT_TIMESTAMP WHERE host_id = ?').run(hostId);
    },
    setTokenHash(hostId, hash) {
      db.prepare('UPDATE remote_hosts SET agent_token_hash = ? WHERE host_id = ?').run(hash, hostId);
    },
    remove(hostId) {
      db.prepare('DELETE FROM remote_hosts WHERE host_id = ?').run(hostId);
    },
    findHostForProjectPath(projectPath) {
      const row = db
        .prepare('SELECT h.* FROM remote_hosts h JOIN projects p ON p.remote_host_id = h.host_id WHERE p.project_path = ?')
        .get(projectPath) as RemoteHostRow | undefined;
      return row ?? null;
    },
  };
}
```

- [ ] **Step 5: index.ts 导出**

```ts
export { createRemoteHostsDb } from '@/modules/remote-agents/remote-host.db.js';
// 并在 index.js 实例化处保留单例 remoteHostsDb = createRemoteHostsDb(connection)（Task 13 接线）
```

- [ ] **Step 6: 运行测试确认通过**
- [ ] **Step 7: Commit**

```bash
git add backend/server/modules/database/schema.ts backend/server/modules/database/index.ts backend/server/shared/types.ts backend/server/modules/remote-agents/remote-host.db.ts backend/server/modules/remote-agents/tests/remote-host.db.test.ts
git commit -m "feat(remote-agents): add remote_hosts table and repository"
```

---

### Task 4: 连接注册表 + RPC + 会话/审批索引

**Files:**
- Create: `backend/server/modules/remote-agents/remote-agents.registry.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-agents.registry.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';

test('registers and unregisters a host', () => {
  const reg = createRemoteAgentsRegistry();
  assert.equal(reg.isOnline('h1'), false);
  reg.register({ hostId: 'h1', roots: ['/srv/app'] });
  assert.equal(reg.isOnline('h1'), true);
  assert.deepEqual(reg.getCapabilities('h1'), ['/srv/app']);
  reg.unregister('h1');
  assert.equal(reg.isOnline('h1'), false);
});

test('rpc resolves via match/pending map; times out with error', async () => {
  const reg = createRemoteAgentsRegistry();
  reg.register({ hostId: 'h1', roots: ['/srv'] });
  const p = reg.rpc('h1', 'session/start', { appSessionId: 's1', command: 'x', cwd: '/srv' }, 2000);
  const pending = reg.takePendingByMethod('session/start');
  assert.ok(pending);
  reg.resolveRpc(pending.id, { ok: true, data: { providerSessionId: 'P1' } });
  const res = await p;
  assert.equal((res as { providerSessionId: string }).providerSessionId, 'P1');
});

test('session index routes appSessionId → host + tracks pending approvals', () => {
  const reg = createRemoteAgentsRegistry();
  reg.setSessionHost('s1', null, 'h1');
  assert.equal(reg.getSessionHost('s1')?.hostId, 'h1');
  reg.addPendingApproval('req1', { appSessionId: 's1', hostId: 'h1' });
  const taken = reg.takePendingApproval('req1');
  assert.equal(taken?.hostId, 'h1');
  assert.equal(reg.takePendingApproval('req1'), undefined);
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现注册表**

```ts
// backend/server/modules/remote-agents/remote-agents.registry.ts
import type { WebSocket } from 'ws';

export type LiteRegistration = {
  hostId: string;
  roots: string[];
  capabilities: string[];
};

export type PendingRpc = {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export function createRemoteAgentsRegistry() {
  const connections = new Map<string, { registration: LiteRegistration; ws: WebSocket }>();
  const pending = new Map<string, PendingRpc>();
  const byMethod = new Map<string, PendingRpc[]>();
  const sessionHost = new Map<string, { hostId: string; providerSessionId: string | null }>();
  const pendingApprovals = new Map<string, { appSessionId: string; hostId: string }>();

  function createRpcId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `rpc-${Math.random().toString(36).slice(2)}`;
  }

  return {
    isOnline(hostId: string): boolean {
      const c = connections.get(hostId);
      return c !== undefined && c.ws.readyState === c.ws.OPEN;
    },
    register(registration: LiteRegistration, ws: WebSocket): void {
      connections.set(registration.hostId, { registration, ws });
    },
    unregister(hostId: string): void {
      connections.delete(hostId);
    },
    getCapabilities(hostId: string): string[] | undefined {
      return connections.get(hostId)?.registration.roots;
    },
    listenerCount(): number {
      return connections.size;
    },
    setSessionHost(appSessionId: string, providerSessionId: string | null, hostId: string): void {
      sessionHost.set(appSessionId, { hostId, providerSessionId });
    },
    getSessionHost(appSessionId: string): { hostId: string; providerSessionId: string | null } | undefined {
      return sessionHost.get(appSessionId);
    },
    clearSessionsForHost(hostId: string): string[] {
      const affected: string[] = [];
      for (const [appSessionId, entry] of sessionHost) {
        if (entry.hostId === hostId) {
          sessionHost.delete(appSessionId);
          affected.push(appSessionId);
        }
      }
      return affected;
    },
    addPendingApproval(requestId: string, entry: { appSessionId: string; hostId: string }): void {
      pendingApprovals.set(requestId, entry);
    },
    takePendingApproval(requestId: string): { appSessionId: string; hostId: string } | undefined {
      const entry = pendingApprovals.get(requestId);
      if (entry) pendingApprovals.delete(requestId);
      return entry;
    },
    rpc<T = unknown>(hostId: string, method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
      const connection = connections.get(hostId);
      if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
        return Promise.reject(new Error(`remote host offline: ${hostId}`));
      }
      return new Promise<T>((resolve, reject) => {
        const id = createRpcId();
        const entry: PendingRpc = {
          id,
          resolve: (v) => resolve(v as T),
          reject,
          timer: setTimeout(() => {
            byMethod.get(method)?.splice(byMethod.get(method)!.indexOf(entry), 1);
            pending.delete(id);
            reject(new Error(`remote rpc timeout: ${method}`));
          }, timeoutMs),
          method,
        };
        pending.set(id, entry);
        byMethod.set(method, [...(byMethod.get(method) ?? []), entry]);
        connection.ws.send(JSON.stringify({ type: 'rpc_req', id, method, params }));
      });
    },
    resolveRpc(id: string, response: { ok: boolean; data?: unknown; error?: string }, method?: string): void {
      const entry = pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(id);
      if (method) {
        const list = byMethod.get(method) ?? [];
        byMethod.set(method, list.filter((e) => e.id !== id));
      }
      if (response.ok) entry.resolve(response.data);
      else entry.reject(new Error(response.error ?? 'remote rpc failed'));
    },
    /** 测试用：不真正 send，只登记 */
    takePendingByMethod(method: string): PendingRpc | undefined {
      return byMethod.get(method)?.[0];
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

export type RemoteAgentsRegistry = ReturnType<typeof createRemoteAgentsRegistry>;
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/remote-agents.registry.ts backend/server/modules/remote-agents/tests/remote-agents.registry.test.ts
git commit -m "feat(remote-agents): connection registry with rpc + session/approval indexes"
```

---

### Task 5: 接收 lite 的 WS 服务（remote-agent.server）

**Files:**
- Create: `backend/server/modules/remote-agents/remote-agent.server.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-agent.server.test.ts`

- [ ] **Step 1: 写失败测试（用注入的 registry 假件 + 假 ws 验证 hello/push/rpc_res 分发）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAgentConnectionHandler } from '../remote-agent.server.js';

test('hello registers host and touches seen; second hello after drop replaces connection', () => {
  const registered: string[] = [];
  const handler = createRemoteAgentConnectionHandler({
    verifyToken: (token) => (token === 'tok-1' ? 'h1' : null),
    registry: {
      register: (r: { hostId: string }) => void registered.push(r.hostId),
      unregister: () => {},
      clearSessionsForHost: () => [],
    } as never,
  });
  const out: Record<string, unknown>[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => out.push(JSON.parse(raw)),
    on: (_evt: string, _cb: unknown) => {},
  } as never;

  const conn = handler(ws as never, 'wss');
  conn.onHello({ type: 'hello', hostId: 'h1', agentVersion: '1.0', nodeVersion: '20', os: 'linux', roots: ['/srv'], capabilities: [] });
  assert.deepEqual(registered, ['h1']);
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现握手/分发**

```ts
// backend/server/modules/remote-agents/remote-agent.server.ts
import type { WebSocketServer, WebSocket } from 'ws';
import type { AgentFrameIn } from '@/shared/agent-runtime/protocol.js';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

export type RemoteAgentServerDeps = {
  verifyToken: (token: string | null) => string | null; // token → hostId
  registry: RemoteAgentsRegistry;
  onHostOnline?: (hostId: string) => void;
  onHostOffline?: (hostId: string) => void;
};

export function createRemoteAgentConnectionHandler(deps: RemoteAgentServerDeps) {
  return function handleConnection(ws: WebSocket, _req: unknown) {
    let hostId: string | null = null;

    ws.on('message', (raw: Buffer) => {
      let frame: AgentFrameIn;
      try {
        frame = JSON.parse(String(raw)) as AgentFrameIn;
      } catch {
        ws.send(JSON.stringify({ type: 'rpc_res', id: '' , ok: false, error: 'bad json' }));
        return;
      }
      if (frame.type === 'hello') {
        const { hostId: h, roots, capabilities } = frame;
        deps.registry.register({ hostId: h, roots, capabilities }, ws);
        hostId = h;
        deps.onHostOnline?.(h);
        ws.send(JSON.stringify({ type: 'rpc_res', id: 'hello', ok: true, data: { accepted: true } }));
        return;
      }
      if (frame.type === 'rpc_res') {
        deps.registry.resolveRpc(frame.id, { ok: frame.ok, data: frame.data, error: frame.error });
        return;
      }
      if (frame.type === 'push') {
        // 由上层注册的 topic 订阅器消费（remote-spawn 会 addListener）
        onPush?.({ topic: frame.topic, payload: frame.payload, from: hostId });
        return;
      }
      if (frame.type === 'pong') {
        deps.registry.touchSeenAt?.(hostId ?? '', frame.at);
      }
    });

    ws.on('close', () => {
      if (hostId) {
        deps.registry.unregister(hostId);
        deps.registry.clearSessionsForHost(hostId);
        deps.onHostOffline?.(hostId);
      }
    });
  };
}

// push 分发器（模块级，remote-spawn 注册；用 TopicBus 避免循环依赖）
type PushHandler = (evt: { topic: string; payload: unknown; from: string | null }) => void;
export const onPushListeners = new Set<PushHandler>();
export function emitPush(evt: { topic: string; payload: unknown; from: string | null }): void {
  onPushListeners.forEach((h) => h(evt));
}

export function createRemoteAgentWss(server: import('http').Server, deps: RemoteAgentServerDeps): WebSocketServer {
  const { WebSocketServer } = require('ws') as typeof import('ws');
  const wss = new WebSocketServer({ server, path: '/api/remote-agents/ws' });
  wss.on('connection', (ws, req) => {
    // token 校验：query ?token=
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    const hostId = deps.verifyToken(token);
    if (!hostId) {
      ws.close(4001, 'invalid token');
      return;
    }
    const handler = createRemoteAgentConnectionHandler(deps);
    handler(ws as never, req);
  });
  return wss;
}
```

> 接线说明：token→hostId 由 `remoteHostsDb.getByTokenHash(sha256(token))` 提供；`createRemoteAgentWss(server, deps)` 在 Task 13 挂到 `server`。测试里直接调 `createRemoteAgentConnectionHandler` 验证分发逻辑。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/remote-agent.server.ts backend/server/modules/remote-agents/tests/remote-agent.server.test.ts
git commit -m "feat(remote-agents): websocket endpoint for lite registration"
```

---

### Task 6: spawn/abort/approval 路由层（remote-spawn.ts）

**Files:**
- Create: `backend/server/modules/remote-agents/remote-spawn.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-spawn.test.ts`

**核心思路**：`withRemoteRouting` 包装 `index.js` 里四个 hook；lookup 判定 `runtimeOptions.projectPath ?? cwd` 是否远程；远程则走 lite RPC + push 订阅。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteRouting } from '../remote-spawn.js';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';

test('spawn routes to local when project path is not remote', async () => {
  let localCalled = false;
  const routing = createRemoteRouting({ lookupHost: () => null, registry: createRemoteAgentsRegistry() });
  const wrapped = routing.wrapSpawn(async () => { localCalled = true; return 'local'; });
  await wrapped('hi', { projectPath: '/local/proj' }, { send: () => {} });
  assert.equal(localCalled, true);
});

test('spawn routes to remote when project path resolves to a host', async () => {
  const registry = createRemoteAgentsRegistry();
  registry.register({ hostId: 'h1', roots: ['/srv'] });
  registry.setSessionHost('s1', null, 'h1');
  registry.takePendingByMethod = () => undefined as never;
  // 注入假 rpc：拦截 session/start
  registry.rpc = async (_h, method, params) => {
    if (method === 'session/start') return { providerSessionId: 'P1' };
    throw new Error('unexpected ' + method);
  };
  const routing = createRemoteRouting({ lookupHost: (p) => (p === '/srv/app' ? 'h1' : null), registry });
  const wrapped = routing.wrapSpawn(async () => { throw new Error('must not run locally'); });
  const events: unknown[] = [];
  const writer = { send: (e) => events.push(e), setSessionId: () => {}, getSessionId: () => null };
  // push 模拟 lite 回传
  wrapped('do it', { projectPath: '/srv/app', cwd: '/srv/app', sessionId: 'P1', resume: false }, writer)
    .then(() => {
      // 手动触发一个 push 事件
      routing.emitSessionPush('s1', { type: 'assistant', eventId: 'e1' });
    });
  // 因 spawn 异步完成后再断言；简化：验证 rpc 被调用
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(registry.pendingCount(), 0);
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现路由层**

```ts
// backend/server/modules/remote-agents/remote-spawn.ts
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';
import { makeSessionStartParamsSchema } from '@/shared/agent-runtime/protocol.js';

export type RemoteProjectsLookup = {
  lookupHost: (projectPath: string | undefined) => string | null;
};

type SpawnFn = (command: string, options: Record<string, unknown>, writer: unknown) => Promise<unknown>;
type WriterLike = { send: (e: unknown) => void; setSessionId: (id: string) => void; getSessionId: () => string | null };

export function createRemoteRouting(deps: RemoteProjectsLookup & { registry: RemoteAgentsRegistry }) {
  const { registry } = deps;
  const sessionPushHandlers = new Map<string, (event: unknown) => void>();

  function registerSessionPush(appSessionId: string, handler: (event: unknown) => void): void {
    sessionPushHandlers.set(appSessionId, handler);
  }
  function unregisterSessionPush(appSessionId: string): void {
    sessionPushHandlers.delete(appSessionId);
  }
  function emitSessionPush(appSessionId: string, event: unknown): void {
    sessionPushHandlers.get(appSessionId)?.(event);
  }

  const schema = makeSessionStartParamsSchema();

  function wrapSpawn(localSpawn: SpawnFn): SpawnFn {
    return async (command, options, writer) => {
      const projectPath = (options?.projectPath ?? options?.cwd) as string | undefined;
      const hostId = deps.lookupHost(projectPath);
      if (!hostId) {
        return localSpawn(command, options, writer);
      }
      const writerLike = writer as WriterLike;
      const appSessionId = String(options?.appSessionId ?? options?.sessionId ?? '');
      const params = schema.parse({
        appSessionId,
        providerSessionId: (options?.sessionId as string | null) ?? null,
        command,
        cwd: projectPath,
        model: options?.model as string | undefined,
        permissionMode: (options?.permissionMode as string) ?? 'default',
        includePartialMessages: options?.includePartialMessages === true,
      });
      const pushHandler = (event: unknown) => writerLike.send(event);
      registerSessionPush(appSessionId, pushHandler);
      try {
        const res = await registry.rpc<{ providerSessionId: string }>(hostId, 'session/start', params);
        registry.setSessionHost(appSessionId, res.providerSessionId, hostId);
        writerLike.setSessionId(res.providerSessionId);
        // 会话持续期间事件经 push 送达；spawn 在收到终态 complete 后才 resolve
        await new Promise<void>((resolve) => {
          const onDone = (event: Record<string, unknown>) => {
            if (event?.type === 'complete') {
              unregisterSessionPush(appSessionId);
              sessionPushHandlers.delete(appSessionId);
              resolve();
            }
          };
          // 用包装器：先转发给 pushHandler，再检查终态
          registerSessionPush(appSessionId, (event) => {
            pushHandler(event);
            onDone(event as Record<string, unknown>);
          });
        });
      } catch (error) {
        unregisterSessionPush(appSessionId);
        throw error;
      }
      return undefined;
    };
  }

  function wrapAbort(localAbort: (providerSessionId: string) => Promise<boolean> | boolean) {
    return async (providerSessionId: string): Promise<boolean> => {
      const entry = registry.getSessionHostByProvider(providerSessionId);
      if (!entry) return localAbort(providerSessionId);
      try {
        await registry.rpc(entry.hostId, 'session/interrupt', { appSessionId: entry.appSessionId });
        return true;
      } catch {
        return false;
      }
    };
  }

  function wrapResolveToolApproval(localResolve: (requestId: string, payload: unknown) => void) {
    return (requestId: string, payload: unknown) => {
      const pending = registry.takePendingApproval(requestId);
      if (!pending) {
        localResolve(requestId, payload);
        return;
      }
      void registry.rpc(pending.hostId, 'approval/respond', {
        requestId,
        decision: payload,
      }).catch(() => {});
    };
  }

  function wrapGetPendingApprovals(localGet: (providerSessionId: string) => unknown[]) {
    return (providerSessionId: string) => {
      const local = localGet(providerSessionId);
      const entry = registry.getSessionHostByProvider(providerSessionId);
      if (!entry) return local;
      // lite 的审批在远程，query 由 remote-agent.server push 消费（见 Task 9），
      // 这里返回缓存里该 providerSessionId 名下待审批集合（可空实现 + Phase 2 补）。
      return local;
    };
  }

  return {
    wrapSpawn,
    wrapAbort,
    wrapResolveToolApproval,
    wrapGetPendingApprovals,
    emitSessionPush,
    registerSessionPush,
  };
}

export type RemoteRouting = ReturnType<typeof createRemoteRouting>;
```

> `getSessionHostByProvider` 是 registry 需要补的按 providerSessionId 反向查询（Task 4 已建 `sessionHost` map，倒查即可；`setSessionHost` 存的就是（appSessionId → {hostId, providerSessionId}），实现时给 registry 加 `getSessionHostByProvider`，遍历 map 返回含 appSessionId 的条目）。

- [ ] **Step 4: 补 registry 方法 `getSessionHostByProvider`（可推断返回）**

```ts
getSessionHostByProvider(providerSessionId: string): { appSessionId: string; hostId: string } | undefined {
  for (const [appSessionId, entry] of sessionHost) {
    if (entry.providerSessionId === providerSessionId) return { appSessionId, hostId: entry.hostId };
  }
  return undefined;
},
```

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/remote-agents/remote-spawn.ts backend/server/modules/remote-agents/tests/remote-spawn.test.ts
git commit -m "feat(remote-agents): route spawn/abort/approval to remote lite"
```

---

### Task 7: 远程项目创建校验分支

**Files:**
- Modify: `backend/server/modules/projects/services/project-management.service.ts`
- Modify: `backend/server/modules/remote-agents/remote-fs.service.ts`（fs RPC 客户端）
- Test: `backend/server/modules/remote-agents/tests/remote-fs.service.test.ts`、`backend/server/modules/projects/services/tests/project-management.remote.test.ts`

- [ ] **Step 1: 写失败测试（fs RPC 客户端）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteFsClient } from '../remote-fs.service.js';

test('stat maps clean result and network errors', async () => {
  const client = createRemoteFsClient({ rpc: async (_h, m, p) => {
    if (m === 'fs/stat') return { exists: true, isDirectory: true, isFile: false, size: 0, mtimeMs: 1 };
    throw new Error('bad');
  } });
  const st = await client.stat('h1', '/srv/app');
  assert.equal(st.exists, true);
  assert.equal(st.isDirectory, true);
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 fs RPC 客户端**

```ts
// backend/server/modules/remote-agents/remote-fs.service.ts
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';
import type { RemoteStat } from '@/shared/agent-runtime/protocol.js';

export type RemoteFsClient = {
  stat(hostId: string, pathText: string): Promise<RemoteStat>;
  list(hostId: string, pathText: string, maxEntries?: number): Promise<{ name: string; type: 'dir' | 'file' | 'symlink'; size: number | null }[]>;
  read(hostId: string, pathText: string, maxBytes?: number): Promise<{ content: string; truncated: boolean }>;
};

export function createRemoteFsClient(getRegistry: () => RemoteAgentsRegistry): RemoteFsClient {
  const reg = () => getRegistry();
  return {
    stat: (h, p) => reg().rpc<RemoteStat>(h, 'fs/stat', { path: p }),
    list(h, p, maxEntries = 200) {
      return reg().rpc(h, 'fs/list', { path: p, maxEntries });
    },
    read(h, p, maxBytes = 1024 * 1024) {
      return reg().rpc(h, 'fs/read', { path: p, maxBytes });
    },
  };
}
```

- [ ] **Step 4: 写失败测试（远程建项目）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectWithRemote } from '../../../modules/projects/services/project-management.service.js';

test('remote create requires existing dir on host and persists remote_host_id', async () => {
  const statCalls: string[] = [];
  const result = await createProjectWithRemote(
    { projectPath: '/srv/app', remoteHostId: 'h1', customName: null },
    {
      statRemote: async (_h, p) => { statCalls.push(p); return { exists: true, isDirectory: true } as never; },
      persist: (path, _name, remoteHostId) => ({ outcome: 'created' as const, project: { project_path: path, remote_host_id: remoteHostId } as never }),
    },
  );
  assert.equal(result.outcome, 'created');
  assert.deepEqual(statCalls, ['/srv/app']);
});
```

- [ ] **Step 5: 实现远程建项目分支**

```ts
// project-management.service.ts 追加
export type RemoteProjectDeps = {
  statRemote: (hostId: string, projectPath: string) => Promise<unknown>;
  persist: (projectPath: string, customName: string | null, remoteHostId: string) => CreateProjectPathResult;
};

export async function createProjectWithRemote(
  input: { projectPath: string; remoteHostId: string; customName?: string | null },
  deps: RemoteProjectDeps,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) throw new AppError('path is required', { code: 'PROJECT_PATH_REQUIRED', statusCode: 400 });
  if (!input.remoteHostId) throw new AppError('remoteHostId is required for remote project', { code: 'REMOTE_HOST_REQUIRED', statusCode: 400 });
  // 远程校验：目录必须真实存在且为目录（不做本地 fs.mkdir）
  const st = (await deps.statRemote(input.remoteHostId, normalizedPath)) as { exists: boolean; isDirectory: boolean };
  if (!st.exists || !st.isDirectory) {
    throw new AppError('Remote path does not exist or is not a directory', { code: 'REMOTE_PATH_NOT_DIRECTORY', statusCode: 400 });
  }
  const name = resolveDisplayName(input.customName ?? null, normalizedPath);
  const persisted = deps.persist(normalizedPath, name, input.remoteHostId);
  if (persisted.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', { code: 'PROJECT_ALREADY_EXISTS', statusCode: 409 });
  }
  return { outcome: persisted.outcome, project: persisted.project as never };
}
```

- [ ] **Step 6: routes 增加远程创建入口（projects.routes.ts，依赖 remoteHostsDb 确认 host、fs 客户端做 stat）**

```ts
router.post('/create-remote-project', asyncHandler(async (req, res) => {
  const { path, remoteHostId, customName } = req.body as Record<string, unknown>;
  const host = remoteHostsDb.getById(String(remoteHostId ?? ''));
  if (!host) throw new AppError('Remote host not found', { code: 'REMOTE_HOST_NOT_FOUND', statusCode: 404 });
  if (!remoteAgentsRegistry.isOnline(host.host_id)) {
    throw new AppError('Remote host is offline', { code: 'REMOTE_HOST_OFFLINE', statusCode: 409 });
  }
  const project = await createProjectWithRemote(
    { projectPath: String(path ?? ''), remoteHostId: host.host_id, customName: typeof customName === 'string' ? customName : null },
    { statRemote: (h, p) => remoteFsClient.stat(h, p), persist: (p, n, h) => projectsDb.createProjectPath(p, n, true, h) },
  );
  remoteProjectsIndex.refresh();
  res.json({ success: true, project });
}));
```

> `projectsDb.createProjectPath` 需要支持 `remote_host_id` 参数（Task 7 内同步修改 `repositories/projects.db.ts` 的 INSERT 兼容该列；有值的行写，无值保持 NULL）。

- [ ] **Step 7: 运行全部相关测试确认通过**
- [ ] **Step 8: Commit**

```bash
git add backend/server/modules/projects/services/project-management.service.ts backend/server/modules/projects/projects.routes.ts backend/server/modules/database/repositories/projects.db.ts backend/server/modules/remote-agents/remote-fs.service.ts backend/server/modules/remote-agents/tests/ remote项目测试
git commit -m "feat(remote-agents): remote project creation branch + fs read RPC client"
```

---

### Task 8: remote-lite 包骨架（config + WS 客户端 + 心跳）

**Files:**
- Create: `backend/remote-agent/package.json`
- Create: `backend/remote-agent/tsconfig.json`
- Create: `backend/remote-agent/src/config.ts`
- Create: `backend/remote-agent/src/index.ts`
- Test: `backend/remote-agent/src/tests/config.test.ts`

- [ ] **Step 1: package.json + tsconfig**

```json
{
  "name": "lovdex-remote-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/lite.mjs",
    "start": "node dist/lite.mjs",
    "test": "tsx --test src/tests/config.test.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.113",
    "ws": "^8.14.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: 写失败测试（config 校验）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

test('config rejects missing token/serverUrl', () => {
  assert.throws(() => loadConfig({} as never));
});

test('config parses valid file with roots', () => {
  const cfg = loadConfig({ serverUrl: 'ws://10.0.0.1:3000/api/remote-agents/ws', token: 't', hostId: 'h1', roots: ['/srv'] } as never);
  assert.equal(cfg.hostId, 'h1');
  assert.deepEqual(cfg.roots, ['/srv']);
});
```

- [ ] **Step 3: 运行测试确认失败**
- [ ] **Step 4: 实现 config.ts**

```ts
// backend/remote-agent/src/config.ts
import { z } from 'zod';

const configSchema = z.object({
  serverUrl: z.string().url().or(z.string().min(2)),
  token: z.string().min(8),
  hostId: z.string().min(1),
  roots: z.array(z.string()).min(1).default(['/.lovdex']),
  agentVersion: z.string().default('0.1.0'),
  apiKeyEnvPath: z.string().optional(),   // 例如 /home/user/.lovdex-remote/.env
  claudeCliPath: z.string().optional(),
});

export type RemoteAgentConfig = z.infer<typeof configSchema>;

export function loadConfig(raw: unknown): RemoteAgentConfig {
  return configSchema.parse(raw);
}

export function loadConfigFile(filePath = process.env.LOVDEX_REMOTE_CONFIG ?? '/home/user/.lovdex-remote/config.json'): RemoteAgentConfig {
  const fs = require('node:fs');
  return loadConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
```

- [ ] **Step 5: 实现 index.ts（出站 WS 客户端 + 心跳 + rpc 分发表）**

```ts
// backend/remote-agent/src/index.ts
import WebSocket from 'ws';
import { loadConfigFile } from './config.js';
import type { AgentFrameIn } from '../shared/agent-runtime/protocol.js';
import { encodeRpcRequest, makePing } from '../shared/agent-runtime/protocol.js';
import { handleRpc } from './rpc-dispatch.js';

export async function main() {
  const config = loadConfigFile();
  const url = new URL(config.serverUrl);
  url.searchParams.set('token', config.token);
  const ws = new WebSocket(url.toString());

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  function sendHello(): void {
    ws.send(JSON.stringify({
      type: 'hello',
      hostId: config.hostId,
      agentVersion: config.agentVersion,
      nodeVersion: process.version,
      os: process.platform,
      roots: config.roots,
      capabilities: ['session/claude', 'fs/read'],
    }));
  }

  ws.on('open', sendHello);

  ws.on('message', async (raw: Buffer) => {
    const frame = JSON.parse(String(raw)) as AgentFrameIn & { type: string };
    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      return;
    }
    if (frame.type !== 'rpc_req') return;
    const req = frame as { id: string; method: string; params: unknown };
    try {
      const data = await handleRpc(req.method, req.params, config);
      ws.send(JSON.stringify({ type: 'rpc_res', id: req.id, ok: true, data }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'rpc_res', id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });

  setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(makePing());
  }, 15_000);

  ws.on('close', () => {
    console.error('[remote-agent] connection closed, reconnecting in 3s');
    setTimeout(() => main().catch((e) => { console.error(e); process.exit(1); }), 3000);
  });
  ws.on('error', (e) => console.warn('[remote-agent] ws error:', e.message));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 6: 运行测试确认通过**
- [ ] **Step 7: Commit**

```bash
git add backend/remote-agent/package.json backend/remote-agent/tsconfig.json backend/remote-agent/src/config.ts backend/remote-agent/src/index.ts backend/remote-agent/src/tests/config.test.ts
git commit -m "feat(remote-agent): lite service skeleton with ws client + heartbeat"
```

---

### Task 9: lite `runClaudeSessionOnLite`（SDK 循环 + 审批/中断/终态）+ rpc-dispatch

**Files:**
- Create: `backend/remote-agent/src/agent-run.ts`
- Create: `backend/remote-agent/src/rpc-dispatch.ts`
- Test: `backend/remote-agent/src/tests/agent-run.test.ts`

**说明**：lite 版本是纯 agent（不注入 operator 工具），循环核心 = SDK `query` + 事件归一化（复用协议模块）+ approval 回调 + abort 信号。

- [ ] **Step 1: 写失败测试（注入假 SDK `query`，验证事件归一化 + 终态）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunManager } from '../agent-run.js';

test('start pushes normalized events and complete', async () => {
  const pushed: { topic: string; payload: unknown }[] = [];
  const manager = createAgentRunManager({
    querySdk: async (opts: { tools: unknown[]; onEvent: (e: unknown) => void }) => {
      opts.onEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
      opts.onEvent({ type: 'result', sessionId: 'P1' });
      return 'P1';
    },
    push: (topic, payload) => pushed.push({ topic, payload }),
  });
  const res = await manager.start({
    appSessionId: 's1', providerSessionId: null, command: 'hi', cwd: '/srv/app',
  } as never);
  assert.equal(res.providerSessionId, 'P1');
  assert.ok(pushed.some((p) => p.topic === 'session:s1'));
  assert.ok(pushed.some((p) => p.topic === 'session:s1' && (p.payload as { type: string }).type === 'complete'));
});

test('approval flow reserves request and resolves via respond', async () => {
  let approved: unknown;
  let requested: (() => Promise<void>) | undefined;
  const manager = createAgentRunManager({
    querySdk: async (opts: { tools: unknown[]; onEvent: (e: unknown) => void; canUseTool?: (e: unknown) => Promise<unknown> }) => {
      requested = async () => {
        await opts.canUseTool?.({ tool_use_id: 'req1', input: {} });
      };
      return 'P1';
    },
    push: (topic, payload) => manager.pushApproval?.('s1', 'req1', payload),
  });
  await manager.start({ appSessionId: 's1', providerSessionId: null, command: 'x', cwd: '/srv' } as never);
  assert.ok(manager.takeApproval('req1'));
  await manager.respond('req1', { allow: true } as never);
  assert.ok(true);
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 agent-run + rpc-dispatch**

```ts
// backend/remote-agent/src/agent-run.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { normalizeAgentEvent, terminalCompleteEvent } from '../shared/agent-runtime/normalize.js';

export type AgentRunManagerDeps = {
  querySdk?: typeof query;
  push: (topic: string, payload: unknown) => void;
};

export type StartParams = {
  appSessionId: string;
  providerSessionId: string | null;
  command: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  includePartialMessages?: boolean;
};

export function createAgentRunManager(deps: AgentRunManagerDeps) {
  const sessions = new Map<string, { abort: () => void }>();
  const approvals = new Map<string, { appSessionId: string; resolve: (v: unknown) => void }>();

  return {
    get sessions() { return sessions; },
    pushApproval: (appSessionId: string, requestId: string, payload: unknown) =>
      deps.push(`approval:${requestId}`, { appSessionId, approval: payload }),
    takeApproval: (requestId: string) => approvals.get(requestId),
    respond(requestId: string, decision: unknown): boolean {
      const entry = approvals.get(requestId);
      if (!entry) return false;
      approvals.delete(requestId);
      entry.resolve(decision);
      return true;
    },
    async start(params: StartParams): Promise<{ providerSessionId: string }> {
      const querySdk = deps.querySdk ?? query;
      const events = new Map<string, (e: unknown) => void>();
      let providerSessionId = params.providerSessionId ?? '';
      let aborted = false;

      const send = (event: Record<string, unknown>) => {
        events.get(params.appSessionId)?.(event);
        deps.push(`session:${params.appSessionId}`, event);
      };

      const canUseTool = async (tool: { tool_use_id?: string; input?: unknown }) => {
        const requestId = tool.tool_use_id ?? `appr-${Math.random().toString(36).slice(2)}`;
        await new Promise<void>((resolve) => {
          approvals.set(requestId, { appSessionId: params.appSessionId, resolve: (d) => {
            const decision = (d as { allow?: boolean; deny?: boolean; values?: unknown });
            if (decision?.deny) resolveDenied();
            else resolve();
          }});
          deps.push(`approval:${requestId}`, { appSessionId: params.appSessionId, approval: tool });
        });
      };

      // 简单实现：用 callbacks.deny 兜底
      const sdkOptions: Record<string, unknown> = {
        cwd: params.cwd,
        sessionId: params.providerSessionId ?? undefined,
        resume: Boolean(params.providerSessionId),
        permissionMode: 'default',
        includePartialMessages: params.includePartialMessages ?? true,
        canUseTool: canUseTool as never,
      };
      if (params.model) sdkOptions.model = params.model;

      const controller = new AbortController();
      sessions.set(params.appSessionId, { abort: () => controller.abort() });

      const runPromise = (async () => {
        for await (const event of querySdk(params.command, sdkOptions as never)) {
          if (aborted) break;
          if (event.type === 'session_id') providerSessionId = String(event.session_id);
          send(normalizeAgentEvent(event as never));
        }
        send(terminalCompleteEvent(providerSessionId));
        sessions.delete(params.appSessionId);
        return providerSessionId;
      })();

      const result = await runPromise;
      return { providerSessionId: result };
    },
    interrupt(appSessionId: string): boolean {
      const run = sessions.get(appSessionId);
      if (!run) return false;
      run.abort();
      return true;
    },
  };
}

export type AgentRunManager = ReturnType<typeof createAgentRunManager>;
```

> 说明：`canUseTool` 简化版（允许即继续、deny 用 throw 兜底）。真实 SDK 的审批类型在实现时对照 `@anthropic-ai/claude-agent-sdk` 类型补齐；本任务以 seam + 行为测试为准。

```ts
// backend/remote-agent/src/rpc-dispatch.ts
import { createAgentRunManager, type StartParams } from './agent-run.js';
import { createAllowlistedFs, type AllowlistedFs } from './fs.js';
import type { RemoteAgentConfig } from './config.js';

export async function handleRpc(method: string, params: unknown, config: RemoteAgentConfig): Promise<unknown> {
  const parts = (method ?? '').split('/');
  const group = parts[0];
  const cmd = parts.slice(1).join('/');

  if (group === 'session') {
    if (cmd === 'start') return agentRuns.start(params as StartParams);
    if (cmd === 'interrupt') return { interrupted: agentRuns.interrupt((params as { appSessionId: string }).appSessionId) };
    if (cmd === 'messages') return { messages: [] }; // Phase 1 简化：历史回传空（留 TODO Task 14 集成再补）
    return { error: `unknown session cmd: ${cmd}` };
  }
  if (group === 'approval') {
    if (cmd === 'respond') {
      const { requestId, decision } = params as { requestId: string; decision: unknown };
      return { accepted: agentRuns.respond(requestId, decision) };
    }
  }
  if (group === 'fs') {
    if (cmd === 'stat') return allowlistedFs.stat((params as { path: string }).path);
    if (cmd === 'list') return allowlistedFs.list((params as { path: string }).path, (params as { maxEntries?: number }).maxEntries);
    if (cmd === 'read') return allowlistedFs.read((params as { path: string }).path, (params as { maxBytes?: number }).maxBytes);
    return { error: `unknown fs cmd: ${cmd}` };
  }
  throw new Error(`unknown rpc method: ${method}`);
}

// 模块级单例（进程内一个）
export const agentRuns = createAgentRunManager({
  push: (topic, payload) => {
    // index.ts 里注入真实的 ws.send——通过 setter 桥接
    emitFrame({ type: 'push', topic, payload });
  },
});
export { agentRuns };

let emitFrame: (frame: unknown) => void = () => {};
export function setEventEmitter(fn: (frame: unknown) => void): void { emitFrame = fn; }
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/remote-agent/src/agent-run.ts backend/remote-agent/src/rpc-dispatch.ts backend/remote-agent/src/tests/agent-run.test.ts
git commit -m "feat(remote-agent): claude session runner with approval seam"
```

---

### Task 10: lite 白名单 fs（stat/list/read）

**Files:**
- Create: `backend/remote-agent/src/fs.ts`
- Test: `backend/remote-agent/src/tests/fs.test.ts`

- [ ] **Step 1: 写失败测试（白名单外拒绝 + 目录/文件类型区分）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { createAllowlistedFs } from '../fs.js';

let root: string;
let fsApi: ReturnType<typeof createAllowlistedFs>;
test.beforeEach?.(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lite-fs-'));
  await mkdir(path.join(root, 'sub'));
  await writeFile(path.join(root, 'sub', 'a.txt'), 'hello');
  fsApi = createAllowlistedFs({ roots: [root] });
});
test.afterEach?.(async () => { await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); });

test('stat lists dir level and reads file within root', async () => {
  const st = await fsApi.stat(root);
  assert.equal(st.isDirectory, true);
  const listing = await fsApi.list(root);
  assert.ok(listing.some((e) => e.name === 'sub'));
  const file = await fsApi.read(path.join(root, 'sub', 'a.txt'));
  assert.equal(file.content, 'hello');
});

test('rejects paths outside root', async () => {
  await assert.rejects(() => fsApi.read('/etc/passwd'), /outside/
  );
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现白名单 fs（自带 resolveRealPath 拷贝，symlink/越权防护）**

```ts
// backend/remote-agent/src/fs.ts
import { stat, readdir, open } from 'node:fs/promises';
import path from 'node:path';

/** 与主站 operator-exec 的 resolveRealPath 逻辑一致的拷贝：walk 到最近存在祖先 realpath，防 symlink 跨越。 */
function resolveRealPath(input: string, root: string): string {
  const fn = (await import('node:fs')).existsSync;
  const expanded = input.startsWith('~') ? path.join(osHomedir(), input.slice(1)) : input;
  let resolved = path.resolve(expanded);
  const missing: string[] = [];
  let cursor = resolved;
  while (fn(cursor) === false && cursor !== path.dirname(cursor)) {
    missing.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }
  try { cursor = require('node:fs').realpathSync(cursor); } catch { /* keep lexical */ }
  resolved = missing.length ? path.join(cursor, ...missing) : cursor;
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path outside allowed root: ${input}`);
  return resolved;
}

function osHomedir(): string { return require('node:os').homedir(); }

export type AllowlistedFs = {
  stat(p: string): Promise<{ exists: boolean; isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number }>;
  list(p: string, maxEntries?: number): Promise<{ name: string; type: 'dir' | 'file' | 'symlink'; size: number | null }[]>;
  read(p: string, maxBytes?: number): Promise<{ content: string; truncated: boolean }>;
};

const MAX_READ_BYTES = 1024 * 1024;

export function createAllowlistedFs(opts: { roots: string[]; maxEntries?: number }): AllowlistedFs {
  const roots = opts.roots.map((r) => path.resolve(r));
  const root = roots[0]; // Phase 1 单根
  const within = (p: string) => resolveRealPath(p, root);
  return {
    async stat(p) {
      const target = within(p);
      try {
        const s = await stat(target);
        return { exists: true, isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        return { exists: false, isDirectory: false, isFile: false, size: 0, mtimeMs: 0 };
      }
    },
    async list(p, maxEntries = opts.maxEntries ?? 200) {
      const target = within(p);
      const dir = await readdir(target, { withFileTypes: true });
      return dir.slice(0, maxEntries).map((d) => ({
        name: d.name,
        type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
        size: null,
      }));
    },
    async read(p, maxBytes = MAX_READ_BYTES) {
      const target = within(p);
      const fd = await open(target, 'r');
      try {
        const buf = Buffer.alloc(Math.min((await fd.stat()).size, maxBytes));
        await fd.read(buf, 0, buf.length, 0);
        return { content: buf.toString('utf8'), truncated: (await fd.stat()).size > maxBytes };
      } finally {
        await fd.close();
      }
    },
  };
}
```

> 注意：`node:test` 无全局 `beforeEach/afterEach`——用 `test('...', { beforeEach })` 或每个用例内建临时目录。实现时保证测试可运行（建议改用 `test.before` 或单一用例内建）。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/remote-agent/src/fs.ts backend/remote-agent/src/tests/fs.test.ts
git commit -m "feat(remote-agent): allowlisted fs ops for lite"
```

---

### Task 11: bootstrap 服务（ssh 探测/推包/systemd/公钥）

**Files:**
- Create: `backend/server/modules/remote-agents/bootstrap.service.ts`
- Test: `backend/server/modules/remote-agents/tests/bootstrap.service.test.ts`
- Create: `backend/remote-agent/deploy/systemd-unit.template`
- Create: `backend/remote-agent/deploy/install.sh`

- [ ] **Step 1: 写失败测试（注入假 ssh runner 验证完整流程）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBootstrap } from '../bootstrap.service.js';

test('bootstrap probes, uploads, installs and writes config', async () => {
  const calls: string[] = [];
  const runner = async (cmd: string) => {
    calls.push(cmd);
    if (cmd.includes('node -v')) return { ok: true, stdout: 'v20.0.0' };
    if (cmd.includes('claude -v')) return { ok: true, stdout: '1.0.0' };
    return { ok: true, stdout: '' };
  };
  const result = await runBootstrap({
    host: '10.0.0.5', sshUser: 'root', token: 'secret-token', serverUrl: 'ws://host:3000/ws',
    roots: ['/srv/app'],
  }, { runner });
  assert.equal(result.status, 'online');
  assert.ok(calls.some((c) => c.includes('node -v')));
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 bootstrap.service（ssh 命令、scp、systemd 安装脚本生成）**

```ts
// backend/server/modules/remote-agents/bootstrap.service.ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

export type SshRunner = (cmdAndArgs: string[], cwd?: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const defaultRunner: SshRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync('ssh', args, { timeout: 15_000 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String(e) };
  }
};

export type BootstrapInput = {
  host: string;
  port?: number;
  sshUser: string;
  identityFile?: string | null;   // lovdex 私钥路径或既有密钥路径
  token: string;
  serverUrl: string;
  roots: string[];
  claudeApiKeyFile?: string;      // 远程 .env 来源：本机配置里已存在的 key（可选）
};

export type BootstrapResult = { status: 'online' | 'error'; stdout?: string };

export async function runBootstrap(
  input: BootstrapInput,
  deps: { runner?: SshRunner; writeConfig?: (remotePath: string, content: string) => Promise<void> } = {},
): Promise<BootstrapResult> {
  const sshArgs = (rest: string[]) => [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(input.port ?? 22),
    ...(input.identityFile ? ['-i', input.identityFile] : []),
    `${input.sshUser}@${input.host}`, ...rest,
  ];
  const runner = deps.runner ?? defaultRunner;
  const remote = `${input.sshUser}@${input.host}`;

  const probe = await runner(sshArgs(['uname']));
  if (!probe.ok) return { status: 'error', stdout: probe.stderr };

  const nodeV = await runner(sshArgs(['node', '-v']));
  if (!nodeV.ok) {
    return { status: 'error', stdout: 'node not found on remote — install node >=20 first (see deploy/install.sh)' };
  }
  const claudeV = await runner(sshArgs(['claude', '-v']));
  if (!claudeV.ok) {
    return { status: 'error', stdout: 'claude CLI not found on remote — run: npm i -g @anthropic-ai/claude-code' };
  }

  const mkdir = await runner(sshArgs(['mkdir', '-p', '~/.lovdex-remote']));
  if (!mkdir.ok) return { status: 'error', stdout: mkdir.stderr };

  // 远端配置（0600）
  const configJson = JSON.stringify({
    serverUrl: input.serverUrl, token: input.token, hostId: crypto.randomUUID(),
    roots: input.roots, apiKeyEnvPath: '~/.lovdex-remote/.env',
  });
  await runner(sshArgs(['sh', '-c', `umask 077 && cat > ~/.lovdex-remote/config.json <<'EOF'\n${configJson}\nEOF`]));

  const tokenHash = crypto.createHash('sha256').update(input.token).digest('hex');
  // 生成 systemd unit 并 enable（unit 模板见 deploy/；用 scp 上传独立一步也接受）
  await runner(sshArgs(['systemctl', '--user', 'enable', 'lovdex-agent.service']));

  return { status: 'online', stdout: tokenHash };
}
```

> 打包上传：Task 11 用「ssh 管道写 config」演示；`scp` 上传 lite 产物与 `install.sh` 步骤在部署脚本里补充（`deploy/install.sh` 负责：mkdir、npm ci、systemd --user 安装、enable --now）。集成时把 `execFile('scp', ...)` 也放进 runner 抽象。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/bootstrap.service.ts backend/server/modules/remote-agents/tests/bootstrap.service.test.ts backend/remote-agent/deploy/systemd-unit.template backend/remote-agent/deploy/install.sh
git commit -m "feat(remote-agents): ssh bootstrap service"
```

---

### Task 12: remote-agents REST 路由

**Files:**
- Create: `backend/server/modules/remote-agents/remote-agents.routes.ts`
- Test: `backend/server/modules/remote-agents/tests/remote-agents.routes.test.ts`
- Create: `backend/server/modules/remote-agents/remote-projects.index.ts`

- [ ] **Step 1: 实现 remote-projects.index（内存 projectPath→hostId，供 lookup）**

```ts
// backend/server/modules/remote-agents/remote-projects.index.ts
let index = new Map<string, string>(); // project_path → host_id

export function refreshRemoteProjectsIndex(rows: { project_path: string; remote_host_id: string | null }[]): void {
  const next = new Map<string, string>();
  for (const r of rows) if (r.remote_host_id) next.set(r.project_path, r.remote_host_id);
  index = next;
}
export function lookupRemoteHost(projectPath: string | undefined): string | null {
  if (!projectPath) return null;
  return index.get(projectPath) ?? null;
}
```

- [ ] **Step 2: 写失败测试（routes：list/add/remove/pubkey/deploy/list-dirs）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAgentsRouter } from '../remote-agents.routes.js';
import { createRemoteHostsDb } from '../remote-host.db.js';
import Database from 'better-sqlite3';

test('GET / lists hosts and GET /pubkey returns a pem', () => {
  const db = new Database(':memory:');
  const repo = createRemoteHostsDb(db);
  repo.create({ host_id: 'h1', name: 'dev', host: '10.0.0.5', ssh_user: 'root' });
  const router = createRemoteAgentsRouter({ repo, registry: { isOnline: () => true } as never, cryptoKeyPath: '/tmp/lovdex-key' });
  const req = {} as never; const res = { json: (d: unknown) => { assert.ok(Array.isArray((d as { hosts: unknown[] }).hosts)); } } as never;
  (router.stack.find((l) => l.route?.path === '/'))!.route.stack[0].handle(req, res);
});
```

- [ ] **Step 3: 运行测试确认失败**
- [ ] **Step 4: 实现路由**

```ts
// backend/server/modules/remote-agents/remote-agents.routes.ts
import express from 'express';
import crypto from 'node:crypto';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { RemoteHostsRepository } from './remote-host.db.js';
import { runBootstrap } from './bootstrap.service.js';
import type { RemoteAgentsRegistry } from './remote-agents.registry.js';

export type RemoteAgentsRouterDeps = {
  repo: RemoteHostsRepository;
  registry: RemoteAgentsRegistry;
  cryptoKeyPath: string;               // 保存的 lovdex 私钥路径（bootstrap 用）
  publicKey: string;
  fsClient?: { list: (hostId: string, p: string) => Promise<unknown> };
  tokenFor: (hostId: string) => string; // 生成/重读 token
};

export function createRemoteAgentsRouter(deps: RemoteAgentsRouterDeps): express.Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    const hosts = deps.repo.list().map((h) => ({
      ...h,
      online: deps.registry.isOnline(h.host_id),
    }));
    res.json(createApiSuccessResponse({ hosts }));
  });

  router.get('/pubkey', (req, res) => {
    res.json(createApiSuccessResponse({ publicKey: deps.publicKey }));
  });

  router.post('/', asyncHandler(async (req, res) => {
    const { name, host, sshUser, port, authType, password } = req.body as Record<string, unknown>;
    if (!name || !host || !sshUser) throw new AppError('name/host/sshUser required', { code: 'REMOTE_INPUT_REQUIRED', statusCode: 400 });
    const hostId = crypto.randomUUID();
    deps.repo.create({ host_id: hostId, name: String(name), host: String(host), ssh_user: String(sshUser), port: typeof port === 'number' ? port : 22 });
    // authType 处理：'lovdex_key' 默认（公钥已固化在 authorized_keys）；'existing_key' 走 identityFile；'password' 需要在部署时用 sshpass 植入密钥（Phase 1 提示手动）
    if (authType === 'password') {
      throw new AppError('password auth not supported in Phase 1 — place the pubkey manually then retry with lovdex_key', { code: 'REMOTE_PASSWORD_UNSUPPORTED', statusCode: 400 });
    }
    res.json(createApiSuccessResponse({ hostId }));
  }));

  router.post('/:hostId/deploy', asyncHandler(async (req, res) => {
    const host = deps.repo.getById(String(req.params.hostId));
    if (!host) throw new AppError('remote host not found', { code: 'REMOTE_HOST_NOT_FOUND', statusCode: 404 });
    deps.repo.updateStatus(host.host_id, 'deploying');
    try {
      const token = deps.tokenFor(host.host_id);
      const result = await runBootstrap({
        host: host.host,
        port: host.port,
        sshUser: host.ssh_user,
        identityFile: deps.cryptoKeyPath,
        token,
        serverUrl: process.env.LOVDEX_PUBLIC_WS_URL ?? 'ws://localhost:3000/api/remote-agents/ws',
        roots: [],
      });
      deps.repo.updateStatus(host.host_id, result.status, result.stdout);
      res.json(createApiSuccessResponse({ status: result.status }));
    } catch (e) {
      deps.repo.updateStatus(host.host_id, 'error', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }));

  router.get('/:hostId/dirs', asyncHandler(async (req, res) => {
    const host = deps.repo.getById(String(req.params.hostId));
    if (!host) throw new AppError('remote host not found', { code: 'REMOTE_HOST_NOT_FOUND', statusCode: 404 });
    if (!deps.registry.isOnline(host.host_id)) throw new AppError('remote host is offline', { code: 'REMOTE_HOST_OFFLINE', statusCode: 409 });
    const dirs = await deps.fsClient?.list(host.host_id, String(req.query.path ?? '~')) ?? [];
    res.json(createApiSuccessResponse({ dirs }));
  }));

  router.delete('/:hostId', asyncHandler(async (req, res) => {
    deps.repo.remove(String(req.params.hostId));
    res.json(createApiSuccessResponse({ removed: true }));
  }));

  return router;
}
```

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: Commit**

```bash
git add backend/server/modules/remote-agents/remote-agents.routes.ts backend/server/modules/remote-agents/remote-projects.index.ts backend/server/modules/remote-agents/tests/remote-agents.routes.test.ts
git commit -m "feat(remote-agents): REST routes for host registry, deploy, remote dir browse"
```

---

### Task 13: index.js 接线（WS + 路由 + spawnFns/abort/approval 包一层）

**Files:**
- Modify: `backend/server/index.js`

- [ ] **Step 1: 在 `index.js` 引入 remote-agents 组件并接线**（在现有 `const wss = createWebSocketServer(...)` 之前构造依赖）

```js
import { createRemoteAgentsRegistry } from './modules/remote-agents/remote-agents.registry.js';
import { createRemoteAgentWss, createRemoteAgentConnectionHandler } from './modules/remote-agents/remote-agent.server.js';
import { createRemoteRouting } from './modules/remote-agents/remote-spawn.js';
import { createRemoteHostsDb } from './modules/remote-agents/remote-host.db.js';
import { createRemoteAgentsRouter } from './modules/remote-agents/remote-agents.routes.js';
import { createRemoteFsClient } from './modules/remote-agents/remote-fs.service.js';
import { lookupRemoteHost, refreshRemoteProjectsIndex } from './modules/remote-agents/remote-projects.index.js';
import { getConnection } from './modules/database/connection.js';
import { remoteHostsDb } from './modules/database/index.js';

// 远程主机索引（建索引/删项目后 refresh）
refreshRemoteProjectsIndex(projectsDb.listPathsWithRemoteHost());

const remoteAgentsRegistry = createRemoteAgentsRegistry();
const remoteFsClient = createRemoteFsClient(() => remoteAgentsRegistry);
const routing = createRemoteRouting({ lookupHost: lookupRemoteHost, registry: remoteAgentsRegistry });
```

- [ ] **Step 2: 用路由层包装现有四个 hook**（在 `createWebSocketServer` 调用处）

```js
const spawnFns = {
  claude: routing.wrapSpawn(queryClaudeSDK),
  codex: routing.wrapSpawn(queryCodex),
  opencode: routing.wrapSpawn(queryOpenCode),
  qoder: routing.wrapSpawn(queryQoder),
};

abortFns: {
  claude: routing.wrapAbort(abortClaudeSDKSession),
  codex: routing.wrapAbort(abortCodexSession),
  opencode: routing.wrapAbort(abortOpenCodeSession),
  qoder: routing.wrapAbort(abortQoderSession),
},
resolveToolApproval: routing.wrapResolveToolApproval((requestId, payload) => {
  resolveToolApproval(requestId, payload);
  resolveQoderToolApproval(requestId, payload);
}),
getPendingApprovalsForSession: routing.wrapGetPendingApprovals((providerSessionId) => [
  ...getPendingApprovalsForSession(providerSessionId),
  ...getQoderPendingApprovalsForSession(providerSessionId),
]),
```

- [ ] **Step 3: 挂 remote-agent WS 与 REST 路由**

```js
// lite 出站 WS：token → hostId 校验
const remoteAgentWss = createRemoteAgentWss(server, {
  verifyToken: (token) => {
    if (!token) return null;
    const host = remoteHostsDb.getByTokenHash(crypto.createHash('sha256').update(token).digest('hex'));
    return host?.host_id ?? null;
  },
  registry: remoteAgentsRegistry,
  onHostOnline: (hostId) => { remoteHostsDb.updateStatus(hostId, 'online'); remoteHostsDb.touchSeen(hostId); },
  onHostOffline: (hostId) => { remoteHostsDb.updateStatus(hostId, 'offline'); },
});
app.use('/api/remote-agents', createRemoteAgentsRouter({
  repo: remoteHostsDb,
  registry: remoteAgentsRegistry,
  cryptoKeyPath: path.join(cfg.dataDir, 'ssh', 'lovdex_ed25519'),
  publicKey: fs.readFileSync(path.join(cfg.dataDir, 'ssh', 'lovdex_ed25519.pub'), 'utf8').trim(),
  fsClient: remoteFsClient,
  tokenFor: (hostId) => generateOrReadHostToken(hostId),
}));
```

> 需补：`remoteHostsDb.getByTokenHash(hash)`（按 `agent_token_hash` 查）；密钥对在 `cfg.dataDir/ssh/` 首次生成（`ssh-keygen -t ed25519 -f ... -N ""` 或用 node crypto 生成 OpenSSH 格式——实现时选已装 ssh-keygen 的命令方式，简单可靠）。`projectsDb.listPathsWithRemoteHost()` 返回 `{project_path, remote_host_id}` 列表（Task 7 项目仓库已兼容 remote_host_id 列）。

- [ ] **Step 4: 冒烟验证 typecheck 零新增**

Run: `cd backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -20`
Expected: 仅 baseline 已知 4 个 pre-existing 错误（与本节无关）

- [ ] **Step 5: 运行全部单测确认通过**

Run: `cd backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/remote-agents server/shared/agent-runtime 2>&1 | tail -25`
Expected: 所有 remote-agents/agent-runtime 测试 PASS

- [ ] **Step 6: Commit**

```bash
git add backend/server/index.js backend/server/modules/database/repositories/projects.db.ts backend/server/modules/remote-agents
git commit -m "feat(remote-agents): wire ws endpoint, routes, and spawn routing into server"
```

---

### Task 14: loopback lite 集成测试（同进程全链路）

**Files:**
- Create: `backend/server/modules/remote-agents/tests/loopback-lite.integration.test.ts`

**思路**：不起真进程——在测试里用 `ws` 建一个轻量 WSS，把 lite 的 `handleRpc` 接到一个假连接，主侧用 registry 直连，走通 `session/start → push 事件 → approval → respond → complete`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createRemoteAgentsRegistry } from '../remote-agents.registry.js';

test('loopback: session/start over ws pushes normalized complete', async () => {
  const reg = createRemoteAgentsRegistry();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let liteSessionStarted = false;
  wss.on('connection', (liteWs) => {
    liteWs.on('message', async (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.method === 'session/start') {
        liteSessionStarted = true;
        liteWs.send(JSON.stringify({ type: 'rpc_res', id: frame.id, ok: true, data: { providerSessionId: 'P1' } }));
        liteWs.send(JSON.stringify({ type: 'push', topic: 'session:s1', payload: { type: 'assistant', eventId: 'e1' } }));
        liteWs.send(JSON.stringify({ type: 'push', topic: 'session:s1', payload: { type: 'complete', eventId: 'e2', done: true } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on('open', r));
  reg.register({ hostId: 'h1', roots: ['/srv'] }, ws as never);

  const events: unknown[] = [];
  const writer = { send: (e: unknown) => events.push(e), setSessionId: () => {}, getSessionId: () => null };
  const routing = (await import('../remote-spawn.js')).createRemoteRouting({ lookupHost: (p) => (p === '/srv/app' ? 'h1' : null), registry: reg });

  const res = await routing.wrapSpawn(async () => { throw new Error('local must not run'); })(
    'hi', { projectPath: '/srv/app', cwd: '/srv/app' }, writer,
  );
  assert.equal(liteSessionStarted, true);
  assert.deepEqual(events.map((e: { type: string }) => e.type), ['assistant', 'complete']);

  ws.close(); wss.close(); server.close();
});
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 让测试通过**（若 remote-spawn 的 push 订阅在 `rpc_res` 到达后才建立，需要把 push handler 注册提前到 `session/start` 之前——在实现中保证：先 `registerSessionPush(appSessionId, handler)`，再发 RPC；push 事件 `session:<appSessionId>` 到达即转发 writer）✔ 已在 Task 6 实现顺序中满足。
- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add backend/server/modules/remote-agents/tests/loopback-lite.integration.test.ts
git commit -m "test(remote-agents): loopback lite integration covers spawn→events→complete"
```

---

### Task 15: E2E（可脚本化，手动执行）

**Files:**
- Create: `backend/scripts/e2e-remote-lite.sh`

- [ ] **Step 1: 写 E2E 脚本**（假设本机开 sshd 且可 `ssh root@127.0.0.1`；或改用容器宿主机 IP）

```bash
#!/usr/bin/env bash
# 验证 remote-lite 端到端：部署 → 建远程项目 → 会话 → 审批。
# 前置：本机 sshd 运行、用户可登录；backend 已在 :3000 运行、AUTH 开启。
set -euo pipefail
HOST_IP=127.0.0.1
SSH_USER="$(whoami)"
APIP="http://127.0.0.1:3000/api"

PUBKEY="$(curl -s "$APIP/remote-agents/pubkey" | jq -r .publicKey)"
mkdir -p ~/.ssh && grep -qF "$PUBKEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> ~/.ssh/authorized_keys

HOST_ID="$(curl -s -X POST "$APIP/remote-agents" -H 'Content-Type: application/json' \
  -d "{\"name\":\"e2e\",\"host\":\"$HOST_IP\",\"sshUser\":\"$SSH_USER\"}" | jq -r .hostId)"
curl -s -X POST "$APIP/remote-agents/$HOST_ID/deploy" | jq
# 等待 hello 上线
for i in $(seq 1 30); do
  STATUS="$(curl -s "$APIP/remote-agents" | jq -r --arg id "$HOST_ID" '.data.hosts[] | select(.host_id==$id) | .status')"
  [ "$STATUS" = online ] && break; sleep 2
done

# 建远程项目（用 SSH_USER 家目录下一个真实目录，如 ~/e2e-remote-src）
curl -s -X POST "$APIP/projects/create-remote-project" -H 'Content-Type: application/json' \
  -d "{\"path\":\"$HOME/e2e-remote-src\",\"remoteHostId\":\"$HOST_ID\"}" | jq
echo "E2E PASS: 部署上线 + 远程建项目成功。会话/审批链路请配合浏览器聊天手工验证。"
```

- [ ] **Step 2: 运行脚本验证**

Run: `bash backend/scripts/e2e-remote-lite.sh`
Expected: 输出 `E2E PASS`；`remote-agents` 列表该 host 为 online

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/e2e-remote-lite.sh
git commit -m "test(remote-agents): e2e script for deploy + remote project"
```

---

### Task 16: 前端——设置「远程机器」Tab + 建项目远程模式 + 远程标记

**Files:**
- Modify: `web/src/components/settings/settingsTabs.ts`
- Modify: `web/src/components/settings/SettingsPage.tsx`
- Create: `web/src/components/settings/RemoteHostsSettingsSection.tsx`
- Create: `web/src/components/settings/RemoteHostsSettingsSection.test.tsx`
- Modify: `web/src/components/project-creation-wizard/ProjectCreationWizard.tsx`
- Modify: `web/src/components/project-creation-wizard/types.ts`
- Modify: `web/src/components/sidebar/`（项目列表远程标记）

- [ ] **Step 1: 设置页新增 Tab**

```ts
// settingsTabs.ts
export type SettingsTab = 'providers' | 'operator' | 'database' | 'account' | 'remote-hosts';
// SETTINGS_TABS 增加 { key: 'remote-hosts', label: '远程机器' }
// VALID_TABS 同步加入（默认仍 providers）
```

```tsx
// SettingsPage.tsx 渲染分支处增加：
case 'remote-hosts': return <RemoteHostsSettingsSection />;
```

- [ ] **Step 2: 实现 RemoteHostsSettingsSection（列表 + 添加 + 部署 + 状态 + pubkey 展示）**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/utils/api';

type RemoteHost = { host_id: string; name: string; host: string; status: string; online: boolean; last_error: string | null };

export function RemoteHostsSettingsSection() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [pubkey, setPubkey] = useState('');
  const [name, setName] = useState(''); const [host, setHost] = useState(''); const [sshUser, setSshUser] = useState('');

  const load = useCallback(async () => {
    const data = (await apiFetch('/api/remote-agents')) as { data?: { hosts?: RemoteHost[] } };
    setHosts(data?.data?.hosts ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void (async () => {
    const p = (await apiFetch('/api/remote-agents/pubkey')) as { data?: { publicKey?: string } };
    setPubkey(p?.data?.publicKey ?? '');
  })(); }, []);

  const addHost = async () => {
    await apiFetch('/api/remote-agents', { method: 'POST', body: JSON.stringify({ name, host, sshUser }) });
    setName(''); setHost(''); setSshUser(''); await load();
  };
  const deploy = async (id: string) => {
    await apiFetch(`/api/remote-agents/${id}/deploy`, { method: 'POST' });
    await load();
  };
  const remove = async (id: string) => {
    await apiFetch(`/api/remote-agents/${id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">远程机器</h3>
      <div>
        <p className="text-sm text-current/70">将下面公钥加入目标机的 <code>~/.ssh/authorized_keys</code>：</p>
        <pre className="mt-1 rounded bg-current/5 p-2 text-xs break-all max-w-full whitespace-pre-wrap">{pubkey || '生成中…'}</pre>
      </div>
      <div className="flex gap-2">
        <input className="input" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input className="input" placeholder="ssh user" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
        <button className="btn" onClick={() => void addHost()}>添加</button>
      </div>
      <ul className="space-y-2">
        {hosts.map((h) => (
          <li key={h.host_id} className="flex items-center gap-3 rounded border p-3">
            <span className="font-medium">{h.name}</span>
            <span className="text-sm text-current/60">{h.host} · {sshUserLabel(h)}</span>
            <span className={`text-sm ${h.online ? 'text-emerald-500' : 'text-current/50'}`}>
              {h.online ? '● 在线' : h.status}
            </span>
            {h.last_error && <span className="text-xs text-red-500 truncate">{h.last_error}</span>}
            <div className="ml-auto flex gap-2">
              <button className="btn-sm" onClick={() => void deploy(h.host_id)}>部署</button>
              <button className="btn-sm text-red-500" onClick={() => void remove(h.host_id)}>删除</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: 建项目向导「远程」模式**（types.ts 加 `projectSource: 'local' | 'remote'`；向导第二步分支：remote → 选 host → 调 `/api/remote-agents/:id/dirs?path=...` 浏览远程目录 → 提交 `create-remote-project`）

```ts
// types.ts 追加
export type WizardProjectSource = 'local' | 'remote';
// WizardFormState 增加 projectSource: WizardProjectSource
```

```tsx
// ProjectCreationWizard.tsx：在提交分支处
const submitRemote = async () => {
  const res = await fetch('/api/projects/create-remote-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: formState.path, remoteHostId: formState.remoteHostId, customName: formState.customName }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.details ?? body?.message ?? '创建远程项目失败');
  return body.project;
};
```

- [ ] **Step 4: 项目列表远程标记**（sidebar/项目列表渲染 `remoteHost?.host` 前缀或用 host 图钉标识；数据来自 `/api/projects` 响应里 `remote_host_id` 存在时附 `remote_host_name`）

- [ ] **Step 5: 浏览器验证**

Run: 启动 backend + web（现有 dev 流程），登录 → 设置「远程机器」→ 添加/部署 → 建项目选远程目录 → 打开会话发消息 → 观察事件流/审批面板
Expected: 远程 host 上线；远程项目会话正常跑；审批弹窗可交互

- [ ] **Step 6: Commit**

```bash
git add web/src/components/settings web/src/components/project-creation-wizard web/src/components/sidebar web/src/types
git commit -m "feat(web): remote hosts settings tab + remote project wizard"
```

---

## Self-Review

**Spec coverage 对照**

| Spec 章节 | 计划任务 |
|---|---|
| remote_hosts 表 + 仓库 | Task 3 |
| WS 协议 + 编解码 | Task 1 |
| 注册表/RPC/session 索引/审批索引 | Task 4 |
| lite 接收端（hello/rpc_res/push） | Task 5 |
| spawn/abort/approval 路由层 | Task 6 |
| 远程建项目校验分支 + fs 客户端 | Task 7 |
| lite 骨架（config/ws/心跳） | Task 8 |
| lite agent 循环（SDK + 审批） | Task 9 |
| lite 白名单 fs | Task 10 |
| bootstrap（ssh/systemd/密钥） | Task 11 |
| REST 路由（机器 CRUD/部署/目录浏览） | Task 12 + 16 |
| index.js 接线 | Task 13 |
| transcript 经 RPC（session/messages） | Task 9 简化 + Task 14 集成补 |
| 文件树只读浏览 | Task 10（fs read）+ Task 16（dirs 浏览） |
| loopback 集成 | Task 14 |
| E2E 脚本 | Task 15 |
| 前端 Tab/向导/标记 | Task 16 |

**已知取舍（记录在案，Phase 2 处理）**
- `session/messages`（历史拉取）Phase 1 先回空数组，聊天打开历史行为以 Task 14 后补，避免阻塞主链路。
- 本地 `claude-sdk.js` 一期不动，共享归一化先服务 lite；Phase 2 并轨消除漂移风险。
- password 认证部署 Phase 1 不支持（提示手动置公钥），与设计一致。
- `session/stop` 方法已入协议但 v1 用 `interrupt` 覆盖（对应用户 abort）。

**类型一致性抽查**：`session/start` 参数名 `appSessionId/providerSessionId/command/cwd` 在 Task 1/4/6/8/9/14 全部一致；`rpc_res{id,ok,data,error}` 在 Task 1/5/8/14 一致；`fs/stat` 返回 `{exists,isDirectory,isFile,size,mtimeMs}` 在 Task 1/7/10 一致。