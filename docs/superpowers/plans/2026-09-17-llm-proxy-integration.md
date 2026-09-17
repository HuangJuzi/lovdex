# llm-proxy 融合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 llm-proxy（Go Anthropic 透明代理）融合进 Lovdex，修复 LLM 偶发报错，并让远程 lite 设备复用已有 WS 反连通道走本机转发。

**Architecture:** llm-proxy 作为本机 sidecar 进程由后端拉起（生成 TOML + 注入 `SOPHNET_API_KEY`）。本机 claude 的 `ANTHROPIC_BASE_URL` 指向代理；远程 lite 上起一个 loopback HTTP 转发器，把 claude CLI 的 HTTP 请求打包成 `llm_req` 帧走 WS 到后端 relay，后端转发给本地 llm-proxy 并流式回 `llm_res`。

**Tech Stack:** TypeScript/Node（后端 + lite，esbuild 打包 lite）、Go 1.21+（llm-proxy sidecar）、node:test + node:assert（测试）。

**设计规格:** `docs/superpowers/specs/2026-09-17-llm-proxy-design.md`

---

## 文件结构总览

**新增：**
- `backend/llm-proxy/` — vendored Go 源码（main.go / main_test.go / translation_test.go / go.mod / go.sum / LICENSE）
- `backend/llm-proxy/build.sh` — Go 构建脚本
- `backend/server/modules/llm-proxy/manager.ts` — TOML 生成 + 进程托管
- `backend/server/modules/remote-agents/llm-relay.ts` — `llm_req` → 本地 llm-proxy → `llm_res`
- `backend/remote-agent/src/llm-forwarder.ts` — lite 侧 HTTP↔WS 桥
- 若干测试文件（见各 Task）

**修改：**
- `backend/server/modules/config/config.ts` — 新增 `llmProxy` 段 + `resolveLlmProxy`
- `backend/server/modules/config/env-sync.ts` — 本机/远程 baseUrl 推导
- `backend/server/shared/agent-runtime/protocol.ts` — 新增 `llm_req`/`llm_res` 帧 + `LLM_FORWARDER_PORT`
- `backend/server/modules/remote-agents/remote-agent.server.ts` — 处理 `llm_req` 帧
- `backend/remote-agent/src/index.ts` — 启动转发器 + 分发 `llm_res`
- `backend/server/modules/websocket/services/headless-task-run.service.ts` — 补 `configEnv`（已知缺口）
- `backend/server/index.js` — boot/shutdown 挂 llm-proxy manager

---

## 测试命令备忘

```bash
# 后端（必须在 backend/ 目录，用 server/tsconfig 解析 @/ 别名）
cd /mnt/b/workdir/github/lovdex/backend
unset TSX_TSCONFIG_PATH
npx tsx --tsconfig server/tsconfig.json --test server/<path>/<file>.test.ts

# 后端 typecheck（验收标准：零新增错误）
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck

# lite 单测
cd /mnt/b/workdir/github/lovdex/backend/remote-agent && npm test

# Go 测试
cd /mnt/b/workdir/github/lovdex/backend/llm-proxy && go test ./...
```

---

## Task 1: Vendor llm-proxy Go 源码并构建

**Files:**
- Create: `backend/llm-proxy/`（从 `/home/zhijuhuang/workdir/github/llm-proxy/` 复制）
- Create: `backend/llm-proxy/build.sh`

- [ ] **Step 1: 复制 Go 源码**

```bash
mkdir -p /mnt/b/workdir/github/lovdex/backend/llm-proxy
cp /home/zhijuhuang/workdir/github/llm-proxy/{main.go,main_test.go,translation_test.go,go.mod,go.sum,LICENSE,config.example.toml} /mnt/b/workdir/github/lovdex/backend/llm-proxy/
```

（不要复制 `llm-proxy-linux-amd64` / `llm-proxy-linux-arm64` / `llm-proxy.service` / `SHA256SUMS`——那是旧仓库的产物，二进制会在下面重新构建。）

- [ ] **Step 2: 写构建脚本**

`backend/llm-proxy/build.sh`：

```bash
#!/usr/bin/env bash
# Builds the llm-proxy sidecar binary into backend/llm-proxy/llm-proxy.
set -euo pipefail
cd "$(dirname "$0")"
go build -o llm-proxy .
echo "built llm-proxy -> $(pwd)/llm-proxy"
```

```bash
chmod +x /mnt/b/workdir/github/lovdex/backend/llm-proxy/build.sh
```

- [ ] **Step 3: 构建并跑 Go 测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend/llm-proxy && go test ./... && ./build.sh
```

Expected: `go test` 全绿（原仓库已跑过）；`./build.sh` 输出 `built llm-proxy -> .../backend/llm-proxy/llm-proxy`，且生成 `llm-proxy` 二进制。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/llm-proxy/
git commit -m "chore(llm-proxy): vendor Go proxy source + build script"
```

---

## Task 2: 配置 —— 新增 `llmProxy` 段 + `resolveLlmProxy`

**Files:**
- Modify: `backend/server/modules/config/config.ts`（`DEFAULT_APP_CONFIG`、导出 `resolveLlmProxy`）
- Test: `backend/server/modules/config/tests/llm-proxy-resolve.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/config/tests/llm-proxy-resolve.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_APP_CONFIG, resolveLlmProxy } from '../config.js';
import type { AppConfig } from '../config.js';

function cfgWith(overrides: Partial<AppConfig['llmProxy']>): AppConfig {
  return {
    ...structuredClone(DEFAULT_APP_CONFIG),
    llmProxy: { ...structuredClone(DEFAULT_APP_CONFIG.llmProxy), ...overrides },
  } as AppConfig;
}

test('resolveLlmProxy disabled by default', () => {
  const r = resolveLlmProxy(structuredClone(DEFAULT_APP_CONFIG));
  assert.equal(r.enabled, false);
});

test('resolveLlmProxy falls back anthropicUrl to providers.claude.baseUrl', () => {
  const cfg = cfgWith({ enabled: true });
  cfg.providers.claude.baseUrl = 'https://upstream.example/anthropic';
  const r = resolveLlmProxy(cfg);
  assert.equal(r.anthropicUrl, 'https://upstream.example/anthropic');
});

test('resolveLlmProxy prefers explicit anthropicUrl + carries apiKey from claude', () => {
  const cfg = cfgWith({ enabled: true, anthropicUrl: 'https://explicit.example/x', port: 9999 });
  cfg.providers.claude.apiKey = 'sk-test';
  const r = resolveLlmProxy(cfg);
  assert.equal(r.anthropicUrl, 'https://explicit.example/x');
  assert.equal(r.port, 9999);
  assert.equal(r.apiKey, 'sk-test');
});

test('resolveLlmProxy applies defaults for empty port/vlmMaxTokens', () => {
  const r = resolveLlmProxy(cfgWith({ enabled: true, port: 0, vlmMaxTokens: 0 }));
  assert.equal(r.port, 8088);
  assert.equal(r.vlmMaxTokens, 8000);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/llm-proxy-resolve.test.ts
```

Expected: FAIL（`resolveLlmProxy` 未导出 / `DEFAULT_APP_CONFIG.llmProxy` 不存在）。

- [ ] **Step 3: 实现 —— `config.ts` 新增段与函数**

在 `DEFAULT_APP_CONFIG`（约 line 60 `runtime` 之前）插入：

```ts
  llmProxy: {
    enabled: false,
    port: 8088,
    anthropicUrl: '',
    openaiUrl: 'https://www.sophnet.com/api/open-apis/openai',
    vlmModel: 'MiniMax-M3',
    vlmMaxTokens: 8000,
    routing: {} as Record<string, string | { model: string; upstream?: string }>,
  },
```

在文件底部（`appConfig()` 单例之前）新增：

```ts
export type LlmProxyResolved = {
  enabled: boolean;
  port: number;
  anthropicUrl: string;
  openaiUrl: string;
  vlmModel: string;
  vlmMaxTokens: number;
  routing: Record<string, string | { model: string; upstream?: string }>;
  apiKey: string;
};

/** Resolve the effective llm-proxy settings, deriving upstream URLs and the key
 * from providers.claude when the dedicated fields are empty. */
export function resolveLlmProxy(cfg: AppConfig): LlmProxyResolved {
  const p = cfg.llmProxy;
  return {
    enabled: p.enabled,
    port: p.port || 8088,
    anthropicUrl: p.anthropicUrl || cfg.providers.claude.baseUrl,
    openaiUrl: p.openaiUrl || 'https://www.sophnet.com/api/open-apis/openai',
    vlmModel: p.vlmModel,
    vlmMaxTokens: p.vlmMaxTokens || 8000,
    routing: p.routing ?? {},
    apiKey: cfg.providers.claude.apiKey,
  };
}
```

（`llmProxy` 段不含新密钥——上游 key 复用 `providers.claude.apiKey`（已被 `SENSITIVE_KEYS` 打码），`routing` 是模型名不是密钥，故无需改 `SENSITIVE_KEYS`。）

- [ ] **Step 4: 跑测试确认通过**

同上命令。Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/config/config.ts backend/server/modules/config/tests/llm-proxy-resolve.test.ts
git commit -m "feat(config): add llmProxy section + resolveLlmProxy"
```

---

## Task 3: env-sync —— 本机/远程 baseUrl 推导

**Files:**
- Modify: `backend/server/modules/config/env-sync.ts`
- Modify: `backend/server/shared/agent-runtime/protocol.ts`（加 `LLM_FORWARDER_PORT`，供本 Task 使用）
- Test: `backend/server/modules/config/tests/env-sync.test.ts`

- [ ] **Step 1: 在 protocol.ts 加常量**

`backend/server/shared/agent-runtime/protocol.ts` 顶部（import 之后）：

```ts
/** Loopback port the lite's LLM HTTP forwarder listens on; main builds remote
 * `configEnv.ANTHROPIC_BASE_URL` against it. The lite forwarder listens on the
 * same constant — keep them in sync. */
export const LLM_FORWARDER_PORT = 18088;
```

- [ ] **Step 2: 写失败测试**

`backend/server/modules/config/tests/env-sync.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_APP_CONFIG } from '../config.js';
import { buildProviderConfigEnv, syncProviderEnv } from '../env-sync.js';
import { LLM_FORWARDER_PORT } from '@/shared/agent-runtime/protocol.js';
import type { AppConfig } from '../config.js';

function cfg(enabled: boolean): AppConfig {
  const c = structuredClone(DEFAULT_APP_CONFIG);
  c.llmProxy.enabled = enabled;
  c.llmProxy.port = 8088;
  c.providers.claude.baseUrl = 'https://upstream.example/anthropic';
  c.providers.claude.apiKey = 'sk-test';
  return c as AppConfig;
}

test('syncProviderEnv points ANTHROPIC_BASE_URL at proxy when enabled', () => {
  delete process.env.ANTHROPIC_BASE_URL;
  syncProviderEnv(cfg(true));
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8088');
});

test('syncProviderEnv keeps providers.claude.baseUrl when disabled', () => {
  syncProviderEnv(cfg(false));
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://upstream.example/anthropic');
});

test('buildProviderConfigEnv (claude) points remote at lite forwarder when enabled', () => {
  const env = buildProviderConfigEnv(cfg(true), 'claude');
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${LLM_FORWARDER_PORT}`);
});

test('buildProviderConfigEnv (claude) keeps upstream URL when disabled', () => {
  const env = buildProviderConfigEnv(cfg(false), 'claude');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://upstream.example/anthropic');
});
```

（注意：`syncProviderEnv` 会写 `process.env`，测试里显式 `delete` 起手避免污染；测试结束后无需恢复——每个断言都重写目标键。）

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/env-sync.test.ts
```

Expected: FAIL（当前 `syncProviderEnv`/`buildProviderConfigEnv` 不感知 `llmProxy.enabled`）。

- [ ] **Step 4: 实现**

`env-sync.ts` 顶部 import 加入 `resolveLlmProxy` 与常量：

```ts
import type { AppConfig } from './config.js';
import { resolveLlmProxy } from './config.js';
import { LLM_FORWARDER_PORT } from '@/shared/agent-runtime/protocol.js';
```

`syncProviderEnv` 的 claude 段，把

```ts
  setOrDelete('ANTHROPIC_BASE_URL', c.baseUrl);
```

替换为

```ts
  // llm-proxy enabled → the CLI targets the local proxy (which forwards to
  // anthropicUrl upstream); disabled → the CLI targets baseUrl directly.
  const llmProxy = resolveLlmProxy(cfg);
  if (llmProxy.enabled) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${llmProxy.port}`;
  } else {
    setOrDelete('ANTHROPIC_BASE_URL', c.baseUrl);
  }
```

`buildProviderConfigEnv` 的 `case 'claude'` 段，把

```ts
      put('ANTHROPIC_BASE_URL', c.baseUrl);
```

替换为

```ts
      const llmProxy = resolveLlmProxy(cfg);
      put('ANTHROPIC_BASE_URL', llmProxy.enabled ? `http://127.0.0.1:${LLM_FORWARDER_PORT}` : c.baseUrl);
```

（其余 claude 字段、`apiKey` 照旧下发——走代理时该 key 被转发器忽略、由 llm-proxy 注入真实上游 key。）

- [ ] **Step 5: 跑测试确认通过 + typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/config/tests/env-sync.test.ts && npm run typecheck
```

Expected: 测试 PASS；typecheck 零新增错误（baseline 有 pre-existing 错误，只对照本次改动是否新增）。

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/config/env-sync.ts backend/server/shared/agent-runtime/protocol.ts backend/server/modules/config/tests/env-sync.test.ts
git commit -m "feat(env-sync): route ANTHROPIC_BASE_URL through llm-proxy (local+remote)"
```

---

## Task 4: 补 headless 任务的 configEnv 缺口

**Files:**
- Modify: `backend/server/modules/websocket/services/headless-task-run.service.ts`

这是已知缺口：远程项目上的 headless 任务构造 `runtimeOptions` 时没带 `configEnv`，会漏掉代理地址/凭据。改动镜像 `chat-websocket.service.ts:273-281`。

- [ ] **Step 1: 查看该文件 import 区，确认已有 `lookupRemoteHost` / `buildProviderConfigEnv` / `getAppConfig`**

```bash
cd /mnt/b/workdir/github/lovdex/backend && sed -n '1,40p' server/modules/websocket/services/headless-task-run.service.ts
```

Expected: 文件顶部已有 `import` 若干；若无 `lookupRemoteHost` / `buildProviderConfigEnv` / `getAppConfig`，先补 import（参考 `chat-websocket.service.ts` 顶部同款 import）。

- [ ] **Step 2: 在 `runtimeOptions` 构造后、`spawnFn` 调用前注入 configEnv**

在 `headless-task-run.service.ts` 的 `runtimeOptions` 定义（`isTaskRun: true,\n  };`）之后、`// Fire-and-forget` 注释之前，插入：

```ts
  // Remote headless runs must carry provider config (proxy baseUrl / key) the
  // same way the interactive chat path does — mirror chat-websocket.service.ts.
  // Only paid when the session resolves to a remote host (the codex branch reads
  // ~/.codex/auth.json, so local runs must not pay that per-send cost).
  if (lookupRemoteHost(runtimeOptions.projectPath ?? runtimeOptions.cwd)) {
    runtimeOptions.configEnv = buildProviderConfigEnv(getAppConfig().get(), provider);
  }
```

（`provider` 是 `headless-task-run.service.ts` 作用域里已有的 provider 变量；`runtimeOptions` 已是 `Record<string, unknown>`，赋 `configEnv` 合法。）

- [ ] **Step 3: typecheck + 跑相关既有测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck
```

Expected: 零新增错误。headless 路径无独立单测，靠 typecheck + 既有服务测试兜底；E2E（Task 12）覆盖真机验证。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/websocket/services/headless-task-run.service.ts
git commit -m "fix(tasks): attach configEnv to remote headless runs"
```

---

## Task 5: 协议 —— 新增 `llm_req`/`llm_res` 帧

**Files:**
- Modify: `backend/server/shared/agent-runtime/protocol.ts`
- Test: `backend/server/shared/agent-runtime/tests/llm-frames.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/shared/agent-runtime/tests/llm-frames.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAgentFrameIn, decodeAgentFrameOut } from '../protocol.js';

test('decodeAgentFrameIn accepts llm_req', () => {
  const f = decodeAgentFrameIn({
    type: 'llm_req', id: 'r1', method: 'POST', path: '/v1/messages',
    headers: { 'content-type': 'application/json' }, bodyBase64: 'aGk=',
  });
  assert.deepEqual(f, {
    type: 'llm_req', id: 'r1', method: 'POST', path: '/v1/messages',
    headers: { 'content-type': 'application/json' }, bodyBase64: 'aGk=',
  });
});

test('decodeAgentFrameIn rejects llm_req with missing fields', () => {
  assert.equal(decodeAgentFrameIn({ type: 'llm_req', id: 'r1' }), null);
  assert.equal(decodeAgentFrameIn({ type: 'llm_req', id: 'r1', method: 'POST', path: '/x', headers: {}, bodyBase64: 7 }), null);
});

test('decodeAgentFrameOut accepts llm_res', () => {
  const f = decodeAgentFrameOut({
    type: 'llm_res', id: 'r1', status: 200, headers: { 'content-type': 'text/event-stream' }, chunkBase64: '', done: false,
  });
  assert.equal(f?.type, 'llm_res');
});

test('decodeAgentFrameOut rejects llm_res with missing fields', () => {
  assert.equal(decodeAgentFrameOut({ type: 'llm_res', id: 'r1' }), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/agent-runtime/tests/llm-frames.test.ts
```

Expected: FAIL（未知帧类型被 decode 拒为 null）。

- [ ] **Step 3: 实现**

`protocol.ts`：

`AgentFrameIn` union 加一行：

```ts
  | { type: 'llm_req'; id: string; method: string; path: string; headers: Record<string, string>; bodyBase64: string }
```

`AgentFrameOut` union 加一行：

```ts
  | { type: 'llm_res'; id: string; status: number; headers: Record<string, string>; chunkBase64: string; done: boolean }
```

`decodeAgentFrameIn` 的 `case 'pong'` 之前加：

```ts
    case 'llm_req': {
      const { id, method, path, headers, bodyBase64 } = f;
      if (typeof id !== 'string' || typeof method !== 'string' || typeof path !== 'string' || typeof bodyBase64 !== 'string') return null;
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return null;
      return { type: 'llm_req', id, method, path, headers: headers as Record<string, string>, bodyBase64 };
    }
```

`decodeAgentFrameOut` 的 `case 'ping'` 之前加：

```ts
    case 'llm_res': {
      const { id, status, headers, chunkBase64, done } = f;
      if (typeof id !== 'string' || typeof status !== 'number' || typeof chunkBase64 !== 'string' || typeof done !== 'boolean') return null;
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return null;
      return { type: 'llm_res', id, status, headers: headers as Record<string, string>, chunkBase64, done };
    }
```

- [ ] **Step 4: 跑测试确认通过**

同上命令。Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/shared/agent-runtime/protocol.ts backend/server/shared/agent-runtime/tests/llm-frames.test.ts
git commit -m "feat(protocol): add llm_req/llm_res frames for WS LLM forwarding"
```

---

## Task 6: lite 转发器 `llm-forwarder.ts`

**Files:**
- Create: `backend/remote-agent/src/llm-forwarder.ts`
- Test: `backend/remote-agent/src/tests/llm-forwarder.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/remote-agent/src/tests/llm-forwarder.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { createLlmForwarder } from '../llm-forwarder.js';

test('handleLlmRes writes head once and streams chunks to pending response', async () => {
  const f = createLlmForwarder();
  const writes: string[] = [];
  const res: any = {
    writeHead: (status: number, headers: Record<string, string>) => writes.push(`head:${status}`),
    write: (c: string) => writes.push(`write:${c}`),
    end: () => writes.push('end'),
    on: () => {},
  };
  // register a pending entry by simulating a request via a captured send
  let sent: any = null;
  f.setSend((frame) => { sent = frame; });
  const server = http.createServer((req, res2) => {
    req.resume();
    req.on('end', () => res2.end('ok'));
  });
  // (integration covered below; here we just test frame handling with a fake pending entry)
  server.close();

  // Directly exercise handleLlmRes by fabricating the pending entry through a
  // real HTTP round-trip in the next test; this test targets the frame handler.
  // NOTE: createLlmForwarder exposes handleLlmRes only against real pending ids,
  // so this test drives the full path via start() in the next case.
  assert.equal(typeof f.handleLlmRes, 'function');
  assert.equal(typeof f.setSend, 'function');
  f.stop();
});
```

> 说明：`handleLlmRes` 只对真实 pending id 生效，纯函数式断言不够。请把下面这个“真实往返”测试作为主测试（替换上面的占位）：

```ts
test('full round-trip: HTTP request becomes llm_req; llm_res streams back', async () => {
  const f = createLlmForwarder();
  const frames: any[] = [];
  f.setSend((frame) => frames.push(frame));
  const port = await f.start(0);

  const body = JSON.stringify({ model: 'sonnet', messages: [] });
  const respPromise = new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  // The forwarder must have emitted one llm_req with base64 body.
  assert.equal(frames.length, 1);
  const reqFrame = frames[0];
  assert.equal(reqFrame.type, 'llm_req');
  assert.equal(reqFrame.path, '/v1/messages');
  assert.equal(Buffer.from(reqFrame.bodyBase64, 'base64').toString(), body);

  // Stream a response back in 2 chunks + done.
  f.handleLlmRes({ type: 'llm_res', id: reqFrame.id, status: 200, headers: { 'content-type': 'application/json' }, chunkBase64: Buffer.from('{"ok":').toString('base64'), done: false });
  f.handleLlmRes({ type: 'llm_res', id: reqFrame.id, status: 200, headers: {}, chunkBase64: Buffer.from('true}').toString('base64'), done: false });
  f.handleLlmRes({ type: 'llm_res', id: reqFrame.id, status: 200, headers: {}, chunkBase64: '', done: true });

  const resp = await respPromise;
  assert.equal(resp.status, 200);
  assert.equal(resp.data, '{"ok":true}');
  assert.equal(f.pendingCount(), 0);

  f.stop();
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend/remote-agent && npm test -- --test-name-pattern=llm-forwarder 2>/dev/null || npx tsx --test src/tests/llm-forwarder.test.ts
```

Expected: FAIL（`../llm-forwarder.js` 不存在）。

- [ ] **Step 3: 实现**

`backend/remote-agent/src/llm-forwarder.ts`：

```ts
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export type LlmResFrame = {
  type: 'llm_res';
  id: string;
  status: number;
  headers: Record<string, string>;
  chunkBase64: string;
  done: boolean;
};

type Pending = { res: http.ServerResponse; responded: boolean };

export type LlmForwarder = {
  /** Listen on 127.0.0.1:<port> (0 = ephemeral). Resolves to the bound port. */
  start(port: number): Promise<number>;
  stop(): void;
  /** Re-point the outbound sender at the live WS socket (rebound on reconnect). */
  setSend(fn: (frame: unknown) => void): void;
  handleLlmRes(frame: LlmResFrame): boolean;
  pendingCount(): number;
};

export function createLlmForwarder(): LlmForwarder {
  const pending = new Map<string, Pending>();
  let server: http.Server | null = null;
  let send: (frame: unknown) => void = () => {};

  function setSend(fn: (frame: unknown) => void): void {
    send = fn;
  }

  function handleLlmRes(frame: LlmResFrame): boolean {
    const p = pending.get(frame.id);
    if (!p) return false;
    if (!p.responded) {
      p.res.writeHead(frame.status, frame.headers);
      p.responded = true;
    }
    if (frame.chunkBase64) p.res.write(Buffer.from(frame.chunkBase64, 'base64'));
    if (frame.done) {
      pending.delete(frame.id);
      p.res.end();
    }
    return true;
  }

  function start(port: number): Promise<number> {
    if (server) return Promise.resolve((server.address() as { port: number }).port);
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const id = randomUUID();
        const headers: Record<string, string> = {};
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]] = req.rawHeaders[i + 1];
        pending.set(id, { res, responded: false });
        res.on('close', () => pending.delete(id));
        send({
          type: 'llm_req',
          id,
          method: req.method ?? 'POST',
          path: req.url ?? '/v1/messages',
          headers,
          bodyBase64: Buffer.concat(chunks).toString('base64'),
        });
      });
    });
    return new Promise((resolve) => {
      server!.listen(port, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
  }

  function stop(): void {
    for (const [, p] of pending) {
      try { p.res.end(); } catch { /* ignore */ }
    }
    pending.clear();
    if (server) { server.close(); server = null; }
  }

  return { start, stop, setSend, handleLlmRes, pendingCount: () => pending.size };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend/remote-agent && npx tsx --test src/tests/llm-forwarder.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/remote-agent/src/llm-forwarder.ts backend/remote-agent/src/tests/llm-forwarder.test.ts
git commit -m "feat(lite): add llm-forwarder HTTP→WS bridge"
```

---

## Task 7: lite `index.ts` —— 启动转发器 + 分发 `llm_res`

**Files:**
- Modify: `backend/remote-agent/src/index.ts`
- Test: `backend/remote-agent/src/tests/index.test.ts`（扩展既有测试）

- [ ] **Step 1: 实现 wiring**

`index.ts`：

顶部 import 加：

```ts
import { createLlmForwarder } from './llm-forwarder.js';
import { LLM_FORWARDER_PORT } from '../../server/shared/agent-runtime/protocol.js';
```

`createLiteService` 内，`let stopped = false;` 之后加：

```ts
  const forwarder = createLlmForwarder();
```

`handleOpen` 内（`setPushEmitter(...)` 之后）加：

```ts
    // Re-point the llm forwarder's outbound send at the live socket too.
    forwarder.setSend((frame) => {
      if (live.readyState === WebSocket.OPEN) {
        live.send(JSON.stringify(frame));
      }
    });
```

`handleMessage` 内，`frame` 解析成功后、`handleIncomingFrame` 调用之前加：

```ts
    if (frame && (frame as Record<string, unknown>).type === 'llm_res') {
      forwarder.handleLlmRes(frame as never);
      return;
    }
```

`start` 函数改：

```ts
  const start = () => {
    if (stopped) return;
    void forwarder.start(LLM_FORWARDER_PORT).catch((err) =>
      console.error('[remote-agent] llm forwarder start failed:', err),
    );
    connect();
  };
```

`stop` 函数内、`if (socket) socket.close();` 之前加：

```ts
    forwarder.stop();
```

- [ ] **Step 2: typecheck + 跑既有 lite 测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend/remote-agent && npm test
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck
```

Expected: lite 测试全绿（含 `index.test.ts` 既有用例）；typecheck 零新增错误。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/remote-agent/src/index.ts
git commit -m "feat(lite): start llm forwarder and route llm_res frames"
```

---

## Task 8: 后端 relay `llm-relay.ts`

**Files:**
- Create: `backend/server/modules/remote-agents/llm-relay.ts`
- Test: `backend/server/modules/remote-agents/tests/llm-relay.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/server/modules/remote-agents/tests/llm-relay.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { relayLlmRequest } from '../llm-relay.js';

test('relayLlmRequest forwards to local proxy and streams llm_res frames', async () => {
  // mock "local llm-proxy": echoes back a small body
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"echo":');
      res.end('true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const sent: string[] = [];
  const ws = { send: (raw: string) => sent.push(raw) };

  relayLlmRequest(
    {
      id: 'r1', method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from('{"model":"sonnet"}').toString('base64'),
    },
    ws,
    { proxyPort: upstreamPort },
  );

  await new Promise((r) => setTimeout(r, 50)); // wait for streaming to finish

  const frames = sent.map((s) => JSON.parse(s));
  assert.equal(frames[0].id, 'r1');
  assert.equal(frames[0].status, 200);
  assert.equal(frames[0].done, false);
  assert.equal(frames[frames.length - 1].done, true);
  const body = frames
    .slice(1)
    .filter((f) => f.chunkBase64)
    .map((f) => Buffer.from(f.chunkBase64, 'base64').toString())
    .join('');
  assert.equal(body, '{"echo":true}');

  upstream.close();
});

test('relayLlmRequest emits a 502 error frame when proxy is down', async () => {
  const sent: string[] = [];
  const ws = { send: (raw: string) => sent.push(raw) };
  relayLlmRequest(
    { id: 'r2', method: 'POST', path: '/v1/messages', headers: {}, bodyBase64: '' },
    ws,
    { proxyPort: 1 }, // nothing listening
  );
  await new Promise((r) => setTimeout(r, 50));
  const last = JSON.parse(sent[sent.length - 1]);
  assert.equal(last.id, 'r2');
  assert.equal(last.status, 502);
  assert.equal(last.done, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/llm-relay.test.ts
```

Expected: FAIL（`../llm-relay.js` 不存在）。

- [ ] **Step 3: 实现**

`backend/server/modules/remote-agents/llm-relay.ts`：

```ts
import http from 'node:http';

export type LlmReqFrame = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

/** Minimal WS surface the relay needs; tests inject a capturing fake. */
export type LlmRelaySocket = { send: (raw: string) => void };

export type LlmRelayOpts = { proxyPort: number };

/** Forwards one lite `llm_req` to the local llm-proxy and streams the response
 * back as `llm_res` frames (status+headers on the first frame, base64 chunks,
 * final `done:true`). */
export function relayLlmRequest(frame: LlmReqFrame, ws: LlmRelaySocket, opts: LlmRelayOpts): void {
  const body = Buffer.from(frame.bodyBase64, 'base64');
  const send = (status: number, headers: Record<string, string>, chunkBase64: string, done: boolean): void => {
    ws.send(JSON.stringify({ type: 'llm_res', id: frame.id, status, headers, chunkBase64, done }));
  };
  const headersOut: Record<string, string> = {
    ...frame.headers,
    host: `127.0.0.1:${opts.proxyPort}`,
    'content-length': String(body.length),
  };
  delete headersOut['content-length']; // recomputed below by node
  headersOut['content-length'] = String(body.length);

  const req = http.request(
    { host: '127.0.0.1', port: opts.proxyPort, path: frame.path, method: frame.method, headers: headersOut },
    (res) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        h[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      }
      send(res.statusCode ?? 502, h, '', false);
      res.on('data', (chunk: Buffer) => send(res.statusCode ?? 502, {}, chunk.toString('base64'), false));
      res.on('end', () => send(res.statusCode ?? 502, {}, '', true));
      res.on('error', () => send(502, {}, '', true));
    },
  );
  req.on('error', () => {
    const errBody = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'llm proxy unavailable' } })).toString('base64');
    send(502, { 'content-type': 'application/json' }, errBody, true);
  });
  req.write(body);
  req.end();
}
```

- [ ] **Step 4: 跑测试确认通过**

同上命令。Expected: PASS（2 个测试）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/remote-agents/llm-relay.ts backend/server/modules/remote-agents/tests/llm-relay.test.ts
git commit -m "feat(remote): add llm-relay (llm_req -> local llm-proxy -> llm_res)"
```

---

## Task 9: `remote-agent.server.ts` —— 处理 `llm_req` 帧

**Files:**
- Modify: `backend/server/modules/remote-agents/remote-agent.server.ts`
- Modify: `backend/server/modules/remote-agents/remote-agent.server.ts`（`RemoteAgentServerDeps` 加 `llmProxyPort` 注入）

- [ ] **Step 1: 实现**

`remote-agent.server.ts`：

import 加：

```ts
import { relayLlmRequest } from './llm-relay.js';
import { resolveLlmProxy } from '@/modules/config/config.js';
import { appConfig } from '@/modules/config/config.js';
```

`RemoteAgentServerDeps` 加一个可选字段（用于测试注入，默认读配置）：

```ts
  /** llm-proxy loopback port the llm_req relay forwards to (default: config). */
  llmProxyPort?: number;
```

`onConnection` 内，`if (f.type === 'pong')` 之前加：

```ts
      if (f.type === 'llm_req') {
        const port = deps.llmProxyPort ?? resolveLlmProxy(appConfig().get()).port;
        relayLlmRequest(f, ws, { proxyPort: port });
        return;
      }
```

（`f` 此时已被 `isAgentFrameIn` 收窄为 `AgentFrameIn`，`llm_req` 分支的字段类型匹配 `LlmReqFrame`。）

- [ ] **Step 2: typecheck + 跑既有 remote-agents 测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/lite-package.test.ts
```

Expected: 零新增错误；既有 remote-agents 测试仍绿。

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/remote-agents/remote-agent.server.ts
git commit -m "feat(remote): handle llm_req frames in the agent ws server"
```

---

## Task 10: llm-proxy manager —— TOML 生成 + 进程托管

**Files:**
- Create: `backend/server/modules/llm-proxy/manager.ts`
- Test: `backend/server/modules/llm-proxy/tests/manager.test.ts`

- [ ] **Step 1: 写失败测试（只测纯函数 `generateToml`）**

`backend/server/modules/llm-proxy/tests/manager.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_APP_CONFIG } from '@/modules/config/config.js';
import { generateToml } from '../manager.js';
import type { AppConfig } from '@/modules/config/config.js';

function cfg(routing: AppConfig['llmProxy']['routing']): AppConfig {
  const c = structuredClone(DEFAULT_APP_CONFIG);
  c.llmProxy.enabled = true;
  c.llmProxy.port = 8088;
  c.llmProxy.anthropicUrl = 'https://upstream.example/anthropic';
  c.llmProxy.openaiUrl = 'https://upstream.example/openai';
  c.llmProxy.vlmModel = 'VLM-X';
  c.llmProxy.vlmMaxTokens = 1234;
  c.llmProxy.routing = routing;
  return c as AppConfig;
}

test('generateToml emits proxy/upstream/vlm sections', () => {
  const toml = generateToml(cfg({}));
  assert.match(toml, /port = 8088/);
  assert.match(toml, /anthropic_url = "https:\/\/upstream\.example\/anthropic"/);
  assert.match(toml, /vlm_model = "VLM-X"/);
  assert.match(toml, /vlm_max_tokens = 1234/);
});

test('generateToml emits string routing entries', () => {
  const toml = generateToml(cfg({ sonnet: 'DeepSeek-V4-Pro', opus: 'GLM-5.2' }));
  assert.match(toml, /\[routing\]/);
  assert.match(toml, /sonnet = "DeepSeek-V4-Pro"/);
  assert.match(toml, /opus = "GLM-5.2"/);
});

test('generateToml emits table routing entries for openai upstream', () => {
  const toml = generateToml(cfg({ flash: { model: 'glm-5.3-flash', upstream: 'openai' } }));
  assert.match(toml, /\[routing\.flash\]/);
  assert.match(toml, /model = "glm-5.3-flash"/);
  assert.match(toml, /upstream = "openai"/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/llm-proxy/tests/manager.test.ts
```

Expected: FAIL（`../manager.js` 不存在）。

- [ ] **Step 3: 实现 `generateToml` + 进程托管**

`backend/server/modules/llm-proxy/manager.ts`：

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { appConfig, resolveLlmProxy } from '@/modules/config/config.js';
import type { AppConfig } from '@/modules/config/config.js';

/** Renders the llm-proxy TOML config from app.config. Pure for testing. */
export function generateToml(cfg: AppConfig): string {
  const p = resolveLlmProxy(cfg);
  const lines: string[] = [];
  lines.push(`[proxy]`, `port = ${p.port}`, `vlm_model = "${p.vlmModel}"`, `vlm_max_tokens = ${p.vlmMaxTokens}`, '');
  lines.push(`[upstream]`, `anthropic_url = "${p.anthropicUrl}"`, `openai_url = "${p.openaiUrl}"`, '');
  lines.push('[keys]', 'sophnet = ""', '');
  lines.push('[routing]');
  for (const [alias, target] of Object.entries(p.routing)) {
    if (typeof target === 'string') {
      lines.push(`${alias} = "${target}"`);
    } else if (target && typeof target.model === 'string') {
      lines.push('', `[routing.${alias}]`, `model = "${target.model}"`);
      if (target.upstream) lines.push(`upstream = "${target.upstream}"`);
    }
  }
  return lines.join('\n') + '\n';
}

export type LlmProxyManager = {
  /** (Re)generate the TOML from current config and (re)start the sidecar. */
  reconcile(): void;
  /** Kill the sidecar (idempotent). */
  stop(): void;
};

export function createLlmProxyManager(opts?: { binaryPath?: string }): LlmProxyManager {
  let child: ChildProcess | null = null;
  const binaryPath = opts?.binaryPath ?? path.join(__dirname, '..', '..', '..', '..', 'llm-proxy', 'llm-proxy');

  function tomlPath(): string {
    return path.join(os.homedir(), '.lovdex', 'data', 'llm-proxy.toml');
  }

  function reconcile(): void {
    const cfg = appConfig().get();
    const p = resolveLlmProxy(cfg);
    if (!p.enabled) {
      stop();
      return;
    }
    if (!fs.existsSync(binaryPath)) {
      console.warn(`[llm-proxy] binary not found at ${binaryPath}; run backend/llm-proxy/build.sh`);
      return;
    }
    const toml = generateToml(cfg);
    fs.mkdirSync(path.dirname(tomlPath()), { recursive: true });
    fs.writeFileSync(tomlPath(), toml, 'utf8');
    stop(); // restart to pick up new config
    child = spawn(binaryPath, [], {
      env: { ...process.env, LLM_PROXY_CONFIG: tomlPath(), SOPHNET_API_KEY: p.apiKey },
      stdio: 'ignore',
    });
    child.on('exit', () => { child = null; });
    console.log(`[llm-proxy] started pid=${child.pid} port=${p.port}`);
  }

  function stop(): void {
    if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } child = null; }
  }

  return { reconcile, stop };
}
```

（`binaryPath` 的 `path.join(__dirname, '..', '..', '..', '..', 'llm-proxy', 'llm-proxy')` 从 `server/modules/llm-proxy/` 升到 `backend/llm-proxy/llm-proxy`；`__dirname` 在 tsx 运行下的 ESM 里不可用，请在实现时用 `import.meta.url` + `fileURLToPath` 求 `__dirname`，或直接传 `binaryPath` 覆盖。实现时以能定位到 `backend/llm-proxy/llm-proxy` 为准。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/llm-proxy/tests/manager.test.ts
```

Expected: PASS（3 个测试）。

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/llm-proxy/manager.ts backend/server/modules/llm-proxy/tests/manager.test.ts
git commit -m "feat(llm-proxy): add manager (TOML generation + sidecar spawn)"
```

---

## Task 11: `index.js` —— boot 挂 manager + shutdown

**Files:**
- Modify: `backend/server/index.js`

- [ ] **Step 1: import + boot reconcile**

`index.js` 顶部（其他 remote-agents import 附近）加：

```js
import { createLlmProxyManager } from './modules/llm-proxy/manager.js';
```

在 `syncProviderEnv(...)` 调用之后（boot 初始化区，约 `index.js:125` 附近），加：

```js
const llmProxyManager = createLlmProxyManager();
llmProxyManager.reconcile();
```

- [ ] **Step 2: shutdown 时停掉 sidecar**

在已有的 SIGTERM/SIGINT 清理逻辑里（`index.js` 中 server close 的路径）加：

```js
llmProxyManager.stop();
```

（若 `index.js` 已有统一的 `shutdown()` 或 `process.on('SIGTERM', ...)`，在其中补这一行；实现时定位到既有退出钩子再放。）

- [ ] **Step 3: typecheck（index.js 是 JS，跑 lint 确认无新告警）**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck
```

Expected: 零新增错误。

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js
git commit -m "feat(llm-proxy): start/stop sidecar with the backend lifecycle"
```

---

## Task 12: E2E 冒烟（手动）

**Files:** 无代码改动。

- [ ] **Step 1: 启动并确认 sidecar 拉起**

```bash
cd /mnt/b/workdir/github/lovdex/backend/llm-proxy && ./build.sh
# 编辑 ~/.lovdex/data/app.config.json，设 llmProxy.enabled=true（保留 providers.claude.baseUrl=sophnet）
# 重启后端（或 supervisor）
curl -s http://127.0.0.1:8088/health 2>/dev/null || echo "proxy not up yet"
```

Expected: llm-proxy 进程存在（`pgrep -f llm-proxy`），`~/.lovdex/data/llm-proxy.toml` 已生成，端口 8088 被监听（`ss -ltnp | grep 8088`）。

- [ ] **Step 2: 本机 claude 走代理跑一轮**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && ANTHROPIC_BASE_URL=http://127.0.0.1:8088 ANTHROPIC_AUTH_TOKEN=dummy npx tsx --tsconfig server/tsconfig.json -e "0" 2>/dev/null
# 更直接：在 Lovdex UI 里开一个本机会话，确认能正常出字、无 thinking 崩溃
```

Expected: 会话正常，`[llm-proxy]` 侧（journalctl/log）出现 `->` 路由日志，报错修复生效。

- [ ] **Step 3: 远程会话冒烟**

在已部署 lite 的远程 host 上开一个 claude 会话，确认：
1. lite 转发器在 `127.0.0.1:18088` 监听（远程 `ss -ltnp | grep 18088`）。
2. 会话走隧道（后端日志出现 `llm_req` 转发），远程无外网也能跑。

- [ ] **Step 4: 记录结果并提交任何修整**

（若发现接线问题，修复后按前面 Task 的粒度补提交；E2E 结果记入 commit message 或 PR 描述。）

---

## Self-Review 结论

- **Spec 覆盖**：架构（Task 1/10/11 sidecar + Task 6/8/9 隧道）、配置与密钥（Task 2/3）、报错修复（llm-proxy 原样继承 Task 1，零改动）、模型路由方案 A（Task 3 保留 CLI 侧 env 映射，routing 表在 TOML 里但默认空转）、headless configEnv 缺口（Task 4）、codex/opencode 共用隧道（llm-req/llm-res 按 path 透传，Task 8 relay 不区分协议）。均有点对点任务。
- **一致性**：`llm_req`/`llm_res` 字段名在 protocol/forwarder/relay/server 四处一致；`LLM_FORWARDER_PORT=18088` 在 protocol/env-sync/lite-index 一致；`resolveLlmProxy` 在 config/env-sync/manager 一致；baseUrl 推导语义与 spec（无迁移版）一致。
- **占位符**：Task 6 第一个测试是占位性说明，已用真实往返测试替换；Task 10 `__dirname` 已在实现注释里给出替代方案；Task 12 为手动步骤（非代码）。
- **风险**：Go 二进制构建依赖 `go 1.26.5` 工具链自动下载（本机已验证可构建）；`__dirname` 需按 ESM 求值；headless configEnv 改动靠 typecheck+E2E 兜底（无独立单测）。
