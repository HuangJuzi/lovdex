# 常用语（快速回复）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话聊天输入框的工具栏加一个「常用语」入口，点一下就把它填进输入框，并且能在弹出的浮层里增删改这些常用语。

**Architecture:** 后端新增一张 `quick_replies` 表和一个 notifications 形状的模块（db DI 工厂 → service 校验 → express router），挂在 `/api/quick-replies`。前端加一个 `useQuickReplies` hook 持有列表与写操作、一个 `QuickRepliesMenu` 紧凑行列表浮层（内联编辑，不弹 Dialog）、一个纯函数 `buildQuickReplyInput` 负责「空则填入、非空追加」。浮层由 `ChatComposer` 工具栏的一个 ⚡ 按钮唤出。

**Tech Stack:** TypeScript / better-sqlite3（裸 SQL，无 ORM）/ Express / React 18 + Tailwind / lucide-react / `node:test`（两边都无 `test` npm script，显式跑文件）。

**Spec:** `docs/superpowers/specs/2026-09-28-quick-replies-design.md`

---

## 两处对 spec 的修正（实现时以本计划为准，原因见下）

1. **接口返回 snake_case，不是 spec 写的 camelCase。**
   spec §4 写的是 camelCase 的 `QuickReply`（`quickReplyId` / `lastUsedAt`）。但仓库里同类小表 API 的实际约定是**直接透出 snake_case 行**：`notifications` 路由把 `NotificationsDb` 的行原样 `res.json`（`web/src/stores/inboxStore.pure.ts:4` 消费的就是 `notification_id`），`scheduled-tasks` 同样是 `schedule_id`（`web/src/types/app.ts:169`）。跟惯例走能省掉整层映射代码，前端写法也与 `inboxStore` 一致。因此线上形状是 `quick_reply_id` / `content` / `created_at` / `updated_at` / `last_used_at`。

2. **`buildQuickReplyInput` 对 `current` 两端做 `trim()`。**
   spec §5.5 写「非空则 `current + ' ' + content`」，但 §6 的测试要求「`current` 有尾随空格 → 不产生双空格」。两者矛盾，以 §6 为准：先 `trim()` 再拼接。副作用是用户草稿的首尾空白会被吞掉，可接受（拼接点本来就要求单词间隔）。

3. **提交粒度比 spec §7 更细。**
   spec 说的是两个提交（后端一、前端一）。本计划按 TDD 步进拆成 6 个（表 / 仓储 / 服务 / 路由挂载 / 前端纯函数与 API / 浮层 / 接线），因为每一步都是一个自洽的可回退单元，也和仓库现有提交粒度一致。若要严格合二为一，在 Task 9 验收通过后用 `git rebase -i` 压缩即可——**不建议**在验收前压，压完更难定位问题。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend/server/modules/database/schema.ts` | 修改 | 新增 `QUICK_REPLIES_TABLE_SCHEMA_SQL`，并拼进 `INIT_SCHEMA_SQL` |
| `backend/server/modules/database/migrations.ts` | 修改 | `runMigrations()` 里建表 + 建索引，保证存量库升级也有这张表 |
| `backend/server/modules/quick-replies/quick-replies.db.ts` | 创建 | `createQuickRepliesDb(connection?)` DI 工厂，裸 SQL |
| `backend/server/modules/quick-replies/quick-replies.service.ts` | 创建 | `createQuickRepliesService(db)`，空内容/重复内容校验 |
| `backend/server/modules/quick-replies/quick-replies.routes.ts` | 创建 | `buildQuickRepliesRouter(svc)` |
| `backend/server/modules/quick-replies/index.ts` | 创建 | 模块唯一公共出口（boundaries 约束） |
| `backend/server/index.js` | 修改 | import + 在 `startServer()` 内 `initializeDatabase()` 之后实例化并挂路由 |
| `backend/server/modules/quick-replies/tests/quick-replies.db.test.ts` | 创建 | 仓储层单测（`:memory:` + 直接 `db.exec(DDL)`） |
| `backend/server/modules/quick-replies/tests/quick-replies.service.test.ts` | 创建 | 校验规则单测 |
| `backend/server/modules/quick-replies/tests/quick-replies.routes.test.ts` | 创建 | HTTP 契约测试（真起 express） |
| `web/src/utils/api.js` | 修改 | 加 `api.quickReplies` 命名空间 |
| `web/src/components/chat/hooks/useQuickReplies.ts` | 创建 | 列表状态 + create/update/remove/markUsed |
| `web/src/components/chat/utils/quickReplyInsert.ts` | 创建 | 纯函数 `buildQuickReplyInput` |
| `web/src/components/chat/utils/quickReplyInsert.test.ts` | 创建 | 纯函数单测 |
| `web/src/components/chat/view/subcomponents/QuickRepliesMenu.tsx` | 创建 | 浮层：列表 / 内联编辑 / 删除 |
| `web/src/components/chat/view/subcomponents/ChatComposer.tsx` | 修改 | ⚡ 按钮 + 浮层接线 + 与斜杠菜单互斥 |
| `web/src/components/chat/hooks/useChatComposerState.ts` | 修改 | 挂 `useQuickReplies`，实现 `handleInsertQuickReply` |
| `web/src/components/chat/view/ChatInterface.tsx` | 修改 | 从 hook 解构并透传给 `ChatComposer` |
| `web/src/i18n/locales/en/chat.json` | 修改 | 加 `input.quickReplies` 文案 |

---

## 动手前：记录验收基线

两个仓库的 typecheck/lint baseline 都不干净（后端做过记录约有 11 个 tsc 错误），验收标准是**零新增**，不是零错误。开始前先跑一遍存下来：

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -3 && npm run lint 2>&1 | tail -3
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -3 && npm run lint 2>&1 | tail -3
```

把每组输出末尾的错误计数记下来，后面每个任务结束都比对。

---

## Task 1: `quick_replies` 表 DDL

**Files:**
- Modify: `backend/server/modules/database/schema.ts`（在 `NOTIFICATIONS_TABLE_SCHEMA_SQL` 之后新增常量；在 `INIT_SCHEMA_SQL` 末尾拼接）
- Modify: `backend/server/modules/database/migrations.ts`（import + `runMigrations()`）

- [ ] **Step 1: 在 schema.ts 里加 DDL 常量**

在 `export const NOTIFICATIONS_TABLE_SCHEMA_SQL = ...` 那个常量的**后面**插入：

```ts
export const QUICK_REPLIES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quick_replies (
  quick_reply_id TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_last_used ON quick_replies(last_used_at);
`;
```

不建 `user_id` 列：现有业务表（tasks / notifications / scheduled_tasks / sessions）都没有，数据是单用户事实模型。时间戳用裸 `CURRENT_TIMESTAMP`，与全库一致（前端解析一律走 `parseBackendTimestamp`）。

- [ ] **Step 2: 把常量和索引拼进 INIT_SCHEMA_SQL**

在 `INIT_SCHEMA_SQL` 模板字符串**末尾**（`${NOTIFICATIONS_TABLE_SCHEMA_SQL}` 那两行索引之后、收尾反引号之前）插入：

```ts

${QUICK_REPLIES_TABLE_SCHEMA_SQL}
```

注意 `QUICK_REPLIES_TABLE_SCHEMA_SQL` 自己的字符串里已经含 `CREATE INDEX`，这里不用再补一行索引。

- [ ] **Step 3: 在 migrations.ts 里补升级路径**

改 import 块（`backend/server/modules/database/migrations.ts:3-17`），把 `QUICK_REPLIES_TABLE_SCHEMA_SQL` 按字母序插进 `NOTIFICATIONS_TABLE_SCHEMA_SQL` 之前：

```ts
import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL,
  NOTIFICATIONS_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  QUICK_REPLIES_TABLE_SCHEMA_SQL,
  REMOTE_HOSTS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL,
  TASKS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';
```

然后在 `runMigrations()` 里跟着 `db.exec(NOTIFICATIONS_TABLE_SCHEMA_SQL);` 那几行（`migrations.ts:833-835` 附近）追加：

```ts
    db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
```

**为什么两处都要写**：只写 `INIT_SCHEMA_SQL`，老库升级后不会有这张表；只写 migrations，新库靠 migrations 也能建但会偏离同模块其他表的写法。notifications 当年就是两处都补的。

- [ ] **Step 4: typecheck 确认没引入新错误**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -3
```

Expected: 错误计数与基线一致（DDL 是纯字符串，不该产生任何类型错误）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts
git commit -m "feat(quick-replies): add the quick_replies table"
```

---

## Task 2: 仓储层 `quick-replies.db.ts`

**Files:**
- Create: `backend/server/modules/quick-replies/quick-replies.db.ts`
- Test: `backend/server/modules/quick-replies/tests/quick-replies.db.test.ts`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/server/modules/quick-replies/tests/quick-replies.db.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { QUICK_REPLIES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { createQuickRepliesDb } from '@/modules/quick-replies/quick-replies.db.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
  return { db, repo: createQuickRepliesDb(db) };
}

/**
 * created_at / last_used_at 都是 CURRENT_TIMESTAMP，只有秒级精度，同一个测试里
 * 连续调用分不出先后。需要可区分的顺序时直接写死时间戳，不要 sleep。
 */
function setLastUsed(db: Database.Database, id: string, value: string | null) {
  db.prepare('UPDATE quick_replies SET last_used_at = ? WHERE quick_reply_id = ?').run(value, id);
}

test('create 新建一条，last_used_at 为空', () => {
  const { repo } = makeDb();
  const row = repo.create('继续');
  assert.equal(row.content, '继续');
  assert.equal(row.last_used_at, null);
  assert.ok(row.quick_reply_id);
  assert.ok(row.created_at);
});

test('list 按最后使用时间倒序', () => {
  const { db, repo } = makeDb();
  const a = repo.create('A');
  const b = repo.create('B');
  const c = repo.create('C');
  setLastUsed(db, a.quick_reply_id, '2026-01-01 00:00:00');
  setLastUsed(db, b.quick_reply_id, '2026-02-01 00:00:00');
  setLastUsed(db, c.quick_reply_id, '2026-03-01 00:00:00');
  assert.deepEqual(repo.list().map((r) => r.content), ['C', 'B', 'A']);
});

test('list 把从未使用过的条目排在最后', () => {
  const { db, repo } = makeDb();
  const unused = repo.create('没用过');
  const used = repo.create('用过');
  setLastUsed(db, used.quick_reply_id, '2026-01-01 00:00:00');
  assert.deepEqual(repo.list().map((r) => r.content), ['用过', '没用过']);
});

test('update 改正文并刷新 updated_at', () => {
  const { db, repo } = makeDb();
  const row = repo.create('旧正文');
  db.prepare(
    "UPDATE quick_replies SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00' WHERE quick_reply_id = ?",
  ).run(row.quick_reply_id);

  const updated = repo.update(row.quick_reply_id, '新正文');
  assert.equal(updated?.content, '新正文');
  assert.notEqual(updated?.updated_at, '2020-01-01 00:00:00');
});

test('update 不存在的 id 返回 null', () => {
  const { repo } = makeDb();
  assert.equal(repo.update('nope', 'x'), null);
});

test('remove 删掉后 list 不再包含它', () => {
  const { repo } = makeDb();
  const row = repo.create('待删');
  assert.equal(repo.remove(row.quick_reply_id), true);
  assert.deepEqual(repo.list(), []);
});

test('remove 不存在的 id 返回 false', () => {
  const { repo } = makeDb();
  assert.equal(repo.remove('nope'), false);
});

test('touch 刷新 last_used_at', () => {
  const { repo } = makeDb();
  const row = repo.create('继续');
  assert.equal(row.last_used_at, null);
  const touched = repo.touch(row.quick_reply_id);
  assert.notEqual(touched?.last_used_at, null);
});

test('touch 不存在的 id 返回 null', () => {
  const { repo } = makeDb();
  assert.equal(repo.touch('nope'), null);
});

test('findByContent 命中已存在的正文，未命中返回 null', () => {
  const { repo } = makeDb();
  const row = repo.create('继续');
  assert.equal(repo.findByContent('继续')?.quick_reply_id, row.quick_reply_id);
  assert.equal(repo.findByContent('没这条'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/quick-replies.db.test.ts
```

Expected: FAIL —— `Cannot find module '@/modules/quick-replies/quick-replies.db.js'`（文件还没建）。

- [ ] **Step 3: 写实现**

创建 `backend/server/modules/quick-replies/quick-replies.db.ts`：

```ts
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type QuickReplyRow = {
  quick_reply_id: string;
  content: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

/**
 * DI 工厂：默认用生产共享连接（getConnection），测试传入内存库。
 * 调用方必须保证 quick_replies 表已建表——生产路径是在 startServer() 里
 * `await initializeDatabase()` 之后才 new，否则下面的 prepare 会抛 no such table。
 */
export function createQuickRepliesDb(connection?: BetterSqlite3.Database) {
  const db = connection ?? getConnection();

  const getById = db.prepare<[string]>('SELECT * FROM quick_replies WHERE quick_reply_id = ?');

  const repo = {
    /**
     * 排序第一键 `last_used_at IS NULL` 不能省：SQLite 的 DESC 虽然默认把 NULL
     * 放最后，但依赖这个隐式行为太脆。显式写出来，并由测试守住「没用过的沉底」。
     */
    list(): QuickReplyRow[] {
      return db.prepare(
        'SELECT * FROM quick_replies ORDER BY last_used_at IS NULL, last_used_at DESC, created_at DESC',
      ).all() as QuickReplyRow[];
    },

    get(id: string): QuickReplyRow | null {
      return (getById.get(id) as QuickReplyRow | undefined) ?? null;
    },

    create(content: string): QuickReplyRow {
      const id = randomUUID();
      db.prepare('INSERT INTO quick_replies (quick_reply_id, content) VALUES (?, ?)').run(id, content);
      // 主键是应用层生成的 UUID，插入后直接按 id 读回即可，不需要 RETURNING。
      return repo.get(id) as QuickReplyRow;
    },

    update(id: string, content: string): QuickReplyRow | null {
      const info = db.prepare(
        'UPDATE quick_replies SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE quick_reply_id = ?',
      ).run(content, id);
      if (info.changes === 0) return null;
      return repo.get(id);
    },

    remove(id: string): boolean {
      return db.prepare('DELETE FROM quick_replies WHERE quick_reply_id = ?').run(id).changes > 0;
    },

    touch(id: string): QuickReplyRow | null {
      const info = db.prepare(
        'UPDATE quick_replies SET last_used_at = CURRENT_TIMESTAMP WHERE quick_reply_id = ?',
      ).run(id);
      if (info.changes === 0) return null;
      return repo.get(id);
    },

    findByContent(content: string): QuickReplyRow | null {
      return (db.prepare('SELECT * FROM quick_replies WHERE content = ? LIMIT 1').get(content) as
        | QuickReplyRow
        | undefined) ?? null;
    },
  };

  return repo;
}

export type QuickRepliesDb = ReturnType<typeof createQuickRepliesDb>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/quick-replies.db.test.ts
```

Expected: PASS，10 个测试全绿（`# pass 10` / `# fail 0`）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/quick-replies/quick-replies.db.ts backend/server/modules/quick-replies/tests/quick-replies.db.test.ts
git commit -m "feat(quick-replies): add the quick replies repository"
```

---

## Task 3: 服务层校验 `quick-replies.service.ts`

**Files:**
- Create: `backend/server/modules/quick-replies/quick-replies.service.ts`
- Test: `backend/server/modules/quick-replies/tests/quick-replies.service.test.ts`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/server/modules/quick-replies/tests/quick-replies.service.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { QUICK_REPLIES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { AppError } from '@/shared/utils.js';
import { createQuickRepliesDb } from '@/modules/quick-replies/quick-replies.db.js';
import { createQuickRepliesService } from '@/modules/quick-replies/quick-replies.service.js';

function makeService() {
  const db = new Database(':memory:');
  db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
  return createQuickRepliesService(createQuickRepliesDb(db));
}

/** 断言抛出的 AppError 带指定 code 与 HTTP 状态。 */
function throwsWith(code: string, statusCode: number) {
  return (error: unknown) =>
    error instanceof AppError && error.code === code && error.statusCode === statusCode;
}

test('create 保存 trim 后的正文', () => {
  const svc = makeService();
  assert.equal(svc.create('  继续  ').content, '继续');
});

test('create 拒绝空白正文', () => {
  const svc = makeService();
  assert.throws(() => svc.create('   '), throwsWith('QUICK_REPLY_EMPTY', 400));
});

test('create 拒绝重复正文（trim 后比较）', () => {
  const svc = makeService();
  svc.create('继续');
  assert.throws(() => svc.create('  继续  '), throwsWith('QUICK_REPLY_DUPLICATE', 409));
});

test('update 改正文', () => {
  const svc = makeService();
  const row = svc.create('旧');
  assert.equal(svc.update(row.quick_reply_id, ' 新 ').content, '新');
});

test('update 拒绝空白正文', () => {
  const svc = makeService();
  const row = svc.create('继续');
  assert.throws(() => svc.update(row.quick_reply_id, ''), throwsWith('QUICK_REPLY_EMPTY', 400));
});

test('update 拒绝与别的条目重复', () => {
  const svc = makeService();
  svc.create('A');
  const b = svc.create('B');
  assert.throws(() => svc.update(b.quick_reply_id, 'A'), throwsWith('QUICK_REPLY_DUPLICATE', 409));
});

test('update 允许保存自己原来的正文', () => {
  const svc = makeService();
  const row = svc.create('A');
  assert.equal(svc.update(row.quick_reply_id, 'A').content, 'A');
});

test('update 目标不存在抛 404', () => {
  const svc = makeService();
  assert.throws(() => svc.update('nope', 'A'), throwsWith('QUICK_REPLY_NOT_FOUND', 404));
});

test('use 刷新 last_used_at，目标不存在抛 404', () => {
  const svc = makeService();
  const row = svc.create('继续');
  assert.notEqual(svc.use(row.quick_reply_id).last_used_at, null);
  assert.throws(() => svc.use('nope'), throwsWith('QUICK_REPLY_NOT_FOUND', 404));
});

test('remove 删掉，目标不存在抛 404', () => {
  const svc = makeService();
  const row = svc.create('待删');
  svc.remove(row.quick_reply_id);
  assert.throws(() => svc.remove(row.quick_reply_id), throwsWith('QUICK_REPLY_NOT_FOUND', 404));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/quick-replies.service.test.ts
```

Expected: FAIL —— `Cannot find module '@/modules/quick-replies/quick-replies.service.js'`。

- [ ] **Step 3: 写实现**

创建 `backend/server/modules/quick-replies/quick-replies.service.ts`：

```ts
import { AppError } from '@/shared/utils.js';
import type { QuickRepliesDb, QuickReplyRow } from './quick-replies.db.js';

/**
 * 业务规则：正文 trim 后不能为空；trim 后不能与已有条目完全相同。
 * 拒绝重复的理由——条目没有标题，两条一模一样的正文在列表里完全无法区分。
 */
export function createQuickRepliesService(db: QuickRepliesDb) {
  const assertContentUsable = (content: string, excludeId?: string): string => {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new AppError('常用语内容不能为空', { code: 'QUICK_REPLY_EMPTY', statusCode: 400 });
    }
    const existing = db.findByContent(trimmed);
    if (existing && existing.quick_reply_id !== excludeId) {
      throw new AppError('该常用语已存在', { code: 'QUICK_REPLY_DUPLICATE', statusCode: 409 });
    }
    return trimmed;
  };

  return {
    list(): QuickReplyRow[] {
      return db.list();
    },

    create(content: string): QuickReplyRow {
      return db.create(assertContentUsable(content));
    },

    update(id: string, content: string): QuickReplyRow {
      const trimmed = assertContentUsable(content, id);
      const row = db.update(id, trimmed);
      if (!row) {
        throw new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });
      }
      return row;
    },

    remove(id: string): void {
      if (!db.remove(id)) {
        throw new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });
      }
    },

    use(id: string): QuickReplyRow {
      const row = db.touch(id);
      if (!row) {
        throw new AppError('常用语不存在', { code: 'QUICK_REPLY_NOT_FOUND', statusCode: 404 });
      }
      return row;
    },
  };
}

export type QuickRepliesService = ReturnType<typeof createQuickRepliesService>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/quick-replies.service.test.ts
```

Expected: PASS，10 个测试全绿。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/quick-replies/quick-replies.service.ts backend/server/modules/quick-replies/tests/quick-replies.service.test.ts
git commit -m "feat(quick-replies): validate quick reply content"
```

---

## Task 4: 路由、模块出口与挂载

**Files:**
- Create: `backend/server/modules/quick-replies/quick-replies.routes.ts`
- Create: `backend/server/modules/quick-replies/index.ts`
- Test: `backend/server/modules/quick-replies/tests/quick-replies.routes.test.ts`
- Modify: `backend/server/index.js`（import 块 ~78-85、`startServer()` 内 ~2256 之后）

- [ ] **Step 1: 先写失败的测试**

创建 `backend/server/modules/quick-replies/tests/quick-replies.routes.test.ts`：

```ts
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';

import { QUICK_REPLIES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { AppError } from '@/shared/utils.js';

import { createQuickRepliesDb } from '../quick-replies.db.js';
import { createQuickRepliesService } from '../quick-replies.service.js';
import { buildQuickRepliesRouter } from '../quick-replies.routes.js';

async function startServer() {
  const db = new Database(':memory:');
  db.exec(QUICK_REPLIES_TABLE_SCHEMA_SQL);
  const service = createQuickRepliesService(createQuickRepliesDb(db));

  const app = express();
  app.use(express.json());
  app.use('/api/quick-replies', buildQuickRepliesRouter(service));
  // 复刻 server/index.js 末尾的全局错误中间件，否则 AppError 会退化成 express
  // 默认的 500 页面，测不到 code/statusCode。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('GET / 空库返回空数组', async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/api/quick-replies`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [] });
  } finally {
    await close();
  }
});

test('POST / 建一条后 GET 能看到，列为 snake_case', async () => {
  const { base, close } = await startServer();
  try {
    const created = await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '继续' }),
    });
    assert.equal(created.status, 201);
    const row = await created.json();
    assert.equal(row.content, '继续');
    assert.equal(row.last_used_at, null);
    assert.ok(row.quick_reply_id);

    const listed = await (await fetch(`${base}/api/quick-replies`)).json();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].quick_reply_id, row.quick_reply_id);
  } finally {
    await close();
  }
});

test('POST / 空内容与重复内容分别返回 400 / 409', async () => {
  const { base, close } = await startServer();
  try {
    const post = (content: string) => fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    const empty = await post('   ');
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'QUICK_REPLY_EMPTY');

    await post('继续');
    const dup = await post('继续');
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error.code, 'QUICK_REPLY_DUPLICATE');
  } finally {
    await close();
  }
});

test('PUT /:id 改正文，不存在的 id 返回 404', async () => {
  const { base, close } = await startServer();
  try {
    const created = await (await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '旧' }),
    })).json();

    const updated = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '新' }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).content, '新');

    const missing = await fetch(`${base}/api/quick-replies/nope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '新' }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'QUICK_REPLY_NOT_FOUND');
  } finally {
    await close();
  }
});

test('DELETE /:id 删掉，再删返回 404', async () => {
  const { base, close } = await startServer();
  try {
    const created = await (await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '待删' }),
    })).json();

    const first = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { success: true });

    const second = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}`, { method: 'DELETE' });
    assert.equal(second.status, 404);
  } finally {
    await close();
  }
});

test('POST /:id/use 刷新 last_used_at，不存在返回 404', async () => {
  const { base, close } = await startServer();
  try {
    const created = await (await fetch(`${base}/api/quick-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '继续' }),
    })).json();

    const used = await fetch(`${base}/api/quick-replies/${created.quick_reply_id}/use`, { method: 'POST' });
    assert.equal(used.status, 200);
    assert.notEqual((await used.json()).last_used_at, null);

    const missing = await fetch(`${base}/api/quick-replies/nope/use`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/quick-replies.routes.test.ts
```

Expected: FAIL —— `Cannot find module '../quick-replies.routes.js'`。

- [ ] **Step 3: 写路由**

创建 `backend/server/modules/quick-replies/quick-replies.routes.ts`：

```ts
import express from 'express';

import { asyncHandler } from '@/shared/utils.js';
import type { QuickRepliesService } from './quick-replies.service.js';

export function buildQuickRepliesRouter(svc: QuickRepliesService) {
  const router = express.Router();

  // 行直接透出 snake_case（与其他业务表 API 一致，前端 inboxStore 也是这么消费
  // notifications 的），不做 camelCase 映射。
  router.get('/', asyncHandler(async (_req, res) => {
    res.json({ items: svc.list() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.status(201).json(svc.create(content));
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.json(svc.update(String(req.params.id), content));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    svc.remove(String(req.params.id));
    res.json({ success: true });
  }));

  // 打点用：只刷新 last_used_at，不碰正文。
  router.post('/:id/use', asyncHandler(async (req, res) => {
    res.json(svc.use(String(req.params.id)));
  }));

  return router;
}

export default buildQuickRepliesRouter;
```

- [ ] **Step 4: 写模块出口**

创建 `backend/server/modules/quick-replies/index.ts`：

```ts
export { createQuickRepliesDb } from './quick-replies.db.js';
export type { QuickReplyRow, QuickRepliesDb } from './quick-replies.db.js';
export { createQuickRepliesService } from './quick-replies.service.js';
export type { QuickRepliesService } from './quick-replies.service.js';
export { buildQuickRepliesRouter } from './quick-replies.routes.js';
```

模块间只经各自 `index.ts` 互访（`eslint-plugin-boundaries` 约束）。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend
npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/quick-replies.routes.test.ts
```

Expected: PASS，6 个测试全绿。

- [ ] **Step 6: 在 server/index.js 里 import 并挂载**

在 `backend/server/index.js` 的 `from './modules/notifications/index.js';`（~85 行）**之后**加：

```js
import {
    createQuickRepliesDb,
    createQuickRepliesService,
    buildQuickRepliesRouter,
} from './modules/quick-replies/index.js';
```

然后在 `startServer()` 里，`app.use('/api/notifications', ...)`（~2256 行）**之后**加：

```js
        // 常用语：同样必须等 initializeDatabase() 建完表再实例化，
        // createQuickRepliesDb 里的 prepare 会校验表存在。
        const quickRepliesService = createQuickRepliesService(createQuickRepliesDb());
        app.use('/api/quick-replies', authenticateToken, buildQuickRepliesRouter(quickRepliesService));
```

**位置不能挪到模块顶层**：`createQuickRepliesDb` 内部的 `prepare` 在表不存在时抛 `no such table`，会让后端起不来（notifications 踩过这个坑）。

- [ ] **Step 7: typecheck + lint 比对基线**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npm run typecheck 2>&1 | tail -3 && npm run lint 2>&1 | tail -3
```

Expected: 错误计数与基线一致（index.js 是 JS，不在 tsc 范围内；新增的 TS 文件应零错误）。

- [ ] **Step 8: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add backend/server/modules/quick-replies backend/server/index.js
git commit -m "feat(quick-replies): expose the quick replies CRUD API"
```

---

## Task 5: 前端纯函数与 API 客户端

**Files:**
- Create: `web/src/components/chat/utils/quickReplyInsert.ts`
- Test: `web/src/components/chat/utils/quickReplyInsert.test.ts`
- Modify: `web/src/utils/api.js`（在 `scheduledTasks` 命名空间之后插入）

- [ ] **Step 1: 先写失败的测试**

创建 `web/src/components/chat/utils/quickReplyInsert.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQuickReplyInput } from './quickReplyInsert';

test('输入框为空时直接填入', () => {
  assert.equal(buildQuickReplyInput('', '继续'), '继续');
});

test('输入框只有空白时也视为空', () => {
  assert.equal(buildQuickReplyInput('   ', '继续'), '继续');
});

test('输入框有内容时追加到末尾，单空格分隔', () => {
  assert.equal(buildQuickReplyInput('写个测试', '继续'), '写个测试 继续');
});

test('输入框有尾随空格时不产生双空格', () => {
  assert.equal(buildQuickReplyInput('写个测试   ', '继续'), '写个测试 继续');
});

test('输入框两端都有空白时一并 trim', () => {
  assert.equal(buildQuickReplyInput(' 写个测试 ', '继续'), '写个测试 继续');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsx --test src/components/chat/utils/quickReplyInsert.test.ts
```

Expected: FAIL —— `Cannot find module './quickReplyInsert'`。

- [ ] **Step 3: 写纯函数**

创建 `web/src/components/chat/utils/quickReplyInsert.ts`：

```ts
/**
 * 点一条常用语之后输入框应有的内容：空则直接填入，非空则追加到末尾。
 *
 * 两边都 trim：既判断「空」，也保证拼接处只有一个空格（用户草稿可能带尾随空白）。
 * 抽成独立纯函数是为了可测——前端测试没有 DOM 环境，只有纯函数能被 node:test 直接覆盖。
 */
export function buildQuickReplyInput(current: string, content: string): string {
  const base = current.trim();
  return base ? `${base} ${content}` : content;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/web
npx tsx --test src/components/chat/utils/quickReplyInsert.test.ts
```

Expected: PASS，5 个测试全绿。

- [ ] **Step 5: 加 API 客户端**

在 `web/src/utils/api.js` 里 `notifications: { ... }` 命名空间**之前**插入（`scheduledTasks` 与 `notifications` 之间，约 384 行）：

```js
  // 常用语（快速回复）。列表行按后端原样透出 snake_case，与其他业务表 API 一致。
  quickReplies: {
    list: () => authenticatedFetch('/api/quick-replies'),
    create: (content) => authenticatedFetch('/api/quick-replies', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
    update: (quickReplyId, content) =>
      authenticatedFetch(`/api/quick-replies/${encodeURIComponent(quickReplyId)}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
    remove: (quickReplyId) =>
      authenticatedFetch(`/api/quick-replies/${encodeURIComponent(quickReplyId)}`, {
        method: 'DELETE',
      }),
    // 打点：只刷新 last_used_at，不改正文。
    use: (quickReplyId) =>
      authenticatedFetch(`/api/quick-replies/${encodeURIComponent(quickReplyId)}/use`, {
        method: 'POST',
      }),
  },
```

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/utils/quickReplyInsert.ts web/src/components/chat/utils/quickReplyInsert.test.ts web/src/utils/api.js
git commit -m "feat(chat): add the quick reply insert helper and API client"
```

---

## Task 6: `useQuickReplies` hook

**Files:**
- Create: `web/src/components/chat/hooks/useQuickReplies.ts`

这个 hook 没有单测：前端测试环境没有 DOM 也没有 React 渲染器（现状如此，`SettingsPage.test.tsx` 只是 `renderToStaticMarkup` 的 SSR 冒烟）。它的逻辑很薄，真正的排序与校验在已测的后端。

- [ ] **Step 1: 写 hook**

创建 `web/src/components/chat/hooks/useQuickReplies.ts`：

```ts
import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';


/** 后端线上形状：quick_replies 行原样透出（snake_case），与其他业务表 API 一致。 */
export type QuickReply = {
  quick_reply_id: string;
  content: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

export type UseQuickRepliesResult = {
  items: QuickReply[];
  isLoading: boolean;
  error: string | null;
  create: (content: string) => Promise<void>;
  update: (quickReplyId: string, content: string) => Promise<void>;
  remove: (quickReplyId: string) => Promise<void>;
  /** 打点，不阻塞点选：失败静默吞掉，下一次 GET 会把顺序纠正回来。 */
  markUsed: (quickReplyId: string) => void;
};

/** 从后端的 {success:false,error:{message}} 里取可展示的文案。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload?.error?.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export function useQuickReplies(): UseQuickRepliesResult {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = (await api.quickReplies.list()) as Response;
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as { items?: QuickReply[] };
      setItems(Array.isArray(payload?.items) ? payload.items : []);
      setError(null);
    } catch {
      setError('无法加载常用语');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 写操作后重拉列表，不做乐观更新：服务端要按 last_used_at 重排，
  // 本地先插入/移动会让列表抖动。
  const mutate = useCallback(
    async (request: () => Promise<Response>) => {
      const response = await request();
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      await refresh();
    },
    [refresh],
  );

  const create = useCallback(
    (content: string) => mutate(() => api.quickReplies.create(content)),
    [mutate],
  );

  const update = useCallback(
    (quickReplyId: string, content: string) =>
      mutate(() => api.quickReplies.update(quickReplyId, content)),
    [mutate],
  );

  const remove = useCallback(
    (quickReplyId: string) => mutate(() => api.quickReplies.remove(quickReplyId)),
    [mutate],
  );

  const markUsed = useCallback(
    (quickReplyId: string) => {
      void api.quickReplies
        .use(quickReplyId)
        .then((response: Response) => {
          if (response.ok) void refresh();
        })
        .catch(() => undefined);
    },
    [refresh],
  );

  return { items, isLoading, error, create, update, remove, markUsed };
}
```

- [ ] **Step 2: typecheck 比对基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -5
```

Expected: 与基线一致，零新增。若报 `QuickReply` 未使用之类的错，说明下一步的消费方还没接上——继续 Task 7 即可，最终一起验。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/hooks/useQuickReplies.ts
git commit -m "feat(chat): add the useQuickReplies hook"
```

---

## Task 7: `QuickRepliesMenu` 浮层组件

**Files:**
- Create: `web/src/components/chat/view/subcomponents/QuickRepliesMenu.tsx`

方案 A 的形态：窄浮层、一条一行、超长截断（`title` 供悬停看全文）、悬停浮出行尾的「改 / 删」、编辑在行内换成小 textarea。**不弹 Dialog。**

组件同样没有单测，理由与 Task 6 相同。定位与关闭逻辑直接复用同文件目录下 Effort 下拉的现成写法（`ChatComposer.tsx:235-275` 的位置计算与 `pointerdown` 外部关闭 + `window` capture 的 Escape）。

- [ ] **Step 1: 写组件**

创建 `web/src/components/chat/view/subcomponents/QuickRepliesMenu.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';

import type { QuickReply } from '../../hooks/useQuickReplies';

const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 360;
const MENU_MIN_HEIGHT = 160;
const EDGE_GAP = 8;

type MenuPosition = { left: number; top: number; maxHeight: number };

/**
 * 工具栏按钮在屏幕底部，浮层必须向上弹（向下必然出屏）。
 * `top` 取按钮顶边再 `translateY(-100%)`，等效于「底边贴在按钮上方 EDGE_GAP 处」。
 */
function computePosition(anchor: HTMLElement | null): MenuPosition {
  if (!anchor || typeof window === 'undefined') {
    return { left: EDGE_GAP, top: 0, maxHeight: MENU_MAX_HEIGHT };
  }
  const rect = anchor.getBoundingClientRect();
  return {
    left: Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE_GAP)),
    top: rect.top - EDGE_GAP,
    maxHeight: Math.min(MENU_MAX_HEIGHT, Math.max(MENU_MIN_HEIGHT, rect.top - EDGE_GAP * 2)),
  };
}

type QuickRepliesMenuProps = {
  items: QuickReply[];
  isLoading: boolean;
  error: string | null;
  /** 工具栏按钮，用于定位与「点自己不算点外部」。 */
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelect: (item: QuickReply) => void;
  onCreate: (content: string) => Promise<void>;
  onUpdate: (quickReplyId: string, content: string) => Promise<void>;
  onRemove: (quickReplyId: string) => Promise<void>;
};

type Draft = { id: string | null; content: string };

function QuickRepliesMenu({
  items,
  isLoading,
  error,
  anchorRef,
  onClose,
  onSelect,
  onCreate,
  onUpdate,
  onRemove,
}: QuickRepliesMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition>(() => computePosition(anchorRef.current));
  // id === null 表示「新增」，有 id 表示编辑该条。
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const updatePosition = useCallback(() => {
    setPosition(computePosition(anchorRef.current));
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  // Escape：编辑态先退出编辑，否则关浮层。用 window capture 抢在 ChatInterface 的
  // 全局 Escape（那会中断会话）之前，并 preventDefault 让它跳过。
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (draft) {
        setDraft(null);
        setActionError(null);
        return;
      }
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [anchorRef, draft, onClose]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    const content = draft.content.trim();
    if (!content) {
      setActionError('常用语内容不能为空');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      if (draft.id) {
        await onUpdate(draft.id, content);
      } else {
        await onCreate(content);
      }
      setDraft(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [draft, onCreate, onUpdate]);

  const handleDelete = useCallback(
    async (quickReplyId: string) => {
      setActionError(null);
      try {
        await onRemove(quickReplyId);
        // 删掉的可能正是当前编辑中的那一条，顺手退出编辑态。
        setDraft((current) => (current?.id === quickReplyId ? null : current));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '删除失败');
      }
    },
    [onRemove],
  );

  const startEditing = useCallback((item: QuickReply) => {
    setActionError(null);
    setDraft({ id: item.quick_reply_id, content: item.content });
  }, []);

  const startCreating = useCallback(() => {
    setActionError(null);
    setDraft({ id: null, content: '' });
  }, []);

  const message = actionError || error;

  const editorRow = (draftId: string | null) => (
    <EditorRow
      initialContent={draft?.content ?? ''}
      busy={busy}
      onChange={(content) => setDraft({ id: draftId, content })}
      onSave={() => void handleSave()}
      onCancel={() => setDraft(null)}
    />
  );

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-label="常用语"
      className="fixed z-[100] overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
      style={{
        left: position.left,
        top: position.top,
        width: MENU_WIDTH,
        maxHeight: position.maxHeight,
        transform: 'translateY(-100%)',
      }}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">常用语</span>
        {!draft && (
          <button
            type="button"
            onClick={startCreating}
            className="flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
          >
            <Plus className="h-3 w-3" />
            新建
          </button>
        )}
      </div>

      {message && (
        <div className="border-b border-border/50 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          {message}
        </div>
      )}

      {isLoading && items.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">加载中…</div>
      )}

      {!isLoading && items.length === 0 && !draft && (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">还没有常用语</div>
      )}

      {items.map((item) => (
        draft && draft.id === item.quick_reply_id ? (
          <div key={item.quick_reply_id}>{editorRow(item.quick_reply_id)}</div>
        ) : (
          <div
            key={item.quick_reply_id}
            className="group flex items-center gap-1 border-b border-border/50 px-2 py-1.5 last:border-b-0 hover:bg-accent/60"
          >
            <button
              type="button"
              onClick={() => onSelect(item)}
              title={item.content}
              className="flex-1 truncate text-left text-xs text-foreground"
            >
              {item.content}
            </button>
            <button
              type="button"
              aria-label="编辑常用语"
              title="编辑"
              onClick={() => startEditing(item)}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="删除常用语"
              title="删除"
              onClick={() => void handleDelete(item.quick_reply_id)}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )
      ))}

      {draft && draft.id === null && editorRow(null)}
    </div>,
    document.body,
  );
}

function EditorRow({
  initialContent,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  initialContent: string;
  busy: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialContent);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="border-b border-border/50 px-2 py-2 last:border-b-0">
      <textarea
        ref={textareaRef}
        value={value}
        rows={2}
        placeholder="输入常用语，Enter 保存，Shift+Enter 换行"
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSave();
          }
        }}
        className="w-full resize-none rounded border border-border bg-muted/40 p-2 text-xs text-foreground outline-none focus:border-primary"
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2 py-1 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

export default QuickRepliesMenu;
```

- [ ] **Step 2: typecheck**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -5
```

Expected: 与基线一致。此时 `QuickRepliesMenu` 还没被引用，但它是独立模块，不该报错。

- [ ] **Step 3: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/view/subcomponents/QuickRepliesMenu.tsx
git commit -m "feat(chat): add the quick replies popover"
```

---

## Task 8: 接线（hook → ChatInterface → ChatComposer）

**Files:**
- Modify: `web/src/components/chat/hooks/useChatComposerState.ts`（import、hook 挂载、`handleInsertQuickReply`、return 对象）
- Modify: `web/src/components/chat/view/subcomponents/ChatComposer.tsx`（props、⚡ 按钮、浮层渲染、互斥）
- Modify: `web/src/components/chat/view/ChatInterface.tsx`（解构 + 透传）
- Modify: `web/src/i18n/locales/en/chat.json`（`input.quickReplies`）

- [ ] **Step 1: useChatComposerState 挂 hook 并实现插入**

在 `web/src/components/chat/hooks/useChatComposerState.ts` 的 import 区（`import { useFileMentions } from './useFileMentions';` 那一组附近）加：

```ts
import { useQuickReplies, type QuickReply } from './useQuickReplies';
import { buildQuickReplyInput } from '../utils/quickReplyInsert';
```

在 `const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);`（~239 行）之后加：

```ts
  // 会话级单实例：列表与写操作只在这里持有一份，不是每个按钮一个实例。
  const quickReplies = useQuickReplies();
```

在 `handleClearInput`（~1265 行）**之后**加：

```ts
  /**
   * 点一条常用语：填进输入框、关浮层、光标移到末尾、顺手打一次点。
   * 刻意不自动发送——用户可能要改完再 Ctrl+Enter。
   * setInput 是异步的，inputValueRef 必须同步更新，否则紧接着的 handleSubmit 会读到旧值。
   */
  const handleInsertQuickReply = useCallback((item: QuickReply) => {
    const next = buildQuickReplyInput(inputValueRef.current, item.content);
    setInput(next);
    inputValueRef.current = next;
    resetCommandMenuState();
    // 打点不 await：点选要零延迟，顺序错了下一次 GET 会纠正。
    quickReplies.markUsed(item.quick_reply_id);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.length, next.length);
    });
  }, [quickReplies, resetCommandMenuState]);
```

文本框高度会由已有的 autosize effect（`useChatComposerState.ts:1167-1177`，`lastAutosizedInputRef !== input` 时调 `resizeTextarea`）自动处理，不用额外写。

在 return 对象里（`showModelsModal,` 附近）加两项：

```ts
    quickReplies,
    handleInsertQuickReply,
```

- [ ] **Step 2: ChatComposer 加 props、按钮与浮层**

在 `web/src/components/chat/view/subcomponents/ChatComposer.tsx`：

(a) lucide import 行（~13 行）加 `Zap`：

```ts
import { ImageIcon, MessageSquareIcon, XIcon, Loader2, ChevronDown, Check, ArrowUpIcon, Cpu, Paperclip, Zap } from 'lucide-react';
```

(b) 加组件 import：

```ts
import QuickRepliesMenu from './QuickRepliesMenu';
import type { QuickReply } from '../../hooks/useQuickReplies';
```

(c) `interface ChatComposerProps {` 里加 7 个 props（放在 `onToggleCommandMenu` 附近即可，文件本来就是一堆平铺 props）：

```ts
  quickReplyItems: QuickReply[];
  isQuickRepliesLoading: boolean;
  quickRepliesError: string | null;
  onCreateQuickReply: (content: string) => Promise<void>;
  onUpdateQuickReply: (quickReplyId: string, content: string) => Promise<void>;
  onRemoveQuickReply: (quickReplyId: string) => Promise<void>;
  onInsertQuickReply: (item: QuickReply) => void;
```

(d) 在函数体解构处（`sendByCtrlEnter,` 之后）加：

```ts
  quickReplyItems,
  isQuickRepliesLoading,
  quickRepliesError,
  onCreateQuickReply,
  onUpdateQuickReply,
  onRemoveQuickReply,
  onInsertQuickReply,
```

(e) 在 `const { t } = useTranslation('chat');` 之后加状态与互斥逻辑：

```ts
  const quickReplyButtonRef = useRef<HTMLButtonElement>(null);
  const [isQuickRepliesOpen, setIsQuickRepliesOpen] = useState(false);

  // 两个工具栏浮层互斥：打开一个就关掉另一个，否则会叠在一起。
  const handleToggleQuickReplies = useCallback(() => {
    const next = !isQuickRepliesOpen;
    if (next) {
      onCloseCommandMenu();
    }
    setIsQuickRepliesOpen(next);
  }, [isQuickRepliesOpen, onCloseCommandMenu]);

  useEffect(() => {
    if (isCommandMenuOpen) {
      setIsQuickRepliesOpen(false);
    }
  }, [isCommandMenuOpen]);

  const handleSelectQuickReply = useCallback((item: QuickReply) => {
    onInsertQuickReply(item);
    setIsQuickRepliesOpen(false);
  }, [onInsertQuickReply]);
```

注意 `handleToggleQuickReplies` 里不能在 `setState` 的 updater 函数里调 `onCloseCommandMenu()`——React StrictMode 会双调用 updater，副作用会跑两次。

(f) 在工具栏斜杠命令按钮（`tooltip={{ content: t('input.showAllCommands') }}` 那个 `PromptInputButton`）**之前**插入 ⚡ 按钮：

```tsx
            <PromptInputButton
              ref={quickReplyButtonRef}
              tooltip={{ content: t('input.quickReplies', { defaultValue: 'Quick replies' }) }}
              onClick={handleToggleQuickReplies}
              aria-expanded={isQuickRepliesOpen}
              aria-haspopup="dialog"
            >
              <Zap />
            </PromptInputButton>
```

不给它加数量角标（常用语数量没有信息量，斜杠命令那个角标是必要的），也不加 `hidden sm:flex`——它是主要入口，窄屏也要能点。

(g) 在 `<CommandMenu ... />`（~363 行）之后渲染浮层：

```tsx
        {isQuickRepliesOpen && (
          <QuickRepliesMenu
            items={quickReplyItems}
            isLoading={isQuickRepliesLoading}
            error={quickRepliesError}
            anchorRef={quickReplyButtonRef}
            onClose={() => setIsQuickRepliesOpen(false)}
            onSelect={handleSelectQuickReply}
            onCreate={onCreateQuickReply}
            onUpdate={onUpdateQuickReply}
            onRemove={onRemoveQuickReply}
          />
        )}
```

- [ ] **Step 3: ChatInterface 解构并透传**

在 `web/src/components/chat/view/ChatInterface.tsx`：

(a) `} = useChatComposerState({` 的解构列表里（`showModelsModal,` 之后）加：

```ts
    quickReplies,
    handleInsertQuickReply,
```

(b) `<ChatComposer` 的 props 列表里（`onToggleCommandMenu={handleToggleCommandMenu}` 附近）加：

```tsx
          quickReplyItems={quickReplies.items}
          isQuickRepliesLoading={quickReplies.isLoading}
          quickRepliesError={quickReplies.error}
          onCreateQuickReply={quickReplies.create}
          onUpdateQuickReply={quickReplies.update}
          onRemoveQuickReply={quickReplies.remove}
          onInsertQuickReply={handleInsertQuickReply}
```

- [ ] **Step 4: 补 i18n 文案**

在 `web/src/i18n/locales/en/chat.json` 的 `input` 块里，`"clearInput": "Clear input",` 之后加：

```json
    "quickReplies": "Quick replies",
```

（只有 en 一个 locale；浮层内部的中文文案是硬编码的，与设置页现状一致。）

- [ ] **Step 5: typecheck + lint 比对基线**

```bash
cd /mnt/b/workdir/github/lovdex/web && npm run typecheck 2>&1 | tail -5 && npm run lint 2>&1 | tail -5
```

Expected: 与基线一致，零新增。这一步是接线正确性的主要自动屏障——props 名字对不上、类型不匹配都会在这里暴露。

- [ ] **Step 6: 跑全部相关测试**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsx --test src/components/chat/utils/quickReplyInsert.test.ts
cd /mnt/b/workdir/github/lovdex/backend && npx tsx --tsconfig server/tsconfig.json --test server/modules/quick-replies/tests/*.test.ts
```

Expected: 两个命令都全绿（后端 26 个用例）。

- [ ] **Step 7: Commit**

```bash
cd /mnt/b/workdir/github/lovdex
git add web/src/components/chat/hooks/useChatComposerState.ts web/src/components/chat/view/subcomponents/ChatComposer.tsx web/src/components/chat/view/ChatInterface.tsx web/src/i18n/locales/en/chat.json
git commit -m "feat(chat): wire the quick replies popover into the composer"
```

---

## Task 9: 端到端手工验收

自动测试覆盖不到浮层交互（没有 DOM 测试环境），这一步是必须的，不是可选的。

- [ ] **Step 1: 确认后端已重启并加载新路由**

新增路由要重启后端才生效。**重启前必须先取得用户明确许可**（一次授权不等于长期授权；用户常自己重启，说「已重启」即可）。

重启后验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3188/api/quick-replies
```

Expected: `401`（路由存在且挂了 `authenticateToken`）。若返回 `404`，说明路由没挂上或后端没重启。

- [ ] **Step 2: 浏览器验收清单**

打开会话页（`http://<lan-ip>:5188`，深链 `?project=<项目>&tab=chat`），逐条确认：

1. 工具栏出现 ⚡ 按钮，位置在斜杠命令（气泡图标）左边，悬停提示「Quick replies」。
2. 点 ⚡ → 浮层向上弹出、贴在按钮上方，显示「常用语 / ＋ 新建」与空态「还没有常用语」。
3. 点「＋ 新建」→ 行内出现 textarea 并自动聚焦；输入「继续」，Enter → 保存成功，列表出现这一条且浮层不关。
4. 再建一条「跑一下相关测试，失败就修到通过为止」。
5. 点「继续」→ 输入框变成「继续」，浮层关闭，光标在末尾，**没有自动发送**。
6. 输入框已有内容「写个测试」时再点一条 → 变成「写个测试 继续」（单空格）。
7. 鼠标移到某一行 → 行尾浮出「改 / 删」两个图标。
8. 点「改」→ 该行变成 textarea（内容为原文）→ 改完 Enter 保存 → 列表更新。
9. 改成一个已存在的正文 → 浮层顶部显示红色「该常用语已存在」，编辑态保留，可以接着改。
10. 点「删」→ 该行消失。
11. 点浮层外面 → 浮层关闭；按 Escape → 浮层关闭，**且没有触发会话中断**（这是全局 Escape 的默认行为，必须确认没被误触发）。
12. 打开 ⚡ 浮层后再点斜杠命令按钮 → 常用语浮层关闭（互斥生效）；反向亦然。
13. 刷新页面 → 排序按最近使用倒序，刚点过的那条在最前。
14. 窄屏（手机宽度）下 ⚡ 按钮仍可见可点。

- [ ] **Step 3: 把发现的问题修掉并重跑受影响的测试**

任何一条不通过都回到对应 Task 修正；改到后端就重跑该模块测试，改到纯函数就重跑 `quickReplyInsert.test.ts`。

---

## 完成标准

- 后端三个测试文件全绿（26 个用例），前端 `quickReplyInsert.test.ts` 全绿（5 个用例）。
- backend / web 的 `typecheck` 与 `lint` 相对基线**零新增**。
- Task 9 的 14 条手工清单逐条确认通过。
- 两个 commit（后端、前端各一）落在 main 上；提交信息不含 `Co-Authored-By` 署名。
