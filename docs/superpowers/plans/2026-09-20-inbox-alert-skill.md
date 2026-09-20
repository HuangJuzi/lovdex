# 收件箱上报 Skill（带版本管理）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `lovdex-alert` 上报约定打包成带版本号的 Claude Code skill，UI 可装/卸/更新，并让"任何对话里说一句放到收件箱"都能产生通知。

**Architecture:** 两条发送路径 —— 助手（operator）用新 MCP 工具 `send_notification` 确定性投递；任务/普通会话输出 `lovdex-alert` 文本标记，由**上移到 `chat-run-registry` complete 分支**的扫描器读 `run.events` 内存缓冲提取（不再 `fetchHistory`，且覆盖三类会话）。skill 内容由现有 `ALERT_PROMPT_INSTRUCTION` 常量生成，frontmatter 带 `version`；状态从磁盘推导，不落库。

**Tech Stack:** better-sqlite3 + Express（DI 工厂路由）；node:test + `npx tsx --test`；React + 自研 `shared/view/ui`；gray-matter（`parseFrontMatter`）解析 frontmatter。

**关键实证约束（spec §2）：**
- operator 会话 `tools = []`（`claude-sdk.js:703`），**没有 Skill 工具** → 助手必须走工具。
- operator 是 `bypassPermissions`（`claude-sdk.js:706`）→ 新 MCP 工具**不会被权限挡**。
- headless 任务是 `permissionMode: 'default'` → 工具会挂起 60s 后 deny → 会话必须走文本。
- `chat-run-registry.service.ts:262` 的 complete 分支是三类会话唯一漏斗；`run.events`（`:37`）已缓冲本轮 assistant 文本。
- `tasks.service.ts:722` 对无 task 会话静默 return → 旧钩子覆盖不了助手/普通聊天。
- `addSkills` 本身就是 rm+重写（`skills.provider.ts:226-235`）→ 安装/更新/重装同一操作。
- claude 的 global skill 源是 `~/.claude/skills`（`claude-skills.provider.ts:102-108`）。

**测试命令（后端）：**
```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json <file>
```
**测试命令（前端，无 DOM 环境）：**
```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsx --test <file>
```
> ⚠️ 跑前端测试**必须** `unset TSX_TSCONFIG_PATH`，否则 tsx 会去找 `web/server/tsconfig.json` 而报错。

**提交约定：** commit message 英文，**不加 Co-Authored-By**。

---

## 文件结构

**后端新建：**
- `backend/server/modules/notifications/alert-skill.ts` — skill 内容生成 + 版本常量（纯函数）
- `backend/server/modules/notifications/alert-skill.service.ts` — getStatus/install/uninstall（磁盘 + provider skills 层）
- `backend/server/modules/notifications/session-alert-scanner.ts` — 扫 `run.events` 投递通知（DI 工厂）
- `backend/server/modules/notifications/tests/alert-skill.test.ts`
- `backend/server/modules/notifications/tests/alert-skill.service.test.ts`
- `backend/server/modules/notifications/tests/session-alert-scanner.test.ts`

**后端修改：**
- `backend/server/modules/notifications/notifications.routes.ts` — 加 skill 三个端点
- `backend/server/modules/notifications/index.ts` — 导出新模块
- `backend/server/modules/notifications/tests/notifications.routes.test.ts` — 补 skill 路由测试
- `backend/server/modules/websocket/services/chat-run-registry.service.ts` — 注入点 + complete 分支调用
- `backend/server/modules/operators/operator.tools.ts` — `send_notification` 工具 + deps 扩展
- `backend/server/modules/operators/tests/operator-tools.test.ts` — 补工具测试
- `backend/server/claude-sdk.js` — system prompt 补 send_notification + 注入 contextSessionId
- `backend/server/index.js` — 装配 scanner / skill 服务 / 启动版本检查 / 删旧扫描

**后端删除：**
- `backend/server/modules/notifications/scan-completed-task.ts`（被 session-alert-scanner 取代）

**前端新建：**
- `web/src/components/settings/inboxSkillStatus.ts` — 纯映射函数（status → UI 文案/状态）
- `web/src/components/settings/tests/inboxSkillStatus.test.ts`
- `web/src/components/settings/InboxSkillSettings.tsx` — 设置页区块

**前端修改：**
- `web/src/utils/api.js` — `notifications` 命名空间加 3 个方法
- `web/src/components/settings/SettingsPage.tsx` — 渲染新区块
- `web/src/components/inbox/InboxPage.tsx` — `skill_update` 通知点击跳设置页

---

## Task 1: skill 内容生成 + 版本常量

**Files:**
- Create: `backend/server/modules/notifications/alert-skill.ts`
- Test: `backend/server/modules/notifications/tests/alert-skill.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/alert-skill.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALERT_SKILL_DIR,
  ALERT_SKILL_VERSION,
  buildAlertSkillMarkdown,
} from '@/modules/notifications/alert-skill.js';
import { ALERT_PROMPT_INSTRUCTION } from '@/modules/notifications/alert-format.js';

test('markdown 有合法 frontmatter，含 name / description / version', () => {
  const md = buildAlertSkillMarkdown();
  const lines = md.split('\n');
  assert.equal(lines[0], '---');
  assert.ok(lines.includes(`name: ${ALERT_SKILL_DIR}`));
  assert.ok(lines.includes(`version: ${ALERT_SKILL_VERSION}`));
  assert.ok(lines.some((l) => l.startsWith('description: ')));
  // frontmatter 必须闭合
  assert.equal(lines.indexOf('---', 1) > 0, true);
});

test('description 含全部触发词（模型靠它决定是否调用）', () => {
  const md = buildAlertSkillMarkdown();
  const desc = md.split('\n').find((l) => l.startsWith('description: ')) ?? '';
  for (const word of ['放到收件箱', '发到收件箱', '通知我', '告警']) {
    assert.ok(desc.includes(word), `description 缺少触发词：${word}`);
  }
});

test('正文完整包含 ALERT_PROMPT_INSTRUCTION（防两处漂移）', () => {
  const md = buildAlertSkillMarkdown();
  // 逐行断言：约定文本的每一行都必须原样出现在 skill 正文里
  for (const line of ALERT_PROMPT_INSTRUCTION.split('\n')) {
    if (!line.trim()) continue;
    assert.ok(md.includes(line), `skill 正文缺少约定行：${line}`);
  }
});

test('正文含 lovdex-alert 代码块围栏与合并规则说明', () => {
  const md = buildAlertSkillMarkdown();
  assert.ok(md.includes('```lovdex-alert'));
  assert.ok(md.includes('合并'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/alert-skill.test.ts
```
Expected: FAIL —— 找不到 `alert-skill.js`

- [ ] **Step 3: 写实现**

`alert-skill.ts`：

```ts
import { ALERT_PROMPT_INSTRUCTION } from './alert-format.js';

/** skill 目录名（`~/.claude/skills` 下的文件夹名）。 */
export const ALERT_SKILL_DIR = 'lovdex-inbox-alert';

/**
 * 约定格式的版本。**改动 `ALERT_PROMPT_INSTRUCTION` 或解析器认可的格式时必须
 * bump** —— 否则已安装的 skill 不会被提示更新，新旧格式会静默不一致。
 */
export const ALERT_SKILL_VERSION = '1.0.0';

/**
 * SKILL.md 的 description。模型靠它判断是否调用本 skill，所以触发词必须写在这里
 * （这是"提示词提到放到收件箱就自动触发"的实现方式）。
 */
export const ALERT_SKILL_DESCRIPTION =
  '把结果或异常发送到 Lovdex 收件箱并在浏览器通知用户。'
  + '当用户要求"放到收件箱"、"发到收件箱"、"通知我"、"有异常告警"、"汇报结果到收件箱"时使用。';

/** 生成 SKILL.md 全文（YAML frontmatter + 正文）。 */
export function buildAlertSkillMarkdown(): string {
  return [
    '---',
    `name: ${ALERT_SKILL_DIR}`,
    `description: ${ALERT_SKILL_DESCRIPTION}`,
    `version: ${ALERT_SKILL_VERSION}`,
    '---',
    '',
    '# Lovdex 收件箱告警上报',
    '',
    '本 skill 说明如何把结果或异常上报到 Lovdex 收件箱。收件箱会在浏览器弹窗、',
    '在侧边栏显示未读角标，并可在 /inbox 页面回看。',
    '',
    ALERT_PROMPT_INSTRUCTION,
    '',
    '## 合并规则',
    '',
    '同一个 `code` 的告警会被收件箱合并成一条并累计次数（显示 ×N），',
    '所以同一个问题反复出现不会刷屏。请为每类异常使用稳定的 `code`。',
    '',
  ].join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/alert-skill.test.ts
```
Expected: PASS，4 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/alert-skill.ts backend/server/modules/notifications/tests/alert-skill.test.ts
git commit -m "feat(notifications): add versioned alert skill markdown builder"
```

---

## Task 2: skill 状态 / 安装 / 卸载服务

**Files:**
- Create: `backend/server/modules/notifications/alert-skill.service.ts`
- Test: `backend/server/modules/notifications/tests/alert-skill.service.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/alert-skill.service.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAlertSkillService } from '@/modules/notifications/alert-skill.service.js';
import { ALERT_SKILL_DIR, ALERT_SKILL_VERSION } from '@/modules/notifications/alert-skill.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lovdex-skill-'));
}

function writeInstalled(root: string, version: string): void {
  const dir = path.join(root, ALERT_SKILL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${ALERT_SKILL_DIR}\ndescription: x\nversion: ${version}\n---\n\nbody\n`, 'utf8');
}

test('未安装：installed=false、无更新', () => {
  const root = tmpRoot();
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: async () => [], removeSkill: async () => ({ removed: true, provider: 'claude', directoryName: '' }) });
  const status = svc.getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.installedVersion, null);
  assert.equal(status.hasUpdate, false);
  assert.equal(status.bundledVersion, ALERT_SKILL_VERSION);
});

test('已安装且版本一致：installed=true、hasUpdate=false', () => {
  const root = tmpRoot();
  writeInstalled(root, ALERT_SKILL_VERSION);
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: async () => [], removeSkill: async () => ({ removed: true, provider: 'claude', directoryName: '' }) });
  const status = svc.getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.installedVersion, ALERT_SKILL_VERSION);
  assert.equal(status.hasUpdate, false);
});

test('已安装但版本落后：hasUpdate=true', () => {
  const root = tmpRoot();
  writeInstalled(root, '0.0.1');
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: async () => [], removeSkill: async () => ({ removed: true, provider: 'claude', directoryName: '' }) });
  const status = svc.getStatus();
  assert.equal(status.hasUpdate, true);
  assert.equal(status.installedVersion, '0.0.1');
});

test('已安装但 frontmatter 缺 version：视为未安装（读不到版本）', () => {
  const root = tmpRoot();
  const dir = path.join(root, ALERT_SKILL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n', 'utf8');
  const svc = createAlertSkillService({ skillsRoot: root, addSkill: async () => [], removeSkill: async () => ({ removed: true, provider: 'claude', directoryName: '' }) });
  assert.equal(svc.getStatus().installed, false);
});

test('install 调 addSkill(claude, 正确 entries) 后状态变已安装', async () => {
  const root = tmpRoot();
  const calls: Array<{ provider: string; input: unknown }> = [];
  const svc = createAlertSkillService({
    skillsRoot: root,
    addSkill: async (provider: string, input: unknown) => {
      calls.push({ provider, input });
      writeInstalled(root, ALERT_SKILL_VERSION); // 模拟真实写盘
      return [];
    },
    removeSkill: async () => ({ removed: true, provider: 'claude', directoryName: '' }),
  });

  const status = await svc.install();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  const entries = (calls[0].input as { entries: Array<{ directoryName?: string; content?: string }> }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].directoryName, ALERT_SKILL_DIR);
  assert.ok((entries[0].content ?? '').includes('```lovdex-alert'));
  assert.equal(status.installed, true);
});

test('uninstall 调 removeSkill(claude, 正确 directoryName) 后状态变未安装', async () => {
  const root = tmpRoot();
  writeInstalled(root, ALERT_SKILL_VERSION);
  const calls: Array<{ provider: string; input: unknown }> = [];
  const svc = createAlertSkillService({
    skillsRoot: root,
    addSkill: async () => [],
    removeSkill: async (provider: string, input: unknown) => {
      calls.push({ provider, input });
      fs.rmSync(path.join(root, ALERT_SKILL_DIR), { recursive: true, force: true });
      return { removed: true, provider: 'claude', directoryName: ALERT_SKILL_DIR };
    },
  });

  const status = await svc.uninstall();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.deepEqual(calls[0].input, { directoryName: ALERT_SKILL_DIR });
  assert.equal(status.installed, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/alert-skill.service.test.ts
```
Expected: FAIL —— 找不到 `alert-skill.service.js`

- [ ] **Step 3: 写实现**

`alert-skill.service.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import {
  ALERT_SKILL_DIR,
  ALERT_SKILL_VERSION,
  buildAlertSkillMarkdown,
} from './alert-skill.js';

export type AlertSkillStatus = {
  installed: boolean;
  installedVersion: string | null;
  bundledVersion: string;
  hasUpdate: boolean;
  skillPath: string;
};

export type AlertSkillServiceDeps = {
  /** 覆盖 skill 根目录（测试注入临时目录）。默认 `~/.claude/skills`。 */
  skillsRoot?: string;
  /** 测试 seam；默认走 provider skills 服务（claude 的 global 源）。 */
  addSkill?: (provider: string, input: { entries: Array<{ content: string; directoryName?: string }> }) => Promise<unknown>;
  removeSkill?: (provider: string, input: { directoryName: string }) => Promise<unknown>;
};

/**
 * 收件箱 skill 的状态与安装。状态**每次从磁盘推导**，不落库 —— 避免 DB 与真实
 * 文件状态漂移（用户可能手动删了目录）。
 */
export function createAlertSkillService(deps: AlertSkillServiceDeps = {}) {
  const skillsRoot = deps.skillsRoot ?? path.join(os.homedir(), '.claude', 'skills');
  const addSkill = deps.addSkill ?? ((p, i) => providerSkillsService.addProviderSkills(p, i as never));
  const removeSkill = deps.removeSkill ?? ((p, i) => providerSkillsService.removeProviderSkill(p, i));
  const skillPath = path.join(skillsRoot, ALERT_SKILL_DIR, 'SKILL.md');

  function getStatus(): AlertSkillStatus {
    let installedVersion: string | null = null;
    try {
      const raw = fs.readFileSync(skillPath, 'utf8');
      const version = (parseFrontMatter(raw).data as Record<string, unknown> | undefined)?.version;
      installedVersion = typeof version === 'string' && version.trim() ? version.trim() : null;
    } catch {
      // 未安装 / 读不到 / frontmatter 缺失 → 一律按未安装处理
    }
    const installed = installedVersion !== null;
    return {
      installed,
      installedVersion,
      bundledVersion: ALERT_SKILL_VERSION,
      hasUpdate: installed && installedVersion !== ALERT_SKILL_VERSION,
      skillPath,
    };
  }

  /** 安装 / 更新 / 重装是同一个操作 —— addSkills 内部先 rm 整个技能目录再写。 */
  async function install(): Promise<AlertSkillStatus> {
    await addSkill('claude', {
      entries: [{ content: buildAlertSkillMarkdown(), directoryName: ALERT_SKILL_DIR }],
    });
    return getStatus();
  }

  async function uninstall(): Promise<AlertSkillStatus> {
    await removeSkill('claude', { directoryName: ALERT_SKILL_DIR });
    return getStatus();
  }

  return { getStatus, install, uninstall };
}

export type AlertSkillService = ReturnType<typeof createAlertSkillService>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/alert-skill.service.test.ts
```
Expected: PASS，6 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/alert-skill.service.ts backend/server/modules/notifications/tests/alert-skill.service.test.ts
git commit -m "feat(notifications): add alert skill status/install/uninstall service"
```

---

## Task 3: skill HTTP 端点

**Files:**
- Modify: `backend/server/modules/notifications/notifications.routes.ts`
- Modify: `backend/server/modules/notifications/tests/notifications.routes.test.ts`

- [ ] **Step 1: 补失败测试**

在 `tests/notifications.routes.test.ts` 末尾追加（该文件已有 `makeSvc` 与 `startServer` 辅助）：

```ts
function makeSkillSvc(installed = false) {
  const state = { installed, installedVersion: installed ? '0.0.1' : null, bundledVersion: '1.0.0', hasUpdate: installed, skillPath: '/tmp/x/SKILL.md' };
  return {
    getStatus: () => state,
    install: async () => ({ ...state, installed: true, installedVersion: '1.0.0', hasUpdate: false }),
    uninstall: async () => ({ ...state, installed: false, installedVersion: null, hasUpdate: false }),
  };
}

test('GET /skill 返回技能状态', async () => {
  const { baseUrl, close } = await startServer(makeSvc(), makeSkillSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/skill`);
    assert.equal(res.status, 200);
    const body = await res.json() as { bundledVersion: string; installed: boolean };
    assert.equal(body.bundledVersion, '1.0.0');
    assert.equal(body.installed, false);
  } finally { await close(); }
});

test('POST /skill/install 安装后返回已安装状态', async () => {
  const { baseUrl, close } = await startServer(makeSvc(), makeSkillSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/skill/install`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { installed: boolean };
    assert.equal(body.installed, true);
  } finally { await close(); }
});

test('POST /skill/uninstall 卸载后返回未安装状态', async () => {
  const { baseUrl, close } = await startServer(makeSvc(), makeSkillSvc(true));
  try {
    const res = await fetch(`${baseUrl}/api/notifications/skill/uninstall`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { installed: boolean };
    assert.equal(body.installed, false);
  } finally { await close(); }
});

test('未接线 skill 服务时 /skill 返回 503', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/skill`);
    assert.equal(res.status, 503);
  } finally { await close(); }
});
```

同时把该文件里的 `startServer` 改成接收第二个参数：

```ts
async function startServer(svc: unknown, skillSvc?: unknown) {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', buildNotificationsRouter(svc as never, skillSvc as never));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.routes.test.ts
```
Expected: FAIL —— `/skill` 返回 404

- [ ] **Step 3: 写实现**

`notifications.routes.ts` 改为（新增第二个参数与三个端点，**注册在 `/:id/read` 之前**）：

```ts
import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import type { NotificationsService } from './notifications.service.js';
import type { AlertSkillService } from './alert-skill.service.js';

export function buildNotificationsRouter(
  svc: NotificationsService,
  skillSvc?: AlertSkillService | null,
) {
  const router = express.Router();

  const requireSkill = (): AlertSkillService => {
    if (!skillSvc) {
      throw new AppError('alert skill service is not wired', { code: 'SKILL_NOT_WIRED', statusCode: 503 });
    }
    return skillSvc;
  };

  // GET /?unread=true&limit=50&offset=0
  router.get('/', asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    res.json(svc.list({ limit, offset, unreadOnly }));
  }));

  router.get('/unread-count', asyncHandler(async (_req, res) => {
    res.json({ unreadCount: svc.unreadCount() });
  }));

  // 必须在 /:id/read 之前注册，否则 read-all 会被 :id 吞掉。
  router.post('/read-all', asyncHandler(async (_req, res) => {
    svc.markAllRead();
    res.json({ success: true, unreadCount: svc.unreadCount() });
  }));

  // ---- 收件箱 skill（装/卸/状态）----
  router.get('/skill', asyncHandler(async (_req, res) => {
    res.json(requireSkill().getStatus());
  }));

  router.post('/skill/install', asyncHandler(async (_req, res) => {
    res.json(await requireSkill().install());
  }));

  router.post('/skill/uninstall', asyncHandler(async (_req, res) => {
    res.json(await requireSkill().uninstall());
  }));

  router.post('/:id/read', asyncHandler(async (req, res) => {
    const row = svc.markRead(String(req.params.id));
    if (!row) throw new AppError('notification not found', { code: 'NOTIFICATION_NOT_FOUND', statusCode: 404 });
    res.json(row);
  }));

  return router;
}

export default buildNotificationsRouter;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.routes.test.ts
```
Expected: PASS，9 tests（原 5 + 新 4）

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/notifications.routes.ts backend/server/modules/notifications/tests/notifications.routes.test.ts
git commit -m "feat(notifications): add alert skill HTTP endpoints"
```

---

## Task 4: 会话告警扫描器（读 run.events）

**Files:**
- Create: `backend/server/modules/notifications/session-alert-scanner.ts`
- Test: `backend/server/modules/notifications/tests/session-alert-scanner.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/session-alert-scanner.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionAlertScanner } from '@/modules/notifications/session-alert-scanner.js';

const text = (content: string) => ({ kind: 'text', role: 'assistant', content });
const ALERT_BLOCK = '```lovdex-alert\n{"severity":"warning","title":"磁盘满","code":"disk_full"}\n```';

function harness(opts: { isOperator?: boolean; task?: unknown } = {}) {
  const emitted: Array<Record<string, unknown>> = [];
  const scanner = createSessionAlertScanner({
    getSessionById: () => ({ is_operator: opts.isOperator ? 1 : 0 }),
    getTaskBySession: () => (opts.task ?? null) as never,
    notifications: { emit: (i: Record<string, unknown>) => { emitted.push(i); return {} as never; } } as never,
  });
  return { scanner, emitted };
}

test('从 run.events 提取标记并 emit', () => {
  const { scanner, emitted } = harness();
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(`巡检完成\n${ALERT_BLOCK}`)] });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].severity, 'warning');
  assert.equal(emitted[0].title, '磁盘满');
  assert.equal(emitted[0].code, 'disk_full');
  assert.equal(emitted[0].sessionId, 's1');
});

test('无标记时不 emit', () => {
  const { scanner, emitted } = harness();
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text('一切正常，无需通知')] });
  assert.equal(emitted.length, 0);
});

test('operator 会话被跳过（助手走 send_notification 工具）', () => {
  const { scanner, emitted } = harness({ isOperator: true });
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] });
  assert.equal(emitted.length, 0);
});

test('关联 task 时带上 task_id / schedule_id / project_path', () => {
  const { scanner, emitted } = harness({
    task: { task_id: 't1', source_schedule_id: 'sch1', project_path: '/p' },
  });
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] });
  assert.equal(emitted[0].taskId, 't1');
  assert.equal(emitted[0].scheduleId, 'sch1');
  assert.equal(emitted[0].projectPath, '/p');
});

test('无关联 task 时 taskId/scheduleId 为 null，但 sessionId 仍在（通知可点击）', () => {
  const { scanner, emitted } = harness();
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] });
  assert.equal(emitted[0].taskId, null);
  assert.equal(emitted[0].scheduleId, null);
  assert.equal(emitted[0].sessionId, 's1');
});

test('多个标记逐个 emit', () => {
  const { scanner, emitted } = harness();
  const two = '```lovdex-alert\n{"severity":"critical","title":"A"}\n```\n```lovdex-alert\n{"severity":"info","title":"B"}\n```';
  scanner.scanCompletedRun({ appSessionId: 's1', events: [text(two)] });
  assert.equal(emitted.length, 2);
});

test('依赖抛错时吞掉不外抛（不影响会话生命周期）', () => {
  const scanner = createSessionAlertScanner({
    getSessionById: () => { throw new Error('boom'); },
    getTaskBySession: () => null,
    notifications: { emit: () => ({}) as never } as never,
  });
  assert.doesNotThrow(() => scanner.scanCompletedRun({ appSessionId: 's1', events: [text(ALERT_BLOCK)] }));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/session-alert-scanner.test.ts
```
Expected: FAIL —— 找不到 `session-alert-scanner.js`

- [ ] **Step 3: 写实现**

`session-alert-scanner.ts`：

```ts
import { parseAlertsFromMessages } from './alert-parser.js';
import type { NotificationsService } from './notifications.service.js';

type ScanEvent = { kind?: string; role?: string; content?: string };

export type SessionAlertScannerDeps = {
  getSessionById: (id: string) => { is_operator?: number | boolean | null } | null;
  getTaskBySession: (id: string) => {
    task_id?: string | null;
    source_schedule_id?: string | null;
    project_path?: string | null;
  } | null;
  notifications: NotificationsService;
};

/**
 * 会话结束时扫描**本轮内存缓冲**（`ChatRun.events`）里的 assistant 文本，提取
 * `lovdex-alert` 标记并投递到收件箱。
 *
 * 为什么扫内存而不是 fetchHistory：complete 到达时本轮 assistant 文本已在
 * `run.events` 里，省掉一次全量转录读取（远程会话还省一次 RPC）。
 *
 * operator 会话跳过 —— 助手没有 Skill 工具、也不该靠解释格式时输出的代码块发通知，
 * 它走 `send_notification` MCP 工具这条确定性路径。
 *
 * 永不抛：与 verdict LLM 同栈，解析/读取失败只 warn，绝不影响会话生命周期。
 */
export function createSessionAlertScanner(deps: SessionAlertScannerDeps) {
  return {
    scanCompletedRun(input: { appSessionId: string; events: readonly ScanEvent[] }): void {
      try {
        const session = deps.getSessionById(input.appSessionId);
        if (session?.is_operator) return;

        const alerts = parseAlertsFromMessages(input.events);
        if (alerts.length === 0) return;

        const task = deps.getTaskBySession(input.appSessionId);
        for (const alert of alerts) {
          deps.notifications.emit({
            severity: alert.severity,
            title: alert.title,
            body: alert.body ?? null,
            code: alert.code ?? null,
            scheduleId: task?.source_schedule_id ?? null,
            taskId: task?.task_id ?? null,
            sessionId: input.appSessionId,
            projectPath: task?.project_path ?? null,
          });
        }
      } catch (error) {
        console.warn('[notifications] session alert scan failed', { sessionId: input.appSessionId }, error);
      }
    },
  };
}

export type SessionAlertScanner = ReturnType<typeof createSessionAlertScanner>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/session-alert-scanner.test.ts
```
Expected: PASS，7 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/session-alert-scanner.ts backend/server/modules/notifications/tests/session-alert-scanner.test.ts
git commit -m "feat(notifications): add session alert scanner reading run event buffer"
```

---

## Task 5: registry 注入点 + complete 分支调用

**Files:**
- Modify: `backend/server/modules/websocket/services/chat-run-registry.service.ts`（注入点加在 `setTaskLinkage` 附近约 :161-170；调用加在 complete 分支 `:281` 之后）

无独立单测（薄接线层；扫描逻辑已在 Task 4 覆盖）。类型正确性由 tsc 兜底。

- [ ] **Step 1: 加注入点**

在 `chat-run-registry.service.ts` 的 `TaskLinkage` 类型定义与 `setTaskLinkage` 之后（约 `:170`，`getTaskLinkage` 之后）追加：

```ts
/**
 * 会话结束时的告警扫描器，注入（而非 import）以保持 registry 不依赖 notifications
 * 与 tasks 模块。见 modules/notifications/session-alert-scanner.ts。
 */
type SessionAlertScannerLike = {
  scanCompletedRun: (input: { appSessionId: string; events: readonly NormalizedMessage[] }) => void;
};

let sessionAlertScanner: SessionAlertScannerLike | null = null;

export function setSessionAlertScanner(scanner: SessionAlertScannerLike | null): void {
  sessionAlertScanner = scanner;
}
```

- [ ] **Step 2: 在 complete 分支调用**

在 `decorateAndRecordEvent` 的 complete 分支里，`taskLinkage?.onSessionStatus(run.appSessionId, state);`（`:281`）**之后**插入：

```ts
    // 告警扫描：读本轮内存缓冲里的 assistant 文本，提取 lovdex-alert 标记。
    // 此刻 run.events 已含本轮 assistant 文本（complete 自身在 :291 才入队，
    // 不影响）。三类会话（助手/任务/普通交互）都经过这里。
    sessionAlertScanner?.scanCompletedRun({ appSessionId: run.appSessionId, events: run.events });
```

- [ ] **Step 3: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -i "chat-run-registry" || echo "no registry type errors"
```
Expected: `no registry type errors`

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/websocket/services/chat-run-registry.service.ts
git commit -m "feat(notifications): scan completed runs for alerts via injected scanner"
```

---

## Task 6: 后端装配（index.js）+ 删除旧扫描

**Files:**
- Modify: `backend/server/index.js`
- Modify: `backend/server/modules/notifications/index.ts`
- Delete: `backend/server/modules/notifications/scan-completed-task.ts`

- [ ] **Step 1: 更新桶文件**

`modules/notifications/index.ts` 改为：

```ts
export { createNotificationsDb } from './notifications.db.js';
export type { NotificationRow, NotificationsDb } from './notifications.db.js';
export { createNotificationsService } from './notifications.service.js';
export type { NotificationsService, NotificationBroadcast } from './notifications.service.js';
export { buildNotificationsRouter } from './notifications.routes.js';
export { createSessionAlertScanner } from './session-alert-scanner.js';
export { createAlertSkillService } from './alert-skill.service.js';
export type { AlertSkillStatus, AlertSkillService } from './alert-skill.service.js';
export { parseAlertsFromMessages } from './alert-parser.js';
export { ALERT_PROMPT_INSTRUCTION } from './alert-format.js';
export { ALERT_SKILL_DIR, ALERT_SKILL_VERSION, buildAlertSkillMarkdown } from './alert-skill.js';
```

（移除了 `scanCompletedTaskForAlerts` 的导出。）

- [ ] **Step 2: 删除旧扫描文件**

```bash
cd /mnt/b/workdir/github/lovdex
git rm backend/server/modules/notifications/scan-completed-task.ts
```

- [ ] **Step 3: 改 index.js 的 import**

把 import 行（约 `:79`）改成：

```js
import {
    createNotificationsDb,
    createNotificationsService,
    buildNotificationsRouter,
    createSessionAlertScanner,
    createAlertSkillService,
} from './modules/notifications/index.js';
```

`chat-run-registry.service.js` **已经被 import**（`index.js:21`）：

```js
import { chatRunRegistry, setTaskLinkage } from '@/modules/websocket/services/chat-run-registry.service.js';
```

在该行里追加 `setSessionAlertScanner`（不要新增一行 import）：

```js
import { chatRunRegistry, setTaskLinkage, setSessionAlertScanner } from '@/modules/websocket/services/chat-run-registry.service.js';
```

- [ ] **Step 4: 恢复 onTaskCompleted 只做 verdict**

把 `onTaskCompleted` 改回（移除扫描块）：

```js
    onTaskCompleted: (taskId, title, sessionId) => {
        if (!sessionId) return;
        const sessionRow = sessionsDb.getSessionById(sessionId);
        const isOperator = Boolean(sessionRow?.is_operator);
        scheduleAutoVerdict(sessionId, taskId, title, isOperator);
    },
```

- [ ] **Step 5: 在 startServer 里装配 scanner + skill 服务**

在 `startServer()` 内、`notificationsService` 赋值与 `app.use('/api/notifications', ...)` 之后（约 `:2180`）插入：

```js
        // 告警扫描器：会话结束时读 run.events 提取 lovdex-alert 标记。
        // 必须在 notificationsService 赋值之后注入（registry 是模块级单例）。
        setSessionAlertScanner(createSessionAlertScanner({
            getSessionById: (id) => sessionsDb.getSessionById(id),
            getTaskBySession: (id) => tasksDb.getTaskBySessionId(id),
            notifications: notificationsService,
        }));

        // 收件箱 skill：状态从磁盘推导，装/卸走 provider skills 层（claude）。
        const alertSkillService = createAlertSkillService();
        app.use('/api/notifications', authenticateToken, buildNotificationsRouter(notificationsService, alertSkillService));

        // 启动时比对内置 vs 已安装版本，落后就发一条 info 通知（进收件箱、
        // 不弹窗不计角标）。失败绝不阻塞启动。
        try {
            const skillStatus = alertSkillService.getStatus();
            if (skillStatus.installed && skillStatus.hasUpdate) {
                notificationsService.emit({
                    severity: 'info',
                    title: `收件箱技能有新版本 v${skillStatus.bundledVersion}`,
                    body: `已安装 v${skillStatus.installedVersion}。到设置页更新后，任务的告警格式才与后端一致。`,
                    code: 'skill_update',
                });
            }
        } catch (error) {
            console.warn('[notifications] skill update check failed', error);
        }
```

**注意**：原有的 `app.use('/api/notifications', authenticateToken, buildNotificationsRouter(notificationsService));` 这一行要被上面的新行**替换**（不要留两行重复注册）。

- [ ] **Step 6: 语法检查 + 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/backend && node --check server/index.js && echo "syntax OK"
unset TSX_TSCONFIG_PATH; npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -cE "error TS"
```
Expected: `syntax OK`；错误数 = baseline 15（**零新增**）

- [ ] **Step 7: 跑全量 notifications 测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/*.test.ts 2>&1 | tail -6
```
Expected: 全绿（parser 8 + db 7 + service 6 + routes 9 + alert-skill 4 + alert-skill.service 6 + session-alert-scanner 7 = 47）

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js backend/server/modules/notifications/index.ts
git commit -m "feat(notifications): wire session alert scanner, skill service and startup check"
```

---

## Task 7: 助手工具 `send_notification`

**Files:**
- Modify: `backend/server/modules/operators/operator.tools.ts`
- Modify: `backend/server/modules/operators/tests/operator-tools.test.ts`

- [ ] **Step 1: 补失败测试**

在 `tests/operator-tools.test.ts` 末尾追加：

```ts
test('send_notification 转发到 emit 并带上会话 id', async () => {
  const emitted: Array<Record<string, unknown>> = [];
  const tools = buildOperatorTools({
    tasks: {} as never,
    contextSessionId: 'sess-1',
    notifications: {
      list: () => [],
      unreadCount: () => 0,
      markRead: () => null,
      markAllRead: () => {},
      emit: (i: Record<string, unknown>) => { emitted.push(i); return { notification_id: 'n1' }; },
    },
  });

  const res = (await tools.send_notification.handler({
    severity: 'warning', title: '磁盘满', body: '97%', code: 'disk_full',
  })) as { success: boolean };

  assert.equal(res.success, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].severity, 'warning');
  assert.equal(emitted[0].title, '磁盘满');
  assert.equal(emitted[0].body, '97%');
  assert.equal(emitted[0].code, 'disk_full');
  assert.equal(emitted[0].sessionId, 'sess-1');
});

test('send_notification 拒绝非法 severity 与空 title', async () => {
  const tools = buildOperatorTools({
    tasks: {} as never,
    notifications: {
      list: () => [], unreadCount: () => 0, markRead: () => null, markAllRead: () => {},
      emit: () => ({ notification_id: 'n1' }),
    },
  });

  await assert.rejects(() => tools.send_notification.handler({ severity: 'fatal', title: 'x' }), /invalid severity/);
  await assert.rejects(() => tools.send_notification.handler({ severity: 'info', title: '   ' }), /title is required/);
});

test('send_notification 未接线时报错', async () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  await assert.rejects(() => tools.send_notification.handler({ severity: 'info', title: 'x' }), /not wired/);
});

test('send_notification schema 要求 severity + title', () => {
  const tools = buildOperatorTools({ tasks: {} as never });
  assert.deepEqual(tools.send_notification.inputSchema.required, ['severity', 'title']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/operators/tests/operator-tools.test.ts
```
Expected: FAIL —— `tools.send_notification` 是 undefined

- [ ] **Step 3: 扩 deps 类型**

`operator.tools.ts` 里 `notifications` 依赖块（约 `:113-124`）改为加上 `emit`，并在 `OperatorToolDeps` 里新增 `contextSessionId`：

```ts
  notifications?: {
    list: (options: { limit: number; offset: number; unreadOnly?: boolean }) => unknown[];
    unreadCount: () => number;
    markRead: (id: string) => unknown;
    markAllRead: () => void;
    emit: (input: {
      severity: 'critical' | 'warning' | 'info';
      title: string;
      body?: string | null;
      code?: string | null;
      sessionId?: string | null;
    }) => unknown;
  };
  /**
   * 当前助手会话 id，注入后 send_notification 发出的通知会带 session_id，
   * 用户在 /inbox 点击可跳回这次对话。
   */
  contextSessionId?: string | null;
```

同时在文件顶部 import 里加入 severity 守卫（若已有 `alert-format` 的 import 则复用）：

```ts
import { isAlertSeverity } from '@/modules/notifications/alert-format.js';
```

- [ ] **Step 4: 加工具**

在 `operator.tools.ts` 的工具对象里、`mark_notification_read` 之后追加：

```ts
    send_notification: {
      description:
        'Send a notification to the user\'s Lovdex 收件箱 (inbox). The user sees it as a browser toast (critical/warning only), a sidebar unread badge, and a row in /inbox. Use this whenever the user asks you to notify them, send something to the inbox, or report an alert. severity: critical|warning|info (info lands in the inbox only — no toast, no badge). code: a stable category id so repeats merge into one row with a ×N counter instead of spamming.',
      inputSchema: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
          title: { type: 'string', description: 'One-line summary shown as the row title' },
          body: { type: 'string', description: 'Optional detail shown under the title' },
          code: { type: 'string', description: 'Optional stable category id used for merge/dedupe' },
        },
        required: ['severity', 'title'],
      },
      handler: async (i: { severity?: string; title?: string; body?: string; code?: string }) => {
        if (!deps.notifications) {
          throw new Error('notifications is not wired (missing notifications dep)');
        }
        if (!isAlertSeverity(i.severity)) {
          throw new Error(`invalid severity: ${String(i.severity)}`);
        }
        if (typeof i.title !== 'string' || !i.title.trim()) {
          throw new Error('title is required');
        }
        const row = deps.notifications.emit({
          severity: i.severity,
          title: i.title.trim(),
          body: typeof i.body === 'string' && i.body.trim() ? i.body.trim() : null,
          code: typeof i.code === 'string' && i.code.trim() ? i.code.trim() : null,
          sessionId: deps.contextSessionId ?? null,
        });
        return { success: true, notification: row };
      },
    },
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/operators/tests/operator-tools.test.ts
```
Expected: PASS，39 tests（原 35 + 新 4）

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/operators/operator.tools.ts backend/server/modules/operators/tests/operator-tools.test.ts
git commit -m "feat(operator): add send_notification tool"
```

---

## Task 8: 助手 system prompt + 注入当前会话 id

**Files:**
- Modify: `backend/server/claude-sdk.js`

- [ ] **Step 1: 注入 contextSessionId**

在 `queryClaudeSDK` 的 operator 分支里，`buildOperatorSdkTools(operatorDepsRef)`（约 `:700`）改为带上当前会话 id：

```js
      const operatorServer = createSdkMcpServer({
        name: 'lovdex-operator',
        tools: buildOperatorSdkTools({ ...operatorDepsRef, contextSessionId: sessionId ?? null }),
        alwaysLoad: true,
      });
```

- [ ] **Step 2: system prompt 加 send_notification**

把 `OPERATOR_INBOX_PROMPT` 常量（`claude-sdk.js` 顶部，`TOOLS_REQUIRING_INTERACTION` 之后）改为：

```js
const OPERATOR_INBOX_PROMPT = [
  '收件箱（通知中心）：任务在最终回复里输出 lovdex-alert 代码块时，后端会在任务结束时扫转录、落库，并在浏览器弹窗 + 侧边栏未读角标 + /inbox 页面展示（同一 code 自动合并计数，不刷屏）。',
  '当用户要你「通知他」「发消息到收件箱」「发个测试通知」「把结果放到收件箱」时，**直接调用 send_notification 工具**（severity/title/body/code），不要只输出 lovdex-alert 代码块——你是助手，走工具这条路。severity 取 critical/warning/info：critical 和 warning 会弹窗并计未读角标，info 只进收件箱。code 用稳定标识以便同类合并。',
  '用 list_notifications 查未读通知，用 mark_notification_read 标记已读（notificationId 指定一条，all=1 全部已读）。',
  '重要：当用户要你建「巡检 / 监控 / 定时检查」类任务、并且希望发现异常时收到通知时，你必须在 create_scheduled_task 的 description 里原样带上下面这段约定，否则任务不会产生任何通知（静默失败）：',
  ALERT_PROMPT_INSTRUCTION,
].join('\n');
```

并把工具清单里的名字补上 `send_notification`（当前是 `.../list_notifications/mark_notification_read 等）`）：

```
delete_scheduled_task/execute_skill/workbench/list_notifications/mark_notification_read/send_notification 等）
```

- [ ] **Step 3: 语法检查**

```bash
cd /mnt/b/workdir/github/lovdex/backend && node --check server/claude-sdk.js && echo "syntax OK"
```
Expected: `syntax OK`

- [ ] **Step 4: 确认 verdict 封闭工具集也排除了 send_notification**

`buildOperatorSdkTools(resolvedDeps, { exclude: [...] })`（约 `:1351`）的 exclude 数组加上 `'send_notification'`：

```js
    const sdkTools = buildOperatorSdkTools(resolvedDeps, { exclude: ['execute_skill', 'workbench', 'delete_task', 'delete_session', 'list_notifications', 'mark_notification_read', 'send_notification'] });
```

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/claude-sdk.js
git commit -m "feat(operator): teach assistant to send notifications via tool"
```

---

## Task 9: 前端 API 命名空间

**Files:**
- Modify: `web/src/utils/api.js`（`notifications` 块内追加）

- [ ] **Step 1: 加方法**

在 `web/src/utils/api.js` 的 `notifications` 对象里、`markAllRead` 之后追加：

```js
    skillStatus: () => authenticatedFetch('/api/notifications/skill'),
    skillInstall: () => authenticatedFetch('/api/notifications/skill/install', { method: 'POST' }),
    skillUninstall: () => authenticatedFetch('/api/notifications/skill/uninstall', { method: 'POST' }),
```

- [ ] **Step 2: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsc --noEmit 2>&1 | grep -cE "error TS"
```
Expected: `0`（web 基线为 0）

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/utils/api.js
git commit -m "feat(inbox): add skill status/install/uninstall api"
```

---

## Task 10: 设置页「收件箱技能」区块（纯逻辑 + UI）

**Files:**
- Create: `web/src/components/settings/inboxSkillStatus.ts`
- Create: `web/src/components/settings/tests/inboxSkillStatus.test.ts`
- Create: `web/src/components/settings/InboxSkillSettings.tsx`
- Modify: `web/src/components/settings/SettingsPage.tsx`

- [ ] **Step 1: 写失败测试**

`web/src/components/settings/tests/inboxSkillStatus.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeSkillStatus, type AlertSkillStatus } from '../inboxSkillStatus.js';

const status = (over: Partial<AlertSkillStatus> = {}): AlertSkillStatus => ({
  installed: false, installedVersion: null, bundledVersion: '1.0.0', hasUpdate: false,
  skillPath: '/home/u/.claude/skills/lovdex-inbox-alert/SKILL.md', ...over,
});

test('未安装：开关关、主按钮为安装', () => {
  const d = describeSkillStatus(status());
  assert.equal(d.switchOn, false);
  assert.equal(d.primaryLabel, '安装');
  assert.equal(d.highlight, false);
  assert.equal(d.versionLine, '内置 v1.0.0');
});

test('已安装且最新：开关开、主按钮为重装、不额外显示已装版本行', () => {
  const d = describeSkillStatus(status({ installed: true, installedVersion: '1.0.0' }));
  assert.equal(d.switchOn, true);
  assert.equal(d.primaryLabel, '重装');
  assert.equal(d.highlight, false);
  assert.equal(d.versionLine, '已安装 v1.0.0 · 内置 v1.0.0');
});

test('有更新：主按钮为更新到新版本、高亮', () => {
  const d = describeSkillStatus(status({ installed: true, installedVersion: '0.9.0', bundledVersion: '1.0.0', hasUpdate: true }));
  assert.equal(d.switchOn, true);
  assert.equal(d.primaryLabel, '更新到 v1.0.0');
  assert.equal(d.highlight, true);
  assert.equal(d.versionLine, '已安装 v0.9.0 · 内置 v1.0.0');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsx --test src/components/settings/tests/inboxSkillStatus.test.ts
```
Expected: FAIL —— 找不到 `inboxSkillStatus.js`

- [ ] **Step 3: 写纯逻辑**

`web/src/components/settings/inboxSkillStatus.ts`：

```ts
export type AlertSkillStatus = {
  installed: boolean;
  installedVersion: string | null;
  bundledVersion: string;
  hasUpdate: boolean;
  skillPath: string;
};

export type SkillStatusView = {
  switchOn: boolean;
  primaryLabel: string;
  versionLine: string;
  highlight: boolean;
};

/** 状态 → UI 文案/开关。纯函数，便于无 DOM 单测。 */
export function describeSkillStatus(status: AlertSkillStatus): SkillStatusView {
  const versionLine = status.installed
    ? `已安装 v${status.installedVersion} · 内置 v${status.bundledVersion}`
    : `内置 v${status.bundledVersion}`;
  return {
    switchOn: status.installed,
    primaryLabel: status.hasUpdate ? `更新到 v${status.bundledVersion}` : (status.installed ? '重装' : '安装'),
    versionLine,
    highlight: status.hasUpdate,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsx --test src/components/settings/tests/inboxSkillStatus.test.ts
```
Expected: PASS，3 tests

- [ ] **Step 5: 写 UI 组件**

`web/src/components/settings/InboxSkillSettings.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../shared/view/ui';
import { api } from '../../utils/api';
import { describeSkillStatus, type AlertSkillStatus } from './inboxSkillStatus';

/**
 * 「收件箱技能」设置区块：把 lovdex-alert 上报约定装进 ~/.claude/skills，
 * 任务会话即可在描述里说"放到收件箱"就触发通知。装/卸/更新共用同一操作
 * （后端 addSkills 先 rm 再写）。
 */
export function InboxSkillSettings() {
  const [status, setStatus] = useState<AlertSkillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.notifications.skillStatus();
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as AlertSkillStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as AlertSkillStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <Card>
        <CardHeader><CardTitle>收件箱技能</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{error ?? '加载中…'}</CardContent>
      </Card>
    );
  }

  const view = describeSkillStatus(status);

  return (
    <Card className={view.highlight ? 'border-warning' : undefined}>
      <CardHeader>
        <CardTitle>收件箱技能</CardTitle>
        <CardDescription>
          把 <code>lovdex-alert</code> 上报约定装进系统 skill 目录（<code>~/.claude/skills</code>）。
          装好后，任务描述里写「有问题放到收件箱」即可自动触发通知，不用再手抄格式。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">{view.versionLine}</div>
        <div className="text-xs text-muted-foreground break-all">{status.skillPath}</div>
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(api.notifications.skillInstall)}
          >
            {view.primaryLabel}
          </Button>
          {view.switchOn ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(api.notifications.skillUninstall)}
            >
              卸载
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default InboxSkillSettings;
```

> 注意：主按钮无论装/卸/更新都调 `skillInstall`（后端是 rm+写，天然幂等）。

- [ ] **Step 6: 挂进设置页**

`SettingsPage.tsx` 顶部 import 加：

```tsx
import { InboxSkillSettings } from './InboxSkillSettings';
```

在 operator tab 的渲染块里（`activeTab === 'operator' && (...)` 内、`<OperatorSkillExecSettings />` 之后）加：

```tsx
                  <InboxSkillSettings />
```

- [ ] **Step 7: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsc --noEmit 2>&1 | grep -iE "InboxSkill|SettingsPage" || echo "no settings type errors"
```
Expected: `no settings type errors`

- [ ] **Step 8: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/settings/inboxSkillStatus.ts web/src/components/settings/tests/inboxSkillStatus.test.ts web/src/components/settings/InboxSkillSettings.tsx web/src/components/settings/SettingsPage.tsx
git commit -m "feat(inbox): add skill settings section"
```

---

## Task 11: `skill_update` 通知点击跳设置页

**Files:**
- Modify: `web/src/components/inbox/InboxPage.tsx`

- [ ] **Step 1: 改 openTarget**

`InboxPage.tsx` 的 `openTarget` 改为（补第三个分支）：

```tsx
  const openTarget = (it: InboxNotification) => {
    markReadLocal(it.notification_id);
    if (it.task_id) navigate(`/task/${it.task_id}`);
    else if (it.session_id) navigate(`/session/${it.session_id}`);
    // 版本更新通知没有 task/session 关联，点它跳设置页去更新 skill。
    else if (it.code === 'skill_update') navigate('/settings?tab=operator');
  };
```

- [ ] **Step 2: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsc --noEmit 2>&1 | grep -i "InboxPage" || echo "no inbox page type errors"
```
Expected: `no inbox page type errors`

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/inbox/InboxPage.tsx
git commit -m "feat(inbox): route skill_update notifications to settings"
```

---

## Task 12: 端到端验证

**Files:** 无（验证 only）

前置：**需要重启后端**（新表无关，但新路由/新注入点/新 prompt 都要重新加载）。重启前先问用户。

- [ ] **Step 1: 跑全部相关测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/*.test.ts server/modules/operators/tests/operator-tools.test.ts 2>&1 | tail -6
```
Expected: 全绿（47 + 39 = 86）

```bash
cd /mnt/b/workdir/github/lovdex/web && unset TSX_TSCONFIG_PATH; npx tsx --test src/stores/tests/inboxStore.test.ts src/components/settings/tests/inboxSkillStatus.test.ts 2>&1 | tail -6
```
Expected: 全绿（7 + 3 = 10）

- [ ] **Step 2: 重启后端后验证 skill 端点**

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3188/api/auth/login -H 'Content-Type: application/json' -d '{"email":"zhiju.huang@sophgo.com","code":"888888"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
echo "$TOKEN" > /tmp/lovdex_token.txt
curl -s http://127.0.0.1:3188/api/notifications/skill -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```
Expected: `installed: false, bundledVersion: "1.0.0", hasUpdate: false`

- [ ] **Step 3: 装 skill 并确认落盘**

```bash
curl -s -X POST http://127.0.0.1:3188/api/notifications/skill/install -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
ls -la ~/.claude/skills/lovdex-inbox-alert/
head -6 ~/.claude/skills/lovdex-inbox-alert/SKILL.md
```
Expected: `installed: true`；目录存在；frontmatter 含 `name`/`description`/`version`

- [ ] **Step 4: 验证"会话里说一句就触发"**

建一个任务，描述只写一句话、不含任何格式约定：

```
在最终回复里输出一个 lovdex-alert 代码块，severity=warning，title=技能触发验证，code=skill_trigger_test。
```

`run-now` 或直接跑该任务，然后轮询：

```bash
curl -s "http://127.0.0.1:3188/api/notifications?limit=20" -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
for n in json.load(sys.stdin):
    if n.get('code')=='skill_trigger_test': print('OK:', n['title'], n['severity'], n['session_id'])
"
```
Expected: 出现 `OK: 技能触发验证 warning <session_id>`（**关键**：`session_id` 非空说明 registry 扫描路径生效，而不是旧的任务钩子）

- [ ] **Step 5: 验证助手工具路径**

在浏览器里跟 Lovdex 助手说「发一个测试信息到收件箱」。检查是否出现一条通知（`code` 由助手决定，看 title）。

Expected: 收件箱出现该条，且浏览器弹出 toast（warning/critical 时）

- [ ] **Step 6: 验证 UI 开关**

打开设置页 → Operator tab → 看到「收件箱技能」卡片显示「已安装 v1.0.0 · 内置 v1.0.0」+「重装」+「卸载」。点「卸载」→ 状态变未安装、目录消失。

```bash
ls ~/.claude/skills/ 2>/dev/null; echo "(应为空)"
```

- [ ] **Step 7: 验证版本更新通知**

手动把已安装的 SKILL.md 版本改旧，重启后端，确认收件箱出现 info 级 `skill_update` 通知：

```bash
sed -i 's/^version: .*/version: 0.0.1/' ~/.claude/skills/lovdex-inbox-alert/SKILL.md
# 重启后端后：
curl -s "http://127.0.0.1:3188/api/notifications?limit=20" -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys,json
for n in json.load(sys.stdin):
    if n.get('code')=='skill_update': print('OK:', n['title'], n['severity'])
"
```
Expected: `OK: 收件箱技能有新版本 v1.0.0 info`

- [ ] **Step 8: 清理**

```bash
curl -s -X POST http://127.0.0.1:3188/api/notifications/skill/uninstall -H "Authorization: Bearer $TOKEN" -o /dev/null -w "%{http_code}\n"
sqlite3 ~/.lovdex/data/new-auth.db "DELETE FROM notifications; SELECT COUNT(*) FROM notifications;"
```
Expected: `200` 和 `0`

---

## Self-Review 记录

- **Spec §3（两个发送机制）** → Task 4/5（会话标记路径）+ Task 7/8（助手工具路径）。✓
- **Spec §4（扫描点上移）** → Task 5（registry 注入 + complete 调用）+ Task 6（删旧扫描、恢复 onTaskCompleted 只做 verdict）。✓
- **Spec §5（skill 打包 + 版本）** → Task 1。✓
- **Spec §6（服务与 API）** → Task 2 + Task 3。✓
- **Spec §7（助手工具 send_notification）** → Task 7 + Task 8。✓
- **Spec §8（版本更新通知，info 级，启动检测）** → Task 6 Step 5。✓
- **Spec §9（前端设置区块 + api）** → Task 9 + Task 10。✓
- **Spec §8 跳转（skill_update → 设置页）** → Task 11。✓
- **Spec §10（不新增表）** → 全程无 schema 改动。✓
- **Spec §11（测试策略）** → 各 Task 的 TDD + Task 12。✓
- **Spec §13 已知限制**（skill 触发概率性、远程无同步、通知不点回具体轮次）→ 无需实现，已在 spec 记录。

**类型一致性核对**：`AlertSkillStatus` 在 Task 2（后端）与 Task 10（前端）各定义一份 —— 这是刻意的，前后端不共享类型文件（仓库现状：前端 `web/src/types/app.ts` 独立）。字段名逐一对齐：`installed` / `installedVersion` / `bundledVersion` / `hasUpdate` / `skillPath`。`createAlertSkillService` 返回的 `getStatus/install/uninstall` 与 Task 3 路由调用、Task 6 装配一致。`createSessionAlertScanner` 的 `scanCompletedRun({ appSessionId, events })` 与 Task 5 的调用签名一致。`deps.notifications.emit` 的入参字段与 `EmitInput`（notifications.service.ts）一致。
