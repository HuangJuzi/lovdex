# Skill 同步机制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Lovdex 加一套 skill 同步机制，支持本地 → 远程、远程 → 本地、远程 → 远程三个方向，以 `.claude/skills` 为主目录，覆盖 user 级与 project 级。

**Architecture:** 复用 lite RPC 单通道（`remote-agent/src/rpc-dispatch.ts` 的 `handleRpc`），新增 `skills/manifest` / `skills/bundle` / `skills/apply` 三个**目录级**方法，原子写 / 备份 / 指纹都在远程侧完成。main 侧把「本地」也实现成一个同接口的节点，编排层因此没有 `if (isRemote)` 分支。远程↔远程 = main 从 A 读 bundle 到内存、直接写给 B。

**Tech Stack:** Node 20 + TypeScript（ESM）、Express、better-sqlite3、zod、node:test、React（web）、ws。

**设计文档：** `docs/superpowers/specs/2026-09-20-skill-sync-design.md`

---

## 前置阅读

实现前先读这四份文件，本计划的所有约定都来自它们：

- `backend/remote-agent/src/rpc-dispatch.ts` — lite 的方法分发（if-chain，无注册表）
- `backend/remote-agent/src/fs.ts` — 已有的路径白名单实现（`resolveWithinRoots`）
- `backend/server/modules/remote-agents/remote-fs.service.ts` — main 侧 RPC 客户端的样板
- `backend/server/shared/agent-runtime/protocol.ts` — 帧定义 + zod params schema

## 命令约定

**所有测试都在 `backend/` 目录下跑，且必须先 `unset TSX_TSCONFIG_PATH`**（该变量被全局导出，会劫持 tsx 的 tsconfig 解析）：

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-hash.test.ts
```

类型检查（baseline 有 pre-existing 错误，验收标准是**零新增**）：

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json
```

提交信息用英文，**不加 `Co-Authored-By` 署名行**。

## 文件结构

**新增**

| 文件 | 职责 |
|---|---|
| `backend/server/shared/skill-hash.ts` | 指纹算法 + 目录遍历（main 与 lite 共用同一份） |
| `backend/server/shared/skill-store.ts` | SkillStore 实现（manifest/bundle/apply），**两端共用** |
| `backend/remote-agent/src/skills.ts` | lite 侧的薄包装：把 store 绑到本机白名单 |
| `backend/server/shared/path-allowlist.ts` | 路径白名单原语（从 `remote-agent/src/fs.ts` 抽出，两端共用） |
| `backend/server/shared/claude-paths.ts` | 导出 `getClaudeHomePath()` / `getClaudeSkillsDir()` |
| `backend/server/modules/skill-sync/types.ts` | 节点、manifest、plan、result 的类型 |
| `backend/server/modules/skill-sync/skill-node.ts` | 节点标签、根目录解析、本地 store |
| `backend/server/modules/skill-sync/remote-skills.service.ts` | 远程 `SkillStore` 的 RPC 客户端 + capability 门控 |
| `backend/server/modules/skill-sync/skill-sync.service.ts` | 编排：plan / plan 缓存 / apply |
| `backend/server/modules/skill-sync/skill-sync.routes.ts` | HTTP API |
| `backend/server/modules/skill-sync/skill-sync.db.ts` | `skill_sync_audit` 读写 |
| `backend/server/modules/operators/operator-skill-sync.tools.ts` | 两个 operator 工具的渲染与开关门控 |
| `web/src/components/settings/SkillSyncSettings.tsx` | 设置页「技能同步」区块 |

**修改**

| 文件 | 改动 |
|---|---|
| `backend/remote-agent/src/config.ts` | 加 `skillRoots` |
| `backend/remote-agent/src/rpc-dispatch.ts` | 加 3 个 `skills/*` 分支 |
| `backend/remote-agent/src/index.ts` | `hello.capabilities` 加 `skills/v1` |
| `backend/server/shared/agent-runtime/protocol.ts` | 加 `SKILLS_CAPABILITY` + 3 个 params schema + 结果类型 |
| `backend/server/modules/database/schema.ts` | 加 `SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL` |
| `backend/server/modules/database/migrations.ts` | 建表迁移 |
| `backend/server/modules/remote-agents/bootstrap.service.ts` | 写 `skillRoots` |
| `backend/server/modules/providers/list/claude/claude-skills.provider.ts` | 删私有 `getClaudeHomePath`，改用共享 helper |
| `backend/server/index.js` | 挂载路由 + 构造单例 |
| `backend/server/modules/operators/operator.tools.ts` | 加 2 个工具 |
| `web/src/components/settings/SettingsPage.tsx` | 挂载新区块 |
| `web/src/utils/api.js` | 4 个 API 封装 |

## 一个实现期发现的约定（写进代码注释）

**远程 user 级 skill 根目录，main 侧发送字面量 `~/.claude/skills`，由 lite 自己展开。**

理由：main 不知道远程主机的 home 目录（`hello` 帧只带 `os`，不带 `homedir`）。lite 的 `fs.ts` 已有 `expandHome()`，且 `skillRoots` 默认值就是 `join(homedir(), '.claude/skills')` —— 发送 `~/.claude/skills` 会被展开成 lite 自己的 home，正好命中白名单默认值。

**项目级**根目录用绝对路径（`join(远程项目 project_path, '.claude/skills')`），main 从 `projects` 表就能拿到。

---

## Task 1: 共享指纹算法 `skill-hash.ts`

main 与 lite 必须算出**逐位相同**的指纹，否则 diff 不成立。所以算法只有一份，两端 import 同一个文件。

**Files:**
- Create: `backend/server/shared/skill-hash.ts`
- Test: `backend/server/shared/tests/skill-hash.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/skill-hash.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectSkillDir,
  computeSkillHash,
  detectEncoding,
  isIgnoredSkillEntry,
  type SkillFileEntry,
} from '../skill-hash.js';

const f = (relativePath: string, content: string, executable = false): SkillFileEntry => ({
  relativePath,
  content,
  encoding: 'utf8',
  executable,
});

async function mkSkillDir(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-hash-'));
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('computeSkillHash is order-independent', () => {
  const a = computeSkillHash([f('SKILL.md', 'a'), f('run.sh', 'b')]);
  const b = computeSkillHash([f('run.sh', 'b'), f('SKILL.md', 'a')]);
  assert.equal(a, b);
});

test('computeSkillHash changes with content, path and exec bit', () => {
  const base = computeSkillHash([f('SKILL.md', 'a')]);
  assert.notEqual(base, computeSkillHash([f('SKILL.md', 'b')]));
  assert.notEqual(base, computeSkillHash([f('OTHER.md', 'a')]));
  assert.notEqual(base, computeSkillHash([f('SKILL.md', 'a', true)]));
});

test('computeSkillHash of an empty skill is stable', () => {
  assert.equal(computeSkillHash([]), computeSkillHash([]));
});

test('computeSkillHash ignores mtimeMs (cross-host clocks are unreliable)', () => {
  const a: SkillFileEntry = { ...f('SKILL.md', 'a'), mtimeMs: 1 };
  const b: SkillFileEntry = { ...f('SKILL.md', 'a'), mtimeMs: 999999999 };
  assert.equal(computeSkillHash([a]), computeSkillHash([b]));
});

test('computeSkillHash round-trips base64 content', () => {
  const bytes = Buffer.from([0x00, 0x01, 0xff]);
  const entry: SkillFileEntry = {
    relativePath: 'logo.png',
    content: bytes.toString('base64'),
    encoding: 'base64',
    executable: false,
  };
  assert.equal(computeSkillHash([entry]), computeSkillHash([{ ...entry }]));
  // 同一份字节，用 utf8 编码声明会算出不同指纹 —— 编码是内容的一部分
  assert.notEqual(computeSkillHash([entry]), computeSkillHash([f('logo.png', bytes.toString('base64'))]));
});

test('isIgnoredSkillEntry skips dotfiles, dot-dirs and node_modules', () => {
  assert.equal(isIgnoredSkillEntry('.git'), true);
  assert.equal(isIgnoredSkillEntry('.skill-sync-backup'), true);
  assert.equal(isIgnoredSkillEntry('.DS_Store'), true);
  assert.equal(isIgnoredSkillEntry('node_modules'), true);
  assert.equal(isIgnoredSkillEntry('SKILL.md'), false);
  assert.equal(isIgnoredSkillEntry('scripts'), false);
});

test('detectEncoding picks base64 for binary content', () => {
  assert.equal(detectEncoding(Buffer.from('hello', 'utf8')), 'utf8');
  assert.equal(detectEncoding(Buffer.from([0x00, 0x01, 0x02])), 'base64');
});

test('collectSkillDir walks recursively, skips ignored entries, POSIX-joins paths', async () => {
  const dir = await mkSkillDir();
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi');
  await fsp.writeFile(path.join(dir, '.git', 'config'), 'ignored');
  await fsp.writeFile(path.join(dir, '.DS_Store'), 'ignored');

  const files = await collectSkillDir(dir);
  assert.deepEqual(files.map((x) => x.relativePath), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(files[0].content, 'hello');
  assert.equal(files[0].encoding, 'utf8');
});

test('collectSkillDir reports the exec bit', async () => {
  const dir = await mkSkillDir();
  await fsp.writeFile(path.join(dir, 'run.sh'), 'echo hi', { mode: 0o755 });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hi', { mode: 0o644 });
  const files = await collectSkillDir(dir);
  assert.equal(files.find((x) => x.relativePath === 'run.sh')?.executable, true);
  assert.equal(files.find((x) => x.relativePath === 'SKILL.md')?.executable, false);
});

test('collectSkillDir skips symlinks', async () => {
  const dir = await mkSkillDir();
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.symlink(path.join(dir, 'SKILL.md'), path.join(dir, 'link.md'));
  const files = await collectSkillDir(dir);
  assert.deepEqual(files.map((x) => x.relativePath), ['SKILL.md']);
});

test('collectSkillDir rejects an oversized single file', async () => {
  const dir = await mkSkillDir();
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
  await fsp.writeFile(path.join(dir, 'big.bin'), big);
  await assert.rejects(() => collectSkillDir(dir), /skill file too large/);
});

test('collectSkillDir output hashes deterministically across calls', async () => {
  const dir = await mkSkillDir();
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi');
  assert.equal(
    computeSkillHash(await collectSkillDir(dir)),
    computeSkillHash(await collectSkillDir(dir)),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-hash.test.ts
```

Expected: FAIL — `Cannot find module '../skill-hash.js'`

- [ ] **Step 3: 写实现**

创建 `backend/server/shared/skill-hash.ts`：

```ts
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Content fingerprint of a skill directory, shared verbatim by the main server
 * and the remote lite agent.
 *
 * Both ends MUST produce bit-identical hashes — the whole diff (and therefore
 * the "preview before overwrite" guarantee) rests on it. There is exactly ONE
 * copy of this algorithm on purpose; do not fork it per side.
 *
 * mtime is deliberately NOT part of the hash: cross-host clocks are
 * unreliable, and including it would make every sync look like a conflict.
 * mtime is carried in the manifest for display only.
 */

/** Directories never walked. Dot-entries are skipped wholesale (see
 * {@link isIgnoredSkillEntry}), which covers `.git`, `.DS_Store` and the
 * `.skill-sync-backup` / `.skill-sync-tmp-*` scratch dirs the apply path
 * creates INSIDE a skill root — they must never leak into a fingerprint. */
export const SKILL_IGNORED_DIRS: readonly string[] = ['node_modules'];

/** Per-file and per-skill transfer caps. These bound a skill BUNDLE (not a
 * single fs read), so they live here rather than in the lite fs layer. */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MiB

export type SkillFileEncoding = 'utf8' | 'base64';

/** One file of a skill directory, in wire form. */
export type SkillFileEntry = {
  /** POSIX separators, relative to the skill directory. */
  relativePath: string;
  content: string;
  encoding: SkillFileEncoding;
  executable: boolean;
  /** Display only — NOT part of the fingerprint (see the module docstring).
   * Optional so hand-built fixtures and the wire format stay simple. */
  mtimeMs?: number;
};

export function isIgnoredSkillEntry(name: string): boolean {
  return name.startsWith('.') || SKILL_IGNORED_DIRS.includes(name);
}

/**
 * `base64` for anything that is not safely representable as text, `utf8`
 * otherwise.
 *
 * The decision is a ROUND-TRIP test, not a NUL scan. A NUL-byte heuristic is
 * not safe on its own: a Latin-1/CP1252/GBK file (or a small binary) with no
 * NUL byte would be labelled `utf8`, and `toString('utf8')` replaces its
 * invalid sequences with U+FFFD. Two different byte sequences then collapse to
 * the same string — same fingerprint for different content — and an applied
 * skill would be silently corrupted while both sides still compare equal.
 *
 * A NUL byte additionally forces `base64` (binary fast path). UTF-8 does permit
 * U+0000, so a NUL is not proof of non-text — but carrying such a file as
 * base64 is never wrong, since base64 is lossless either way.
 *
 * `TextDecoder({ fatal: true })` is deliberately NOT used: it strips a BOM by
 * default, which would introduce a new lossy path.
 */
export function detectEncoding(buf: Buffer): SkillFileEncoding {
  if (buf.includes(0)) return 'base64';
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? 'utf8' : 'base64';
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function entryBytes(entry: SkillFileEntry): Buffer {
  return Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
}

function byRelativePath(a: SkillFileEntry, b: SkillFileEntry): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

/**
 * Fingerprints `files`. Entries are sorted first, so directory enumeration
 * order never changes the result.
 *
 * This is a trust boundary (wire manifests, hand-built fixtures): a duplicate
 * `relativePath` would otherwise make the result depend on input order, so it
 * is rejected outright.
 */
export function computeSkillHash(files: readonly SkillFileEntry[]): string {
  const sorted = [...files].sort(byRelativePath);
  const h = createHash('sha256');
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (i > 0 && entry.relativePath === sorted[i - 1].relativePath) {
      throw new Error(`duplicate relativePath: ${entry.relativePath}`);
    }
    h.update(entry.relativePath);
    h.update('\0');
    h.update(sha256Hex(entryBytes(entry)));
    h.update('\0');
    h.update(entry.executable ? '1' : '0');
    h.update('\0');
  }
  return h.digest('hex');
}

/** O_NOFOLLOW so a file swapped for a symlink between the readdir snapshot and
 * the open cannot be followed out of the skill root. O_NONBLOCK so a FIFO
 * raced in does not block the open forever (ignored for regular files; absent
 * on Windows, hence the `?? 0`). */
const SKILL_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0);

/** Transient conditions that must skip one entry, not fail the whole walk. */
function isSkippableOpenError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  // ELOOP: swapped for a symlink (O_NOFOLLOW). ENOENT: deleted mid-walk.
  return code === 'ELOOP' || code === 'ENOENT';
}

/**
 * Reads every file under `dir` into wire form, sorted by relativePath.
 * Symlinks are never followed (mirrors the lite fs layer) — enforced at open
 * time, not just from the readdir snapshot.
 * Throws when a file exceeds {@link MAX_SKILL_FILE_BYTES} or the skill exceeds
 * {@link MAX_SKILL_TOTAL_BYTES}.
 */
export async function collectSkillDir(dir: string): Promise<SkillFileEntry[]> {
  const out: SkillFileEntry[] = [];
  let total = 0;

  async function walk(current: string): Promise<void> {
    const dirents = await fsp.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      if (isIgnoredSkillEntry(dirent.name)) continue;
      // Fast path only — the authoritative check is O_NOFOLLOW at open time.
      if (dirent.isSymbolicLink()) continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;

      const rel = path.relative(dir, abs).split(path.sep).join('/');

      let handle;
      try {
        handle = await fsp.open(abs, SKILL_OPEN_FLAGS);
      } catch (err) {
        if (isSkippableOpenError(err)) continue;
        throw err;
      }
      try {
        const stat = await handle.stat();
        // A FIFO / device / directory may have raced in after the snapshot.
        if (!stat.isFile()) continue;
        if (stat.size > MAX_SKILL_FILE_BYTES) {
          throw new Error(`skill file too large: ${rel} (${stat.size} bytes)`);
        }

        const buf = await handle.readFile();
        // Re-check against the REAL byte length: the file may have grown
        // between stat and read, which would otherwise bypass the caps.
        if (buf.length > MAX_SKILL_FILE_BYTES) {
          throw new Error(`skill file too large: ${rel} (${buf.length} bytes)`);
        }
        total += buf.length;
        if (total > MAX_SKILL_TOTAL_BYTES) {
          throw new Error(`skill too large: exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`);
        }

        const encoding = detectEncoding(buf);
        out.push({
          relativePath: rel,
          content: buf.toString(encoding),
          encoding,
          executable: (stat.mode & 0o111) !== 0,
          mtimeMs: stat.mtimeMs,
        });
      } finally {
        await handle.close();
      }
    }
  }

  await walk(dir);
  return out.sort(byRelativePath);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-hash.test.ts
```

Expected: `# pass 19` / `# fail 0`

> **执行期修正（commit `0eb39d5`）**：代码审查发现初版 `detectEncoding` 用「含 NUL」判定编码，会让无 NUL 的非 UTF-8 文件（Latin-1/GBK 文本、小二进制）被判成 utf8，`toString('utf8')` 把非法序列替换成 U+FFFD —— **两个不同字节序列塌缩成同一字符串**，不同目录算出同一指纹，且 apply 后字节永久损坏却仍判「一致」。
>
> 上面贴的代码已经是修正版（round-trip 判定 + `O_NOFOLLOW` 打开 + 读后按真实长度复核上限 + 跳过 ENOENT/ELOOP + 重复 relativePath 抛错）。对应新增 7 条测试，总计 19 条。
>
> 无损性已用**全量两字节穷举（65536 组）+ 20 万次随机 fuzz 验证，零有损**。

- [ ] **Step 5: 提交**

```bash
git add backend/server/shared/skill-hash.ts backend/server/shared/tests/skill-hash.test.ts
git commit -m "feat(skill-sync): shared skill fingerprint algorithm"
```

---

## Task 2: lite 侧跨端一致性测试

Task 1 的算法是同一份文件，但**风险在于 lite 打包/部署时会带上另一份拷贝**（`lite-package.ts` 打的是 `remote-agent/` + `server/shared/`）。这条测试用**写死的 golden hash** 把算法冻结住：任何一侧改了算法，这里立刻炸。

**Files:**
- Test: `backend/remote-agent/src/tests/skill-hash-parity.test.ts`

- [ ] **Step 1: 写测试（golden 先留空串）**

创建 `backend/remote-agent/src/tests/skill-hash-parity.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSkillHash, type SkillFileEntry } from '../../../server/shared/skill-hash.js';

/**
 * Golden fingerprint — freezes the algorithm on the LITE side.
 *
 * The main server and the lite agent must agree bit-for-bit, so this constant
 * is duplicated by `backend/server/shared/tests/skill-hash.test.ts`. If you
 * change the algorithm, BOTH goldens must change together in the same commit;
 * a one-sided change means remote diffs silently report every skill as
 * "changed".
 */
const GOLDEN = 'REPLACE_ME';

const FIXTURE: SkillFileEntry[] = [
  { relativePath: 'SKILL.md', content: 'hello', encoding: 'utf8', executable: false },
  { relativePath: 'scripts/run.sh', content: 'echo hi', encoding: 'utf8', executable: true },
];

test('lite computes the same golden fingerprint as main', () => {
  assert.equal(computeSkillHash(FIXTURE), GOLDEN);
});
```

- [ ] **Step 2: 填入 golden 值**

跑一次，从失败信息里读出实际值：

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/skill-hash-parity.test.ts
```

Expected: FAIL，输出形如 `+ actual - expected ... + 'a3f1...' - 'REPLACE_ME'`。把 `+` 那行的 64 位十六进制值抄进 `GOLDEN`。

- [ ] **Step 3: 在 main 侧加同一条 golden 断言**

在 `backend/server/shared/tests/skill-hash.test.ts` 末尾追加（`GOLDEN` 用**同一个值**）：

```ts
test('golden fingerprint is frozen across main and lite', () => {
  // 与 backend/remote-agent/src/tests/skill-hash-parity.test.ts 的 GOLDEN 必须一致
  const GOLDEN = 'THE_SAME_VALUE';
  assert.equal(
    computeSkillHash([
      { relativePath: 'SKILL.md', content: 'hello', encoding: 'utf8', executable: false },
      { relativePath: 'scripts/run.sh', content: 'echo hi', encoding: 'utf8', executable: true },
    ]),
    GOLDEN,
  );
});
```

- [ ] **Step 4: 两条测试都跑通**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/skill-hash-parity.test.ts server/shared/tests/skill-hash.test.ts
```

Expected: `# pass 21` / `# fail 0`（parity 1 条 + skill-hash 20 条）

> **执行期修正（commit `2e64aa0`）**：计划原写的 import 深度 `../../server/shared/` 少一层 —— 测试在 `remote-agent/src/tests/`，到 `backend/` 需要三级 `../../../server/shared/`（与同目录 `session-provider.test.ts` 的既有写法一致）。已按实际修正。
>
> Golden 值：`67235fa7090160e8df19fa7052a0f40e01bb127f0b38991880eee38da70b24f4`，两侧文件各写一份。已独立复算确认匹配，且验证过翻转 exec 位会让它变化（即这条测试真的能抓住算法漂移，不是恒真）。

- [ ] **Step 5: 提交**

```bash
git add backend/remote-agent/src/tests/skill-hash-parity.test.ts backend/server/shared/tests/skill-hash.test.ts
git commit -m "test(skill-sync): freeze skill fingerprint across main and lite"
```

---

## Task 3: 协议层 —— `SKILLS_CAPABILITY` + 3 个 params schema

**Files:**
- Modify: `backend/server/shared/agent-runtime/protocol.ts`
- Test: `backend/server/shared/agent-runtime/tests/skills-params.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/agent-runtime/tests/skills-params.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILLS_CAPABILITY,
  makeSkillsApplyParamsSchema,
  makeSkillsBundleParamsSchema,
  makeSkillsManifestParamsSchema,
} from '../protocol.js';

test('SKILLS_CAPABILITY is the versioned capability string', () => {
  assert.equal(SKILLS_CAPABILITY, 'skills/v1');
});

test('manifest params require a non-empty root', () => {
  assert.deepEqual(makeSkillsManifestParamsSchema().parse({ root: '~/.claude/skills' }), {
    root: '~/.claude/skills',
  });
  assert.throws(() => makeSkillsManifestParamsSchema().parse({ root: '' }));
  assert.throws(() => makeSkillsManifestParamsSchema().parse({}));
});

test('bundle params require root and name', () => {
  const schema = makeSkillsBundleParamsSchema();
  assert.deepEqual(schema.parse({ root: '/srv/.claude/skills', name: 'demo' }), {
    root: '/srv/.claude/skills',
    name: 'demo',
  });
  assert.throws(() => schema.parse({ root: '/srv/.claude/skills' }));
});

test('apply params accept a null expectedTargetHash and default force to false', () => {
  const parsed = makeSkillsApplyParamsSchema().parse({
    root: '/srv/.claude/skills',
    name: 'demo',
    contentHash: 'abc',
    files: [
      { relativePath: 'SKILL.md', content: 'hi', encoding: 'utf8', executable: false },
    ],
    expectedTargetHash: null,
  });
  assert.equal(parsed.expectedTargetHash, null);
  assert.equal(parsed.force, false);
});

test('apply params default encoding to utf8 and executable to false', () => {
  const parsed = makeSkillsApplyParamsSchema().parse({
    root: '/srv/.claude/skills',
    name: 'demo',
    contentHash: 'abc',
    files: [{ relativePath: 'SKILL.md', content: 'hi' }],
    expectedTargetHash: 'def',
  });
  assert.equal(parsed.files[0].encoding, 'utf8');
  assert.equal(parsed.files[0].executable, false);
});

test('apply params reject a relativePath that escapes the skill directory', () => {
  const schema = makeSkillsApplyParamsSchema();
  const base = { root: '/srv/.claude/skills', name: 'demo', contentHash: 'abc', expectedTargetHash: null };
  for (const bad of ['../evil.md', '/etc/passwd', 'a/../../evil.md', 'a\\..\\evil.md', '']) {
    assert.throws(
      () => schema.parse({ ...base, files: [{ relativePath: bad, content: 'x' }] }),
      undefined,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/agent-runtime/tests/skills-params.test.ts
```

Expected: FAIL — `makeSkillsApplyParamsSchema is not a function`

- [ ] **Step 3: 写实现**

在 `backend/server/shared/agent-runtime/protocol.ts` 顶部 import 区加：

```ts
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES, type SkillFileEntry } from '../skill-hash.js';
```

紧挨着现有的 `LLM_FORWARD_CAPABILITY` 常量下方加：

```ts
/** Capability the lite advertises when it implements the directory-level
 * `skills/*` RPCs. Main refuses to plan a sync against a host without it
 * rather than silently falling back to per-file `fs/*` copies (which have no
 * atomicity and cannot fingerprint the remote side). Bump to `skills/v2` if
 * the wire shape ever changes incompatibly. */
export const SKILLS_CAPABILITY = 'skills/v1';
```

在文件末尾（`GitExecResult` 附近）加：

```ts
/** One skill directory as listed by `skills/manifest`. */
export type SkillManifestEntry = {
  /** Directory name — the skill's identity for sync purposes. */
  name: string;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  /** Display only; NEVER part of the fingerprint. */
  mtime: number;
  description?: string;
  version?: string;
  /**
   * Set when the directory could not be read (too large, unreadable, …).
   * `contentHash` is then `''` and the entry is INERT: the listing survives so
   * one bad skill cannot hide every other one, but the sync must refuse to
   * touch it rather than treat an unreadable target as "absent".
   */
  error?: string;
};

/** `skills/manifest` result. `exists: false` means the root has never been
 * created on that host — a normal state, not an error. */
export type RemoteSkillManifest = {
  root: string;
  exists: boolean;
  entries: SkillManifestEntry[];
};

/** `skills/bundle` result: every file of one skill, plus its fingerprint. */
export type RemoteSkillBundle = {
  name: string;
  contentHash: string;
  files: SkillFileEntry[];
};

/** `skills/apply` result. `skipped` means the target already had the desired
 * contentHash, so nothing was written. */
export type RemoteSkillApplyResult = {
  action: 'created' | 'updated' | 'skipped';
  backupPath?: string;
  contentHash: string;
};

/**
 * Rejects a skill-relative path that could escape the skill directory.
 * POSIX and Windows separators are both rejected — a `a\..\evil.md` that slips
 * through here would be joined on Windows and escape.
 */
function skillRelativePathSchema() {
  return z
    .string()
    .min(1)
    .refine(
      (p) =>
        !p.startsWith('/') &&
        !p.startsWith('\\') &&
        !p.includes('\\') &&
        !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'),
      { message: 'relativePath must stay inside the skill directory' },
    );
}

/** Zod schema for the `skills/manifest` `rpc_req` params. */
export function makeSkillsManifestParamsSchema() {
  return z.object({ root: z.string().min(1) });
}

/** Zod schema for the `skills/bundle` `rpc_req` params. */
export function makeSkillsBundleParamsSchema() {
  return z.object({ root: z.string().min(1), name: z.string().min(1) });
}

/**
 * Zod schema for the `skills/apply` `rpc_req` params.
 *
 * `expectedTargetHash` is the fingerprint the caller SAW when it planned the
 * sync; the lite re-hashes the live target and refuses when they differ (the
 * target was modified after the preview). `force: true` overrides that check.
 */
export function makeSkillsApplyParamsSchema() {
  return z.object({
    root: z.string().min(1),
    name: z.string().min(1),
    contentHash: z.string().min(1),
    files: z
      .array(
        z.object({
          relativePath: skillRelativePathSchema(),
          content: z.string(),
          encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
          executable: z.boolean().optional().default(false),
          mtimeMs: z.number().optional(),
        }),
      )
      .max(2000),
    expectedTargetHash: z.string().nullable(),
    force: z.boolean().optional().default(false),
  });
}

/** Compile-time guard: the schema's file shape must stay assignable to the
 * shared `SkillFileEntry` used by the fingerprint algorithm. */
export type SkillsApplyFile = z.infer<
  ReturnType<typeof makeSkillsApplyParamsSchema>
>['files'][number];
const _skillsApplyFileIsSkillFileEntry: SkillFileEntry = {} as SkillsApplyFile;
void _skillsApplyFileIsSkillFileEntry;

/** Caps re-exported so the lite can enforce them without a second import. */
export { MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/agent-runtime/tests/skills-params.test.ts
```

Expected: `# pass 6` / `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add backend/server/shared/agent-runtime/protocol.ts backend/server/shared/agent-runtime/tests/skills-params.test.ts
git commit -m "feat(skill-sync): add skills/* rpc params schemas and capability"
```

---

## Task 4: lite 配置加 `skillRoots`

**为什么是独立白名单而不是复用 `roots`**：`roots` 覆盖的是项目目录，把 home 加进去会顺带放开通用 `fs/*` 对 home 的读写。skill RPC 是目录级的，只该放开 skill 根。

**老主机不用重新 deploy**：zod 的 `.default()` 在解析时补齐，已有的 `~/.lovdex-remote/config.json` 缺这个键会自动拿到默认值。

**Files:**
- Modify: `backend/remote-agent/src/config.ts`
- Test: `backend/remote-agent/src/tests/config.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/remote-agent/src/tests/config.test.ts` 末尾追加：

```ts
test('loadConfig defaults skillRoots to the host home .claude/skills', () => {
  const cfg = loadConfig({
    serverUrl: 'ws://localhost:3188/api/remote-agents/ws',
    token: 'a'.repeat(8),
    hostId: 'h1',
    roots: ['/srv/projects'],
  });
  assert.deepEqual(cfg.skillRoots, [path.join(os.homedir(), '.claude/skills')]);
});

test('loadConfig keeps an explicit skillRoots', () => {
  const cfg = loadConfig({
    serverUrl: 'ws://localhost:3188/api/remote-agents/ws',
    token: 'a'.repeat(8),
    hostId: 'h1',
    roots: ['/srv/projects'],
    skillRoots: ['/srv/shared-skills'],
  });
  assert.deepEqual(cfg.skillRoots, ['/srv/shared-skills']);
});

test('loadConfig rejects an empty skillRoots array', () => {
  assert.throws(() =>
    loadConfig({
      serverUrl: 'ws://localhost:3188/api/remote-agents/ws',
      token: 'a'.repeat(8),
      hostId: 'h1',
      roots: ['/srv/projects'],
      skillRoots: [],
    }),
  );
});
```

在该文件顶部补 import（若已存在则跳过）：

```ts
import os from 'node:os';
import path from 'node:path';
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/config.test.ts
```

Expected: FAIL — `Expected values to be strictly deep-equal: + [] - [ '/home/.../.claude/skills' ]`

- [ ] **Step 3: 写实现**

在 `backend/remote-agent/src/config.ts` 顶部加 import：

```ts
import { homedir } from 'node:os';
import path from 'node:path';
```

把 `configSchema` 改成：

```ts
const configSchema = z.object({
  serverUrl: z.string().min(2),
  token: z.string().min(8),
  hostId: z.string().min(1),
  roots: z.array(z.string()).min(1),
  /**
   * Directories the `skills/*` RPCs may touch, SEPARATE from `roots`.
   *
   * `roots` is the project-directory whitelist for the general `fs/*` surface;
   * adding `~` there would hand the main server read/write over the whole home
   * directory. Skill sync only needs the skill roots, so it gets its own list.
   *
   * Defaults to this host's `~/.claude/skills` — and because it is a zod
   * default (not a required field), a lite deployed before this option existed
   * picks it up on the next parse without a re-deploy.
   */
  skillRoots: z.array(z.string()).min(1).default(() => [path.join(homedir(), '.claude/skills')]),
  agentVersion: z.string().default('0.1.0'),
  apiKeyEnvPath: z.string().optional(),
  claudeCliPath: z.string().optional(),
});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/config.test.ts
```

Expected: `# fail 0`，且新增 3 条全部 pass

- [ ] **Step 5: 加一个容错的读取 helper**

`skillRoots` 在 zod 输出类型里是**必填**，但仓库里不少测试用 `{ roots: [root] } as unknown as RemoteAgentConfig` 造 cfg（`fs.test.ts:182` 等）。直接 `cfg.skillRoots` 会拿到 `undefined` 并在展开时抛错。在 `config.ts` 末尾加：

```ts
/**
 * Every directory the `skills/*` RPCs may touch: the project roots plus the
 * dedicated skill roots.
 *
 * Defensive about `skillRoots` being absent: `loadConfig` always fills it, but
 * tests and older call sites construct config literals directly. An absent
 * list degrades to "skill roots are just the project roots" rather than
 * throwing.
 */
export function skillRootsOf(cfg: RemoteAgentConfig): string[] {
  return [...cfg.roots, ...(cfg.skillRoots ?? [])];
}
```

- [ ] **Step 6: 修被类型变更打到的测试 fixture**

`remote-agent/src/tests/index.test.ts:7` 和 `remote-agent/src/tests/rpc-dispatch-messages.test.ts:14` 是仓库里仅有的两个**带类型**的 `RemoteAgentConfig` 字面量。给它们各加一行：

```ts
  skillRoots: ['/home/lite/.claude/skills'],
```

然后确认零新增类型错误：

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -20
```

Expected: 错误数量与改动前一致（baseline 有 pre-existing 错误，**不能多**）

- [ ] **Step 7: 提交**

```bash
git add backend/remote-agent/src/config.ts backend/remote-agent/src/tests/config.test.ts backend/remote-agent/src/tests/index.test.ts backend/remote-agent/src/tests/rpc-dispatch-messages.test.ts
git commit -m "feat(remote-agent): add skillRoots allowlist to lite config"
```

---

## Task 5: 共享 `claude-paths.ts`

`getClaudeHomePath` 现在是 `claude-skills.provider.ts:20` 的模块私有 const。同步逻辑也要用它 —— 不导出就会两边各写一份 `join(homedir(), '.claude')`，迟早漂移。

**Files:**
- Create: `backend/server/shared/claude-paths.ts`
- Modify: `backend/server/modules/providers/list/claude/claude-skills.provider.ts:20`
- Test: `backend/server/shared/tests/claude-paths.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/claude-paths.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { getClaudeHomePath, getClaudeSkillsDir } from '../claude-paths.js';

test('getClaudeHomePath is ~/.claude', () => {
  assert.equal(getClaudeHomePath(), path.join(os.homedir(), '.claude'));
});

test('getClaudeSkillsDir is ~/.claude/skills', () => {
  assert.equal(getClaudeSkillsDir(), path.join(os.homedir(), '.claude', 'skills'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/claude-paths.test.ts
```

Expected: FAIL — `Cannot find module '../claude-paths.js'`

- [ ] **Step 3: 写实现**

创建 `backend/server/shared/claude-paths.ts`：

```ts
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code's per-user config root (`~/.claude`).
 *
 * Shared by the provider skill discovery (`claude-skills.provider.ts`) and the
 * skill-sync local node, so the two can never drift onto different roots.
 */
export const getClaudeHomePath = (): string => path.join(os.homedir(), '.claude');

/** Claude Code's user-level skills directory (`~/.claude/skills`). */
export const getClaudeSkillsDir = (): string => path.join(getClaudeHomePath(), 'skills');
```

在 `backend/server/modules/providers/list/claude/claude-skills.provider.ts` 里**删掉**第 20 行的 `const getClaudeHomePath = ...`，改为从共享模块 import：

```ts
import { getClaudeHomePath } from '@/shared/claude-paths.js';
```

（若该文件已有 `os` / `path` 的 import 且因此变为未使用，一并删掉对应 import。）

- [ ] **Step 4: 跑测试确认通过 + 回归**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/claude-paths.test.ts server/modules/providers/tests/skills.test.ts
```

Expected: 两条文件全部 pass（`skills.test.ts` 是回归 —— 证明抽取没改变 provider 行为）

- [ ] **Step 5: 提交**

```bash
git add backend/server/shared/claude-paths.ts backend/server/shared/tests/claude-paths.test.ts backend/server/modules/providers/list/claude/claude-skills.provider.ts
git commit -m "refactor(providers): extract getClaudeHomePath into shared claude-paths"
```

---

## Task 6: 抽取路径白名单到 `shared/path-allowlist.ts`

**为什么必须先做这一步**：SkillStore 的 apply 是整个功能里最容易出错的代码（原子写 + 备份 + 回滚）。如果 lite 和 main 的本地节点各写一份，就等于把最危险的逻辑复制成两份。所以把整份 SkillStore 放进 `server/shared/`，两端共用 —— 这也让「本地只是另一个节点」这句话在代码层面**字面成立**。

SkillStore 需要 `resolveWithinRoots`，它现在住在 `remote-agent/src/fs.ts` 里。这几个函数是纯的（只用 `node:fs|path|os`），搬到 shared 没有副作用。**`fs.test.ts` 的 15 条测试就是这次搬迁的回归网** —— 它们逐条覆盖了 symlink、`..` 穿越、白名单拒绝。

**Files:**
- Create: `backend/server/shared/path-allowlist.ts`
- Modify: `backend/remote-agent/src/fs.ts:1-160`

- [ ] **Step 1: 把函数原样搬到新文件**

创建 `backend/server/shared/path-allowlist.ts`，内容为从 `backend/remote-agent/src/fs.ts` **逐字搬过来**的以下成员（连同它们的注释）：

- `expandHome`（私有）
- `resolveDisplayPath`（私有）
- `resolveRealPath`（私有）
- `resolveWithin`（私有）
- `resolveWithinRoots`（**导出**）

文件头部 import 与 `fs.ts` 保持一致：

```ts
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
```

在文件顶部加一段模块说明：

```ts
/**
 * Path allowlist primitives shared by the main server and the remote lite
 * agent.
 *
 * A symlink- and `..`-aware resolver that answers exactly one question: "is
 * this path inside one of these roots?" The security decision always uses the
 * realpath form; the caller gets the lexical (symlink-preserving) form back so
 * a symlinked project root keeps the path the user actually chose.
 *
 * Extracted verbatim from `remote-agent/src/fs.ts` so the skill store can run
 * on BOTH sides without forking this logic.
 */
```

- [ ] **Step 2: 让 `fs.ts` 改用它**

在 `backend/remote-agent/src/fs.ts` 里删掉搬走的五个函数，改为：

```ts
import { resolveWithinRoots } from '../../server/shared/path-allowlist.js';

// Re-exported so existing importers (`skills.ts`, tests, future callers) keep
// resolving it from here.
export { resolveWithinRoots };
```

`fs.ts` 里如果 `existsSync` / `realpathSync` / `homedir` 因此变成未使用，一并删掉对应的 import 与 `expandHome` 的调用点。

- [ ] **Step 3: 跑回归测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/fs.test.ts remote-agent/src/tests/fs-write.test.ts remote-agent/src/tests/git.test.ts
```

Expected: 三个文件全部 `# fail 0`（这是纯搬迁，**行为必须一模一样**）

- [ ] **Step 4: 确认零新增类型错误**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -20
```

Expected: 错误数量与改动前一致

- [ ] **Step 5: 提交**

```bash
git add backend/server/shared/path-allowlist.ts backend/remote-agent/src/fs.ts
git commit -m "refactor(remote-agent): extract path allowlist into shared module"
```

---

## Task 7: 共享 `skill-store.ts` —— manifest

**Files:**
- Create: `backend/server/shared/skill-store.ts`
- Test: `backend/server/shared/tests/skill-store-manifest.test.ts`

**背景**：这个模块同时被 main（本地节点）和 lite（远程节点）使用。lite 用 esbuild 打包（`lite-package.ts:68`，**故意不带 `--packages=external`**），所以 import 的 npm 依赖会被打进 `dist/lite.mjs`。`skill-hash.ts` 与 `path-allowlist.ts` 只用 node 内建（零成本）；`frontmatter.ts` 会带进 `gray-matter` + `js-yaml`（约 100KB），为了在列表里显示 description/version 值得。

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/skill-store-manifest.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillStore } from '../skill-store.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-store-'));
  return fsp.realpath(dir);
}

async function writeSkill(root: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

test('manifest returns exists:false for a root that has never been created', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(path.join(root, 'nope'));
  assert.equal(result.exists, false);
  assert.deepEqual(result.entries, []);
});

test('manifest lists skill directories with hash, size and frontmatter', async () => {
  const root = await mkRoot();
  const body = '---\nname: demo\ndescription: A demo skill\nversion: 1.2.0\n---\n\nBody\n';
  await writeSkill(root, 'demo', { 'SKILL.md': body, 'scripts/run.sh': 'echo hi' });
  const store = createSkillStore({ roots: [root] });

  const result = await store.manifest(root);
  assert.equal(result.exists, true);
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.name, 'demo');
  assert.equal(entry.fileCount, 2);
  assert.equal(entry.totalBytes, Buffer.byteLength(body) + Buffer.byteLength('echo hi'));
  assert.equal(entry.description, 'A demo skill');
  assert.equal(entry.version, '1.2.0');
  assert.match(entry.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(entry.mtime > 0);
});

test('manifest skips dot-entries, node_modules, plain files and symlinks', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'demo', { 'SKILL.md': 'hi' });
  await writeSkill(root, '.skill-sync-backup', { 'SKILL.md': 'backup' });
  await writeSkill(root, 'node_modules', { 'SKILL.md': 'dep' });
  await fsp.writeFile(path.join(root, 'loose.md'), 'not a skill');
  await fsp.symlink(path.join(root, 'demo'), path.join(root, 'linked'));

  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);
  assert.deepEqual(result.entries.map((e) => e.name), ['demo']);
});

test('manifest sorts entries by name', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'zeta', { 'SKILL.md': 'z' });
  await writeSkill(root, 'alpha', { 'SKILL.md': 'a' });
  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);
  assert.deepEqual(result.entries.map((e) => e.name), ['alpha', 'zeta']);
});

test('manifest tolerates malformed frontmatter', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'demo', { 'SKILL.md': '---\n: : bad yaml [\n---\nbody' });
  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].description, undefined);
  assert.match(result.entries[0].contentHash, /^[0-9a-f]{64}$/);
});

test('manifest marks an oversized skill as inert instead of failing the listing', async () => {
  const root = await mkRoot();
  await writeSkill(root, 'good', { 'SKILL.md': 'hi' });
  await writeSkill(root, 'huge', { 'big.bin': 'x' });
  await fsp.writeFile(path.join(root, 'huge', 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  const store = createSkillStore({ roots: [root] });
  const result = await store.manifest(root);

  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName.good.error, undefined);
  assert.match(byName.good.contentHash, /^[0-9a-f]{64}$/);
  assert.match(byName.huge.error ?? '', /skill file too large/);
  assert.equal(byName.huge.contentHash, '');
});

test('manifest rejects a root outside the allowlist', async () => {
  const root = await mkRoot();
  const outside = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(() => store.manifest(outside), /path outside allowed root/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-manifest.test.ts
```

Expected: FAIL — `Cannot find module '../skill-store.js'`

- [ ] **Step 3: 写实现**

创建 `backend/server/shared/skill-store.ts`：

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { collectSkillDir, computeSkillHash, isIgnoredSkillEntry, type SkillFileEntry } from './skill-hash.js';
import { parseFrontMatter } from './frontmatter.js';
import { resolveWithinRoots } from './path-allowlist.js';
import type {
  RemoteSkillApplyResult,
  RemoteSkillBundle,
  RemoteSkillManifest,
  SkillManifestEntry,
} from './agent-runtime/protocol.js';

/**
 * Directory-level skill read/write, shared by the main server's local node and
 * the remote lite agent.
 *
 * Both sides run THIS code — same fingerprint, same atomic-write discipline —
 * which is what lets the sync orchestrator treat "local" and "remote" as two
 * interchangeable nodes with no branching.
 *
 * Scratch directories (backup / staging / the pre-swap original) are all
 * dot-prefixed so `isIgnoredSkillEntry` skips them: they must never show up in
 * a manifest or leak into a fingerprint.
 */
export const SKILL_BACKUP_DIR = '.skill-sync-backup';
const SKILL_TMP_PREFIX = '.skill-sync-tmp-';
const SKILL_OLD_PREFIX = '.skill-sync-old-';

/** A skill name is a single directory name — never a path. */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

export type SkillApplyInput = {
  root: string;
  name: string;
  /** The fingerprint the caller believes `files` produce (verified here). */
  contentHash: string;
  files: SkillFileEntry[];
  /** Fingerprint the caller saw for the CURRENT target during planning.
   * `null` means "the target did not exist". */
  expectedTargetHash: string | null;
  force: boolean;
};

export type SkillStore = {
  manifest(root: string): Promise<RemoteSkillManifest>;
  bundle(root: string, name: string): Promise<RemoteSkillBundle>;
  apply(input: SkillApplyInput): Promise<RemoteSkillApplyResult>;
};

function byteLength(entry: SkillFileEntry): number {
  return Buffer.byteLength(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Builds a manifest row from an already-collected skill directory.
 *
 * Frontmatter parsing is best-effort: a malformed block must not break the
 * whole listing, because the skill still syncs fine by content hash.
 */
export function buildManifestEntry(name: string, files: SkillFileEntry[]): SkillManifestEntry {
  let description: string | undefined;
  let version: string | undefined;
  const skillMd = files.find((f) => f.relativePath === 'SKILL.md' && f.encoding === 'utf8');
  if (skillMd) {
    try {
      const data = parseFrontMatter(skillMd.content).data as Record<string, unknown>;
      if (typeof data.description === 'string') description = data.description;
      if (typeof data.version === 'string') version = data.version;
      else if (typeof data.version === 'number') version = String(data.version);
    } catch {
      // ignore — see docstring
    }
  }
  return {
    name,
    contentHash: computeSkillHash(files),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + byteLength(f), 0),
    mtime: files.reduce((n, f) => Math.max(n, f.mtimeMs ?? 0), 0),
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

export function createSkillStore(opts: { roots: string[] }): SkillStore {
  const roots = opts.roots;

  function resolveRoot(root: string): string {
    return resolveWithinRoots(root, roots);
  }

  /** Resolves `<root>/<name>` and asserts `name` is exactly ONE path segment. */
  function resolveSkillDir(root: string, name: string): string {
    if (!SKILL_NAME_RE.test(name) || name === '.' || name === '..') {
      throw new Error(`invalid skill name: ${name}`);
    }
    const resolvedRoot = resolveRoot(root);
    const dir = resolveWithinRoots(path.join(resolvedRoot, name), roots);
    // Belt and braces: `path.join` + the allowlist already block traversal, but
    // assert the parent so a name can never address a nested directory.
    if (path.dirname(dir) !== resolvedRoot) {
      throw new Error(`invalid skill name: ${name}`);
    }
    return dir;
  }

  async function readExistingHash(dir: string): Promise<string | null> {
    let stat;
    try {
      stat = await fsp.stat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
    return computeSkillHash(await collectSkillDir(dir));
  }

  return {
    async manifest(root) {
      const resolvedRoot = resolveRoot(root);
      let dirents;
      try {
        dirents = await fsp.readdir(resolvedRoot, { withFileTypes: true });
      } catch (err) {
        // A host that has never had a skill installed is a normal state, not
        // an error — main renders "此主机还没有技能" from exists:false.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { root: resolvedRoot, exists: false, entries: [] };
        }
        throw err;
      }

      const entries: SkillManifestEntry[] = [];
      for (const dirent of dirents) {
        if (isIgnoredSkillEntry(dirent.name)) continue;
        if (dirent.isSymbolicLink() || !dirent.isDirectory()) continue;
        try {
          const files = await collectSkillDir(path.join(resolvedRoot, dirent.name));
          entries.push(buildManifestEntry(dirent.name, files));
        } catch (err) {
          // One unreadable or oversized skill must not blank the whole listing
          // — that would hide every OTHER skill too. Record it as inert and let
          // the plan refuse to touch it.
          entries.push({
            name: dirent.name,
            contentHash: '',
            fileCount: 0,
            totalBytes: 0,
            mtime: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { root: resolvedRoot, exists: true, entries: entries.sort(byName) };
    },

    // bundle / apply land in Task 8 and Task 9.
    async bundle() {
      throw new Error('not implemented');
    },
    async apply() {
      throw new Error('not implemented');
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-manifest.test.ts
```

Expected: `# pass 7` / `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add backend/server/shared/skill-store.ts backend/server/shared/tests/skill-store-manifest.test.ts
git commit -m "feat(skill-sync): shared skill store manifest"
```

---

## Task 8: 共享 `skill-store.ts` —— bundle

**Files:**
- Modify: `backend/server/shared/skill-store.ts`
- Test: `backend/server/shared/tests/skill-store-bundle.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/skill-store-bundle.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillStore } from '../skill-store.js';
import { computeSkillHash } from '../skill-hash.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-store-bundle-'));
  return fsp.realpath(dir);
}

test('bundle returns every file plus a matching fingerprint', async () => {
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');
  await fsp.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi', { mode: 0o755 });

  const store = createSkillStore({ roots: [root] });
  const bundle = await store.bundle(root, 'demo');

  assert.equal(bundle.name, 'demo');
  assert.deepEqual(bundle.files.map((f) => f.relativePath), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(bundle.files.find((f) => f.relativePath === 'scripts/run.sh')?.executable, true);
  assert.equal(bundle.contentHash, computeSkillHash(bundle.files));
});

test('bundle base64-encodes binary files', async () => {
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x00, 0x01, 0xff]));
  const store = createSkillStore({ roots: [root] });
  const bundle = await store.bundle(root, 'demo');
  assert.equal(bundle.files[0].encoding, 'base64');
  assert.equal(Buffer.from(bundle.files[0].content, 'base64').toString('hex'), '0001ff');
});

test('bundle rejects a missing skill', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(() => store.bundle(root, 'ghost'), /skill not found: ghost/);
});

test('bundle rejects path-traversal names', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  for (const bad of ['..', '.', 'a/b', '../demo', 'demo/../other']) {
    await assert.rejects(() => store.bundle(root, bad), /invalid skill name/);
  }
});

test('bundle rejects a root outside the allowlist', async () => {
  const root = await mkRoot();
  const outside = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(() => store.bundle(outside, 'demo'), /path outside allowed root/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-bundle.test.ts
```

Expected: FAIL — `not implemented`

- [ ] **Step 3: 写实现**

把 `backend/server/shared/skill-store.ts` 里 `bundle` 的 stub 替换为：

```ts
    async bundle(root, name) {
      const dir = resolveSkillDir(root, name);
      let files;
      try {
        files = await collectSkillDir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`skill not found: ${name}`);
        }
        throw err;
      }
      return { name, contentHash: computeSkillHash(files), files };
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-bundle.test.ts
```

Expected: `# pass 5` / `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add backend/server/shared/skill-store.ts backend/server/shared/tests/skill-store-bundle.test.ts
git commit -m "feat(skill-sync): shared skill store bundle read"
```

---

## Task 9: 共享 `skill-store.ts` —— apply（原子写 + 备份 + 回滚）

整个功能里风险最高的一段。**写入顺序不能改**：POSIX 上 `rename` 到已存在的非空目录会 `ENOTEMPTY`，所以必须先把旧目录挪走。

**Files:**
- Modify: `backend/server/shared/skill-store.ts`
- Test: `backend/server/shared/tests/skill-store-apply.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/shared/tests/skill-store-apply.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillStore, SKILL_BACKUP_DIR } from '../skill-store.js';
import { collectSkillDir, computeSkillHash, type SkillFileEntry } from '../skill-hash.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-store-apply-'));
  return fsp.realpath(dir);
}

function file(relativePath: string, content: string, executable = false): SkillFileEntry {
  return { relativePath, content, encoding: 'utf8', executable };
}

/** 把 files 打包成 apply 需要的形状（contentHash 由真实算法算出）。 */
function bundleOf(files: SkillFileEntry[]) {
  return { files, contentHash: computeSkillHash(files) };
}

async function readSkill(root: string, name: string): Promise<string> {
  const files = await collectSkillDir(path.join(root, name));
  return JSON.stringify(files.map((f) => [f.relativePath, f.content]));
}

test('apply creates a new skill and reports created', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const { files, contentHash } = bundleOf([file('SKILL.md', 'hello')]);

  const result = await store.apply({
    root, name: 'demo', contentHash, files, expectedTargetHash: null, force: false,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.backupPath, undefined);
  assert.equal(result.contentHash, contentHash);
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'hello');
});

test('apply updates an existing skill and backs the old version up', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });

  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  const result = await store.apply({
    root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false,
  });

  assert.equal(result.action, 'updated');
  assert.ok(result.backupPath);
  assert.equal(await fsp.readFile(path.join(result.backupPath!, 'SKILL.md'), 'utf8'), 'v1');
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'v2');
});

test('apply skips when the target already matches', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });

  const again = await store.apply({
    root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: v1.contentHash, force: false,
  });
  assert.equal(again.action, 'skipped');
  assert.equal(again.backupPath, undefined);
});

test('apply refuses when the target drifted from the previewed hash', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  // 目标在预览之后被改了
  await fsp.writeFile(path.join(root, 'demo', 'SKILL.md'), 'edited-locally');

  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  await assert.rejects(
    () => store.apply({ root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false }),
    /target changed/,
  );
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'edited-locally');
});

test('apply with force overwrites a drifted target', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  await fsp.writeFile(path.join(root, 'demo', 'SKILL.md'), 'edited-locally');

  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  const result = await store.apply({
    root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: true,
  });
  assert.equal(result.action, 'updated');
  assert.equal(await fsp.readFile(path.join(root, 'demo', 'SKILL.md'), 'utf8'), 'v2');
});

test('apply rejects a declared contentHash that the files do not produce', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: 'f'.repeat(64), files: [file('SKILL.md', 'hello')],
      expectedTargetHash: null, force: false,
    }),
    /bundle hash mismatch/,
  );
  await assert.rejects(() => fsp.stat(path.join(root, 'demo')), /ENOENT/);
});

test('apply preserves the executable bit', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const { files, contentHash } = bundleOf([file('SKILL.md', 'hi'), file('scripts/run.sh', 'echo hi', true)]);
  await store.apply({ root, name: 'demo', contentHash, files, expectedTargetHash: null, force: false });

  const stat = await fsp.stat(path.join(root, 'demo', 'scripts', 'run.sh'));
  assert.ok((stat.mode & 0o111) !== 0, 'exec bit must survive the round trip');
  const round = await store.bundle(root, 'demo');
  assert.equal(round.contentHash, contentHash);
});

test('apply rejects an unsafe relativePath', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  await assert.rejects(
    () => store.apply({
      root, name: 'demo', contentHash: computeSkillHash([file('../evil.md', 'x')]),
      files: [file('../evil.md', 'x')], expectedTargetHash: null, force: false,
    }),
    /unsafe relativePath/,
  );
});

test('a failed apply leaves the existing skill untouched', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — permission bits do not apply');
    return;
  }
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  const before = await readSkill(root, 'demo');

  // 只读根目录：staging 目录建不出来，写入必须在碰到原目录之前就失败
  await fsp.chmod(root, 0o500);
  try {
    const v2 = bundleOf([file('SKILL.md', 'v2')]);
    await assert.rejects(() =>
      store.apply({ root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false }),
    );
  } finally {
    await fsp.chmod(root, 0o700);
  }

  assert.equal(await readSkill(root, 'demo'), before);
});

test('the backup directory is never listed as a skill', async () => {
  const root = await mkRoot();
  const store = createSkillStore({ roots: [root] });
  const v1 = bundleOf([file('SKILL.md', 'v1')]);
  await store.apply({ root, name: 'demo', contentHash: v1.contentHash, files: v1.files, expectedTargetHash: null, force: false });
  const v2 = bundleOf([file('SKILL.md', 'v2')]);
  await store.apply({ root, name: 'demo', contentHash: v2.contentHash, files: v2.files, expectedTargetHash: v1.contentHash, force: false });

  assert.equal((await fsp.stat(path.join(root, SKILL_BACKUP_DIR))).isDirectory(), true);
  const manifest = await store.manifest(root);
  assert.deepEqual(manifest.entries.map((e) => e.name), ['demo']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-apply.test.ts
```

Expected: FAIL — `not implemented`

- [ ] **Step 3: 写实现**

把 `backend/server/shared/skill-store.ts` 里 `apply` 的 stub 替换为：

```ts
    async apply(input) {
      const dir = resolveSkillDir(input.root, input.name);
      const parent = path.dirname(dir);

      // 1. The caller's declared hash must actually match the files it sent —
      //    otherwise the drift checks below compare against a lie.
      const desired = computeSkillHash(input.files);
      if (desired !== input.contentHash) {
        throw new Error(
          `bundle hash mismatch for ${input.name}: declared ${input.contentHash}, computed ${desired}`,
        );
      }

      const current = await readExistingHash(dir);
      if (current === desired) {
        return { action: 'skipped', contentHash: desired };
      }
      // 2. The target must still be what the caller previewed. This is what
      //    makes "preview before overwrite" real rather than decorative: a
      //    skill edited on this host since the preview is never silently lost.
      if (current !== null && current !== input.expectedTargetHash && !input.force) {
        throw new Error(
          `target changed: ${input.name} on this host no longer matches the previewed hash`,
        );
      }

      // 3. Back up the current version before touching anything.
      let backupPath: string | undefined;
      if (current !== null) {
        backupPath = path.join(parent, SKILL_BACKUP_DIR, `${input.name}.${stamp()}`);
        await fsp.mkdir(path.dirname(backupPath), { recursive: true });
        await fsp.cp(dir, backupPath, { recursive: true });
      }

      // 4. Stage the new content in a sibling temp dir (same filesystem, so
      //    the rename below is atomic).
      const tmpDir = path.join(parent, `${SKILL_TMP_PREFIX}${randomUUID()}`);
      await fsp.mkdir(tmpDir, { recursive: true });
      try {
        await writeSkillFiles(tmpDir, input.files);
      } catch (err) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        throw err;
      }

      // 5. Swap. POSIX rename onto a NON-EMPTY directory fails with ENOTEMPTY,
      //    so the old directory has to move aside first.
      const oldDir = path.join(parent, `${SKILL_OLD_PREFIX}${randomUUID()}`);
      let movedAside = false;
      try {
        if (current !== null) {
          await fsp.rename(dir, oldDir);
          movedAside = true;
        }
        await fsp.rename(tmpDir, dir);
      } catch (err) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        if (movedAside) {
          // Put the original back — a failed swap must not leave a hole.
          await fsp.rename(oldDir, dir);
        }
        throw err;
      }

      // 6. Verify what actually landed; restore from the backup if it differs.
      const landed = await readExistingHash(dir);
      if (landed !== desired) {
        await fsp.rm(dir, { recursive: true, force: true });
        if (backupPath) await fsp.cp(backupPath, dir, { recursive: true });
        throw new Error(`post-write verification failed for ${input.name}`);
      }

      if (movedAside) await fsp.rm(oldDir, { recursive: true, force: true });

      return {
        action: current === null ? 'created' : 'updated',
        ...(backupPath !== undefined ? { backupPath } : {}),
        contentHash: desired,
      };
    },
```

并在 `createSkillStore` 外层（文件末尾）加两个辅助函数：

```ts
/** Filesystem-safe ISO timestamp for backup directory names. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Writes `files` under `baseDir`, recreating the directory structure.
 *
 * `relativePath` is validated again here (not just at the RPC schema) because
 * this function is also reachable from unit tests and any future caller that
 * builds a bundle in-process.
 */
async function writeSkillFiles(baseDir: string, files: readonly SkillFileEntry[]): Promise<void> {
  for (const file of files) {
    const abs = path.join(baseDir, ...file.relativePath.split('/'));
    const rel = path.relative(baseDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`unsafe relativePath: ${file.relativePath}`);
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const mode = file.executable ? 0o755 : 0o644;
    await fsp.writeFile(abs, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), { mode });
    // writeFile's mode is masked by umask, so normalize explicitly — the exec
    // bit is part of the fingerprint and must survive the round trip.
    await fsp.chmod(abs, mode);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-apply.test.ts
```

Expected: `# pass 10` / `# fail 0`（`# skipped 1` 仅当以 root 运行）

- [ ] **Step 5: 跑本阶段全部四个文件确认没有互相破坏**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/skill-store-manifest.test.ts server/shared/tests/skill-store-bundle.test.ts server/shared/tests/skill-store-apply.test.ts
```

Expected: `# fail 0`

- [ ] **Step 6: 提交**

```bash
git add backend/server/shared/skill-store.ts backend/server/shared/tests/skill-store-apply.test.ts
git commit -m "feat(skill-sync): atomic skill apply with backup and rollback"
```

---

## Task 10: lite 接入 —— `skills.ts` 包装 + 3 个 RPC 分支 + capability

**Files:**
- Create: `backend/remote-agent/src/skills.ts`
- Modify: `backend/remote-agent/src/rpc-dispatch.ts`
- Modify: `backend/remote-agent/src/index.ts:101`
- Test: `backend/remote-agent/src/tests/skills-rpc.test.ts`
- Test: `backend/remote-agent/src/tests/index.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/remote-agent/src/tests/skills-rpc.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleRpc } from '../rpc-dispatch.js';
import { __resetSkillStoreForTests } from '../skills.js';
import type { RemoteAgentConfig } from '../config.js';

async function mkRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-skills-rpc-'));
  return fsp.realpath(dir);
}

function cfgFor(roots: string[]): RemoteAgentConfig {
  return {
    serverUrl: 'ws://localhost:3188/api/remote-agents/ws',
    token: 'a'.repeat(8),
    hostId: 'h1',
    roots,
    skillRoots: roots,
    agentVersion: '0.1.0',
  };
}

test('handleRpc skills/manifest lists skills under the configured skill root', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');

  const result = (await handleRpc('skills/manifest', { root }, cfgFor([root]))) as {
    entries: { name: string }[];
  };
  assert.deepEqual(result.entries.map((e) => e.name), ['demo']);
});

test('handleRpc skills/bundle returns files for one skill', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const dir = path.join(root, 'demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'hello');

  const result = (await handleRpc('skills/bundle', { root, name: 'demo' }, cfgFor([root]))) as {
    files: unknown[];
    contentHash: string;
  };
  assert.equal(result.files.length, 1);
  assert.match(result.contentHash, /^[0-9a-f]{64}$/);
});

test('handleRpc skills/apply round-trips a bundle into a second skill', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const cfg = cfgFor([root]);
  const src = path.join(root, 'demo');
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(src, 'SKILL.md'), 'hello');

  const bundle = (await handleRpc('skills/bundle', { root, name: 'demo' }, cfg)) as {
    contentHash: string;
    files: unknown[];
  };
  const result = (await handleRpc(
    'skills/apply',
    { root, name: 'copy', contentHash: bundle.contentHash, files: bundle.files, expectedTargetHash: null },
    cfg,
  )) as { action: string };

  assert.equal(result.action, 'created');
  assert.equal(await fsp.readFile(path.join(root, 'copy', 'SKILL.md'), 'utf8'), 'hello');
});

test('handleRpc skills/* rejects params that fail the schema', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  await assert.rejects(() => handleRpc('skills/manifest', {}, cfgFor([root])));
  await assert.rejects(() => handleRpc('skills/bundle', { root }, cfgFor([root])));
});

test('handleRpc skills/* enforces the allowlist', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  const outside = await mkRoot();
  await assert.rejects(
    () => handleRpc('skills/manifest', { root: outside }, cfgFor([root])),
    /path outside allowed root/,
  );
});

test('handleRpc skills/* degrades to cfg.roots when skillRoots is absent', async () => {
  __resetSkillStoreForTests();
  const root = await mkRoot();
  // 模拟老的/未类型化的 cfg（仓库里多处用 as unknown as RemoteAgentConfig 造）
  const cfg = {
    serverUrl: 'ws://x/y',
    token: 'a'.repeat(8),
    hostId: 'h1',
    roots: [root],
    agentVersion: '0.1.0',
  } as unknown as RemoteAgentConfig;

  const result = (await handleRpc('skills/manifest', { root }, cfg)) as { exists: boolean };
  assert.equal(result.exists, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/skills-rpc.test.ts
```

Expected: FAIL — `Cannot find module '../skills.js'`

- [ ] **Step 3: 写 lite 包装模块**

创建 `backend/remote-agent/src/skills.ts`：

```ts
import { createSkillStore, type SkillStore } from '../../server/shared/skill-store.js';
import { skillRootsOf, type RemoteAgentConfig } from './config.js';

/**
 * The lite's skill store: the SHARED implementation, scoped to this host's
 * allowlist (project roots + the dedicated skill roots).
 *
 * Deliberately thin — the main server's local node calls the exact same
 * `createSkillStore`, so a skill written here and one written there are
 * indistinguishable by construction. There is no lite-specific write logic to
 * drift out of sync.
 */
let cachedKey: string | null = null;
let cached: SkillStore | null = null;

export function skillStoreFor(cfg: RemoteAgentConfig): SkillStore {
  const roots = skillRootsOf(cfg);
  const key = roots.join('\0');
  if (cachedKey !== null && cachedKey === key && cached !== null) return cached;
  cachedKey = key;
  cached = createSkillStore({ roots });
  return cached;
}

/** TEST SEAM ONLY — drop the memoized store so a test with different roots
 * builds a fresh one. Double underscore marks it test-only. */
export function __resetSkillStoreForTests(): void {
  cachedKey = null;
  cached = null;
}
```

- [ ] **Step 4: 接进 `handleRpc`**

在 `backend/remote-agent/src/rpc-dispatch.ts` 顶部加 import：

```ts
import { skillStoreFor } from './skills.js';
import {
  makeSkillsApplyParamsSchema,
  makeSkillsBundleParamsSchema,
  makeSkillsManifestParamsSchema,
} from '../../server/shared/agent-runtime/protocol.js';
```

（把 `makeSkillsApplyParamsSchema` 等并进已有的 `protocol.js` import 语句即可。）

在 `handleRpc` 里 `providers/probe` 分支之后、`throw new Error('unknown rpc method: ...')` 之前插入：

```ts
  if (method === 'skills/manifest' || method === 'skills/bundle' || method === 'skills/apply') {
    const store = skillStoreFor(cfg);
    if (method === 'skills/manifest') {
      const p = makeSkillsManifestParamsSchema().parse(params);
      return store.manifest(p.root);
    }
    if (method === 'skills/bundle') {
      const p = makeSkillsBundleParamsSchema().parse(params);
      return store.bundle(p.root, p.name);
    }
    const p = makeSkillsApplyParamsSchema().parse(params);
    return store.apply(p);
  }
```

同时把 `handleRpc` 的 docstring 补一行：

```
 * - `skills/manifest|bundle|apply` → directory-level skill read/write scoped to
 *   `cfg.roots` + `cfg.skillRoots` (the shared skill store, so local and remote
 *   sync through identical code).
```

- [ ] **Step 5: 加 capability 并导出 `buildHelloFrame`**

在 `backend/remote-agent/src/index.ts` 的 `buildHelloFrame` 上把 `function buildHelloFrame` 改成 `export function buildHelloFrame`，并在 capabilities 数组里加一项：

```ts
      SKILLS_CAPABILITY,
```

（从 `../../server/shared/agent-runtime/protocol.js` 一并 import `SKILLS_CAPABILITY`。）

同时把 capabilities 上方那段注释补一句：

```ts
  // `skills/v1` gates the directory-level skill sync RPCs; main refuses to plan
  // a sync against a host that does not advertise it rather than falling back
  // to per-file fs/* copies (no atomicity, no remote fingerprint).
```

- [ ] **Step 6: 加 capability 断言**

在 `backend/remote-agent/src/tests/index.test.ts` 里加 import 与用例：

```ts
import { buildHelloFrame } from '../index.js';
import { SKILLS_CAPABILITY } from '../../server/shared/agent-runtime/protocol.js';
```

```ts
test('hello frame advertises the skills capability', () => {
  const frame = JSON.parse(buildHelloFrame(cfg));
  assert.equal(frame.type, 'hello');
  assert.ok(frame.capabilities.includes(SKILLS_CAPABILITY));
  assert.ok(frame.capabilities.includes('fs/read'));
});
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test remote-agent/src/tests/skills-rpc.test.ts remote-agent/src/tests/index.test.ts
```

Expected: 两个文件 `# fail 0`

- [ ] **Step 8: 提交**

```bash
git add backend/remote-agent/src/skills.ts backend/remote-agent/src/rpc-dispatch.ts backend/remote-agent/src/index.ts backend/remote-agent/src/tests/skills-rpc.test.ts backend/remote-agent/src/tests/index.test.ts
git commit -m "feat(remote-agent): expose skills/manifest|bundle|apply over lite rpc"
```

---

## Task 11: main 侧节点抽象 —— 类型 + 远程客户端 + 本地节点

**Files:**
- Create: `backend/server/modules/skill-sync/types.ts`
- Create: `backend/server/modules/skill-sync/remote-skills.service.ts`
- Create: `backend/server/modules/skill-sync/skill-node.ts`
- Test: `backend/server/modules/skill-sync/tests/remote-skills.service.test.ts`
- Test: `backend/server/modules/skill-sync/tests/skill-node.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/skill-sync/tests/skill-node.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  REMOTE_USER_SKILL_ROOT,
  parseSkillNode,
  skillNodeLabel,
  userSkillRoot,
} from '../skill-node.js';

test('skillNodeLabel / parseSkillNode round-trip', () => {
  assert.equal(skillNodeLabel({ kind: 'local' }), 'local');
  assert.equal(skillNodeLabel({ kind: 'remote', hostId: 'h1' }), 'remote:h1');
  assert.deepEqual(parseSkillNode('local'), { kind: 'local' });
  assert.deepEqual(parseSkillNode('remote:h1'), { kind: 'remote', hostId: 'h1' });
});

test('parseSkillNode rejects malformed labels', () => {
  for (const bad of ['', 'remote:', 'remote', 'REMOTE:h1', 'local:h1']) {
    assert.throws(() => parseSkillNode(bad), /invalid skill node/);
  }
});

test('userSkillRoot is the local claude skills dir for local and a tilde path for remote', () => {
  assert.equal(
    userSkillRoot({ kind: 'local' }),
    path.join(os.homedir(), '.claude', 'skills'),
  );
  // 远程节点必须发字面量 `~`：main 不知道远程主机的 home，
  // lite 侧 expandHome() 会把它展开成自己的 home。
  assert.equal(userSkillRoot({ kind: 'remote', hostId: 'h1' }), REMOTE_USER_SKILL_ROOT);
  assert.equal(REMOTE_USER_SKILL_ROOT, '~/.claude/skills');
});
```

创建 `backend/server/modules/skill-sync/tests/remote-skills.service.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSkillsCapable,
  createRemoteSkillStore,
  createRemoteSkillsClient,
} from '../remote-skills.service.js';
import { SKILLS_CAPABILITY } from '@/shared/agent-runtime/protocol.js';

type Call = { hostId: string; method: string; params: unknown; timeoutMs: number };

function fakeRegistry(caps: string[] | undefined, calls: Call[]) {
  return {
    getCapabilities: () => caps,
    rpc: async (hostId: string, method: string, params: unknown, timeoutMs = 60_000) => {
      calls.push({ hostId, method, params, timeoutMs });
      if (method === 'skills/manifest') return { root: '/x', exists: true, entries: [] };
      if (method === 'skills/bundle') return { name: 'demo', contentHash: 'h', files: [] };
      return { action: 'created', contentHash: 'h' };
    },
  } as unknown as Parameters<typeof createRemoteSkillsClient>[0] extends () => infer R ? R : never;
}

test('assertSkillsCapable accepts a host advertising skills/v1', () => {
  assertSkillsCapable(fakeRegistry([SKILLS_CAPABILITY], []) as never, 'h1');
});

test('assertSkillsCapable rejects an offline host', () => {
  assert.throws(() => assertSkillsCapable(fakeRegistry(undefined, []) as never, 'h1'), /不在线/);
});

test('assertSkillsCapable rejects a lite without the capability', () => {
  assert.throws(
    () => assertSkillsCapable(fakeRegistry(['fs/read'], []) as never, 'h1'),
    /版本过旧/,
  );
});

test('remote client forwards the three methods with their timeouts', async () => {
  const calls: Call[] = [];
  const client = createRemoteSkillsClient(() => fakeRegistry([SKILLS_CAPABILITY], calls) as never);

  await client.manifest('h1', '~/.claude/skills');
  await client.bundle('h1', '/srv/.claude/skills', 'demo');
  await client.apply('h1', {
    root: '/srv/.claude/skills',
    name: 'demo',
    contentHash: 'h',
    files: [],
    expectedTargetHash: null,
    force: false,
  });

  assert.deepEqual(calls.map((c) => c.method), ['skills/manifest', 'skills/bundle', 'skills/apply']);
  assert.deepEqual(calls.map((c) => c.timeoutMs), [30_000, 60_000, 120_000]);
  assert.deepEqual(calls[0].params, { root: '~/.claude/skills' });
  assert.equal((calls[2].params as { force: boolean }).force, false);
});

test('the remote store binds hostId into every call', async () => {
  const calls: Call[] = [];
  const store = createRemoteSkillStore(() => fakeRegistry([SKILLS_CAPABILITY], calls) as never, 'h9');
  await store.manifest('/srv/.claude/skills');
  assert.equal(calls[0].hostId, 'h9');
});

test('every remote store call is gated on the capability', async () => {
  const store = createRemoteSkillStore(() => fakeRegistry(['fs/read'], []) as never, 'h1');
  await assert.rejects(() => store.manifest('/x'), /版本过旧/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-node.test.ts server/modules/skill-sync/tests/remote-skills.service.test.ts
```

Expected: FAIL — `Cannot find module '../skill-node.js'`

- [ ] **Step 3: 写类型**

创建 `backend/server/modules/skill-sync/types.ts`：

```ts
import type { SkillApplyInput, SkillStore } from '@/shared/skill-store.js';

export type { SkillApplyInput, SkillStore };

/**
 * A sync endpoint. "local" is the machine running the main server; every other
 * node is a remote host with a lite agent. Both implement the same
 * {@link SkillStore}, which is why the orchestrator has no branching.
 */
export type SkillNode = { kind: 'local' } | { kind: 'remote'; hostId: string };

export type SkillScope = 'user' | 'project';

/** `onlyTarget` is display-only in v1 — there is no delete path. */
export type SkillSyncAction = 'create' | 'update' | 'same' | 'onlyTarget';

export type SkillSyncEntry = {
  name: string;
  action: SkillSyncAction;
  fromHash?: string;
  toHash?: string;
  bytes?: number;
  description?: string;
  /**
   * Set when either side could not be fingerprinted (oversized / unreadable).
   * `action` is then computed from "hash unknown" and `apply` refuses the entry
   * outright — an unreadable TARGET must never be mistaken for an absent one,
   * or the sync would overwrite content it could not read.
   */
  error?: string;
};

/**
 * A previewed sync. Held server-side under `planId` (see the plan cache) so the
 * client cannot hand back a doctored plan — the two optimistic-concurrency
 * checks are only meaningful if the plan is the one the server produced.
 */
export type SyncPlan = {
  planId: string;
  from: SkillNode;
  to: SkillNode;
  scope: SkillScope;
  projectId?: number;
  targetProjectId?: number;
  fromRoot: string;
  toRoot: string;
  entries: SkillSyncEntry[];
  summary: { create: number; update: number; same: number; onlyTarget: number };
  createdAt: number;
};

export type SkillSyncResultEntry = {
  name: string;
  status: 'ok' | 'failed' | 'conflict' | 'skipped';
  action?: 'create' | 'update';
  backupPath?: string;
  error?: string;
};

export type SkillSyncResult = {
  planId: string;
  from: SkillNode;
  to: SkillNode;
  entries: SkillSyncResultEntry[];
  summary: { ok: number; failed: number; conflict: number; skipped: number };
};

export type ApplyRequest = {
  planId: string;
  /** Optional subset of plan entries to transfer (create/update only). */
  names?: string[];
  actor: 'user' | 'operator' | 'system';
  force?: boolean;
};
```

- [ ] **Step 4: 写远程客户端**

创建 `backend/server/modules/skill-sync/remote-skills.service.ts`：

```ts
import { SKILLS_CAPABILITY } from '@/shared/agent-runtime/protocol.js';
import type {
  RemoteSkillApplyResult,
  RemoteSkillBundle,
  RemoteSkillManifest,
} from '@/shared/agent-runtime/protocol.js';
import type { SkillApplyInput, SkillStore } from '@/shared/skill-store.js';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';

/**
 * RPC timeouts. `apply` mirrors `fs/write` (120s) because it moves a whole
 * directory over the wire; `manifest` is a metadata-only call.
 */
export const SKILL_RPC_TIMEOUTS = { manifest: 30_000, bundle: 60_000, apply: 120_000 } as const;

/**
 * Gate every skill RPC on the `skills/v1` capability.
 *
 * An older lite has no `skills/*` methods at all, so the RPC would come back as
 * `unknown rpc method` — a confusing error for what is really "this host needs
 * a deploy". Failing here names the actual remedy.
 */
export function assertSkillsCapable(registry: RemoteAgentsRegistry, hostId: string): void {
  const caps = registry.getCapabilities(hostId);
  if (!caps) {
    throw new Error(`远程主机 ${hostId} 不在线`);
  }
  if (!caps.includes(SKILLS_CAPABILITY)) {
    throw new Error(`目标主机 lite 版本过旧（缺少 ${SKILLS_CAPABILITY}），请先 deploy 升级`);
  }
}

export type RemoteSkillsClient = {
  manifest(hostId: string, root: string): Promise<RemoteSkillManifest>;
  bundle(hostId: string, root: string, name: string): Promise<RemoteSkillBundle>;
  apply(hostId: string, input: SkillApplyInput): Promise<RemoteSkillApplyResult>;
};

export function createRemoteSkillsClient(
  getRegistry: () => RemoteAgentsRegistry,
): RemoteSkillsClient {
  const reg = () => getRegistry();
  return {
    manifest(hostId, root) {
      assertSkillsCapable(reg(), hostId);
      return reg().rpc<RemoteSkillManifest>(hostId, 'skills/manifest', { root }, SKILL_RPC_TIMEOUTS.manifest);
    },
    bundle(hostId, root, name) {
      assertSkillsCapable(reg(), hostId);
      return reg().rpc<RemoteSkillBundle>(hostId, 'skills/bundle', { root, name }, SKILL_RPC_TIMEOUTS.bundle);
    },
    apply(hostId, input) {
      assertSkillsCapable(reg(), hostId);
      return reg().rpc<RemoteSkillApplyResult>(hostId, 'skills/apply', input, SKILL_RPC_TIMEOUTS.apply);
    },
  };
}

/** A {@link SkillStore} bound to one host — the node adapter's remote half. */
export function createRemoteSkillStore(
  getRegistry: () => RemoteAgentsRegistry,
  hostId: string,
): SkillStore {
  const client = createRemoteSkillsClient(getRegistry);
  return {
    manifest: (root) => client.manifest(hostId, root),
    bundle: (root, name) => client.bundle(hostId, root, name),
    apply: (input) => client.apply(hostId, input),
  };
}
```

- [ ] **Step 5: 写节点适配器**

创建 `backend/server/modules/skill-sync/skill-node.ts`：

```ts
import { getClaudeHomePath, getClaudeSkillsDir } from '@/shared/claude-paths.js';
import { createSkillStore, type SkillStore } from '@/shared/skill-store.js';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';
import { createRemoteSkillStore } from './remote-skills.service.js';
import type { SkillNode } from './types.js';

/**
 * Wire format for a node: `local` | `remote:<hostId>`. Used in the API surface
 * and in audit rows, where a structured value would be noisy.
 */
export function skillNodeLabel(node: SkillNode): string {
  return node.kind === 'local' ? 'local' : `remote:${node.hostId}`;
}

export function parseSkillNode(label: string): SkillNode {
  if (label === 'local') return { kind: 'local' };
  if (label.startsWith('remote:')) {
    const hostId = label.slice('remote:'.length);
    if (hostId.length > 0) return { kind: 'remote', hostId };
  }
  throw new Error(`invalid skill node: ${label}`);
}

/**
 * User-level skill root for a node.
 *
 * For a REMOTE node this is the literal `~/.claude/skills`, expanded by the
 * lite against ITS OWN home directory: main has no idea where the remote user's
 * home is (the `hello` frame carries `os`, not `homedir`). The lite's
 * `skillRoots` default is exactly `join(homedir(), '.claude/skills')`, so the
 * expanded path lands inside its allowlist.
 */
export const REMOTE_USER_SKILL_ROOT = '~/.claude/skills';

export function userSkillRoot(node: SkillNode): string {
  return node.kind === 'local' ? getClaudeSkillsDir() : REMOTE_USER_SKILL_ROOT;
}

/**
 * The local node's store. Allowlist is `~/.claude` (not `~/.claude/skills`) so
 * the project-level root `<project>/.claude/skills` can be resolved by the same
 * store when the project lives under the home directory.
 */
export function createLocalSkillStore(): SkillStore {
  return createSkillStore({ roots: [getClaudeHomePath()] });
}

/** The store for a node, given the registry for remote lookups. */
export function skillStoreForNode(
  node: SkillNode,
  getRegistry: () => RemoteAgentsRegistry,
): SkillStore {
  return node.kind === 'local'
    ? createLocalSkillStore()
    : createRemoteSkillStore(getRegistry, node.hostId);
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-node.test.ts server/modules/skill-sync/tests/remote-skills.service.test.ts
```

Expected: `# fail 0`

- [ ] **Step 7: 提交**

```bash
git add backend/server/modules/skill-sync/
git commit -m "feat(skill-sync): main-side node adapters and remote skills client"
```

---

## Task 12: `skill_sync_audit` 表 + 读写

**为什么不复用 `operator_exec_audit`**：那张表的 CHECK 只允许 `execute_skill` / `workbench`，语义是「助手工具执行」；同步是用户和助手都能触发的运维动作，混在一起会让审计口径变糊。

**为什么不建同步状态表**：状态一律实时探测（与 `alert-skill.service.ts` 的「每次从磁盘推导、不落库」一致），避免与真实文件状态漂移。这张表只记发生过什么。

**Files:**
- Modify: `backend/server/modules/database/schema.ts`
- Modify: `backend/server/modules/database/migrations.ts`
- Create: `backend/server/modules/skill-sync/skill-sync.db.ts`
- Test: `backend/server/modules/skill-sync/tests/skill-sync.db.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/skill-sync/tests/skill-sync.db.test.ts`：

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSkillSyncAuditDb, type SkillSyncAuditRepository } from '../skill-sync.db.js';

let db: Database.Database;
let repo: SkillSyncAuditRepository;

beforeEach(() => {
  db = new Database(':memory:');
  repo = createSkillSyncAuditDb(db);
});

function row(overrides: Partial<Parameters<SkillSyncAuditRepository['record']>[0]> = {}) {
  return {
    actor: 'user' as const,
    from_node: 'local',
    to_node: 'remote:h1',
    scope: 'user' as const,
    skill_name: 'demo',
    action: 'create',
    status: 'ok' as const,
    ...overrides,
  };
}

test('createSkillSyncAuditDb is idempotent (safe to run on every boot)', () => {
  assert.doesNotThrow(() => createSkillSyncAuditDb(db));
});

test('record + list round-trips a successful sync', () => {
  repo.record(row({ content_hash: 'a'.repeat(64), backup_path: '/srv/.claude/skills/.skill-sync-backup/demo.x' }));

  const rows = repo.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'user');
  assert.equal(rows[0].from_node, 'local');
  assert.equal(rows[0].to_node, 'remote:h1');
  assert.equal(rows[0].skill_name, 'demo');
  assert.equal(rows[0].action, 'create');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].content_hash, 'a'.repeat(64));
  assert.ok(rows[0].created_at);
});

test('record keeps the failure reason', () => {
  repo.record(row({ status: 'failed', error: 'target changed: demo on this host no longer matches the previewed hash' }));
  assert.match(repo.list()[0].error ?? '', /target changed/);
});

test('record rejects an unknown actor or status', () => {
  assert.throws(() => repo.record(row({ actor: 'robot' as never })));
  assert.throws(() => repo.record(row({ status: 'maybe' as never })));
});

test('list returns newest first and honours the limit', () => {
  repo.record(row({ skill_name: 'first', created_at: '2026-01-01T00:00:00.000Z' }));
  repo.record(row({ skill_name: 'second', created_at: '2026-02-01T00:00:00.000Z' }));
  repo.record(row({ skill_name: 'third', created_at: '2026-03-01T00:00:00.000Z' }));

  assert.deepEqual(repo.list().map((r) => r.skill_name), ['third', 'second', 'first']);
  assert.deepEqual(repo.list(2).map((r) => r.skill_name), ['third', 'second']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.db.test.ts
```

Expected: FAIL — `Cannot find module '../skill-sync.db.js'`

- [ ] **Step 3: 加 schema**

在 `backend/server/modules/database/schema.ts` 末尾追加：

```ts
export const SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skill_sync_audit (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor             TEXT NOT NULL CHECK (actor IN ('user','operator','system')),
    from_node         TEXT NOT NULL,
    to_node           TEXT NOT NULL,
    scope             TEXT NOT NULL CHECK (scope IN ('user','project')),
    project_id        INTEGER,
    target_project_id INTEGER,
    skill_name        TEXT NOT NULL,
    action            TEXT NOT NULL,
    content_hash      TEXT,
    backup_path       TEXT,
    status            TEXT NOT NULL CHECK (status IN ('ok','failed')),
    error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_sync_audit_created ON skill_sync_audit(created_at DESC);
`;
```

- [ ] **Step 4: 写仓库**

创建 `backend/server/modules/skill-sync/skill-sync.db.ts`：

```ts
import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

/**
 * Audit trail for skill syncs.
 *
 * `action` intentionally has NO CHECK constraint: v1 has no delete path, but a
 * future one must not require a table rebuild just to widen the enum. The
 * values in use today are `create` | `update` | `skip` | `conflict`.
 */
export type SkillSyncAuditInput = {
  actor: 'user' | 'operator' | 'system';
  /** `local` | `remote:<hostId>` — see skillNodeLabel(). */
  from_node: string;
  to_node: string;
  scope: 'user' | 'project';
  project_id?: number | null;
  target_project_id?: number | null;
  skill_name: string;
  action: string;
  content_hash?: string | null;
  backup_path?: string | null;
  status: 'ok' | 'failed';
  error?: string | null;
  /** Test seam: override the timestamp instead of relying on CURRENT_TIMESTAMP. */
  created_at?: string;
};

export type SkillSyncAuditRow = {
  id: number;
  created_at: string;
  actor: string;
  from_node: string;
  to_node: string;
  scope: string;
  project_id: number | null;
  target_project_id: number | null;
  skill_name: string;
  action: string;
  content_hash: string | null;
  backup_path: string | null;
  status: string;
  error: string | null;
};

export type SkillSyncAuditRepository = {
  record(input: SkillSyncAuditInput): void;
  list(limit?: number): SkillSyncAuditRow[];
};

export function createSkillSyncAuditDb(db: Database.Database): SkillSyncAuditRepository {
  db.exec(SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL);
  return {
    record(input) {
      db.prepare(
        `INSERT INTO skill_sync_audit
           (actor, from_node, to_node, scope, project_id, target_project_id,
            skill_name, action, content_hash, backup_path, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      ).run(
        input.actor,
        input.from_node,
        input.to_node,
        input.scope,
        input.project_id ?? null,
        input.target_project_id ?? null,
        input.skill_name,
        input.action,
        input.content_hash ?? null,
        input.backup_path ?? null,
        input.status,
        input.error ?? null,
        input.created_at ?? null,
      );
    },
    list(limit = 100) {
      return db
        .prepare('SELECT * FROM skill_sync_audit ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit) as SkillSyncAuditRow[];
    },
  };
}

/**
 * Production singleton.
 *
 * Built lazily through `getConnection()` — instantiating at module scope would
 * run the DDL before `initializeDatabase()` and crash the backend at boot
 * (exactly the trap the `notifications` table fell into). Mirrors
 * `operatorAuditDb`.
 */
export const skillSyncAuditDb: SkillSyncAuditRepository = {
  record: (input) => createSkillSyncAuditDb(getConnection()).record(input),
  list: (limit) => createSkillSyncAuditDb(getConnection()).list(limit),
};
```

- [ ] **Step 5: 加迁移**

在 `backend/server/modules/database/migrations.ts` 里：

1. 把 `SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL` 加进文件顶部从 `@/modules/database/schema.js` 的 import 列表。
2. 在 `migrateRemoteHostsTable` 函数之后加：

```ts
/**
 * Skill-sync audit table. The repository also execs this DDL on construction
 * (idempotent), but running it here keeps a fresh install's table set
 * complete before any repository is built.
 */
export function migrateSkillSyncAuditTable(db: Database): void {
  db.exec(SKILL_SYNC_AUDIT_TABLE_SCHEMA_SQL);
}
```

3. 在 `runMigrations` 里紧挨着 `migrateRemoteHostsTable(db);` 的下一行加：

```ts
    migrateSkillSyncAuditTable(db);
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.db.test.ts
```

Expected: `# pass 5` / `# fail 0`

- [ ] **Step 7: 提交**

```bash
git add backend/server/modules/database/schema.ts backend/server/modules/database/migrations.ts backend/server/modules/skill-sync/skill-sync.db.ts backend/server/modules/skill-sync/tests/skill-sync.db.test.ts
git commit -m "feat(skill-sync): add skill_sync_audit table and repository"
```

---

## Task 13: 编排 —— plan（差异计算 + plan 缓存）

**Files:**
- Create: `backend/server/modules/skill-sync/skill-sync.service.ts`
- Test: `backend/server/modules/skill-sync/tests/skill-sync.plan.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/skill-sync/tests/skill-sync.plan.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeSkillHash, type SkillFileEntry } from '@/shared/skill-hash.js';
import { createSkillStore } from '@/shared/skill-store.js';

import { createSkillSyncService } from '../skill-sync.service.js';
import type { SkillNode } from '../types.js';

async function mkRoot(tag: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sync-${tag}-`));
  return fsp.realpath(dir);
}

async function putSkill(root: string, name: string, content: string): Promise<string> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content);
  const files: SkillFileEntry[] = [{ relativePath: 'SKILL.md', content, encoding: 'utf8', executable: false }];
  return computeSkillHash(files);
}

/** 两个本地目录伪装成两个节点，让 plan 的编排逻辑可测且不碰网络。 */
function serviceForRoots(fromRoot: string, toRoot: string, clock = { t: 1000 }) {
  return createSkillSyncService({
    getRegistry: () => {
      throw new Error('remote nodes are not exercised in this test');
    },
    getProjectById: () => null,
    audit: () => {},
    now: () => clock.t,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });
}

const LOCAL: SkillNode = { kind: 'local' };

test('plan classifies create / update / same / onlyTarget', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');
  await putSkill(fromRoot, 'changed', 'new');
  await putSkill(fromRoot, 'identical', 'same');
  await putSkill(toRoot, 'changed', 'old');
  await putSkill(toRoot, 'identical', 'same');
  await putSkill(toRoot, 'extra', 'x');

  const svc = serviceForRoots(fromRoot, toRoot);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName.fresh.action, 'create');
  assert.equal(byName.changed.action, 'update');
  assert.equal(byName.identical.action, 'same');
  assert.equal(byName.extra.action, 'onlyTarget');
  assert.deepEqual(plan.summary, { create: 1, update: 1, same: 1, onlyTarget: 1 });
});

test('plan records both hashes and the source size for each entry', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'changed', 'new');
  await putSkill(toRoot, 'changed', 'old');

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const entry = plan.entries[0];
  assert.match(entry.fromHash ?? '', /^[0-9a-f]{64}$/);
  assert.match(entry.toHash ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(entry.fromHash, entry.toHash);
  assert.equal(entry.bytes, Buffer.byteLength('new'));
});

test('plan leaves toHash undefined for a create and fromHash undefined for onlyTarget', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');
  await putSkill(toRoot, 'extra', 'x');

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName.fresh.toHash, undefined);
  assert.equal(byName.extra.fromHash, undefined);
});

test('plan handles a target root that does not exist yet', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = path.join(await mkRoot('to'), 'never-created');
  await putSkill(fromRoot, 'fresh', 'a');

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  assert.deepEqual(plan.summary, { create: 1, update: 0, same: 0, onlyTarget: 0 });
});

test('plan returns a planId and stashes the plan server-side', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const clock = { t: 1000 };
  const svc = serviceForRoots(fromRoot, toRoot, clock);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  assert.match(plan.planId, /^[0-9a-f-]{36}$/);
  const cached = svc.takePlan(plan.planId);
  assert.equal(cached?.planId, plan.planId);
  // 取出即失效：一个 plan 只能 apply 一次
  assert.equal(svc.takePlan(plan.planId), null);
});

test('a plan older than the TTL is rejected', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const clock = { t: 1000 };
  const svc = serviceForRoots(fromRoot, toRoot, clock);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  clock.t += 10 * 60 * 1000 + 1;
  assert.equal(svc.takePlan(plan.planId), null);
});

test('plan rejects a project scope without both project ids', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const svc = serviceForRoots(fromRoot, toRoot);

  await assert.rejects(() => svc.plan({ from: LOCAL, to: LOCAL, scope: 'project' }), /projectId/);
  await assert.rejects(
    () => svc.plan({ from: LOCAL, to: LOCAL, scope: 'project', projectId: 1 }),
    /targetProjectId/,
  );
});

test('plan refuses a node whose host does not own the given project', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const svc = createSkillSyncService({
    getRegistry: () => {
      throw new Error('unused');
    },
    // 项目在远程 h1 上，但源节点给的是 local
    getProjectById: () => ({ project_path: '/srv/app', remote_host_id: 'h1' }),
    audit: () => {},
    now: () => 1000,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });

  await assert.rejects(
    () => svc.plan({ from: LOCAL, to: LOCAL, scope: 'project', projectId: 1, targetProjectId: 1 }),
    /lives on h1 but node local/,
  );
});

test('plan surfaces an unreadable skill as a blocked entry instead of dropping it', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'good', 'a');
  const huge = path.join(fromRoot, 'huge');
  await fsp.mkdir(huge, { recursive: true });
  await fsp.writeFile(path.join(huge, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  const plan = await serviceForRoots(fromRoot, toRoot).plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.match(byName.huge.error ?? '', /skill file too large/);
  assert.equal(byName.huge.fromHash, undefined);
  assert.equal(byName.good.error, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.plan.test.ts
```

Expected: FAIL — `Cannot find module '../skill-sync.service.js'`

- [ ] **Step 3: 写实现**

创建 `backend/server/modules/skill-sync/skill-sync.service.ts`：

```ts
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SkillStore } from '@/shared/skill-store.js';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';
import { skillNodeLabel, skillStoreForNode, userSkillRoot } from './skill-node.js';
import type { SkillSyncAuditInput } from './skill-sync.db.js';
import type {
  ApplyRequest,
  SkillNode,
  SkillScope,
  SkillSyncAction,
  SkillSyncEntry,
  SkillSyncResult,
  SkillSyncResultEntry,
  SyncPlan,
} from './types.js';

/** How long a previewed plan stays applicable. */
export const PLAN_TTL_MS = 10 * 60 * 1000;

/** The minimum shape the service needs from the projects repository. */
export type ProjectLookup = (projectId: number) => { project_path: string; remote_host_id: string | null } | null;

export type SkillSyncServiceDeps = {
  getRegistry: () => RemoteAgentsRegistry;
  getProjectById: ProjectLookup;
  audit: (input: SkillSyncAuditInput) => void;
  /** Test seam. */
  now?: () => number;
  /** Test seam: two local directories standing in for two nodes. */
  localStore?: SkillStore;
  localRootOverride?: { fromRoot: string; toRoot: string };
};

export type PlanRequest = {
  from: SkillNode;
  to: SkillNode;
  scope: SkillScope;
  projectId?: number;
  targetProjectId?: number;
};

/** Which side of the sync a root is being resolved for. */
export type SyncSide = 'from' | 'to';

type CachedPlan = { plan: SyncPlan; createdAt: number };

export type SkillSyncService = {
  plan(req: PlanRequest): Promise<SyncPlan>;
  /** Root resolution, exposed so the browse endpoint does not have to plan. */
  resolveRoot(node: SkillNode, scope: SkillScope, projectId: number | undefined, side: SyncSide): string;
  takePlan(planId: string): SyncPlan | null;
  apply(req: ApplyRequest): Promise<SkillSyncResult>;
};

function actionFor(fromHash: string | undefined, toHash: string | undefined): SkillSyncAction {
  if (fromHash === undefined) return 'onlyTarget';
  if (toHash === undefined) return 'create';
  return fromHash === toHash ? 'same' : 'update';
}

export function createSkillSyncService(deps: SkillSyncServiceDeps): SkillSyncService {
  const now = deps.now ?? (() => Date.now());
  const plans = new Map<string, CachedPlan>();

  /** Lazily sweeps expired entries; the map is small (one entry per preview). */
  function sweep(): void {
    const cutoff = now() - PLAN_TTL_MS;
    for (const [id, entry] of plans) {
      if (entry.createdAt < cutoff) plans.delete(id);
    }
  }

  function storeFor(node: SkillNode): SkillStore {
    if (node.kind === 'local' && deps.localStore) return deps.localStore;
    return skillStoreForNode(node, deps.getRegistry);
  }

  /**
   * Resolves the skill root for one side of the sync.
   *
   * `side` matters because BOTH endpoints may be local (a local→local sync is
   * how the tests drive the orchestrator), and the two sides need different
   * roots.
   *
   * Project scope requires the project row so the path AND the host can be
   * cross-checked — pairing a remote node with a local project row would
   * otherwise read the wrong machine's disk.
   */
  function rootFor(
    node: SkillNode,
    scope: SkillScope,
    projectId: number | undefined,
    side: SyncSide,
  ): string {
    if (scope === 'user') {
      if (node.kind === 'local' && deps.localRootOverride) {
        return side === 'from' ? deps.localRootOverride.fromRoot : deps.localRootOverride.toRoot;
      }
      return userSkillRoot(node);
    }
    const field = side === 'from' ? 'projectId' : 'targetProjectId';
    if (projectId === undefined) {
      throw new Error(`${field} is required for project scope (${skillNodeLabel(node)})`);
    }
    const project = deps.getProjectById(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const projectHost = project.remote_host_id ?? null;
    const nodeHost = node.kind === 'remote' ? node.hostId : null;
    if (projectHost !== nodeHost) {
      throw new Error(
        `project ${projectId} lives on ${projectHost ?? 'local'} but node ${skillNodeLabel(node)} was given`,
      );
    }
    return path.join(project.project_path, '.claude', 'skills');
  }

  return {
    resolveRoot: rootFor,

    async plan(req) {
      sweep();
      const fromRoot = rootFor(req.from, req.scope, req.projectId, 'from');
      const toRoot = rootFor(req.to, req.scope, req.targetProjectId, 'to');

      const [fromManifest, toManifest] = await Promise.all([
        storeFor(req.from).manifest(fromRoot),
        storeFor(req.to).manifest(toRoot),
      ]);

      const fromByName = new Map(fromManifest.entries.map((e) => [e.name, e]));
      const toByName = new Map(toManifest.entries.map((e) => [e.name, e]));
      const names = [...new Set([...fromByName.keys(), ...toByName.keys()])].sort();

      const entries: SkillSyncEntry[] = names.map((name) => {
        const from = fromByName.get(name);
        const to = toByName.get(name);
        // An inert entry (unreadable / oversized) has contentHash '' — treat it
        // as "hash unknown" so the action is never computed against a lie, and
        // carry the reason so apply can refuse it explicitly.
        const fromHash = from && !from.error ? from.contentHash : undefined;
        const toHash = to && !to.error ? to.contentHash : undefined;
        const blocked = from?.error ?? to?.error;
        return {
          name,
          action: actionFor(fromHash, toHash),
          ...(fromHash !== undefined ? { fromHash } : {}),
          ...(toHash !== undefined ? { toHash } : {}),
          ...(from && !from.error ? { bytes: from.totalBytes } : {}),
          ...(from?.description ? { description: from.description } : {}),
          ...(blocked ? { error: blocked } : {}),
        };
      });

      const plan: SyncPlan = {
        planId: randomUUID(),
        from: req.from,
        to: req.to,
        scope: req.scope,
        ...(req.projectId !== undefined ? { projectId: req.projectId } : {}),
        ...(req.targetProjectId !== undefined ? { targetProjectId: req.targetProjectId } : {}),
        fromRoot,
        toRoot,
        entries,
        summary: {
          create: entries.filter((e) => e.action === 'create').length,
          update: entries.filter((e) => e.action === 'update').length,
          same: entries.filter((e) => e.action === 'same').length,
          onlyTarget: entries.filter((e) => e.action === 'onlyTarget').length,
        },
        createdAt: now(),
      };
      plans.set(plan.planId, { plan, createdAt: plan.createdAt });
      return plan;
    },

    takePlan(planId) {
      sweep();
      const cached = plans.get(planId);
      if (!cached) return null;
      // Single use: a preview authorises ONE apply. Re-applying the same planId
      // would skip the drift checks the second time around.
      plans.delete(planId);
      return cached.plan;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.plan.test.ts
```

Expected: `# pass 9` / `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/skill-sync/skill-sync.service.ts backend/server/modules/skill-sync/tests/skill-sync.plan.test.ts
git commit -m "feat(skill-sync): plan diff with server-side plan cache"
```

---

## Task 14: 编排 —— apply（逐条传输 + 部分失败 + 审计）

**Files:**
- Modify: `backend/server/modules/skill-sync/skill-sync.service.ts`
- Test: `backend/server/modules/skill-sync/tests/skill-sync.apply.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/skill-sync/tests/skill-sync.apply.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeSkillHash, type SkillFileEntry } from '@/shared/skill-hash.js';
import { createSkillStore } from '@/shared/skill-store.js';

import { createSkillSyncService } from '../skill-sync.service.js';
import type { SkillNode } from '../types.js';
import type { SkillSyncAuditInput } from '../skill-sync.db.js';

async function mkRoot(tag: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `apply-${tag}-`));
  return fsp.realpath(dir);
}

async function putSkill(root: string, name: string, content: string): Promise<string> {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content);
  const files: SkillFileEntry[] = [{ relativePath: 'SKILL.md', content, encoding: 'utf8', executable: false }];
  return computeSkillHash(files);
}

const LOCAL: SkillNode = { kind: 'local' };

function serviceFor(fromRoot: string, toRoot: string, audits: SkillSyncAuditInput[]) {
  return createSkillSyncService({
    getRegistry: () => {
      throw new Error('remote nodes are not exercised in this test');
    },
    getProjectById: () => null,
    audit: (input) => audits.push(input),
    now: () => 1000,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });
}

test('apply creates and updates, and reports per-entry status', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');
  await putSkill(fromRoot, 'changed', 'new');
  await putSkill(toRoot, 'changed', 'old');
  await putSkill(toRoot, 'extra', 'x');

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, actor: 'user' });

  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName.fresh.status, 'ok');
  assert.equal(byName.changed.status, 'ok');
  assert.equal(byName.extra.status, 'skipped');
  assert.equal(await fsp.readFile(path.join(toRoot, 'fresh', 'SKILL.md'), 'utf8'), 'a');
  assert.equal(await fsp.readFile(path.join(toRoot, 'changed', 'SKILL.md'), 'utf8'), 'new');
  assert.equal(await fsp.readFile(path.join(toRoot, 'extra', 'SKILL.md'), 'utf8'), 'x');
  assert.deepEqual(result.summary, { ok: 2, failed: 0, conflict: 0, skipped: 1 });
});

test('apply refuses a skill it could not fingerprint on the source side', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const huge = path.join(fromRoot, 'huge');
  await fsp.mkdir(huge, { recursive: true });
  await fsp.writeFile(path.join(huge, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, actor: 'user' });

  assert.equal(result.entries[0].status, 'failed');
  assert.match(result.entries[0].error ?? '', /无法读取/);
  assert.equal(audits[0].status, 'failed');
  await assert.rejects(() => fsp.stat(path.join(toRoot, 'huge')), /ENOENT/);
});

test('apply writes one audit row per transferred skill', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  await svc.apply({ planId: plan.planId, actor: 'operator' });

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'operator');
  assert.equal(audits[0].skill_name, 'fresh');
  assert.equal(audits[0].action, 'create');
  assert.equal(audits[0].status, 'ok');
  assert.equal(audits[0].from_node, 'local');
  assert.equal(audits[0].to_node, 'local');
  assert.equal(audits[0].scope, 'user');
});

test('apply honours the names subset', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'a-skill', 'a');
  await putSkill(fromRoot, 'b-skill', 'b');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, names: ['a-skill'], actor: 'user' });

  assert.deepEqual(result.entries.filter((e) => e.status === 'ok').map((e) => e.name), ['a-skill']);
  await assert.rejects(() => fsp.stat(path.join(toRoot, 'b-skill')), /ENOENT/);
});

test('a source that changed after planning is reported as a conflict, not overwritten', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'demo', 'v1');

  const audits: SkillSyncAuditInput[] = [];
  const svc = serviceFor(fromRoot, toRoot, audits);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  // 源在 plan 之后被改了
  await putSkill(fromRoot, 'demo', 'v2');

  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  assert.equal(result.entries[0].status, 'conflict');
  assert.match(result.entries[0].error ?? '', /源/);
  await assert.rejects(() => fsp.stat(path.join(toRoot, 'demo')), /ENOENT/);
  assert.equal(audits[0].status, 'failed');
});

test('a target that changed after planning is reported as a conflict', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'demo', 'v1');
  await putSkill(toRoot, 'demo', 'v0');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });

  // 目标在 plan 之后被改了
  await putSkill(toRoot, 'demo', 'edited-locally');

  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  assert.equal(result.entries[0].status, 'conflict');
  assert.equal(await fsp.readFile(path.join(toRoot, 'demo', 'SKILL.md'), 'utf8'), 'edited-locally');
});

test('force overrides a drifted target', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'demo', 'v1');
  await putSkill(toRoot, 'demo', 'v0');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  await putSkill(toRoot, 'demo', 'edited-locally');

  const result = await svc.apply({ planId: plan.planId, actor: 'user', force: true });
  assert.equal(result.entries[0].status, 'ok');
  assert.equal(await fsp.readFile(path.join(toRoot, 'demo', 'SKILL.md'), 'utf8'), 'v1');
});

test('one failing entry does not abort the rest of the batch', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'a-broken', 'v1');
  await putSkill(fromRoot, 'b-good', 'v1');

  const svc = serviceFor(fromRoot, toRoot, []);
  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  await putSkill(fromRoot, 'a-broken', 'v2'); // 只有 a 漂移

  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName['a-broken'].status, 'conflict');
  assert.equal(byName['b-good'].status, 'ok');
  assert.equal(await fsp.readFile(path.join(toRoot, 'b-good', 'SKILL.md'), 'utf8'), 'v1');
});

test('apply rejects an unknown or already-used planId', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  const svc = serviceFor(fromRoot, toRoot, []);

  await assert.rejects(() => svc.apply({ planId: 'nope', actor: 'user' }), /plan not found or expired/);
});

test('a failing audit write does not turn a successful transfer into a failure', async () => {
  const fromRoot = await mkRoot('from');
  const toRoot = await mkRoot('to');
  await putSkill(fromRoot, 'fresh', 'a');

  const svc = createSkillSyncService({
    getRegistry: () => {
      throw new Error('unused');
    },
    getProjectById: () => null,
    audit: () => {
      throw new Error('disk full');
    },
    now: () => 1000,
    localStore: createSkillStore({ roots: [fromRoot, toRoot] }),
    localRootOverride: { fromRoot, toRoot },
  });

  const plan = await svc.plan({ from: LOCAL, to: LOCAL, scope: 'user' });
  const result = await svc.apply({ planId: plan.planId, actor: 'user' });
  assert.equal(result.entries[0].status, 'ok');
  assert.equal(await fsp.readFile(path.join(toRoot, 'fresh', 'SKILL.md'), 'utf8'), 'a');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.apply.test.ts
```

Expected: FAIL — `svc.apply is not a function`

- [ ] **Step 3: 写实现**

在 `backend/server/modules/skill-sync/skill-sync.service.ts` 里：

1. 在 `SkillSyncService` 类型里补上 `apply`（`resolveRoot` / `takePlan` 在 Task 13 已定义，不要重复添加）：

```ts
export type SkillSyncService = {
  plan(req: PlanRequest): Promise<SyncPlan>;
  /** Root resolution, exposed so the browse endpoint does not have to plan. */
  resolveRoot(node: SkillNode, scope: SkillScope, projectId: number | undefined, side: SyncSide): string;
  takePlan(planId: string): SyncPlan | null;
  apply(req: ApplyRequest): Promise<SkillSyncResult>;
};
```

2. 把 `import type { ... } from './types.js'` 补上 `ApplyRequest, SkillSyncResult, SkillSyncResultEntry`。

3. 在 `return { ... }` 之前加一个内部函数：

```ts
  /**
   * Re-reads the source bundle and re-verifies its fingerprint.
   *
   * The plan's `fromHash` was computed at preview time; if the source changed
   * since, the plan no longer describes what would actually be written, so the
   * entry is refused rather than silently transferred.
   */
  async function transfer(
    plan: SyncPlan,
    entry: SkillSyncEntry,
    force: boolean,
  ): Promise<SkillSyncResultEntry> {
    // An inert entry (oversized / unreadable on either side) is refused before
    // any I/O: treating an unreadable target as "absent" would overwrite
    // content the server could not even read.
    if (entry.error) {
      return { name: entry.name, status: 'failed', error: `无法读取：${entry.error}` };
    }

    const fromStore = storeFor(plan.from);
    const toStore = storeFor(plan.to);

    let bundle;
    try {
      bundle = await fromStore.bundle(plan.fromRoot, entry.name);
    } catch (err) {
      return { name: entry.name, status: 'failed', error: message(err) };
    }
    if (bundle.contentHash !== entry.fromHash) {
      return {
        name: entry.name,
        status: 'conflict',
        error: `源在预览之后被修改（预览 ${short(entry.fromHash)}，当前 ${short(bundle.contentHash)}）`,
      };
    }

    try {
      const applied = await toStore.apply({
        root: plan.toRoot,
        name: entry.name,
        contentHash: bundle.contentHash,
        files: bundle.files,
        expectedTargetHash: entry.toHash ?? null,
        force,
      });
      return {
        name: entry.name,
        status: applied.action === 'skipped' ? 'skipped' : 'ok',
        action: entry.action === 'update' ? 'update' : 'create',
        ...(applied.backupPath !== undefined ? { backupPath: applied.backupPath } : {}),
      };
    } catch (err) {
      const text = message(err);
      return {
        name: entry.name,
        status: /target changed/.test(text) ? 'conflict' : 'failed',
        error: text,
      };
    }
  }
```

4. 在 `return { ... }` 对象里加 `apply`：

```ts
    async apply(req) {
      const plan = this.takePlan(req.planId);
      if (!plan) throw new Error('plan not found or expired');

      const wanted = req.names ? new Set(req.names) : null;
      const targets = plan.entries.filter(
        (e) => e.action === 'create' || e.action === 'update',
      );
      const selected = targets.filter((e) => (wanted ? wanted.has(e.name) : true));

      const entries: SkillSyncResultEntry[] = [];
      for (const entry of selected) {
        entries.push(await transfer(plan, entry, req.force === true));
      }
      // `same` and `onlyTarget` entries are reported as skipped so the UI can
      // render the full plan rather than a partial list.
      for (const entry of plan.entries) {
        if (entry.action === 'same' || entry.action === 'onlyTarget') {
          entries.push({ name: entry.name, status: 'skipped' });
        }
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const entry of entries) {
        const input = {
          actor: req.actor,
          from_node: skillNodeLabel(plan.from),
          to_node: skillNodeLabel(plan.to),
          scope: plan.scope,
          project_id: plan.projectId ?? null,
          target_project_id: plan.targetProjectId ?? null,
          skill_name: entry.name,
          action: entry.action ?? 'skip',
          content_hash: plan.entries.find((e) => e.name === entry.name)?.fromHash ?? null,
          backup_path: entry.backupPath ?? null,
          status: entry.status === 'ok' ? ('ok' as const) : ('failed' as const),
          error: entry.error ?? null,
        };
        // Audit must never turn a successful transfer into a reported failure.
        try {
          deps.audit(input);
        } catch (err) {
          console.warn('[skill-sync] audit write failed:', message(err));
        }
      }

      return {
        planId: plan.planId,
        from: plan.from,
        to: plan.to,
        entries,
        summary: {
          ok: entries.filter((e) => e.status === 'ok').length,
          failed: entries.filter((e) => e.status === 'failed').length,
          conflict: entries.filter((e) => e.status === 'conflict').length,
          skipped: entries.filter((e) => e.status === 'skipped').length,
        },
      };
    },
```

5. 在文件末尾加两个小工具：

```ts
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(hash: string | undefined): string {
  return hash ? hash.slice(0, 8) : 'none';
}
```

> **注意**：`this.takePlan(...)` 在对象字面量方法里可用（方法简写会绑定到该对象）。若 lint 报 `no-invalid-this`，改为先 `const takePlan = ...` 抽成局部函数再引用。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.apply.test.ts
```

Expected: `# pass 10` / `# fail 0`

- [ ] **Step 5: 跑编排层全部测试**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.plan.test.ts server/modules/skill-sync/tests/skill-sync.apply.test.ts
```

Expected: `# fail 0`

- [ ] **Step 6: 提交**

```bash
git add backend/server/modules/skill-sync/skill-sync.service.ts backend/server/modules/skill-sync/tests/skill-sync.apply.test.ts
git commit -m "feat(skill-sync): per-entry apply with conflict isolation and audit"
```

---

## Task 15: HTTP API + 接线

**Files:**
- Create: `backend/server/modules/skill-sync/skill-sync.routes.ts`
- Modify: `backend/server/index.js`
- Test: `backend/server/modules/skill-sync/tests/skill-sync.routes.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/skill-sync/tests/skill-sync.routes.test.ts`：

```ts
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createSkillSyncRouter } from '../skill-sync.routes.js';
import type { SkillSyncService } from '../skill-sync.service.js';

function fakeService(overrides: Partial<SkillSyncService> = {}): SkillSyncService {
  return {
    resolveRoot: () => '/x',
    plan: async (req) => ({
      planId: 'p1',
      from: req.from,
      to: req.to,
      scope: req.scope,
      fromRoot: '/from',
      toRoot: '/to',
      entries: [],
      summary: { create: 0, update: 0, same: 0, onlyTarget: 0 },
      createdAt: 1,
    }),
    takePlan: () => null,
    apply: async (req) => ({
      planId: req.planId,
      from: { kind: 'local' },
      to: { kind: 'local' },
      entries: [],
      summary: { ok: 0, failed: 0, conflict: 0, skipped: 0 },
    }),
    ...overrides,
  };
}

async function withServer(
  deps: Parameters<typeof createSkillSyncRouter>[0],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/skills', createSkillSyncRouter(deps));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/api/skills`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const DEPS = {
  getRegistry: () => ({}) as never,
  listNodes: () => [
    { label: 'local', name: '本机', online: true },
    { label: 'remote:h1', name: 'dev1', online: true },
    { label: 'remote:h2', name: 'dev2', online: false, reason: '离线' },
  ],
};

test('GET /nodes lists local plus every registered remote host', async () => {
  await withServer({ ...DEPS, service: fakeService() }, async (base) => {
    const res = await fetch(`${base}/nodes`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { nodes: { label: string; online: boolean }[] };
    assert.deepEqual(body.nodes.map((n) => n.label), ['local', 'remote:h1', 'remote:h2']);
    assert.equal(body.nodes[2].online, false);
  });
});

test('POST /sync/plan parses the node labels into SkillNode values', async () => {
  let seen: unknown = null;
  const service = fakeService({
    plan: async (req) => {
      seen = req;
      return fakeService().plan(req);
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'local', to: 'remote:h1', scope: 'user' }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, { from: { kind: 'local' }, to: { kind: 'remote', hostId: 'h1' }, scope: 'user' });
});

test('POST /sync/plan rejects an invalid node label', async () => {
  await withServer({ ...DEPS, service: fakeService() }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'nope', to: 'local', scope: 'user' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /invalid skill node/);
  });
});

test('POST /sync/plan rejects an unknown scope', async () => {
  await withServer({ ...DEPS, service: fakeService() }, async (base) => {
    const res = await fetch(`${base}/sync/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'local', to: 'local', scope: 'galaxy' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /sync/apply forwards planId / names / force and tags the actor as user', async () => {
  let seen: unknown = null;
  const service = fakeService({
    apply: async (req) => {
      seen = req;
      return fakeService().apply(req);
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'p1', names: ['demo'], force: true }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, { planId: 'p1', names: ['demo'], force: true, actor: 'user' });
});

test('POST /sync/apply surfaces an expired plan as 400', async () => {
  const service = fakeService({
    apply: async () => {
      throw new Error('plan not found or expired');
    },
  });
  await withServer({ ...DEPS, service }, async (base) => {
    const res = await fetch(`${base}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'gone' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /plan not found or expired/);
  });
});

test('GET /manifest parses the node label and forwards scope/projectId', async () => {
  let seen: unknown = null;
  const manifest = async (node: unknown, scope: unknown, projectId: unknown) => {
    seen = { node, scope, projectId };
    return { root: '/x', exists: true, entries: [] };
  };
  await withServer({ ...DEPS, service: fakeService(), manifest: manifest as never }, async (base) => {
    const res = await fetch(`${base}/manifest?node=remote:h1&scope=project&projectId=7`);
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, { node: { kind: 'remote', hostId: 'h1' }, scope: 'project', projectId: 7 });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.routes.test.ts
```

Expected: FAIL — `Cannot find module '../skill-sync.routes.js'`

- [ ] **Step 3: 写路由**

创建 `backend/server/modules/skill-sync/skill-sync.routes.ts`：

```ts
import express, { type Request, type Response } from 'express';

import type { RemoteAgentsRegistry } from '../remote-agents/remote-agents.registry.js';
import { parseSkillNode, skillStoreForNode } from './skill-node.js';
import type { SkillSyncService } from './skill-sync.service.js';
import type { SkillNode, SkillScope } from './types.js';

export type SkillSyncRouterDeps = {
  service: SkillSyncService;
  getRegistry: () => RemoteAgentsRegistry;
  /** Node picker data: local plus every registered host, with online state. */
  listNodes: () => { label: string; name: string; online: boolean; reason?: string }[];
  /** Overridable for tests. */
  manifest?: (node: SkillNode, scope: SkillScope, projectId?: number) => Promise<unknown>;
};

function requireNode(raw: unknown, field: string): SkillNode {
  if (typeof raw !== 'string') throw new Error(`${field} must be a node label`);
  return parseSkillNode(raw);
}

function requireScope(raw: unknown): SkillScope {
  if (raw !== 'user' && raw !== 'project') throw new Error('scope must be "user" or "project"');
  return raw;
}

function optionalId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error('projectId must be an integer');
  return n;
}

export function createSkillSyncRouter(deps: SkillSyncRouterDeps): express.Router {
  const router = express.Router();

  const defaultManifest = (node: SkillNode, scope: SkillScope, projectId?: number) =>
    skillStoreForNode(node, deps.getRegistry).manifest(
      deps.service.resolveRoot(node, scope, projectId, 'from'),
    );

  router.get('/nodes', (_req: Request, res: Response) => {
    res.json({ nodes: deps.listNodes() });
  });

  router.get('/manifest', async (req: Request, res: Response, next) => {
    try {
      const node = requireNode(req.query.node, 'node');
      const scope = requireScope(req.query.scope);
      const projectId = optionalId(req.query.projectId);
      const impl = deps.manifest ?? defaultManifest;
      res.json(await impl(node, scope, projectId));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sync/plan', async (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const plan = await deps.service.plan({
        from: requireNode(body.from, 'from'),
        to: requireNode(body.to, 'to'),
        scope: requireScope(body.scope),
        ...(optionalId(body.projectId) !== undefined ? { projectId: optionalId(body.projectId) } : {}),
        ...(optionalId(body.targetProjectId) !== undefined
          ? { targetProjectId: optionalId(body.targetProjectId) }
          : {}),
      });
      res.json(plan);
    } catch (err) {
      next(err);
    }
  });

  router.post('/sync/apply', async (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.planId !== 'string' || body.planId.length === 0) {
        throw new Error('planId is required');
      }
      const names = Array.isArray(body.names)
        ? body.names.filter((n): n is string => typeof n === 'string')
        : undefined;
      const result = await deps.service.apply({
        planId: body.planId,
        ...(names !== undefined ? { names } : {}),
        force: body.force === true,
        // The route is behind authenticateToken, so this is always a human.
        actor: 'user',
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/skill-sync/tests/skill-sync.routes.test.ts
```

Expected: `# pass 7` / `# fail 0`

- [ ] **Step 5: 在 `index.js` 里构造单例并挂载**

在 `backend/server/index.js` 的 import 区（紧挨 `remote-agents` 那批）加：

```js
import { createSkillSyncService } from './modules/skill-sync/skill-sync.service.js';
import { createSkillSyncRouter } from './modules/skill-sync/skill-sync.routes.js';
import { skillSyncAuditDb } from './modules/skill-sync/skill-sync.db.js';
```

在 `setRemoteAgentsRuntime(...)` 之后（那里 registry 已经建好）加：

```js
// Skill sync: ONE service instance so the plan cache is process-wide.
// The audit repo is a lazy singleton (getConnection()), so nothing here needs
// to wait for initializeDatabase().
const skillSyncService = createSkillSyncService({
    getRegistry: () => getRemoteAgentsRuntime().registry,
    getProjectById: (projectId) => projectsDb.getProjectById(String(projectId)),
    audit: (row) => skillSyncAuditDb.record(row),
});
```

在 `app.use('/api/providers', ...)` 附近加挂载：

```js
app.use('/api/skills', authenticateToken, createSkillSyncRouter({
    service: skillSyncService,
    getRegistry: () => getRemoteAgentsRuntime().registry,
    listNodes: () => [
        { label: 'local', name: '本机', online: true },
        ...remoteHostsDb.list().map((h) => ({
            label: `remote:${h.host_id}`,
            name: h.name,
            online: h.status === 'online',
            ...(h.status === 'online' ? {} : { reason: h.last_error || '离线' }),
        })),
    ],
}));
```

> 绑定名已核实：`projectsDb` 与 `remoteHostsDb` 都是 `index.js:58` 从 `./modules/database/index.js` 具名导入的；`projectsDb.getProjectById(id)` 接受字符串 id 并返回含 `project_path` / `remote_host_id` 的行，正是 `ProjectLookup` 需要的形状（`index.js` 里传 projectId 的地方都在做 `String(...)` 转换）。

- [ ] **Step 6: 冒烟 —— 后端能起来且路由存在**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -20
```

Expected: 错误数量与改动前一致

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3188/api/skills/nodes
```

Expected: `401`（未带 token —— 证明路由已挂载且在鉴权之后）。**注意：重启后端前必须先问用户**，见 memory `lovdex-backend-restart-requires-confirm`；本步可在用户同意重启后执行。

- [ ] **Step 7: 提交**

```bash
git add backend/server/modules/skill-sync/skill-sync.routes.ts backend/server/modules/skill-sync/tests/skill-sync.routes.test.ts backend/server/index.js
git commit -m "feat(skill-sync): http api and wiring"
```

---

## Task 16: bootstrap 写入 `skillRoots`

**Files:**
- Modify: `backend/server/modules/remote-agents/bootstrap.service.ts`
- Test: `backend/server/modules/remote-agents/tests/bootstrap.service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/server/modules/remote-agents/tests/bootstrap.service.test.ts` 末尾追加（`baseInput` / `fakeRunner` / `fakePush` 都是本文件里已有的夹具）：

```ts
test('bootstrap omits skillRoots when the caller does not provide one', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  const result = await runBootstrap(baseInput, { runner, push, installScriptPath: '/local/install.sh' });

  assert.equal(result.ok, true);
  const configWrite = calls.find((argv) => argv.join(' ').includes('config.json'));
  assert.ok(configWrite, 'expected a config.json write');
  assert.doesNotMatch(configWrite.join(' '), /skillRoots/);
  assert.equal(result.skillRoots, undefined);
});

test('bootstrap writes skillRoots into config.json when provided', async () => {
  const { runner, calls } = fakeRunner();
  const { push } = fakePush();

  const result = await runBootstrap(
    { ...baseInput, skillRoots: ['/srv/.claude/skills'] },
    { runner, push, installScriptPath: '/local/install.sh' },
  );

  assert.equal(result.ok, true);
  const configWrite = calls.find((argv) => argv.join(' ').includes('config.json'));
  assert.ok(configWrite, 'expected a config.json write');
  assert.match(configWrite.join(' '), /skillRoots/);
  assert.deepEqual(result.skillRoots, ['/srv/.claude/skills']);
});

test('bootstrap rejects an empty skillRoots array', async () => {
  const { runner, push } = fakeRunner();
  const result = await runBootstrap(
    { ...baseInput, skillRoots: [] },
    { runner, push, installScriptPath: '/local/install.sh' },
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /skillRoots must be non-empty/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/bootstrap.service.test.ts
```

Expected: FAIL —— 写出的 config.json 里没有 `skillRoots`

- [ ] **Step 3: 写实现**

在 `backend/server/modules/remote-agents/bootstrap.service.ts` 里：

1. `BootstrapInput` 加字段（放在 `roots` 下方）：

```ts
  /**
   * Directories the lite's `skills/*` RPCs may touch. Optional: the lite
   * defaults to its own `~/.claude/skills` when the key is absent, so an
   * existing host does NOT need a re-deploy to gain skill sync.
   */
  skillRoots?: string[];
```

2. `BootstrapResult` 加同名字段。

3. `validateInput` 里，`roots` 校验之后加（只在给了值时才校验）：

```ts
  if (input.skillRoots !== undefined && input.skillRoots.length === 0) {
    return fail('skillRoots must be non-empty when provided (omit it to use the lite default)');
  }
```

4. 第 208 行附近构造 `configJson` 的地方，改成条件带上：

```ts
    roots: input.roots,
    ...(input.skillRoots ? { skillRoots: input.skillRoots } : {}),
```

5. 结果里回显：`...(input.skillRoots ? { skillRoots: input.skillRoots } : {})`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/remote-agents/tests/bootstrap.service.test.ts
```

Expected: `# fail 0`

- [ ] **Step 5: 提交**

```bash
git add backend/server/modules/remote-agents/bootstrap.service.ts backend/server/modules/remote-agents/tests/bootstrap.service.test.ts
git commit -m "feat(remote-agents): allow bootstrap to set skillRoots"
```

---

## Task 17: 前端 —— API 封装 + 设置页「技能同步」区块

**Files:**
- Modify: `web/src/utils/api.js`
- Create: `web/src/components/settings/SkillSyncSettings.tsx`
- Modify: `web/src/components/settings/SettingsPage.tsx`

- [ ] **Step 1: 加 API 封装**

`web/src/utils/api.js` 的形状是**一个大的 `api` 对象 + 命名空间**，每个方法调 `authenticatedFetch(path, options)` 并返回 `Response`。在 `notifications` 命名空间之后加一个 `skills` 命名空间：

```js
  // Skill sync across the local machine and remote hosts.
  skills: {
    nodes: () => authenticatedFetch('/api/skills/nodes').then((r) => r.json()),
    manifest: (node, scope, projectId) => {
      const qs = new URLSearchParams({ node, scope });
      if (projectId != null) qs.set('projectId', String(projectId));
      return authenticatedFetch(`/api/skills/manifest?${qs.toString()}`).then((r) => r.json());
    },
    plan: (body) =>
      authenticatedFetch('/api/skills/sync/plan', {
        method: 'POST',
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    apply: (body) =>
      authenticatedFetch('/api/skills/sync/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      }).then((r) => r.json()),
  },
```

- [ ] **Step 2: 写组件**

创建 `web/src/components/settings/SkillSyncSettings.tsx`。骨架如下（样式沿用设置页现有 class 约定）：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';

type NodeOption = { label: string; name: string; online: boolean; reason?: string };
type Entry = { name: string; action: 'create' | 'update' | 'same' | 'onlyTarget'; fromHash?: string; toHash?: string; bytes?: number; description?: string };
type Plan = { planId: string; entries: Entry[]; summary: Record<string, number> };
type Result = { entries: { name: string; status: string; error?: string }[]; summary: Record<string, number> };

const ACTION_LABEL: Record<Entry['action'], string> = {
  create: '新增',
  update: '更新',
  same: '相同',
  onlyTarget: '目标多余',
};

export function SkillSyncSettings() {
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [from, setFrom] = useState('local');
  const [to, setTo] = useState('local');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.skills.nodes().then((r) => setNodes(r.nodes ?? [])).catch((e) => setError(String(e.message ?? e)));
  }, []);

  const preview = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next: Plan = await api.skills.plan({ from, to, scope });
      setPlan(next);
      // 只有会真正传输的条目默认勾选
      setSelected(new Set(next.entries.filter((e) => e.action === 'create' || e.action === 'update').map((e) => e.name)));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [from, to, scope]);

  const run = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.skills.apply({ planId: plan.planId, names: [...selected] }));
      setPlan(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [plan, selected]);

  const transferable = plan?.entries.filter((e) => e.action === 'create' || e.action === 'update') ?? [];

  return (
    <section className="settings-section">
      <h3>技能同步</h3>
      <p className="settings-hint">把 skill 从一个节点同步到另一个节点。以 .claude/skills 为主目录。</p>

      <div className="skill-sync-controls">
        <label>
          源
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {nodes.map((n) => (
              <option key={n.label} value={n.label} disabled={!n.online}>
                {n.name}{n.online ? '' : `（${n.reason ?? '离线'}）`}
              </option>
            ))}
          </select>
        </label>
        <label>
          目标
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {nodes.map((n) => (
              <option key={n.label} value={n.label} disabled={!n.online}>
                {n.name}{n.online ? '' : `（${n.reason ?? '离线'}）`}
              </option>
            ))}
          </select>
        </label>
        <label>
          范围
          <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project')}>
            <option value="user">用户级 ~/.claude/skills</option>
            <option value="project">项目级 &lt;项目&gt;/.claude/skills</option>
          </select>
        </label>
        <button type="button" onClick={preview} disabled={busy || from === to}>预览差异</button>
      </div>

      {error && <p className="settings-error">{error}</p>}

      {plan && (
        <>
          <p className="settings-hint">
            新增 {plan.summary.create} · 更新 {plan.summary.update} · 相同 {plan.summary.same} · 目标多余 {plan.summary.onlyTarget}
          </p>
          {/* 桌面：表格。窄屏由 CSS 切成卡片（保留桌面布局，见既有约定） */}
          <table className="skill-sync-table">
            <thead>
              <tr><th /><th>技能</th><th>动作</th><th>源</th><th>目标</th><th>大小</th></tr>
            </thead>
            <tbody>
              {plan.entries.map((e) => (
                <tr key={e.name} data-action={e.action}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={e.action !== 'create' && e.action !== 'update'}
                      checked={selected.has(e.name)}
                      onChange={(ev) => {
                        const next = new Set(selected);
                        if (ev.target.checked) next.add(e.name); else next.delete(e.name);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td>{e.name}{e.description ? <small> {e.description}</small> : null}</td>
                  <td>{ACTION_LABEL[e.action]}</td>
                  <td>{e.fromHash?.slice(0, 8) ?? '—'}</td>
                  <td>{e.toHash?.slice(0, 8) ?? '—'}</td>
                  <td>{e.bytes != null ? `${e.bytes} B` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={run} disabled={busy || selected.size === 0}>
            同步选中的 {selected.size} 项
          </button>
          {transferable.length === 0 && <p className="settings-hint">两边已经完全一致。</p>}
        </>
      )}

      {result && (
        <div className="skill-sync-result">
          <p>成功 {result.summary.ok} · 跳过 {result.summary.skipped} · 冲突 {result.summary.conflict} · 失败 {result.summary.failed}</p>
          <ul>
            {result.entries.filter((e) => e.status !== 'skipped').map((e) => (
              <li key={e.name}>{e.name} — {e.status}{e.error ? `：${e.error}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
```

**窄屏适配**：在组件同目录的样式文件（或 `SettingsPage` 使用的样式表）里加：

```css
@media (max-width: 640px) {
  .skill-sync-table thead { display: none; }
  .skill-sync-table tr { display: block; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; }
  .skill-sync-table td { display: block; border: none; }
}
```

- [ ] **Step 3: 挂到设置页**

在 `web/src/components/settings/SettingsPage.tsx` 第 92–93 行附近（`<OperatorSkillExecSettings />` / `<InboxSkillSettings />` 旁边）加：

```tsx
<SkillSyncSettings />
```

并加 import：

```tsx
import { SkillSyncSettings } from './SkillSyncSettings';
```

- [ ] **Step 4: 跑前端检查**

```bash
cd /mnt/b/workdir/github/lovdex/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20
```

Expected: 零新增错误（web 测试无 DOM 环境，见 memory `lovdex-cli-verification-recipe`）

- [ ] **Step 5: 浏览器 E2E（人工）**

启动前端 dev server，打开 `http://<本机IP>:5188/settings?tab=operator`，确认「技能同步」区块出现、源/目标下拉能列出在线主机、点「预览差异」能出表。

**验收方式按 memory `lovdex-screenshot-read-hallucinates`**：用 `computed display` + 元素紧裁切判断，不要把整页截图的图像描述当证据。

- [ ] **Step 6: 提交**

```bash
git add web/src/utils/api.js web/src/components/settings/SkillSyncSettings.tsx web/src/components/settings/SettingsPage.tsx
git commit -m "feat(web): skill sync settings section"
```

---

## Task 18: operator 工具

`skill_sync_apply` 是往远程机器写磁盘，**默认关闭**，需在 operator 配置里显式开启 —— 不该让助手自作主张推到生产机。

**Files:**
- Modify: `backend/server/modules/operators/operator.tools.ts`
- Modify: `backend/server/modules/operators/operator.config.ts`
- Test: `backend/server/modules/operators/tests/operator-skill-sync.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/server/modules/operators/tests/operator-skill-sync.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSkillSyncOperatorTools } from '../operator-skill-sync.tools.js';

function deps(overrides: Record<string, unknown> = {}) {
  const audits: unknown[] = [];
  const applied: unknown[] = [];
  return {
    audits,
    applied,
    service: {
      plan: async (req: unknown) => ({ planId: 'p1', entries: [], summary: {}, request: req }),
      apply: async (req: unknown) => {
        applied.push(req);
        return { planId: 'p1', entries: [], summary: { ok: 0, skipped: 0, conflict: 0, failed: 0 }, request: req };
      },
    },
    audit: (row: unknown) => audits.push(row),
    ...overrides,
  };
}

test('skill_sync_plan is available by default and is read-only', async () => {
  const d = deps();
  const tools = createSkillSyncOperatorTools(d as never);
  const result = await tools.skill_sync_plan({ from: 'local', to: 'remote:h1', scope: 'user' });
  assert.match(String(result), /p1|新增|没有/);
  assert.equal(d.audits.length, 0, 'a read-only plan must not write audit rows');
});

test('skill_sync_apply is denied unless explicitly enabled', async () => {
  const d = deps({ allowApply: false });
  const tools = createSkillSyncOperatorTools(d as never);
  const result = await tools.skill_sync_apply({ planId: 'p1' });
  assert.match(String(result), /未开启/);
  assert.equal(d.audits.length, 0);
});

test('skill_sync_apply runs and audits when enabled', async () => {
  const d = deps({ allowApply: true });
  const tools = createSkillSyncOperatorTools(d as never);
  await tools.skill_sync_apply({ planId: 'p1', names: ['demo'], force: true });
  assert.equal(d.audits.length, 0, 'auditing happens inside the service, not the tool');
  assert.equal((d.applied[0] as { actor: string }).actor, 'operator');
  assert.equal((d.applied[0] as { force: boolean }).force, true);
});

test('skill_sync_plan rejects a bad node label', async () => {
  const tools = createSkillSyncOperatorTools(deps() as never);
  await assert.rejects(() => tools.skill_sync_plan({ from: 'nope', to: 'local', scope: 'user' }), /invalid skill node/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-skill-sync.test.ts
```

Expected: FAIL — `Cannot find module '../operator-skill-sync.tools.js'`

- [ ] **Step 3: 写工具模块**

创建 `backend/server/modules/operators/operator-skill-sync.tools.ts`：

```ts
import { parseSkillNode } from '../skill-sync/skill-node.js';
import type { SkillSyncService } from '../skill-sync/skill-sync.service.js';
import type { SkillScope, SyncPlan } from '../skill-sync/types.js';

export type SkillSyncOperatorDeps = {
  service: Pick<SkillSyncService, 'plan' | 'apply'>;
  /** Operator config gate — writes are opt-in. */
  allowApply: boolean;
};
function requireScope(raw: unknown): SkillScope {
  if (raw !== 'user' && raw !== 'project') throw new Error('scope must be "user" or "project"');
  return raw;
}

function renderPlan(plan: SyncPlan): string {
  const { create, update, same, onlyTarget } = plan.summary;
  const head = `planId=${plan.planId} 新增 ${create} · 更新 ${update} · 相同 ${same} · 目标多余 ${onlyTarget}`;
  const rows = plan.entries
    .filter((e) => e.action !== 'same')
    .map((e) => `- ${e.name} [${e.action}]`);
  return [head, ...rows].join('\n');
}

export function createSkillSyncOperatorTools(deps: SkillSyncOperatorDeps) {
  return {
    /** Read-only: produces a preview and a planId. Writes nothing, audits nothing. */
    async skill_sync_plan(input: { from: string; to: string; scope: string; projectId?: number; targetProjectId?: number }) {
      const plan = await deps.service.plan({
        from: parseSkillNode(input.from),
        to: parseSkillNode(input.to),
        scope: requireScope(input.scope),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.targetProjectId !== undefined ? { targetProjectId: input.targetProjectId } : {}),
      });
      return renderPlan(plan);
    },

    async skill_sync_apply(input: { planId: string; names?: string[]; force?: boolean }) {
      if (!deps.allowApply) {
        return '技能同步的写操作未开启。请在 设置 → 助手 里打开「允许助手同步技能」后重试。';
      }
      const result = await deps.service.apply({
        planId: input.planId,
        ...(input.names !== undefined ? { names: input.names } : {}),
        force: input.force === true,
        actor: 'operator',
      });
      const { ok, skipped, conflict, failed } = result.summary;
      const lines = [`成功 ${ok} · 跳过 ${skipped} · 冲突 ${conflict} · 失败 ${failed}`];
      for (const e of result.entries) {
        if (e.status === 'ok' || e.status === 'skipped') continue;
        lines.push(`- ${e.name} [${e.status}]${e.error ? `：${e.error}` : ''}`);
      }
      return lines.join('\n');
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/b/workdir/github/lovdex/backend && unset TSX_TSCONFIG_PATH && npx tsx --tsconfig server/tsconfig.json --test server/modules/operators/tests/operator-skill-sync.test.ts
```

Expected: `# pass 4` / `# fail 0`

- [ ] **Step 5: 接进 operator 配置与工具注册**

工具清单的形状是 `createOperatorTools(deps)` 返回一个 `{ [toolName]: { description, inputSchema, handler } }` 的大对象，可选依赖用 `deps.xxx` 判空（照 `execute_skill` 的 `deps.skillExec` 写法）。

1. 在 `backend/server/modules/operators/operator.config.ts` 的 `OperatorConfig` 里加字段（放在 `interactive_chat_enabled` 下方）：

```ts
  /**
   * Allow the operator to WRITE skills to other machines via skill_sync_apply.
   * Default off: this pushes files onto remote hosts, so it must be an explicit
   * opt-in. `skill_sync_plan` is read-only and always available.
   */
  allow_skill_sync: boolean;
```

并在 `DEFAULT_OPERATOR_CONFIG` 里加：

```ts
  allow_skill_sync: false,
```

（`getOperatorConfig` 已经把存储的 partial 合并在默认值上，新字段无需迁移。）

2. 在 `backend/server/modules/operators/operator.tools.ts` 的 `OperatorToolDeps` 里加可选依赖（放在 `skillExec` 附近）：

```ts
  /**
   * Skill sync. Wired by the server; `allowApply` comes from
   * getOperatorConfig().allow_skill_sync.
   */
  skillSync?: {
    service: Pick<SkillSyncService, 'plan' | 'apply'>;
    allowApply: boolean;
  };
```

顶部加 import：

```ts
import type { SkillSyncService } from '@/modules/skill-sync/skill-sync.service.js';
```

3. 在返回的工具对象里（紧挨 `workbench` 之后）加两个工具：

```ts
    skill_sync_plan: {
      description:
        'Preview a skill sync between two nodes WITHOUT writing anything. from/to are node labels: "local" for the machine running Lovdex, or "remote:<hostId>" for a registered remote host. scope=user syncs ~/.claude/skills; scope=project syncs <project>/.claude/skills and then requires projectId + targetProjectId. Returns a planId plus a per-skill action list (create/update/same/onlyTarget). Pass the planId to skill_sync_apply to actually transfer — the preview is single-use and expires in 10 minutes.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source node label, e.g. "local" or "remote:h1"' },
          to: { type: 'string', description: 'Target node label' },
          scope: { type: 'string', enum: ['user', 'project'] },
          projectId: { type: 'number', description: 'Source project id (project scope only)' },
          targetProjectId: { type: 'number', description: 'Target project id (project scope only)' },
        },
        required: ['from', 'to', 'scope'],
      },
      handler: async (i: {
        from: string;
        to: string;
        scope: string;
        projectId?: number;
        targetProjectId?: number;
      }) => {
        if (!deps.skillSync) throw new Error('skill_sync_plan is not wired (missing skillSync dep)');
        return createSkillSyncOperatorTools(deps.skillSync).skill_sync_plan(i);
      },
    },
    skill_sync_apply: {
      description:
        'Execute a skill sync previously previewed by skill_sync_plan. planId is REQUIRED and single-use. names optionally narrows the transfer to a subset of the plan entries. Refuses any skill whose source or target changed since the preview (report those back to the user instead of forcing); set force=true only when the user explicitly asks to overwrite a modified target. Backups of overwritten skills are kept under .skill-sync-backup/ on the target. Requires the user to have enabled "allow skill sync" in operator settings — otherwise this returns a message telling them how to turn it on.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: 'planId returned by skill_sync_plan' },
          names: { type: 'array', items: { type: 'string' }, description: 'Optional subset of skill names' },
          force: { type: 'boolean', description: 'Overwrite a target that changed since the preview (default false)' },
        },
        required: ['planId'],
      },
      handler: async (i: { planId: string; names?: string[]; force?: boolean }) => {
        if (!deps.skillSync) throw new Error('skill_sync_apply is not wired (missing skillSync dep)');
        return createSkillSyncOperatorTools(deps.skillSync).skill_sync_apply(i);
      },
    },
```

顶部再加一个 import：

```ts
import { createSkillSyncOperatorTools } from './operator-skill-sync.tools.js';
```

> `skill_sync_apply` 的 `force` 只在用户明确要求覆盖时传 true；工具描述里已经这么写，别在 handler 里替助手做决定。

4. 在 `backend/server/index.js` 构造 operator 工具的地方，把 `skillSync` 注入进去：

```js
  skillSync: {
    service: skillSyncService,
    allowApply: getOperatorConfig().allow_skill_sync,
  },
```

（`skillSyncService` 是 Task 15 Step 5 建的那个单例。）

- [ ] **Step 6: 确认零新增类型错误并提交**

```bash
cd /mnt/b/workdir/github/lovdex/backend && npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -20
```

Expected: 错误数量与改动前一致

```bash
git add backend/server/modules/operators/
git commit -m "feat(operator): skill sync tools, writes opt-in"
```

---

## Task 19: 真机 E2E（三条路径）

用远程验证机跑通 local→remote / remote→local / remote→remote。

**Files:** 无（验证任务）

- [ ] **Step 1: 准备**

确认验证机在线：`172.26.167.52`。优先用 `asr.cpu@:28211`（PID1 是 bash 的 docker 容器）—— 它走 install.sh 非 systemd 路径，正好覆盖「老 config.json 缺 `skillRoots`」的兼容性。

- [ ] **Step 2: 验证老 config 兼容（不重新 deploy）**

在验证机上确认 `~/.lovdex-remote/config.json` **没有** `skillRoots` 键，然后重启 lite，断言 `skills/manifest` 仍可用（zod 默认值生效）：

```bash
grep -c skillRoots ~/.lovdex-remote/config.json || echo "no skillRoots key (expected)"
```

Expected: 没有该键，但同步仍能工作 → 证明老主机免 deploy。

- [ ] **Step 3: local → remote**

在设置页选 源=本机 / 目标=验证机 / 范围=用户级，预览后同步一个新 skill。然后在验证机上核对：

```bash
ls -la ~/.claude/skills/
cat ~/.claude/skills/<name>/SKILL.md
```

Expected: 文件出现且内容一致。

- [ ] **Step 4: 验证备份与漂移保护**

在验证机上手工改 `~/.claude/skills/<name>/SKILL.md`，回设置页重新预览（应显示为「更新」），同步。

Expected: 同步**被拒绝**为 conflict，验证机上的本地修改**原封不动**。再次同步并勾选强制覆盖后：

```bash
ls -la ~/.claude/skills/.skill-sync-backup/
```

Expected: 出现带时间戳的备份目录，且里面是手工改过的版本。

- [ ] **Step 5: remote → local**

把验证机上手工创建的一个 skill 拉回本机，核对内容与 `.skill-sync-backup/` 行为同上。

- [ ] **Step 6: remote → remote**

需要第二台在线远程主机。若暂时只有一台，用同一台主机的两个不同项目做**项目级**同步作为替代验证（源项目/目标项目同机不同路径），并在计划里如实记录这次替代。

Expected: 目标侧内容与源一致；`skill_sync_audit` 里 `from_node` / `to_node` 分别是两台主机。

- [ ] **Step 7: 查审计**

```bash
sqlite3 ~/.lovdex/data/new-auth.db "SELECT created_at, actor, from_node, to_node, skill_name, action, status FROM skill_sync_audit ORDER BY id DESC LIMIT 20;"
```

Expected: 每一步都留痕，`actor` 区分 `user` / `operator`。

- [ ] **Step 8: 提交验证记录**

把实际结果（含失败与替代方案）追加到本计划文件末尾的「执行记录」小节，然后：

```bash
git add docs/superpowers/plans/2026-09-20-skill-sync.md
git commit -m "docs(skill-sync): record remote e2e results"
```

---

## 执行记录

（执行时在此追加：每台验证机的实际行为、遇到的偏差、被替代的步骤。）

