# Skill 同步机制（本地 ↔ 远程 · 远程 ↔ 远程）设计

日期：2026-09-20
状态：已确认，待写实现计划

## 0. 背景与目标

Lovdex 的 skill 发现与写入（`backend/server/modules/providers/shared/skills/skills.provider.ts`）目前**只读 main 本机磁盘**：claude provider 的源是 `~/.claude/skills`（user）和 `<project>/.claude/skills`（project），完全不感知远程主机。远程主机上跑着同一套 Claude Code / Qoder，但它们的 `.claude/skills` 既读不到也写不进去。

目标：给 Lovdex 加一套 skill 同步机制，支持三个方向 ——

1. **分发**：本地 → 远程（最痛，优先）
2. **收集**：远程 → 本地
3. **远程 ↔ 远程**：经 main 中转

以 `.claude/skills` 为主目录，覆盖 user 级与 project 级。

### 参考 Sophclaw-client 的结论

`sophclaw-client` 仓库里**没有** local↔remote 同步实现（`renderer/stores/claw.ts` 明确把云端 ledger 同步列为范围外）。最接近的是 `feat/sophcode-skill-manager` 分支的 `desktop/src/main/skill-manager.ts`：本地 catalog → 运行时快照的单向复制。可借鉴的只有三件套：

- `collectSkillFiles()` 的 **contentHash 指纹**（递归排序遍历 + sha256）
- `sophcode.yaml` **manifest**（id / version / entry / requirements）
- tmp 目录构建 + **原子 `renameSync`** 替换

目录约定、冲突策略、远程端点协议都需要我们自己定。

## 1. 非目标（v1 明确不做）

- **不做 tar/zip 打包传输**。目录级 RPC 传文件数组已足够；等真出现带大量二进制资源的 skill 再演进（预留 `skills/v2` capability）。
- **不做定时/自动同步**。同步一律显式触发。
- **不做新主机上线自动铺开**。
- **不做目标端删除**。`onlyTarget`（目标有、源没有）**仅展示**，v1 没有任何删除路径。
- **不做按 git remote URL 的项目自动配对**。降级为 UI 建议提示，留后续。

## 2. 统一节点模型

同步方向不是独立参数，而是 `from` / `to` 的组合 —— 三个方向共用同一条代码路径：

```ts
type SkillNode = { kind: 'local' } | { kind: 'remote'; hostId: string };
type SkillScope = 'user' | 'project';

planSync({ from, to, scope, projectId?, targetProjectId? }) → SyncPlan
applySync({ planId, names?, actor })                        → SyncResult
// names：可选，只同步 plan.entries 的子集（只能选 create/update 条目）
```

- `local → remote`：`from = {kind:'local'}`，`to = {kind:'remote', hostId}`
- `remote → local`：反过来
- `remote → remote`：`from = A`，`to = B` —— main 从 A 读 bundle 到内存，直接写给 B，**不落临时文件**

**本地也实现成一个节点**，与远程节点共用同一套接口（`listManifest` / `readBundle` / `applyBundle`），所以编排层里**没有 `if (isRemote)` 分支**。这是整个设计的核心简化。

### 目录解析

| scope | local | remote |
|---|---|---|
| user | `~/.claude/skills` | 远程 agent 进程 `join(os.homedir(), '.claude/skills')` |
| project | `<项目 project_path>/.claude/skills` | `<远程项目 project_path>/.claude/skills`（该字段本身即远程路径） |

## 3. 指纹算法

放 `backend/server/shared/skill-hash.ts`，**main 与 lite 复用同一份实现**。两端算出的指纹必须逐位相同，否则 diff 不成立。

```
skillContentHash(root, name):
  files = 递归遍历 <root>/<name>
          跳过：以 . 开头的目录（含 .git、.skill-sync-backup、.skill-sync-tmp-*）
                以 . 开头的文件（含 .DS_Store）
                node_modules/
                符号链接（与 lite fs 层一致，不跟随）
  entries = files.map(f => ({
    rel:  relative(<root>/<name>, f) 的分隔符统一替换为 '/',
    hash: sha256(fileBytes),
    exec: (mode & 0o111) !== 0,
  })).sort(按 rel 的字节序)

  h = sha256()
  for e of entries:
    h.update(e.rel + '\0' + e.hash + '\0' + (e.exec ? '1' : '0') + '\0')
  return h.digest('hex')
```

要点：

- **不纳入 mtime**。跨机时钟不可靠，纳入会产生大量假冲突。mtime 只在列表里展示。
- **纳入可执行位**。skill 常带脚本，权限位是内容的一部分。
- **只算文件，不算空目录**。空目录跨机同步无意义。
- **路径分隔符统一为 `/`**。否则 Windows 主机（若将来支持）会算出不同指纹。

## 4. manifest 与差异分类

### manifest 条目

```ts
type SkillManifestEntry = {
  name: string;          // 目录名，即 skill 标识
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  mtime: number;         // 仅展示，不参与 diff
  description?: string;  // SKILL.md frontmatter
  version?: string;      // SKILL.md frontmatter
};
```

manifest 阶段顺手解析 `SKILL.md` frontmatter（复用 `server/shared/frontmatter.ts`），省掉列表页的额外往返。

### 差异分类

对 `from` 与 `to` 的 manifest 按 `name` 求并集：

| action | 含义 | 默认是否传输 |
|---|---|---|
| `create` | 目标没有 | 是 |
| `update` | 两边都有，`contentHash` 不同 | 是 |
| `same` | `contentHash` 相同 | 否 |
| `onlyTarget` | 目标有、源没有 | 否（v1 无删除路径） |

```ts
type SyncPlan = {
  planId: string;
  from: SkillNode; to: SkillNode; scope: SkillScope;
  projectId?: number; targetProjectId?: number;
  entries: Array<{
    name: string;
    action: 'create' | 'update' | 'same' | 'onlyTarget';
    fromHash?: string; toHash?: string;
    bytes?: number; description?: string;
  }>;
  summary: { create: number; update: number; same: number; onlyTarget: number };
  createdAt: number;
};
```

### 乐观并发校验（"预览确认"真正兑现的地方）

`apply` 时必须做两次校验，否则预览就只是装饰：

- **源侧**：重读源 bundle 算 hash，与 plan 里的 `fromHash` 不符 → 该条目标 `conflict`（plan 到 apply 之间源被改了）
- **目标侧**：远程 `skills/apply` 前重算目标现有 hash，与 plan 里的 `toHash` 不符 → 拒绝，除非 `force`（目标被改过，不能默默覆盖）

## 5. lite 侧：3 个新 RPC

在 `backend/remote-agent/src/rpc-dispatch.ts` 的 `handleRpc` 加三个分支，与现有 `fs/*` 同构。

### `skills/manifest`

```
params: { root: string }
→ { root: string; exists: boolean; entries: SkillManifestEntry[] }
```

只扫 root 的**直接子目录**。root 不存在返回 `exists: false` 而非报错 —— 全新机器没装过 skill 是正常态。

### `skills/bundle`

```
params: { root: string; name: string }
→ { name: string; contentHash: string;
    files: Array<{ relativePath: string; content: string;
                   encoding: 'utf8' | 'base64'; executable: boolean }> }
```

- `name` 必须匹配 `/^[A-Za-z0-9._-]+$/` 且不是 `.` / `..`，再过 `resolveWithinRoots` 兜底
- 编码按内容探测：含 NUL 字节走 `base64`，否则 `utf8`，每项显式带 `encoding`
- 拒绝符号链接
- 单文件 > 2 MiB 或单 skill > 16 MiB → 报错，v1 不做分片

### `skills/apply`

```
params: { root, name, contentHash, files, expectedTargetHash: string | null, force?: boolean }
→ { action: 'created' | 'updated' | 'skipped'; backupPath?: string; contentHash: string }
```

写入顺序（POSIX 上 `rename` 到非空目录会 `ENOTEMPTY`，必须三步走）：

1. `resolveWithinRoots(root)` + `name` 校验
2. 目标已存在 → 重算 hash，与 `expectedTargetHash` 不符且非 `force` → 抛 `target changed`
3. 备份整目录到 `<root>/.skill-sync-backup/<name>.<ISO 时间戳>/`
4. 写 tmp 目录 `<root>/.skill-sync-tmp-<rand>/` → 把旧目录 `rename` 到 `.skill-sync-old-<rand>` → tmp `rename` 到目标 → 删旧目录
5. 校验写入后 hash == 期望 `contentHash`，不符则把备份 `rename` 回去（回滚）

## 6. 白名单：新增 `skillRoots`，不动 `roots`

lite 的 `roots` 是必填白名单（`config.ts` 明确拒绝默认 `['/']`），当前只覆盖项目目录，挡得住 `~/.claude/skills`。

新增独立配置项：

```ts
skillRoots: z.array(z.string()).default(() => [join(homedir(), '.claude/skills')])
```

skills RPC 的路径校验用 `resolveWithinRoots(p, [...cfg.roots, ...cfg.skillRoots])`。三个理由：

1. **不强迫运维把 home 加进 `roots`** —— 那会顺带放开通用 `fs/*` 对 home 的读写，权限扩大得没必要
2. **已有主机不必重新 deploy** —— zod `.default()` 在解析时补齐，老 `config.json` 缺这个键会自动拿到默认值
3. **项目级路径本来就在 `roots` 里**，天然放行

`bootstrap.service.ts` 在写 `config.json` 时显式带上 `skillRoots`（便于运维查看/编辑），但**不是必填**，缺省由 lite 侧兜底。

### capability 探测

`hello.capabilities` 加 `'skills/v1'`。main 侧 `registry.getCapabilities(hostId)` 探测不到 → 返回明确错误「目标主机 lite 版本过旧，请先 deploy 升级」，**不静默降级**到逐文件 `fs/*` 搬运。

## 7. main 侧模块

### `remote-skills.service.ts`（RPC 客户端）

照 `remote-fs.service.ts` 的形状：

```ts
createRemoteSkillsClient(getRegistry) → {
  manifest(hostId, root): Promise<RemoteSkillManifest>   // 30s
  bundle(hostId, root, name): Promise<RemoteSkillBundle> // 60s
  apply(hostId, root, payload): Promise<RemoteSkillApply>// 120s，与 fs/write 对齐
}
```

### `skill-sync.service.ts`（编排）

节点差异全部收敛到两个适配器（`localSkillStore` / `remoteSkillStore`），共用同一接口：

```ts
createSkillSyncService(deps) → {
  listNodes(): SkillNode[]        // local + 全部在线远程主机
  plan(req): Promise<SyncPlan>    // 读两端 manifest → diff
  apply(req): Promise<SyncResult> // 逐 entry：读源 bundle → 写目标
}
```

**plan 缓存**：结果放进程内 `Map<planId, { plan, actor, createdAt }>`，TTL 10 分钟，访问时惰性清理。apply 用 `planId` 取回 —— **不让前端回传整个 plan**，否则计划内容可被篡改，第 4 节的两道校验形同虚设。

（单进程假设。lovdex 后端是单进程 tsx/supervisor 模型，符合现状。）

## 8. HTTP API

```
GET  /api/skills/nodes                              列出节点（local + 在线远程主机）
GET  /api/skills/manifest?node=&scope=&projectId=   列某节点 skill（含 hash）
POST /api/skills/sync/plan                          出差异预览 → planId
POST /api/skills/sync/apply                         执行
```

按现有项目路由的样板分流：`lookupRemoteHost(projectPath)` → 远程走 RPC，否则 `node:fs`。

## 9. 审计表

新建 `skill_sync_audit`：

```sql
CREATE TABLE IF NOT EXISTS skill_sync_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL CHECK (actor IN ('user','operator','system')),
  from_node TEXT NOT NULL,        -- 'local' | 'remote:<hostId>'
  to_node TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user','project')),
  project_id INTEGER,
  target_project_id INTEGER,
  skill_name TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'create' | 'update' | 'skip' | 'conflict'
                                  -- ('delete' 预留：v1 无删除路径，但表结构先容纳，
                                  --  避免将来加删除功能时要改 CHECK 约束做迁移)
  content_hash TEXT,
  backup_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','failed')),
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_skill_sync_audit_created ON skill_sync_audit(created_at DESC);
```

**不复用 `operator_exec_audit`**：那张表的 CHECK 只允许 `execute_skill` / `workbench`，语义是「助手工具执行」；同步是用户和助手都能触发的运维动作，混在一起会让审计口径变糊。

**不建同步状态表**：状态一律实时探测（与 `alert-skill.service.ts` 的「每次从磁盘推导、不落库」一致），避免与真实文件状态漂移。

## 10. 项目级配对

`projects` 表里同一份代码在两端是**两行**（本地项目 `remote_host_id IS NULL`；远程项目 `remote_host_id` 非空且 `project_path` 是远程路径）。因此 `scope = 'project'` 时请求必须同时给：

- `projectId` — 源项目（本地项目，或远程项目）
- `targetProjectId` — 目标项目

UI 用下拉选。**v1 不做自动配对**：按 git remote URL 匹配会误配（fork、多 remote、无 remote 的项目），按路径尾段匹配太脆。后续可做成 UI 里的「建议目标」提示，标黄但不自动执行。

## 11. 入口 1：设置页 UI

在 `web/src/components/settings/SettingsPage.tsx` 现有 `InboxSkillSettings` 旁新增「技能同步」区块。

流程：源节点 → 目标节点 → scope（用户级 / 项目级）→ **预览差异** → 差异表 → 勾选 → 同步。

差异表列：skill 名 / 动作 / 源 hash 短码 / 目标 hash 短码 / 大小 / 描述。离线主机在下拉里置灰并标注原因。

按既有约定（见 memory `lovdex-mobile-adaptation-keeps-desktop`）：**桌面用表格，窄屏才双渲染成卡片**，不砍桌面布局。

## 12. 入口 2：operator 工具

两个工具，与 `execute_skill` / `workbench` 同层注册：

- `skill_sync_plan({ from, to, scope, projectId?, targetProjectId? })` — 只读，返回差异摘要
- `skill_sync_apply({ planId, names? })` — 写操作

`skill_sync_apply` **默认关闭，需在 operator 配置里显式开启**（照 `execute_skill` 的白名单开关模式）。理由：这是往远程机器写磁盘，不该让助手自作主张推到生产机。

两次调用都写入 `skill_sync_audit`，`actor = 'operator'`。

## 13. 错误处理

| 情况 | 行为 |
|---|---|
| 目标主机离线 | plan 阶段拒绝，不产生 plan |
| lite 未升级（缺 `skills/v1`） | plan 阶段拒绝，提示先 deploy 升级 |
| skill 超大小上限 | plan 阶段用 manifest 的 `totalBytes` 预检标红，不等到传一半才炸 |
| 目标 hash 漂移 | 该条目标 `conflict`，**其余继续**，不整批中断 |
| 单条传输失败 | 不中断整批：逐 entry 记 `status`，最后汇总；apply 本身原子，失败即回滚到备份 |
| 磁盘满 / 权限不足 | 透传 lite 错误消息，附 skill 名和路径 |

## 14. 测试策略

- **`skill-hash` 单测**：确定性（文件枚举顺序不影响结果）、POSIX 分隔符、可执行位、跳过规则。**外加跨端一致性测试** —— 同一 fixture 在 main 和 lite 两侧各算一次，断言相等。这是整个 diff 成立的前提，不能只测单侧。
- **lite `skills/*` 单测**：name 校验、路径穿越、roots 拒绝、目标 hash 漂移、回滚路径、备份生成。
- **`skill-sync.service` 单测**：diff 四分类、plan 缓存 TTL、部分失败汇总。
- **端到端**：用远程验证机 172.26.167.52 真机跑三条路径（local→remote / remote→local / remote→remote）。其中 `asr.cpu@:28211`（PID1 是 bash 的 docker 容器）走 install.sh 非 systemd 路径，正好验证 lite 升级 + 老 `config.json` 缺 `skillRoots` 的兼容性。

测试跑法见 memory `lovdex-cli-verification-recipe`：`npx tsx --test <file>`，需先 `unset TSX_TSCONFIG_PATH`。

## 15. 涉及文件

**新增**

- `backend/server/shared/skill-hash.ts` — 共享指纹算法
- `backend/server/shared/claude-paths.ts` — 导出 `getClaudeHomePath()`，供下面两处共用
- `backend/remote-agent/src/skills.ts` — lite 侧 skill 目录读写（manifest/bundle/apply）
- `backend/server/modules/skill-sync/remote-skills.service.ts` — RPC 客户端
- `backend/server/modules/skill-sync/skill-sync.service.ts` — 编排 + plan 缓存
- `backend/server/modules/skill-sync/skill-sync.routes.ts` — HTTP API
- `web/src/components/settings/SkillSyncSettings.tsx` — 设置页区块

（目录名用 `skill-sync` 而非 `skills`，避免与既有的 `providers/services/skills.service.ts`、`providers/shared/skills/` 混淆 —— 那两处是 provider 维度的 skill 发现，这里是跨节点同步。）

**修改**

- `backend/remote-agent/src/rpc-dispatch.ts` — 加 3 个分支
- `backend/remote-agent/src/config.ts` — 加 `skillRoots`
- `backend/remote-agent/src/index.ts` — `hello.capabilities` 加 `skills/v1`
- `backend/server/shared/agent-runtime/protocol.ts` — 加 3 个 params schema
- `backend/server/modules/database/schema.ts` + `migrations.ts` — 加 `skill_sync_audit`
- `backend/server/modules/remote-agents/bootstrap.service.ts` — 写 `skillRoots`
- `backend/server/modules/providers/list/claude/claude-skills.provider.ts` — 删掉私有 `getClaudeHomePath`（第 20 行），改用共享 helper
- `backend/server/index.js` — 挂载路由 + 构造单例
- `backend/server/modules/operators/operator.tools.ts` — 加 2 个工具
- `web/src/components/settings/SettingsPage.tsx` — 挂载新区块
- `web/src/utils/api.js` — 4 个 API 封装

**复用（不重写）**

- `backend/server/modules/remote-agents/remote-projects.index.ts` 的 `lookupRemoteHost` / `lookupHostForPath` — 项目路径 → 远程主机分流
- `backend/server/shared/frontmatter.ts` — 解析 `SKILL.md` 的 `description` / `version`
- `backend/server/modules/remote-agents/runtime.ts` 的 `getRemoteAgentsRuntime()` — 取 registry 单例

## 16. 后续演进

- **`skills/v2`**：bundle 改成 tar 单帧 + 分片，应对带大量二进制资源的 skill
- **自动配对**：按 git remote URL 给出项目级「建议目标」
- **自动铺开**：新主机上线自动同步 user 级 skill 全集
- **三方合并**：以 plan 时的共同祖先做 diff3，替代「冲突即拒绝」
