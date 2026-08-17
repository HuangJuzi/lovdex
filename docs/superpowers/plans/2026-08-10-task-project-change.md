# 任务修改所属项目 + 清空会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 积压/待做任务支持在详情页修改所属项目；修改时若已关联会话则硬删除该会话（DB 行 + 磁盘 transcript）并解绑任务。

**Architecture:** 后端 `PATCH /api/tasks/:taskId` 增加 `projectPath` 字段；`tasksService.updateTask` 改为 async，负责状态校验（仅 backlog/todo）、目标项目存在性校验、删除关联会话（经 `deps.deleteSessionHard` 注入，生产默认延迟 import `sessionsService` 并容错 SESSION_NOT_FOUND）与解绑（`session_id = null`）。前端 `TaskDetail` 属性区「所属项目」在 backlog/todo 时渲染下拉选择器，会话删除前弹确认框。

**Tech Stack:** Express + better-sqlite3（后端），React + Vite + TS（前端），node:test + tsx（测试）。

---

## 文件总览

**后端 `lovdex-backend/`：**

| 文件 | 改动 |
|---|---|
| `server/modules/database/repositories/tasks.db.ts` | `updateTask` 的 updates 类型加 `projectPath?: string`，SET 子句加 `project_path = ?` |
| `server/modules/tasks/services/tasks.service.ts` | `updateTask` 改 async；`deps` 加 `deleteSessionHard`；处理 projectPath 的校验/删会话/解绑；同项目 no-op |
| `server/modules/tasks/tasks.routes.ts` | PATCH 的 `hasFieldUpdates` 加 `'projectPath'`；读 `body.projectPath`；`await` service |
| `server/modules/tasks/tests/tasks.service.test.ts` | 重写 stub `updateTask` 支持键翻译；新增 7 个用例 |

**前端 `lovdex-cli/`：**

| 文件 | 改动 |
|---|---|
| `src/components/tasks/TaskDetail.tsx` | 挂载时拉项目列表；属性区「所属项目」按状态渲染 select/只读；变更处理（确认 → PATCH → 刷新/回退） |

**不改** `server/index.js`：`deleteSessionHard` 的生产默认实现内置在 service 中（延迟 `import('@/modules/providers/services/sessions.service.js')` + SESSION_NOT_FOUND 容错），无需 index.js 注入。（设计文档文件表中列了 index.js，此处以 service 内默认实现落地，耦合更小且容错可在测试中覆盖。）

---

## Task 1: 服务层测试先行（TDD red）

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tests/tasks.service.test.ts`

- [ ] **Step 1: 重写测试桩 `makeDbStub` 的 `updateTask`，支持字段名翻译**

原因：真实 repo 的 `updateTask` 收 `projectPath`/`sessionId` 等驼峰键，旧桩用对象展开合并，无法把 `projectPath` 写进 `project_path`。先让桩忠实模拟真实 repo，新测试才能观察到项目字段变化。

把 `makeDbStub` 里第 59-65 行的 `updateTask` 替换为：

```ts
    updateTask: (id: string, updates: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next: StoredTask = { ...current };
      if (updates.title !== undefined) next.title = String(updates.title);
      if (updates.description !== undefined) next.description = updates.description as string | null;
      if (updates.executorProvider !== undefined) next.executor_provider = String(updates.executorProvider);
      if (updates.executorModel !== undefined) next.executor_model = updates.executorModel as string | null;
      if (updates.sessionId !== undefined) next.session_id = updates.sessionId as string | null;
      if (updates.projectPath !== undefined) next.project_path = String(updates.projectPath);
      tasks.set(id, next);
      return next;
    },
```

- [ ] **Step 2: 新增项目变更测试用例**

在文件末尾（`getTaskBySessionId` 用例之后）追加：

```ts
test('updateTask: backlog/todo task project change deletes the linked session and unlinks', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
  assert.equal(row?.session_id, null);
  assert.deepEqual(deleted, ['s1']);
  const stored = db.getTask('t1') as StoredTask;
  assert.equal(stored.project_path, '/q');
  assert.equal(stored.session_id, null);
});

test('updateTask: project change without a session does not delete anything', async () => {
  const { db } = makeDbStub();
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
  assert.deepEqual(deleted, []);
});

test('updateTask: rejects project change for non-backlog/todo tasks', async () => {
  for (const status of ['in_progress', 'in_review', 'done']) {
    const { db } = makeDbStub();
    db.updateTaskStatus('t1', status);
    const svc = createTasksService(db, {
      broadcast: () => {},
      deps: { projectsDb: makeProjectStub('/p') },
    });
    await assert.rejects(
      () => svc.updateTask('t1', { projectPath: '/q' }),
      /not backlog or todo/,
    );
  }
});

test('updateTask: rejects an unknown target project without deleting the session', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  await assert.rejects(() => svc.updateTask('t1', { projectPath: '/nope' }), /project not found/);
  assert.deepEqual(deleted, []);
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
});

test('updateTask: selecting the current project is a no-op', async () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: (e) => events.push(e),
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/p' });
  assert.equal(row?.project_path, '/p');
  assert.deepEqual(deleted, []);
  assert.equal(events.length, 0);
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
});

test('updateTask: tolerates a missing session row when deleting', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async () => {
        const e = new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        throw e;
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
});

test('updateTask: ordinary field updates leave the session untouched', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { title: 'new title' });
  assert.equal(row?.title, 'new title');
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
  assert.deepEqual(deleted, []);
});
```

需要给测试文件顶部补 `AppError` import。把第 4 行所在 import 区改为：

```ts
import { projectsDb } from '@/modules/database/index.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';
import { AppError } from '@/shared/utils.js';
```

- [ ] **Step 3: 运行测试，确认新增用例失败（red）**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/tasks/tests/tasks.service.test.ts 2>&1 | tail -30
```
Expected：原 7 个用例仍过；新增用例中「rejects project change」「rejects unknown target」「same project no-op」「deletes linked session」失败（服务层尚无校验/删会话/no-op 逻辑），「without session」「missing session row」「ordinary field updates」可能通过（桩已能透传 projectPath）。

---

## Task 2: 后端实现（TDD green）

**Files:**
- Modify: `lovdex-backend/server/modules/database/repositories/tasks.db.ts`
- Modify: `lovdex-backend/server/modules/tasks/services/tasks.service.ts`

- [ ] **Step 1: repo `updateTask` 支持 `projectPath`**

在 `lovdex-backend/server/modules/database/repositories/tasks.db.ts` 第 112-118 行的 `updateTask` updates 类型里加 `projectPath?: string;`，并在 SET 子句区（`sessionId` 判断之后）加一行：

```ts
  updateTask(taskId: string, updates: {
    title?: string;
    description?: string | null;
    executorProvider?: TaskEngine;
    executorModel?: string | null;
    sessionId?: string | null;
    projectPath?: string;
  }): TaskRow | null {
    const db = getConnection();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.executorProvider !== undefined) { sets.push('executor_provider = ?'); params.push(updates.executorProvider); }
    if (updates.executorModel !== undefined) { sets.push('executor_model = ?'); params.push(updates.executorModel); }
    if (updates.sessionId !== undefined) { sets.push('session_id = ?'); params.push(updates.sessionId); }
    if (updates.projectPath !== undefined) { sets.push('project_path = ?'); params.push(updates.projectPath); }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(taskId);
    if (sets.length === 1) return tasksDb.getTask(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...params);
    return tasksDb.getTask(taskId);
  },
```

- [ ] **Step 2: service `deps` 加 `deleteSessionHard` 并实现生产默认**

在 `createTasksService` 的 `opts.deps` 类型（第 59 行）改为：

```ts
    deps?: {
      projectsDb?: typeof projectsDb;
      deleteSessionHard?: (sessionId: string) => Promise<void>;
    };
```

在函数体里 `const resolveProject = opts.deps?.projectsDb ?? projectsDb;` 之后加：

```ts
  /**
   * Hard-deletes a session row plus its transcript file. Production default is a
   * lazy import of sessionsService so unit tests (which inject a stub) never pull
   * in the websocket/chat-run-registry dependency chain.
   */
  const deleteSessionHard: (sessionId: string) => Promise<void> =
    opts.deps?.deleteSessionHard
    ?? ((sessionId) =>
        import('@/modules/providers/services/sessions.service.js').then(({ sessionsService }) =>
          sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true }),
        ));
```

- [ ] **Step 3: 重写 service `updateTask` 为 async + 项目变更逻辑**

把第 177-187 行整个 `updateTask` 替换为：

```ts
    async updateTask(taskId: string, updates: Parameters<TaskDbLike['updateTask']>[1]): Promise<TaskRow | null> {
      if (updates.executorProvider !== undefined && !isTaskEngine(updates.executorProvider)) {
        throw new AppError(`invalid executor_provider: ${String(updates.executorProvider)}`, {
          code: 'INVALID_EXECUTOR',
          statusCode: 400,
        });
      }
      const current = resolveDb.getTask(taskId);
      if (!current) return null;

      const { projectPath, ...rest } = updates;
      const wantsProjectChange = projectPath !== undefined && projectPath !== current.project_path;

      // Picking the task's current project (with no other changes) is a no-op:
      // no write, no event, no session deletion.
      if (projectPath !== undefined && !wantsProjectChange && Object.keys(rest).length === 0) {
        return decorate(current);
      }

      let effective: Parameters<TaskDbLike['updateTask']>[1] = rest;
      if (wantsProjectChange) {
        if (current.status !== 'backlog' && current.status !== 'todo') {
          throw new AppError('cannot change project for a task that is not backlog or todo', {
            code: 'PROJECT_CHANGE_NOT_ALLOWED',
            statusCode: 400,
          });
        }
        if (!resolveProject.getProjectPath(projectPath)) {
          throw new AppError(`project not found: ${projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
        if (current.session_id) {
          try {
            await deleteSessionHard(current.session_id);
          } catch (err) {
            // A session row that is already gone shouldn't block the project
            // change — the outcome (unlink from a dead session) is the same.
            if ((err as AppError)?.code !== 'SESSION_NOT_FOUND') throw err;
          }
        }
        effective = { ...rest, projectPath, sessionId: null };
      }

      const row = resolveDb.updateTask(taskId, effective);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row ? decorate(row) : null;
    },
```

- [ ] **Step 4: 运行全部服务测试，确认通过（green）**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx tsx --test server/modules/tasks/tests/tasks.service.test.ts 2>&1 | tail -20
```
Expected：`# pass 14`（原 7 + 新 7），`# fail 0`。

- [ ] **Step 5: lint 后端改动文件**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx eslint server/modules/tasks/services/tasks.service.ts server/modules/tasks/tasks.routes.ts server/modules/database/repositories/tasks.db.ts server/modules/tasks/tests/tasks.service.test.ts
```
Expected：无输出，exit 0。

> 注：后端 `npm run typecheck` 有存量错误（`server/shared/utils.ts` 的 `Dirent` 泛型），不做为本计划门禁；以测试 + lint + 运行时验证为准。

- [ ] **Step 6: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/database/repositories/tasks.db.ts server/modules/tasks/services/tasks.service.ts server/modules/tasks/tests/tasks.service.test.ts
git commit -m "feat: allow changing a backlog/todo task's project, hard-deleting its session

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 路由 PATCH 支持 `projectPath`

**Files:**
- Modify: `lovdex-backend/server/modules/tasks/tasks.routes.ts`

- [ ] **Step 1: `hasFieldUpdates` 加入 `'projectPath'`**

把第 73 行改为：

```ts
      const hasFieldUpdates = ['title', 'description', 'executorProvider', 'executorModel', 'sessionId', 'projectPath'].some((k) => body[k] !== undefined);
```

- [ ] **Step 2: updates 类型加 `projectPath` 并读取**

把第 86-92 行的 updates 类型加 `projectPath?: string;`，并在第 98 行 `sessionId` 处理之后加：

```ts
      if (typeof body.projectPath === 'string') updates.projectPath = body.projectPath;
```

- [ ] **Step 3: `await` service 调用**

把第 99 行 `const row = tasksService.updateTask(taskId, updates);` 改为：

```ts
      const row = await tasksService.updateTask(taskId, updates);
```

- [ ] **Step 4: lint + 服务测试仍绿**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend && npx eslint server/modules/tasks/tasks.routes.ts && npx tsx --test server/modules/tasks/tests/tasks.service.test.ts 2>&1 | tail -5
```
Expected：lint 无输出；`# pass 14`，`# fail 0`。

- [ ] **Step 5: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-backend
git add server/modules/tasks/tasks.routes.ts
git commit -m "feat: accept projectPath in task PATCH route

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 前端 TaskDetail 项目选择器

**Files:**
- Modify: `lovdex-cli/src/components/tasks/TaskDetail.tsx`

- [ ] **Step 1: type import 加 `Project`**

把第 6 行改为：

```ts
import type { Project, Task, TaskStatus, TaskUpsertedEvent } from '../../types/app';
```

- [ ] **Step 2: 加项目列表/选中值状态**

在第 27 行 `const [resultContent, setResultContent] = useState('');` 之后加：

```ts
  // Project selector for backlog/todo tasks. `projects` mirrors the TaskBoard
  // create-form dropdown; `projectPath` is the pending selection (reverted on
  // cancel/failure).
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPath, setProjectPath] = useState('');
```

- [ ] **Step 3: 拉项目列表 + 同步选中值 + 重名消歧**

在 `load` 回调定义之后（第 51 行 `}, [taskId]);` 之后）加：

```ts
  const projectPathOf = (project: Project): string => project.fullPath || project.path || '';

  // `displayName` can collide across projects while the path stays unique — the
  // same disambiguation the TaskBoard create form uses.
  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      const name = project.displayName || projectPathOf(project);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [projects]);

  // Keep the pending selection in sync with the task's actual project.
  useEffect(() => {
    if (task) setProjectPath(task.project_path);
  }, [task?.project_path]);

  useEffect(() => {
    let cancelled = false;
    api.projects()
      .then(async (res) => {
        if (!res.ok) return [];
        const data = (await res.json()) as Project[];
        return Array.isArray(data) ? data : [];
      })
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => console.error('load projects for task detail failed', err));
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 4: 加 `changeProject` 处理器**

在 `startExecution` 函数定义之后（第 209 行 `}` 之后）加：

```ts
  async function changeProject(nextPath: string) {
    if (!task || nextPath === task.project_path) return;
    const previous = task.project_path;
    if (task.session_id) {
      const ok = window.confirm('修改项目将删除当前会话及其全部对话记录，此操作不可恢复。是否继续？');
      if (!ok) {
        setProjectPath(previous);
        return;
      }
    }
    setProjectPath(nextPath);
    try {
      const res = await api.tasks.update(task.task_id, { projectPath: nextPath });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        console.error('changeProject failed', err?.error?.message ?? res.status);
        setProjectPath(previous);
        return;
      }
      setTask(await res.json());
    } catch (err) {
      console.error('changeProject failed', err);
      setProjectPath(previous);
    }
  }
```

- [ ] **Step 5: 属性区「所属项目」按状态渲染下拉/只读**

把第 322-325 行：

```tsx
              <div className="mb-3">
                <div className="mb-1 text-xs text-muted-foreground">所属项目</div>
                <div className="text-sm text-foreground">{task.project_path}</div>
              </div>
```

替换为：

```tsx
              <div className="mb-3">
                <div className="mb-1 text-xs text-muted-foreground">所属项目</div>
                {task.status === 'backlog' || task.status === 'todo' ? (
                  <select
                    className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
                    value={projectPath}
                    onChange={(e) => void changeProject(e.target.value)}
                  >
                    {projects.map((project) => {
                      const path = projectPathOf(project);
                      const name = project.displayName || path;
                      const label =
                        duplicateProjectNames.has(name) && name !== path ? `${name} — ${path}` : name;
                      return (
                        <option key={project.projectId} value={path} title={path}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <div className="text-sm text-foreground">{task.project_path}</div>
                )}
              </div>
```

- [ ] **Step 6: cli typecheck**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && npm run typecheck
```
Expected：无输出，exit 0。

- [ ] **Step 7: cli lint**

Run:
```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli && npx eslint src/components/tasks/TaskDetail.tsx
```
Expected：无输出，exit 0。

- [ ] **Step 8: Commit**

```bash
cd /mnt/b/workdir/github/lovdex/lovdex-cli
git add src/components/tasks/TaskDetail.tsx
git commit -m "feat: allow changing a backlog/todo task's project from the detail page

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 端到端手工验证

**Files:** 无（验证只读）

- [ ] **Step 1: 重启服务**

```bash
systemctl --user restart lovdex && sleep 3 && systemctl --user status lovdex --no-pager | head -6
```
Expected：`Active: active (running)`。后端跑 `tsx`（`npm run dev`），改动已生效。

- [ ] **Step 2: 验证 backlog/todo 任务改项目**

打开 `http://localhost:5187` → 任务面板 → 点进一个 **backlog/todo** 任务：
- 属性区「所属项目」显示下拉，列出所有项目。
- 选另一个项目 → 若该任务有会话，弹出确认框；取消则回退；确认则项目更新。
- 任务有会话时确认后：「打开会话」按钮消失（`session_id` 已清空），重新点「开始执行」会在新项目建新会话。
- 无会话任务直接切换，不弹窗。

- [ ] **Step 3: 验证非 backlog/todo 任务只读**

点进 **in_progress / in_review / done** 任务：属性区「所属项目」保持只读文本，无下拉。

- [ ] **Step 4: 验证会话已硬删除**

改项目前记下任务的 `session_id`；改完后在侧栏（主页）确认该会话不再出现，且磁盘 transcript 文件已删除：
```bash
find /home/zhijuhuang/.claude/projects -type f -name '*.jsonl' | grep <session_id>
```
Expected：无输出（文件已删）。

- [ ] **Step 5: 回归**

确认任务面板其它操作（新建任务、改状态、开始执行、删除任务、改标题/描述）不受影响。

---

## Self-Review 记录

- **Spec 覆盖**：§2.1 交互 → Task 4；§2.2 后端语义 → Task 2/3；§3 数据流/错误处理 → Task 2 Step 3；§4 不发 WS 事件 → 设计说明（无实现项）；§5 测试 → Task 1 + Task 5 手测清单。无缺口。
- **占位符扫描**：无 TBD/TODO；每步含完整代码与命令。
- **类型一致性**：`deleteSessionHard: (sessionId: string) => Promise<void>` 在 deps 类型、默认实现、测试 stub 中一致；`projectPath` 在 repo updates 类型、service `Parameters<TaskDbLike['updateTask']>[1]`、route body 解析、前端 `api.tasks.update` body 中一致。
