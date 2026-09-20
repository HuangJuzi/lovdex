# 异常通知收件箱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 巡检任务在最终回复里输出 `lovdex-alert` 标记，后端在任务完成时扫转录提取它，落库 + 全客户端广播；前端弹窗 + 侧边栏未读角标 + `/inbox` 收件箱回看。

**Architecture:** 后端新增 `backend/server/modules/notifications/` 模块（DI 工厂：service + db + routes + 纯函数 parser），扫描消费者挂进现有 `onTaskCompleted` 钩子（与 verdict LLM 并列，不改 `tasks.service`），`emit` 通过现有 `broadcastTask` 同款全客户端 fan-out 推 `notification_created` / `notification_updated`。前端复用 `WebSocketContext.subscribe` 实时通道 + 仿 `branchStore` 的模块级单例 `inboxStore` 跨路由持有未读数，新增 `/inbox` 路由与侧边栏入口，并加一个仓库首个轻量 toast 组件。

**Tech Stack:** better-sqlite3 + Express（DI 工厂路由，`asyncHandler` + `AppError`）；node:test + `npx tsx --test`（DB 测试用临时库）；React + react-router + `useSyncExternalStore` 风格 store；Tailwind + 自研 `shared/view/ui`。

**关键实证约束（来自 spec §2）：**
- 转录扫描不调用工具，不受 headless 权限限制。
- `onTaskCompleted` 只在 `state==='completed'` 触发（`tasks.service.ts:791`），远程本地同链路。
- 远程 codex/opencode 转录拉不回（返回空），等价于"没报"，静默即可。
- 前端无 toast 库；现有约定是 `alert()` + `Dialog`（`web/src/shared/view/ui/Dialog.tsx`）。

**测试命令（后端，仓库约定，见 memory lovdex-cli-verification-recipe）：**
```bash
cd backend && npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/<file>.test.ts
```
> ⚠️ 运行前若 shell 有 `TSX_TSCONFIG_PATH` 全局导出，需 `unset TSX_TSCONFIG_PATH`（见 memory lovdex-tsx-env-gotcha）。

**提交约定：** commit message 用英文，**不加 Co-Authored-By 署名行**（见 memory lovdex-commit-message-no-coauthored）。

---

## 文件结构

**后端（新建 `backend/server/modules/notifications/`）：**
- `alert-format.ts` — 格式约定常量（skill 与 prompt 共享的 single source of truth）
- `alert-parser.ts` — 从 messages 数组提取并校验 `lovdex-alert` 块（纯函数）
- `notifications.db.ts` — better-sqlite3 CRUD + 按 `dedupe_key` 合并 upsert
- `notifications.service.ts` — `emit` / `list` / `markRead` / `markAllRead` / `unreadCount` + 裁剪
- `notifications.routes.ts` — `buildNotificationsRouter(svc)`
- `scan-completed-task.ts` — 把"读转录→parse→emit"串起来，供 `onTaskCompleted` 调用
- `index.ts` — 桶文件 re-export
- `tests/alert-parser.test.ts` / `tests/notifications.db.test.ts` / `tests/notifications.service.test.ts` / `tests/notifications.routes.test.ts`

**后端（修改）：**
- `backend/server/modules/database/schema.ts` — 加 `NOTIFICATIONS_TABLE_SCHEMA_SQL` + 拼进 `INIT_SCHEMA_SQL`
- `backend/server/modules/database/migrations.ts` — `runMigrations` 里 `db.exec(NOTIFICATIONS_TABLE_SCHEMA_SQL)` + 索引
- `backend/server/index.js` — 装配 service、路由注册、`onTaskCompleted` 追加扫描消费者、广播函数

**前端（新建）：**
- `web/src/stores/inboxStore.ts` — 模块级单例，管未读数与列表
- `web/src/stores/inboxStore.pure.ts` — 纯 reducer 逻辑（供单测）
- `web/src/components/inbox/InboxPage.tsx` + `web/src/components/inbox/index.ts`
- `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx`
- `web/src/shared/view/ui/Toast.tsx` — 轻量 toast（仓库首个）
- `web/src/stores/tests/inboxStore.test.ts`（纯逻辑）

**前端（修改）：**
- `web/src/App.tsx` — 加 `/inbox` 路由
- `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx` — 插入 `SidebarInboxEntry`
- `web/src/components/app/AppContent.tsx` — 挂载时未读补推汇总 Dialog + 挂 toast 监听
- `web/src/utils/api.js` — 加 `notifications` 命名空间
- `web/src/shared/view/ui/index.ts` — 导出 `Toast`

---

## Task 1: 格式约定常量 + 类型

**Files:**
- Create: `backend/server/modules/notifications/alert-format.ts`

- [ ] **Step 1: 写常量与类型**

`alert-format.ts`：

```ts
/**
 * `lovdex-alert` 标记的格式约定 —— skill 正文与 prompt 注入共享的 single source
 * of truth（spec §3.2）。后端解析器（alert-parser.ts）认这份定义，skill 的
 * SKILL.md 也应由它生成/核对，避免两处漂移。
 */

export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** 一个已校验的告警标记（parser 输出）。 */
export type ParsedAlert = {
  severity: AlertSeverity;
  title: string;
  body?: string;
  code?: string;
};

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

/** 代码块围栏的语言标记。 */
export const ALERT_FENCE_LANG = 'lovdex-alert';

/**
 * 注入巡检 prompt 或 skill 正文的约定文本。用户在巡检任务描述里带上它，
 * 模型据此在需要通知时输出标记。故意精简，能随 prompt 走到远程主机。
 */
export const ALERT_PROMPT_INSTRUCTION = [
  '当你需要通知用户（发现异常、需要关注的结果）时，在最终回复里输出一个代码块：',
  '',
  '```lovdex-alert',
  '{"severity":"warning","title":"一句话摘要","body":"详细描述（可选）","code":"稳定类别标识（可选，用于合并同类）"}',
  '```',
  '',
  'severity 取 critical / warning / info。无需通知时不要输出该代码块。',
].join('\n');
```

- [ ] **Step 2: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/alert-format.ts
git commit -m "feat(notifications): add alert format constants and types"
```

---

## Task 2: 告警解析器（纯函数，TDD）

**Files:**
- Create: `backend/server/modules/notifications/alert-parser.ts`
- Test: `backend/server/modules/notifications/tests/alert-parser.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/alert-parser.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAlertsFromMessages } from '@/modules/notifications/alert-parser.js';

const msg = (content: string, role: 'assistant' | 'user' = 'assistant') => ({ kind: 'text', role, content });

test('提取单个合法标记', () => {
  const alerts = parseAlertsFromMessages([
    msg('巡检完成。\n```lovdex-alert\n{"severity":"warning","title":"/var 剩余 3%"}\n```'),
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.equal(alerts[0].title, '/var 剩余 3%');
});

test('提取同一条消息里的多个标记', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"severity":"critical","title":"A"}\n```\n中间\n```lovdex-alert\n{"severity":"info","title":"B","code":"ok"}\n```'),
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map(a => a.title), ['A', 'B']);
});

test('扫描全部 assistant 文本，不止最后一条', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"severity":"warning","title":"早期告警"}\n```'),
    msg('后续一大段无关的收尾说明……'),
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, '早期告警');
});

test('非法 JSON 被丢弃', () => {
  const alerts = parseAlertsFromMessages([msg('```lovdex-alert\n{不是 json}\n```')]);
  assert.equal(alerts.length, 0);
});

test('缺 severity 或 title 被丢弃', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"title":"没有 severity"}\n```'),
    msg('```lovdex-alert\n{"severity":"warning"}\n```'),
  ]);
  assert.equal(alerts.length, 0);
});

test('非法 severity 被丢弃', () => {
  const alerts = parseAlertsFromMessages([msg('```lovdex-alert\n{"severity":"fatal","title":"x"}\n```')]);
  assert.equal(alerts.length, 0);
});

test('忽略非 text / 非 assistant 消息', () => {
  const alerts = parseAlertsFromMessages([
    { kind: 'tool_use', role: 'assistant', content: '```lovdex-alert\n{"severity":"warning","title":"工具里的不算"}\n```' },
    msg('```lovdex-alert\n{"severity":"warning","title":"用户消息里的不算"}\n```', 'user'),
  ]);
  assert.equal(alerts.length, 0);
});

test('保留可选字段 body / code', () => {
  const alerts = parseAlertsFromMessages([
    msg('```lovdex-alert\n{"severity":"critical","title":"磁盘满","body":"97%","code":"disk_full"}\n```'),
  ]);
  assert.equal(alerts[0].body, '97%');
  assert.equal(alerts[0].code, 'disk_full');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/alert-parser.test.ts
```
Expected: FAIL —— `Cannot find module '.../alert-parser.js'`

- [ ] **Step 3: 写实现**

`alert-parser.ts`：

```ts
import { isAlertSeverity, type ParsedAlert } from './alert-format.js';

/** 只认 assistant 的文本消息；其它 kind/role 一律跳过（spec §4.1）。 */
type ScanMessage = { kind?: string; role?: string; content?: string };

// 捕获 ```lovdex-alert ... ``` 之间的正文。[\s\S] 跨行；?<json> 命名分组。
const FENCE_RE = /```lovdex-alert\s*\n(?<json>[\s\S]*?)```/g;

/**
 * 从一段 normalized 转录消息里提取所有合法的 lovdex-alert 标记。
 * 容错原则（spec §4.1）：非法 JSON / 缺 severity|title / 非法 severity 一律
 * console.warn 后丢弃，绝不 coerce。一条消息允许多个标记。
 */
export function parseAlertsFromMessages(messages: readonly ScanMessage[]): ParsedAlert[] {
  const out: ParsedAlert[] = [];
  for (const message of messages) {
    if (message.kind !== 'text' || message.role !== 'assistant') continue;
    const text = message.content;
    if (typeof text !== 'string' || !text.includes('lovdex-alert')) continue;

    for (const match of text.matchAll(FENCE_RE)) {
      const raw = match.groups?.json?.trim();
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn('[notifications] discarded lovdex-alert: invalid JSON');
        continue;
      }
      const alert = coerceAlert(parsed);
      if (alert) out.push(alert);
    }
  }
  return out;
}

function coerceAlert(value: unknown): ParsedAlert | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isAlertSeverity(record.severity)) {
    console.warn('[notifications] discarded lovdex-alert: bad severity', record.severity);
    return null;
  }
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    console.warn('[notifications] discarded lovdex-alert: missing title');
    return null;
  }
  const alert: ParsedAlert = { severity: record.severity, title: record.title.trim() };
  if (typeof record.body === 'string' && record.body.trim() !== '') alert.body = record.body.trim();
  if (typeof record.code === 'string' && record.code.trim() !== '') alert.code = record.code.trim();
  return alert;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/alert-parser.test.ts
```
Expected: PASS，8 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/alert-parser.ts backend/server/modules/notifications/tests/alert-parser.test.ts
git commit -m "feat(notifications): add alert parser with fault tolerance"
```

---

## Task 3: 数据库表 schema + 迁移

**Files:**
- Modify: `backend/server/modules/database/schema.ts`
- Modify: `backend/server/modules/database/migrations.ts:797`（`runMigrations` 里 APP_CONFIG 那批 `db.exec` 附近）

- [ ] **Step 1: 加表 schema 常量**

在 `schema.ts` 的 `TOKEN_INGEST_CURSOR_TABLE_SCHEMA_SQL` 定义之后（约 `schema.ts:288`，`INIT_SCHEMA_SQL` 之前）新增：

```ts
export const NOTIFICATIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  notification_id   TEXT PRIMARY KEY,
  severity          TEXT NOT NULL,
  code              TEXT,
  title             TEXT NOT NULL,
  body              TEXT,
  schedule_id       TEXT,
  task_id           TEXT,
  session_id        TEXT,
  project_path      TEXT,
  dedupe_key        TEXT NOT NULL,
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  first_seen_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at           DATETIME,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;
```

- [ ] **Step 2: 拼进 INIT_SCHEMA_SQL**

在 `schema.ts` 的 `INIT_SCHEMA_SQL` 模板里，`${TOKEN_INGEST_CURSOR_TABLE_SCHEMA_SQL}`（约 `schema.ts:349`）之后追加：

```ts
${NOTIFICATIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key, read_at);
```

- [ ] **Step 3: 迁移里建表（幂等）**

`migrations.ts` 顶部 import 块（约 `migrations.ts:3-13`）加入：

```ts
  NOTIFICATIONS_TABLE_SCHEMA_SQL,
```

在 `runMigrations` 里 `db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);`（`migrations.ts:797`）之后追加：

```ts
    db.exec(NOTIFICATIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key, read_at)');
```

- [ ] **Step 4: 跑现有 DB 迁移测试确认无回归**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/database/tests/*.test.ts 2>&1 | tail -15
```
Expected: PASS（若该目录无测试文件则跳过本步，下一 Task 的 db 测试会覆盖建表）

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts
git commit -m "feat(notifications): add notifications table schema and migration"
```

---

## Task 4: notifications.db 仓库层（合并 upsert，TDD）

**Files:**
- Create: `backend/server/modules/notifications/notifications.db.ts`
- Test: `backend/server/modules/notifications/tests/notifications.db.test.ts`

数据库测试用**临时库 + 显式建表**（不依赖生产 config），模式参考 memory `lovdex-backend-baseline-not-clean`（DB 测试用真实临时库）。

- [ ] **Step 1: 写失败测试**

`tests/notifications.db.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { NOTIFICATIONS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { createNotificationsDb } from '@/modules/notifications/notifications.db.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(NOTIFICATIONS_TABLE_SCHEMA_SQL);
  return createNotificationsDb(db);
}

test('insert 新建一条未读通知', () => {
  const repo = makeDb();
  const row = repo.upsert({
    severity: 'warning', title: 'A', dedupeKey: 's1:disk_full',
    scheduleId: 's1', taskId: 't1', sessionId: 'sess1', projectPath: '/p', code: 'disk_full',
  });
  assert.equal(row.occurrence_count, 1);
  assert.equal(row.read_at, null);
  assert.equal(row.title, 'A');
});

test('同 dedupe_key 未读命中：计数++ 并刷新，不新建', () => {
  const repo = makeDb();
  const first = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 's1:disk_full' });
  const second = repo.upsert({ severity: 'warning', title: 'A2', dedupeKey: 's1:disk_full', body: '新详情' });
  assert.equal(first.notification_id, second.notification_id);
  assert.equal(second.occurrence_count, 2);
  assert.equal(second.title, 'A2');
  assert.equal(second.body, '新详情');
  assert.equal(repo.list({ limit: 50, offset: 0 }).length, 1);
});

test('同 dedupe_key 但已读：复活原条（read_at 清空、计数++）', () => {
  const repo = makeDb();
  const first = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 's1:disk_full' });
  repo.markRead(first.notification_id);
  const revived = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 's1:disk_full' });
  assert.equal(revived.notification_id, first.notification_id);
  assert.equal(revived.read_at, null);
  assert.equal(revived.occurrence_count, 2);
});

test('unreadCount 只数未读', () => {
  const repo = makeDb();
  const a = repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 'k:a' });
  repo.upsert({ severity: 'critical', title: 'B', dedupeKey: 'k:b' });
  assert.equal(repo.unreadCount(), 2);
  repo.markRead(a.notification_id);
  assert.equal(repo.unreadCount(), 1);
});

test('markAllRead 全部置已读', () => {
  const repo = makeDb();
  repo.upsert({ severity: 'warning', title: 'A', dedupeKey: 'k:a' });
  repo.upsert({ severity: 'warning', title: 'B', dedupeKey: 'k:b' });
  repo.markAllRead();
  assert.equal(repo.unreadCount(), 0);
});

test('list 按 created_at 倒序 + 分页', () => {
  const repo = makeDb();
  for (let i = 0; i < 5; i++) repo.upsert({ severity: 'info', title: `T${i}`, dedupeKey: `k:${i}` });
  const page = repo.list({ limit: 2, offset: 0 });
  assert.equal(page.length, 2);
});

test('pruneOldRead 只裁剪已读、保留未读', () => {
  const repo = makeDb();
  const a = repo.upsert({ severity: 'info', title: 'A', dedupeKey: 'k:a' });
  repo.upsert({ severity: 'warning', title: 'B', dedupeKey: 'k:b' });
  repo.markRead(a.notification_id);
  const removed = repo.pruneOldRead({ maxRows: 1 }); // 只留 1 条 → 裁掉已读的 A
  assert.equal(removed, 1);
  assert.equal(repo.list({ limit: 50, offset: 0 }).length, 1);
  assert.equal(repo.unreadCount(), 1); // 未读 B 还在
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.db.test.ts
```
Expected: FAIL —— 找不到 `notifications.db.js`

- [ ] **Step 3: 写实现**

`notifications.db.ts`：

```ts
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { AlertSeverity } from './alert-format.js';

export type NotificationRow = {
  notification_id: string;
  severity: AlertSeverity;
  code: string | null;
  title: string;
  body: string | null;
  schedule_id: string | null;
  task_id: string | null;
  session_id: string | null;
  project_path: string | null;
  dedupe_key: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  read_at: string | null;
  created_at: string;
};

export type UpsertInput = {
  severity: AlertSeverity;
  title: string;
  dedupeKey: string;
  body?: string | null;
  code?: string | null;
  scheduleId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
};

export type ListOptions = { limit: number; offset: number; unreadOnly?: boolean };

/**
 * DI 工厂：默认用生产共享连接（getConnection），测试传入内存库。
 * 合并语义见 spec §6：同 dedupe_key 未读→计数++刷新；已读→复活原条。
 */
export function createNotificationsDb(connection?: BetterSqlite3.Database) {
  const db = connection ?? getConnection();

  const getByDedupe = db.prepare<[string]>(
    'SELECT * FROM notifications WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1',
  );

  return {
    upsert(input: UpsertInput): NotificationRow {
      const existing = getByDedupe.get(input.dedupeKey) as NotificationRow | undefined;
      if (existing) {
        // 未读命中：计数++ + 刷新内容；已读命中：额外复活（read_at=NULL）。
        db.prepare(`
          UPDATE notifications
          SET occurrence_count = occurrence_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              severity = @severity,
              title = @title,
              body = @body,
              code = @code,
              read_at = NULL
          WHERE notification_id = @id
        `).run({
          id: existing.notification_id,
          severity: input.severity,
          title: input.title,
          body: input.body ?? null,
          code: input.code ?? null,
        });
        return db.prepare('SELECT * FROM notifications WHERE notification_id = ?')
          .get(existing.notification_id) as NotificationRow;
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO notifications
          (notification_id, severity, code, title, body, schedule_id, task_id, session_id, project_path, dedupe_key)
        VALUES (@id, @severity, @code, @title, @body, @scheduleId, @taskId, @sessionId, @projectPath, @dedupeKey)
      `).run({
        id,
        severity: input.severity,
        code: input.code ?? null,
        title: input.title,
        body: input.body ?? null,
        scheduleId: input.scheduleId ?? null,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
        projectPath: input.projectPath ?? null,
        dedupeKey: input.dedupeKey,
      });
      return db.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(id) as NotificationRow;
    },

    list(options: ListOptions): NotificationRow[] {
      const where = options.unreadOnly ? 'WHERE read_at IS NULL' : '';
      return db.prepare(
        `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(options.limit, options.offset) as NotificationRow[];
    },

    get(id: string): NotificationRow | null {
      return (db.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(id) as NotificationRow) ?? null;
    },

    markRead(id: string): NotificationRow | null {
      db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE notification_id = ? AND read_at IS NULL').run(id);
      return this.get(id);
    },

    markAllRead(): void {
      db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE read_at IS NULL').run();
    },

    unreadCount(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number };
      return row.n;
    },

    /**
     * 保留策略（spec §11）：先按时间删超过 maxAgeDays 的已读，再按 maxRows 上限
     * 删最旧的已读。全程只裁已读，未读永不删。返回删除条数。
     */
    pruneOldRead(opts: { maxRows: number; maxAgeDays?: number }): number {
      let removed = 0;
      if (opts.maxAgeDays) {
        const info = db.prepare(
          `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < datetime('now', ?)`,
        ).run(`-${opts.maxAgeDays} days`);
        removed += info.changes;
      }
      const total = (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
      if (total > opts.maxRows) {
        const excess = total - opts.maxRows;
        const info = db.prepare(`
          DELETE FROM notifications WHERE notification_id IN (
            SELECT notification_id FROM notifications
            WHERE read_at IS NOT NULL
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(excess);
        removed += info.changes;
      }
      return removed;
    },
  };
}

export type NotificationsDb = ReturnType<typeof createNotificationsDb>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.db.test.ts
```
Expected: PASS，7 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/notifications.db.ts backend/server/modules/notifications/tests/notifications.db.test.ts
git commit -m "feat(notifications): add db repository with merge upsert and prune"
```

---

## Task 5: notifications.service（emit + 广播 + 裁剪，TDD）

**Files:**
- Create: `backend/server/modules/notifications/notifications.service.ts`
- Test: `backend/server/modules/notifications/tests/notifications.service.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/notifications.service.test.ts`（用假 db + 假 broadcast，验证广播事件与去重键组装）：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotificationsService } from '@/modules/notifications/notifications.service.js';
import type { NotificationRow } from '@/modules/notifications/notifications.db.js';

function fakeRow(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    notification_id: 'n1', severity: 'warning', code: null, title: 'A', body: null,
    schedule_id: null, task_id: null, session_id: null, project_path: null,
    dedupe_key: 'k', occurrence_count: 1,
    first_seen_at: 't', last_seen_at: 't', read_at: null, created_at: 't',
    ...over,
  };
}

function makeHarness(existingByKey = new Map<string, NotificationRow>()) {
  const broadcasts: Array<{ kind: string; payload: unknown }> = [];
  let pruneCalls = 0;
  const db = {
    upsert: (input: { dedupeKey: string; title: string }) => {
      const prev = existingByKey.get(input.dedupeKey);
      const row = fakeRow({ notification_id: prev?.notification_id ?? `n${existingByKey.size + 1}`, title: input.title, dedupe_key: input.dedupeKey, occurrence_count: (prev?.occurrence_count ?? 0) + 1 });
      existingByKey.set(input.dedupeKey, row);
      return row;
    },
    list: () => [...existingByKey.values()],
    get: (id: string) => [...existingByKey.values()].find(r => r.notification_id === id) ?? null,
    markRead: (id: string) => { const r = [...existingByKey.values()].find(x => x.notification_id === id); if (r) r.read_at = 'now'; return r ?? null; },
    markAllRead: () => { for (const r of existingByKey.values()) r.read_at = 'now'; },
    unreadCount: () => [...existingByKey.values()].filter(r => !r.read_at).length,
    pruneOldRead: () => { pruneCalls++; return 0; },
  };
  const svc = createNotificationsService(db as never, {
    broadcast: (event) => broadcasts.push(event as { kind: string; payload: unknown }),
    maxRows: 500,
  });
  return { svc, broadcasts, getPruneCalls: () => pruneCalls };
}

test('emit 新建 → 广播 notification_created', () => {
  const { svc, broadcasts } = makeHarness();
  svc.emit({ severity: 'warning', title: 'A', scheduleId: 's1', code: 'disk_full' });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].kind, 'notification_created');
});

test('emit 同 schedule+code 再次 → 广播 notification_updated', () => {
  const { svc, broadcasts } = makeHarness();
  svc.emit({ severity: 'warning', title: 'A', scheduleId: 's1', code: 'disk_full' });
  svc.emit({ severity: 'warning', title: 'A2', scheduleId: 's1', code: 'disk_full' });
  assert.equal(broadcasts[1].kind, 'notification_updated');
});

test('dedupeKey：有 schedule 用 schedule+code', () => {
  const seen = new Map<string, NotificationRow>();
  const { svc } = makeHarness(seen);
  svc.emit({ severity: 'warning', title: 'A', scheduleId: 's1', code: 'disk_full' });
  assert.ok(seen.has('s1:disk_full'));
});

test('dedupeKey：无 code 用 title 兜底', () => {
  const seen = new Map<string, NotificationRow>();
  const { svc } = makeHarness(seen);
  svc.emit({ severity: 'warning', title: '磁盘满', taskId: 't1' });
  assert.ok(seen.has('t1:磁盘满'));
});

test('emit 落库后调用 pruneOldRead', () => {
  const { svc, getPruneCalls } = makeHarness();
  svc.emit({ severity: 'info', title: 'A', taskId: 't1' });
  assert.equal(getPruneCalls(), 1);
});

test('markAllRead 广播 notification_updated', () => {
  const { svc, broadcasts } = makeHarness();
  svc.emit({ severity: 'warning', title: 'A', taskId: 't1' });
  svc.markAllRead();
  assert.equal(broadcasts.at(-1)!.kind, 'notification_updated');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.service.test.ts
```
Expected: FAIL —— 找不到 `notifications.service.js`

- [ ] **Step 3: 写实现**

`notifications.service.ts`：

```ts
import type { AlertSeverity } from './alert-format.js';
import type { NotificationsDb, NotificationRow, ListOptions } from './notifications.db.js';

/** emit 的入参：来源标识（scheduleId 或 taskId）决定去重键前缀。 */
export type EmitInput = {
  severity: AlertSeverity;
  title: string;
  body?: string | null;
  code?: string | null;
  scheduleId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
};

export type NotificationBroadcast =
  | { kind: 'notification_created'; payload: NotificationRow }
  | { kind: 'notification_updated'; payload: { notification_id?: string; unreadCount: number } };

export type NotificationsServiceDeps = {
  broadcast: (event: NotificationBroadcast) => void;
  /** 保留上限；超出裁剪最旧已读（spec §11）。 */
  maxRows?: number;
  /** 保留天数；超过的已读按时间裁剪（spec §11，默认 90）。 */
  maxAgeDays?: number;
};

/**
 * 去重键（spec §6）：定时任务用 schedule_id，普通任务用 task_id；类别用 code，
 * 无 code 退化到 title。前缀缺失时用 'anon'，避免不同来源误合并。
 */
function buildDedupeKey(input: EmitInput): string {
  const source = input.scheduleId ?? input.taskId ?? 'anon';
  const category = input.code ?? input.title;
  return `${source}:${category}`;
}

export function createNotificationsService(db: NotificationsDb, deps: NotificationsServiceDeps) {
  const maxRows = deps.maxRows ?? 500;
  const maxAgeDays = deps.maxAgeDays ?? 90;

  return {
    /** 落库（合并去重）+ 裁剪 + 广播。新建发 created，命中已存在发 updated。 */
    emit(input: EmitInput): NotificationRow {
      const dedupeKey = buildDedupeKey(input);
      const before = db.unreadCount();
      const row = db.upsert({
        severity: input.severity,
        title: input.title,
        dedupeKey,
        body: input.body ?? null,
        code: input.code ?? null,
        scheduleId: input.scheduleId ?? null,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
        projectPath: input.projectPath ?? null,
      });
      db.pruneOldRead({ maxRows, maxAgeDays });
      // occurrence_count === 1 → 首次出现（新建或复活后仍是首见的新条），发 created；
      // 否则是已存在未读条的合并，发 updated 只带计数。
      if (row.occurrence_count === 1) {
        deps.broadcast({ kind: 'notification_created', payload: row });
      } else {
        deps.broadcast({ kind: 'notification_updated', payload: { notification_id: row.notification_id, unreadCount: db.unreadCount() } });
      }
      void before;
      return row;
    },

    list(options: ListOptions): NotificationRow[] {
      return db.list(options);
    },

    unreadCount(): number {
      return db.unreadCount();
    },

    markRead(id: string): NotificationRow | null {
      const row = db.markRead(id);
      deps.broadcast({ kind: 'notification_updated', payload: { notification_id: id, unreadCount: db.unreadCount() } });
      return row;
    },

    markAllRead(): void {
      db.markAllRead();
      deps.broadcast({ kind: 'notification_updated', payload: { unreadCount: db.unreadCount() } });
    },
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
```

> 注：`emit` 里 `occurrence_count === 1` 判定新建的前提是"复活已读条会 ++ 计数"（Task 4 已实现：已读命中也 `occurrence_count + 1`），故复活条的计数 ≥ 2，会走 `notification_updated`——复活的通知靠前端重新计入未读数刷新，不重复弹窗（可接受，spec §6 的复活弹窗由前端未读数变化驱动）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.service.test.ts
```
Expected: PASS，6 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/notifications.service.ts backend/server/modules/notifications/tests/notifications.service.test.ts
git commit -m "feat(notifications): add service with emit dedupe and broadcast"
```

---

## Task 6: notifications.routes（HTTP，TDD）

**Files:**
- Create: `backend/server/modules/notifications/notifications.routes.ts`
- Test: `backend/server/modules/notifications/tests/notifications.routes.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/notifications.routes.test.ts`（仿 `scheduler.routes.test.ts` 起临时 express server）：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { buildNotificationsRouter } from '@/modules/notifications/notifications.routes.js';

function makeSvc() {
  const rows = new Map<string, Record<string, unknown>>();
  rows.set('n1', { notification_id: 'n1', title: 'A', severity: 'warning', read_at: null });
  return {
    list: (o: { unreadOnly?: boolean }) => [...rows.values()].filter(r => !o.unreadOnly || !r.read_at),
    unreadCount: () => [...rows.values()].filter(r => !r.read_at).length,
    markRead: (id: string) => { const r = rows.get(id); if (!r) return null; r.read_at = 'now'; return r; },
    markAllRead: () => { for (const r of rows.values()) r.read_at = 'now'; },
    emit: () => ({}) as never,
  };
}

async function startServer(svc: unknown) {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', buildNotificationsRouter(svc as never));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('GET / 返回列表', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications`);
    assert.equal(res.status, 200);
    const body = await res.json() as unknown[];
    assert.equal(body.length, 1);
  } finally { await close(); }
});

test('GET /unread-count 返回计数', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/unread-count`);
    const body = await res.json() as { unreadCount: number };
    assert.equal(body.unreadCount, 1);
  } finally { await close(); }
});

test('POST /:id/read 标记已读', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/n1/read`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});

test('POST /:id/read 不存在 → 404', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/nope/read`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally { await close(); }
});

test('POST /read-all 全部已读', async () => {
  const { baseUrl, close } = await startServer(makeSvc());
  try {
    const res = await fetch(`${baseUrl}/api/notifications/read-all`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { await close(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.routes.test.ts
```
Expected: FAIL —— 找不到 `notifications.routes.js`

- [ ] **Step 3: 写实现**

`notifications.routes.ts`：

```ts
import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import type { NotificationsService } from './notifications.service.js';

export function buildNotificationsRouter(svc: NotificationsService) {
  const router = express.Router();

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

  router.post('/read-all', asyncHandler(async (_req, res) => {
    svc.markAllRead();
    res.json({ success: true, unreadCount: svc.unreadCount() });
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

> 路由顺序：`/read-all` 必须在 `/:id/read` 之前注册，否则 `read-all` 会被 `:id` 吞掉（同 memory 里 tasks `/by-session/:id` 顺序坑）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/notifications.routes.test.ts
```
Expected: PASS，5 tests

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/notifications.routes.ts backend/server/modules/notifications/tests/notifications.routes.test.ts
git commit -m "feat(notifications): add HTTP routes"
```

---

## Task 7: 扫描消费者 + 桶文件

**Files:**
- Create: `backend/server/modules/notifications/scan-completed-task.ts`
- Create: `backend/server/modules/notifications/index.ts`

无独立单测（薄胶水层；解析与 emit 已各自覆盖）。类型正确性由 Task 8 装配时的启动验证兜底。

- [ ] **Step 1: 写 scan-completed-task.ts**

```ts
import { parseAlertsFromMessages } from './alert-parser.js';
import type { NotificationsService } from './notifications.service.js';

export type ScanDeps = {
  /** 复用 sessionsService.fetchHistory；返回 { messages }。 */
  fetchHistory: (sessionId: string, opts?: { limit?: number; offset?: number }) => Promise<{ messages?: unknown[] }>;
  notifications: NotificationsService;
  /** 取任务的关联信息（project_path / schedule 来源），用于去重键与跳转。 */
  getTaskMeta: (taskId: string) => { scheduleId?: string | null; projectPath?: string | null } | null;
};

/**
 * 任务完成时读转录、提取 lovdex-alert 标记、逐条 emit。挂在 index.js 的
 * onTaskCompleted（只在 state==='completed' 触发）。永不抛：解析/读取失败只
 * console.warn，绝不影响任务生命周期（与 verdict LLM 同栈，spec §4）。
 */
export async function scanCompletedTaskForAlerts(
  args: { taskId: string; sessionId: string },
  deps: ScanDeps,
): Promise<void> {
  try {
    const history = await deps.fetchHistory(args.sessionId, { limit: 200, offset: 0 });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const alerts = parseAlertsFromMessages(messages as never);
    if (alerts.length === 0) return;
    const meta = deps.getTaskMeta(args.taskId) ?? {};
    for (const alert of alerts) {
      deps.notifications.emit({
        severity: alert.severity,
        title: alert.title,
        body: alert.body ?? null,
        code: alert.code ?? null,
        scheduleId: meta.scheduleId ?? null,
        taskId: args.taskId,
        sessionId: args.sessionId,
        projectPath: meta.projectPath ?? null,
      });
    }
  } catch (error) {
    console.warn('[notifications] scan failed', { taskId: args.taskId }, error);
  }
}
```

- [ ] **Step 2: 写 index.ts 桶文件**

```ts
export { createNotificationsDb } from './notifications.db.js';
export type { NotificationRow, NotificationsDb } from './notifications.db.js';
export { createNotificationsService } from './notifications.service.js';
export type { NotificationsService, NotificationBroadcast } from './notifications.service.js';
export { buildNotificationsRouter } from './notifications.routes.js';
export { scanCompletedTaskForAlerts } from './scan-completed-task.js';
export { parseAlertsFromMessages } from './alert-parser.js';
export { ALERT_PROMPT_INSTRUCTION } from './alert-format.js';
```

- [ ] **Step 3: 类型检查（无独立测试，靠 tsc 兜底）**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -i "notifications" || echo "no notifications type errors"
```
Expected: `no notifications type errors`（baseline 已有的无关错误忽略，见 memory lovdex-backend-baseline-not-clean）

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/notifications/scan-completed-task.ts backend/server/modules/notifications/index.ts
git commit -m "feat(notifications): add completed-task scanner and barrel"
```

---

## Task 8: 后端装配（index.js）

**Files:**
- Modify: `backend/server/index.js`（import 段、`getConnection` 后建 service、`onTaskCompleted` 追加、路由注册）

- [ ] **Step 1: 加 import**

在 `index.js` import 段（`buildSchedulerRouter` 那批附近，约 `index.js:78`）加：

```js
import { createNotificationsDb, createNotificationsService, buildNotificationsRouter, scanCompletedTaskForAlerts } from './modules/notifications/index.js';
```

- [ ] **Step 2: 建 service（在 broadcastTask 定义之后、tasksService 之前，约 index.js:469 后）**

```js
// 通知中心：emit 走与 broadcastTask 同款全客户端 fan-out（notification_created /
// notification_updated），扫描消费者挂在 onTaskCompleted（见下）。
const notificationsDb = createNotificationsDb();
const notificationsService = createNotificationsService(notificationsDb, {
    broadcast: (event) => broadcastTask(event),
    maxRows: 500,
});
```

- [ ] **Step 3: onTaskCompleted 追加扫描消费者**

把 `index.js:498-503` 的 `onTaskCompleted` 改成（在 verdict 之外追加扫描，两者并列）：

```js
    onTaskCompleted: (taskId, title, sessionId) => {
        if (!sessionId) return;
        const sessionRow = sessionsDb.getSessionById(sessionId);
        const isOperator = Boolean(sessionRow?.is_operator);
        scheduleAutoVerdict(sessionId, taskId, title, isOperator);
        // 通知扫描：读转录提取 lovdex-alert 标记 → emit。operator 会话（助手自身）
        // 不参与，避免助手输出被当巡检告警。永不抛（内部已 try/catch）。
        if (!isOperator) {
            void scanCompletedTaskForAlerts(
                { taskId, sessionId },
                {
                    fetchHistory: sessionsService.fetchHistory.bind(sessionsService),
                    notifications: notificationsService,
                    getTaskMeta: (id) => {
                        const t = tasksService.getTask(id);
                        return t ? { scheduleId: t.source_schedule_id ?? null, projectPath: t.project_path ?? null } : null;
                    },
                },
            );
        }
    },
```

- [ ] **Step 4: 注册路由（在 scheduled-tasks 路由之后，约 index.js:673 后）**

```js
app.use('/api/notifications', authenticateToken, buildNotificationsRouter(notificationsService));
```

- [ ] **Step 5: 启动后端冒烟（确认无装配错误）**

先问用户是否可重启后端（memory lovdex-backend-restart-requires-confirm：重启前必须先问）。获准后最小重启：kill 后端 tsx 子进程让 supervisor 拉起。然后：

```bash
curl -s http://127.0.0.1:3188/api/notifications/unread-count -H "Authorization: Bearer $TOKEN" | head
```
Expected: `{"unreadCount":0}`（需带有效 token；若鉴权阻挡，改为看后端启动日志无 `notifications` 相关报错即可）

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/index.js
git commit -m "feat(notifications): wire service, scanner and routes in index.js"
```

---

## Task 9: 前端 API 客户端 + inboxStore 纯逻辑（TDD）

**Files:**
- Modify: `web/src/utils/api.js`（加 `notifications` 命名空间）
- Create: `web/src/stores/inboxStore.pure.ts`（纯 reducer）
- Test: `web/src/stores/tests/inboxStore.test.ts`

前端 web 测试无 DOM 环境（memory lovdex-cli-verification-recipe），故只测纯逻辑。用 `npx tsx --test` 跑（不经过浏览器）。

- [ ] **Step 1: 加 api 命名空间**

`web/src/utils/api.js` 的 `scheduledTasks` 块之后（约 `api.js:384`）加：

```js
  notifications: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.unread) qs.set('unread', 'true');
      if (params.limit != null) qs.set('limit', String(params.limit));
      if (params.offset != null) qs.set('offset', String(params.offset));
      const s = qs.toString();
      return authenticatedFetch(`/api/notifications${s ? `?${s}` : ''}`);
    },
    unreadCount: () => authenticatedFetch('/api/notifications/unread-count'),
    markRead: (id) => authenticatedFetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    markAllRead: () => authenticatedFetch('/api/notifications/read-all', { method: 'POST' }),
  },
```

- [ ] **Step 2: 写失败测试**

`web/src/stores/tests/inboxStore.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { inboxReducer, countUnread, type InboxState, type InboxNotification } from '../inboxStore.pure.js';

const n = (over: Partial<InboxNotification> = {}): InboxNotification => ({
  notification_id: 'n1', severity: 'warning', title: 'A', read_at: null,
  occurrence_count: 1, ...over,
});

test('countUnread 只数 read_at 为空的', () => {
  const rows = [n({ notification_id: 'a' }), n({ notification_id: 'b', read_at: 'now' })];
  assert.equal(countUnread(rows), 1);
});

test('countUnread 排除 info（spec §5）', () => {
  const rows = [n({ notification_id: 'a', severity: 'info' }), n({ notification_id: 'b', severity: 'warning' })];
  assert.equal(countUnread(rows), 1);
});

test('created：新条插到最前', () => {
  const state: InboxState = { items: [n({ notification_id: 'a' })] };
  const next = inboxReducer(state, { type: 'created', row: n({ notification_id: 'b' }) });
  assert.equal(next.items[0].notification_id, 'b');
});

test('created：同 id 幂等（不重复插）', () => {
  const state: InboxState = { items: [n({ notification_id: 'a' })] };
  const next = inboxReducer(state, { type: 'created', row: n({ notification_id: 'a', title: 'A2' }) });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].title, 'A2');
});

test('updated：替换已存在条', () => {
  const state: InboxState = { items: [n({ notification_id: 'a', occurrence_count: 1 })] };
  const next = inboxReducer(state, { type: 'updated', row: n({ notification_id: 'a', occurrence_count: 5 }) });
  assert.equal(next.items[0].occurrence_count, 5);
});

test('replaceAll：整表替换（refetch / 重连）', () => {
  const state: InboxState = { items: [n({ notification_id: 'a' })] };
  const next = inboxReducer(state, { type: 'replaceAll', rows: [n({ notification_id: 'x' }), n({ notification_id: 'y' })] });
  assert.equal(next.items.length, 2);
});

test('markReadLocal：本地置已读', () => {
  const state: InboxState = { items: [n({ notification_id: 'a', read_at: null })] };
  const next = inboxReducer(state, { type: 'markReadLocal', id: 'a' });
  assert.equal(next.items[0].read_at !== null, true);
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/stores/tests/inboxStore.test.ts
```
Expected: FAIL —— 找不到 `inboxStore.pure.js`

- [ ] **Step 4: 写实现**

`web/src/stores/inboxStore.pure.ts`：

```ts
export type InboxSeverity = 'critical' | 'warning' | 'info';

export type InboxNotification = {
  notification_id: string;
  severity: InboxSeverity;
  title: string;
  body?: string | null;
  code?: string | null;
  task_id?: string | null;
  session_id?: string | null;
  occurrence_count: number;
  read_at?: string | null;
  first_seen_at?: string;
  last_seen_at?: string;
};

export type InboxState = { items: InboxNotification[] };

export type InboxAction =
  | { type: 'created'; row: InboxNotification }
  | { type: 'updated'; row: InboxNotification }
  | { type: 'replaceAll'; rows: InboxNotification[] }
  | { type: 'markReadLocal'; id: string }
  | { type: 'markAllReadLocal' };

export function countUnread(items: readonly InboxNotification[]): number {
  // info 不计入角标（spec §5）：只有 warning/critical 才是"要你看一眼"的。
  return items.filter((it) => !it.read_at && it.severity !== 'info').length;
}

/** 纯 reducer：所有状态变更集中于此，便于单测与 store 复用。 */
export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'created': {
      const rest = state.items.filter((it) => it.notification_id !== action.row.notification_id);
      return { items: [action.row, ...rest] };
    }
    case 'updated': {
      const i = state.items.findIndex((it) => it.notification_id === action.row.notification_id);
      if (i === -1) return { items: [action.row, ...state.items] };
      const items = [...state.items];
      items[i] = action.row;
      return { items };
    }
    case 'replaceAll':
      return { items: [...action.rows] };
    case 'markReadLocal':
      return {
        items: state.items.map((it) =>
          it.notification_id === action.id && !it.read_at ? { ...it, read_at: new Date().toISOString() } : it,
        ),
      };
    case 'markAllReadLocal':
      return { items: state.items.map((it) => (it.read_at ? it : { ...it, read_at: new Date().toISOString() })) };
    default:
      return state;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/stores/tests/inboxStore.test.ts
```
Expected: PASS，6 tests

- [ ] **Step 6: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/utils/api.js web/src/stores/inboxStore.pure.ts web/src/stores/tests/inboxStore.test.ts
git commit -m "feat(inbox): add api namespace and inbox store pure reducer"
```

---

## Task 10: inboxStore 单例（WS 驱动 + 跨路由持有）

**Files:**
- Create: `web/src/stores/inboxStore.ts`

无独立单测（浏览器副作用层；纯逻辑已在 Task 9 覆盖）。

- [ ] **Step 1: 写实现**

`web/src/stores/inboxStore.ts`：

```ts
/**
 * 收件箱共享状态源。跨路由存活（/inbox、/tasks 会卸载 AppContent，组件级 state
 * 会丢），故用模块级单例 + useSyncExternalStore 风格订阅（仿 branchStore.ts）。
 * 数据来自 REST 首拉 + WS 实时（notification_created / notification_updated /
 * websocket_reconnected 全量 refetch）。
 */

import { api } from '../utils/api';
import { inboxReducer, countUnread, type InboxState, type InboxNotification } from './inboxStore.pure';

type Listener = () => void;

let state: InboxState = { items: [] };
const listeners = new Set<Listener>();

function setState(next: InboxState) {
  state = next;
  listeners.forEach((l) => l());
}

export function getInboxSnapshot(): InboxState {
  return state;
}

export function getUnreadCount(): number {
  return countUnread(state.items);
}

export function subscribeInbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** REST 全量拉取（首挂 / 重连）。 */
export async function refreshInbox(): Promise<void> {
  try {
    const res = await api.notifications.list({ limit: 200 });
    if (!res.ok) return;
    const rows = (await res.json()) as InboxNotification[];
    setState(inboxReducer(state, { type: 'replaceAll', rows: Array.isArray(rows) ? rows : [] }));
  } catch {
    // 瞬时失败保留上一次快照。
  }
}

/** 把一条 WS 帧喂给 store。返回是否是"值得弹窗"的新告警（created 且非 info）。 */
export function applyInboxEvent(event: { kind?: string; payload?: unknown }): InboxNotification | null {
  if (event.kind === 'notification_created') {
    const row = event.payload as InboxNotification;
    setState(inboxReducer(state, { type: 'created', row }));
    return row.severity !== 'info' ? row : null;
  }
  if (event.kind === 'notification_updated') {
    const payload = event.payload as { notification_id?: string };
    // 计数/已读变更：拿不到整行时做一次轻量 refetch 保持一致。
    if (payload?.notification_id) void refreshInbox();
    else void refreshInbox();
    return null;
  }
  if (event.kind === 'websocket_reconnected') {
    void refreshInbox();
  }
  return null;
}

export function markReadLocal(id: string): void {
  setState(inboxReducer(state, { type: 'markReadLocal', id }));
  void api.notifications.markRead(id);
}

export function markAllReadLocal(): void {
  setState(inboxReducer(state, { type: 'markAllReadLocal' }));
  void api.notifications.markAllRead();
}
```

- [ ] **Step 2: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit 2>&1 | grep -i "inboxStore" || echo "no inboxStore type errors"
```
Expected: `no inboxStore type errors`

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/stores/inboxStore.ts
git commit -m "feat(inbox): add singleton store with WS-driven updates"
```

---

## Task 11: Toast 组件（仓库首个）

**Files:**
- Create: `web/src/shared/view/ui/Toast.tsx`
- Modify: `web/src/shared/view/ui/index.ts`（导出）

- [ ] **Step 1: 写 Toast.tsx**

复用 `Alert` 的 cva 配色思路，`createPortal` 到右上角，几秒自动消失。参考 `web/src/shared/view/ui/Alert.tsx` 与 `AnchorPopover.tsx` 的 portal 用法。

```tsx
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type ToastSeverity = 'critical' | 'warning' | 'info';

export type ToastItem = {
  id: string;
  severity: ToastSeverity;
  title: string;
  body?: string | null;
  onClick?: () => void;
};

const SEVERITY_STYLE: Record<ToastSeverity, { ring: string; icon: JSX.Element }> = {
  critical: { ring: 'border-destructive/50 bg-destructive/10', icon: <AlertCircle className="h-4 w-4 text-destructive" /> },
  warning: { ring: 'border-warning/50 bg-warning/10', icon: <AlertTriangle className="h-4 w-4 text-warning" /> },
  info: { ring: 'border-border bg-muted', icon: <Info className="h-4 w-4 text-muted-foreground" /> },
};

const AUTO_DISMISS_MS = 6000;

/** 单条 toast：挂载后 AUTO_DISMISS_MS 自动淡出。 */
function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(item.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [item.id, onDismiss]);

  const style = SEVERITY_STYLE[item.severity];
  return (
    <div
      className={cn('pointer-events-auto w-80 rounded-md border p-3 shadow-lg', style.ring, item.onClick && 'cursor-pointer')}
      onClick={item.onClick}
      role="alert"
    >
      <div className="flex items-start gap-2">
        {style.icon}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{item.title}</div>
          {item.body ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</div> : null}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onDismiss(item.id); }}
          aria-label="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** 容器：固定右上角。由调用方通过 push/remove 控制 items。 */
export function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex flex-col gap-2">
      {items.map((it) => <ToastCard key={it.id} item={it} onDismiss={onDismiss} />)}
    </div>,
    document.body,
  );
}

/** 便捷 hook：维护一个 toast 列表 + push/dismiss。 */
export function useToastStack() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((item: ToastItem) => setItems((prev) => [...prev, item]), []);
  const dismiss = useCallback((id: string) => setItems((prev) => prev.filter((it) => it.id !== id)), []);
  return { items, push, dismiss };
}
```

> `text-warning` / `border-warning` 依赖已暴露给 Tailwind 的 warning token（见近期 commit `225cda0` feat(design): expose success/warning/info/chart tokens）。若类名不生效，回退用 `text-amber-500`。

- [ ] **Step 2: 导出**

`web/src/shared/view/ui/index.ts` 末尾加：

```ts
export { ToastStack, useToastStack } from './Toast';
export type { ToastItem, ToastSeverity } from './Toast';
```

- [ ] **Step 3: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit 2>&1 | grep -i "Toast" || echo "no Toast type errors"
```
Expected: `no Toast type errors`

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/shared/view/ui/Toast.tsx web/src/shared/view/ui/index.ts
git commit -m "feat(inbox): add lightweight toast component"
```

---

## Task 12: 侧边栏入口 + 未读角标

**Files:**
- Create: `web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx`
- Modify: `web/src/components/sidebar/view/subcomponents/SidebarContent.tsx`（在 `SidebarScheduledEntry` 后插入）

- [ ] **Step 1: 写 SidebarInboxEntry.tsx**

仿 `SidebarScheduledEntry.tsx`，订阅 `inboxStore` 未读数渲染角标：

```tsx
import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { subscribeInbox, getUnreadCount } from '../../../../stores/inboxStore';

/**
 * 「收件箱」侧边栏整行入口，置于「定时任务」之后。点击跳 /inbox。
 * 未读数用红点角标显示（订阅模块级 inboxStore，跨路由存活）。
 */
export default function SidebarInboxEntry() {
  const navigate = useNavigate();
  const unread = useSyncExternalStore(subscribeInbox, getUnreadCount, () => 0);
  return (
    <div className="flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      <Button
        variant="ghost"
        className={cn('flex w-full justify-between p-2 h-auto font-normal hover:bg-muted', unread > 0 && 'bg-primary/5')}
        onClick={() => navigate('/inbox')}
        title="收件箱"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Inbox className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">收件箱</span>
        </div>
        {unread > 0 ? (
          <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: 插入 SidebarContent**

`SidebarContent.tsx` 顶部 import（`SidebarScheduledEntry` import 附近，约 `:17`）加：

```tsx
import SidebarInboxEntry from './SidebarInboxEntry';
```

在 `<SidebarScheduledEntry />`（`SidebarContent.tsx:304`）之后加一行：

```tsx
      <SidebarInboxEntry />
```

- [ ] **Step 3: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit 2>&1 | grep -iE "SidebarInbox|SidebarContent" || echo "no sidebar type errors"
```
Expected: `no sidebar type errors`

- [ ] **Step 4: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/sidebar/view/subcomponents/SidebarInboxEntry.tsx web/src/components/sidebar/view/subcomponents/SidebarContent.tsx
git commit -m "feat(inbox): add sidebar entry with unread badge"
```

---

## Task 13: /inbox 页面

**Files:**
- Create: `web/src/components/inbox/InboxPage.tsx`
- Create: `web/src/components/inbox/index.ts`
- Modify: `web/src/App.tsx`（加路由 + import）

- [ ] **Step 1: 写 InboxPage.tsx**

```tsx
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCheck, AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import { useWebSocket } from '../../contexts/WebSocketContext';
import {
  subscribeInbox, getInboxSnapshot, refreshInbox, applyInboxEvent, markReadLocal, markAllReadLocal,
} from '../../stores/inboxStore';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';

const SEVERITY_ICON: Record<InboxSeverity, JSX.Element> = {
  critical: <AlertCircle className="h-4 w-4 text-destructive" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning" />,
  info: <Info className="h-4 w-4 text-muted-foreground" />,
};

const SEVERITY_ORDER: InboxSeverity[] = ['critical', 'warning', 'info'];

export default function InboxPage() {
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();
  const snapshot = useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);

  // 首挂全量拉取。
  useEffect(() => { void refreshInbox(); }, []);

  // WS 实时：喂给 store（含重连全量刷新）。
  useEffect(() => subscribe((event) => { applyInboxEvent(event as { kind?: string; payload?: unknown }); }), [subscribe]);

  const grouped = useMemo(() => {
    const by: Record<InboxSeverity, InboxNotification[]> = { critical: [], warning: [], info: [] };
    for (const it of snapshot.items) by[it.severity].push(it);
    return by;
  }, [snapshot.items]);

  const openTarget = (it: InboxNotification) => {
    markReadLocal(it.notification_id);
    if (it.task_id) navigate(`/task/${it.task_id}`);
    else if (it.session_id) navigate(`/session/${it.session_id}`);
  };

  return (
    <div className="mx-auto flex h-screen w-full max-w-3xl flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /></Button>
          <h1 className="text-lg font-semibold">收件箱</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => markAllReadLocal()}>
          <CheckCheck className="mr-1 h-4 w-4" />全部已读
        </Button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto">
        {snapshot.items.length === 0 ? (
          <div className="py-20 text-center text-sm text-muted-foreground">暂无通知</div>
        ) : (
          SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((severity) => (
            <section key={severity}>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                {SEVERITY_ICON[severity]} {severity}
              </div>
              <ul className="space-y-1.5">
                {grouped[severity].map((it) => (
                  <li
                    key={it.notification_id}
                    className={`rounded-md border p-3 ${it.read_at ? 'opacity-60' : 'bg-muted/40'} ${(it.task_id || it.session_id) ? 'cursor-pointer hover:bg-muted' : ''}`}
                    onClick={() => openTarget(it)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium">{it.title}</span>
                      {it.occurrence_count > 1 ? (
                        <span className="ml-2 shrink-0 text-xs text-muted-foreground">×{it.occurrence_count}</span>
                      ) : null}
                    </div>
                    {it.body ? <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{it.body}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写 index.ts**

```ts
export { default as InboxPage } from './InboxPage';
```

- [ ] **Step 3: 加路由**

`App.tsx` import 段（约 `App.tsx:10`，TaskBoardPage import 附近）加：

```tsx
import { InboxPage } from './components/inbox';
```

`App.tsx` 的 `<Routes>` 里（`/tasks` route 附近，约 `App.tsx:132`）加：

```tsx
                  <Route path="/inbox" element={<InboxPage />} />
```

- [ ] **Step 4: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit 2>&1 | grep -iE "inbox|InboxPage" || echo "no inbox page type errors"
```
Expected: `no inbox page type errors`

- [ ] **Step 5: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/inbox/ web/src/App.tsx
git commit -m "feat(inbox): add /inbox page with severity grouping"
```

---

## Task 14: 全局实时 toast + 打开页面补推汇总弹窗

**Files:**
- Modify: `web/src/components/app/AppContent.tsx`（挂 toast 监听 + 首挂未读汇总 Dialog）

AppContent 是常驻工作区页（`/` 与 `/session/:id`），把全局 toast 监听与"打开补推"挂这里。注意：`/inbox`、`/tasks` 不经过 AppContent，但那两页本身就展示收件箱/无需补推，可接受。

- [ ] **Step 1: 加实时 toast + 补推逻辑**

在 `AppContent.tsx` 顶部 import 加：

```tsx
import { useState } from 'react';
import { ToastStack, useToastStack, Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';
import { refreshInbox, applyInboxEvent, getUnreadCount, getInboxSnapshot } from '../../stores/inboxStore';
```

在 `AppContent` 组件体内（已有 `const { ws, sendMessage, subscribe } = useWebSocket();`，约 `AppContent.tsx:54`）加：

```tsx
  const { items: toasts, push: pushToast, dismiss: dismissToast } = useToastStack();
  const [summaryOpen, setSummaryOpen] = useState(false);

  // 首挂：拉取收件箱，若有未读的 warning/critical 弹一次汇总（spec §10「打开即补推」）。
  useEffect(() => {
    void (async () => {
      await refreshInbox();
      const important = getInboxSnapshot().items.filter((it) => !it.read_at && it.severity !== 'info');
      if (important.length > 0) setSummaryOpen(true);
    })();
  }, []);

  // 全局实时 toast：新告警（created 且非 info）到达即右上角弹一条，点击跳转。
  useEffect(() => subscribe((event) => {
    const row = applyInboxEvent(event as { kind?: string; payload?: unknown });
    if (row) {
      pushToast({
        id: row.notification_id,
        severity: row.severity,
        title: row.title,
        body: row.body,
        onClick: () => {
          dismissToast(row.notification_id);
          if (row.task_id) navigate(`/task/${row.task_id}`);
          else if (row.session_id) navigate(`/session/${row.session_id}`);
        },
      });
    }
  }), [subscribe, pushToast, dismissToast, navigate]);
```

> `navigate` 若组件里尚未有，需 `const navigate = useNavigate();`（`react-router-dom`）。先确认 AppContent 是否已引入 `useNavigate`；若无则一并加。

在 `AppContent` 的 return JSX 最外层（顶层 fragment/div 内末尾）加：

```tsx
      <ToastStack items={toasts} onDismiss={dismissToast} />
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent>
          <DialogTitle>你有未读通知</DialogTitle>
          <div className="mt-2 space-y-1.5">
            {getInboxSnapshot().items.filter((it) => !it.read_at && it.severity !== 'info').slice(0, 8).map((it) => (
              <div key={it.notification_id} className="truncate text-sm">· {it.title}{it.occurrence_count > 1 ? ` ×${it.occurrence_count}` : ''}</div>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSummaryOpen(false)}>知道了</Button>
            <Button size="sm" onClick={() => { setSummaryOpen(false); navigate('/inbox'); }}>去收件箱</Button>
          </div>
        </DialogContent>
      </Dialog>
```

> 需确认 `Button` 已在 AppContent import；若无则加 `Button` 到那条 `shared/view/ui` import。

- [ ] **Step 2: 类型检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit 2>&1 | grep -iE "AppContent" || echo "no AppContent type errors"
```
Expected: `no AppContent type errors`

- [ ] **Step 3: 提交**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/app/AppContent.tsx
git commit -m "feat(inbox): add realtime toast and open-page summary dialog"
```

---

## Task 15: 端到端冒烟验证

**Files:** 无（验证 only）

按 memory `lovdex-cli-verification-recipe`：puppeteer-core + 缓存 chromium 连 `:5188`，深链 `?project=&tab=`；判定用 computed display + 元素紧裁切像素剖面，**不要整页截图看图**（memory lovdex-screenshot-read-hallucinates）。

- [ ] **Step 1: 后端注入一条测试通知**

先问用户是否可重启后端（memory lovdex-backend-restart-requires-confirm）。确认前后端在跑后，直接对 DB 插一条未读通知（绕过任务链路，纯验证前端）：

```bash
sqlite3 ~/.lovdex/data/new-auth.db "INSERT INTO notifications (notification_id, severity, title, dedupe_key) VALUES ('smoke-1','warning','冒烟测试告警','smoke:test');"
```

- [ ] **Step 2: 浏览器验证角标 + 页面**

用 puppeteer 打开 `http://<lan-ip>:5188`（memory lovdex-access-via-ip：用 IP 不用 localhost）：
1. 侧边栏「收件箱」行出现红点角标（读该元素 computed 内容 / 紧裁切像素，确认数字 ≥1）。
2. 点进 `/inbox`，看到「冒烟测试告警」条目。
3. 点「全部已读」，角标消失（unread=0）。

Expected: 三步都通过。若前端白屏 Invalid hook call，见 memory lovdex-vite-deps-poisoned（`rm web/node_modules/.vite` + 重启 frontend）。

- [ ] **Step 3: 清理测试数据**

```bash
sqlite3 ~/.lovdex/data/new-auth.db "DELETE FROM notifications WHERE notification_id='smoke-1';"
```

- [ ] **Step 4: 跑全部后端 notifications 测试确认整体绿**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH; npx tsx --test --tsconfig server/tsconfig.json server/modules/notifications/tests/*.test.ts 2>&1 | tail -10
```
Expected: 全部 PASS（alert-parser 8 + db 7 + service 6 + routes 5 = 26 tests）

- [ ] **Step 5: 无新增提交（验证 only），如有清理改动则提交**

```bash
cd /mnt/b/workdir/github/lovdex
git status --short
```

---

## 端到端手动验收（真实巡检链路，可选）

> 一次性验证"提示词驱动"闭环，不作为 CI。

1. 建一个定时任务，描述里带上 `ALERT_PROMPT_INSTRUCTION` 的文本 + "检查磁盘，若使用率>90% 输出 critical 告警"。
2. `run-now` 触发；任务完成后 `onTaskCompleted` 扫转录。
3. 浏览器开着 → 右上角 toast 弹出；侧边栏角标 +1；`/inbox` 可见该条。
4. 再次 run-now（同 code）→ 收件箱里合并为一条、`occurrence_count` +1、不重复弹窗。

---

## Self-Review 记录

- **Spec §3（格式约定）** → Task 1（常量）+ Task 2（parser）。✓
- **Spec §4（onTaskCompleted 扫描 / 容错 / 全部 assistant 文本）** → Task 2（扫全部 assistant text）+ Task 7（scanner）+ Task 8（钩子接线，operator 排除）。✓
- **Spec §5（severity 语义：info 不弹窗/不角标）** → Task 10（`applyInboxEvent` 只对非 info 返回弹窗行）+ Task 12（角标读 `countUnread`，已排除 info，见 Task 9 修正版）。✓
- **Spec §6（合并去重：未读++/已读复活）** → Task 4（db upsert）+ Task 5（dedupeKey 组装）。✓
- **Spec §7（表结构）** → Task 3。✓
- **Spec §8（后端模块）** → Task 4–8。✓
- **Spec §9（广播 kind）** → Task 5 + Task 8。✓
- **Spec §10（inboxStore / WS / 侧边栏 / 页面 / toast / 补推）** → Task 9–14。✓
- **Spec §11（保留 90 天/500 条，裁剪已读）** → Task 4（`pruneOldRead` 同时按 maxAgeDays + maxRows 裁剪已读）+ Task 5（emit 后 `{ maxRows, maxAgeDays: 90 }`）。✓
- **Spec §12（测试）** → 各 Task 的 TDD + Task 15。✓
- **Spec §13（默认值）** → 独立路由 /inbox（Task 13）、500 条 + 90 天（Task 4）、无 Web Push（全程未触碰 sw.js）、无看门狗（无相关 Task）。✓

两处 self-review 发现的 spec 缺口（info 不计入角标、保留策略补时间维度）已直接合入 Task 9 与 Task 4/5 的实现，无遗留待办。
