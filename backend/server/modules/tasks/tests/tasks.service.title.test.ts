/**
 * createTask 的标题生成接线：空标题 → LLM 取名（阻塞窗口 + 超时后回写），
 * 失败一律降级到本地首行兜底，绝不因取名失败让建任务报错。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { FALLBACK_TITLE } from '@/modules/tasks/services/task-title.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';

type StoredTask = Record<string, unknown> & { task_id: string; title: string; status: string };

function makeDbStub() {
  const tasks = new Map<string, StoredTask>();
  let seq = 0;

  const db = {
    createTask: (input: Record<string, unknown>) => {
      seq += 1;
      const row: StoredTask = {
        task_id: `t${seq}`,
        project_path: input.projectPath,
        description: input.description ?? null,
        status: (input.status ?? 'todo') as string,
        executor_provider: input.executorProvider ?? 'claude',
        executor_model: input.executorModel ?? null,
        session_id: input.sessionId ?? null,
        sub_status: null,
        position: seq,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        ...input,
        title: (input.title ?? '') as string,
      };
      tasks.set(row.task_id, row);
      return row;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: () => null,
    listTasks: () => [...tasks.values()],
    updateTask: (id: string, updates: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, ...updates } as StoredTask;
      tasks.set(id, next);
      return next;
    },
    updateTaskStatus: () => {},
    updateTaskSubStatus: () => {},
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
    writeContextResult: () => {},
  };

  return db as unknown as TaskDbLike;
}

const projectStub = {
  getProjectPath: (path: string) =>
    path === '/p'
      ? { project_id: 'p1', project_path: path, custom_project_name: null, isStarred: 0, isArchived: 0 }
      : null,
} as unknown as typeof projectsDb;

function build(
  generateTitle?: (input: { description: string | null }) => Promise<string | null>,
  titleBlockingMs = 20,
) {
  const events: { kind: string; task?: StoredTask }[] = [];
  const svc = createTasksService(makeDbStub(), {
    broadcast: (e) => events.push(e as never),
    deps: { projectsDb: projectStub, generateTitle },
    titleBlockingMs,
  });
  return { svc, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('createTask asks the model for a title when the title is blank', async () => {
  const seen: (string | null)[] = [];
  const { svc } = build(async (input) => {
    seen.push(input.description);
    return '修复登录超时';
  });

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '登录页老是超时，帮我看看' });

  assert.equal(task.title, '修复登录超时');
  assert.deepEqual(seen, ['登录页老是超时，帮我看看']);
});

test('createTask treats a whitespace-only title as blank', async () => {
  const { svc } = build(async () => '修复登录超时');
  const task = await svc.createTask({ projectPath: '/p', title: '   ', description: '登录页老是超时' });
  assert.equal(task.title, '修复登录超时');
});

test('createTask keeps a provided title and never calls the model', async () => {
  let calls = 0;
  const { svc } = build(async () => {
    calls += 1;
    return '模型取的名字';
  });

  const task = await svc.createTask({ projectPath: '/p', title: '我自己写的名字', description: '登录页老是超时' });

  assert.equal(task.title, '我自己写的名字');
  assert.equal(calls, 0);
});

test('createTask falls back to the description first line when the model returns nothing', async () => {
  const { svc } = build(async () => null);
  const task = await svc.createTask({
    projectPath: '/p',
    title: '',
    description: '给看板加筛选\n更多细节在后面',
  });
  assert.equal(task.title, '给看板加筛选');
});

test('createTask falls back to the description first line when the model request rejects', async () => {
  const { svc } = build(async () => {
    throw new Error('relay 挂了');
  });
  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });
  assert.equal(task.title, '给看板加筛选');
});

test('createTask does not call the model when the description is blank either', async () => {
  let calls = 0;
  const { svc } = build(async () => {
    calls += 1;
    return '不该被调用';
  });

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '' });

  assert.equal(task.title, FALLBACK_TITLE);
  assert.equal(calls, 0);
});

test('createTask still works with no title generator wired at all', async () => {
  const { svc } = build(undefined);
  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });
  assert.equal(task.title, '给看板加筛选');
});

test('createTask survives a generator that throws synchronously', async () => {
  // 契约上 generateTitle 返回 Promise，但取名失败绝不能冒泡成建任务失败 ——
  // 一个同步抛错（接线写错、依赖初始化失败）不该让任务建不出来。
  const { svc } = build((() => {
    throw new Error('generator 初始化就炸了');
  }) as unknown as (input: { description: string | null }) => Promise<string | null>);

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });
  assert.equal(task.title, '给看板加筛选');
});

test('createTask does not wait for a slow model past the blocking window', async () => {
  let resolveModel: (v: string | null) => void = () => {};
  const model = new Promise<string | null>((resolve) => {
    resolveModel = resolve;
  });
  const { svc } = build(() => model, 20);

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });

  // 超时后立刻用本地兜底建任务，不让调用方干等。
  assert.equal(task.title, '给看板加筛选');
  resolveModel('看板筛选');
});

test('createTask writes the late model title back and broadcasts it', async () => {
  let resolveModel: (v: string | null) => void = () => {};
  const model = new Promise<string | null>((resolve) => {
    resolveModel = resolve;
  });
  const { svc, events } = build(() => model, 20);

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });
  assert.equal(task.title, '给看板加筛选');
  assert.equal(events.length, 1, 'creation broadcasts exactly once');

  resolveModel('看板筛选');
  await flush();

  assert.equal(svc.getTask(task.task_id)?.title, '看板筛选');
  assert.equal(events.length, 2, 'the write-back broadcasts a second upsert');
  assert.equal((events[1].task as unknown as StoredTask).title, '看板筛选');
});

test('createTask write-back yields when the user renamed the task in the meantime', async () => {
  let resolveModel: (v: string | null) => void = () => {};
  const model = new Promise<string | null>((resolve) => {
    resolveModel = resolve;
  });
  const { svc, events } = build(() => model, 20);

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });
  // 在途期间用户改了名字 —— 回写必须让位。
  await svc.updateTask(task.task_id, { title: '用户改的名字' });
  const afterRename = events.length;

  resolveModel('看板筛选');
  await flush();

  assert.equal(svc.getTask(task.task_id)?.title, '用户改的名字');
  assert.equal(events.length, afterRename, 'no write-back broadcast');
});

test('createTask never writes back when the model answered nothing', async () => {
  let resolveModel: (v: string | null) => void = () => {};
  const model = new Promise<string | null>((resolve) => {
    resolveModel = resolve;
  });
  const { svc, events } = build(() => model, 20);

  const task = await svc.createTask({ projectPath: '/p', title: '', description: '给看板加筛选' });
  resolveModel(null);
  await flush();

  assert.equal(svc.getTask(task.task_id)?.title, '给看板加筛选');
  assert.equal(events.length, 1);
});

test('createTask validates before spending time on the model', async () => {
  let calls = 0;
  const { svc } = build(async () => {
    calls += 1;
    return '模型取的名字';
  });

  await assert.rejects(
    svc.createTask({ projectPath: '/p', title: '', description: 'x', status: 'bogus' as never }),
    /status/,
  );
  assert.equal(calls, 0, 'an invalid request must not reach the model');
});
