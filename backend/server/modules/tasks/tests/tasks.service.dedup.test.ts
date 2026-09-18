/**
 * createTask 的重复提交合并（HTTP 入口开的那道后端防线）。
 *
 * 前端在途禁用确认按钮只在同一个弹窗实例里有效；这里覆盖它管不到的：两个标签页、
 * 关掉弹窗再贴一次、第一次其实成功了但客户端没拿到响应的重试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';

type StoredTask = Record<string, unknown> & { task_id: string; title: string };

function makeDbStub(opts: { failFirstCreate?: boolean } = {}) {
  const tasks = new Map<string, StoredTask>();
  let seq = 0;
  let createCalls = 0;

  const db = {
    createTask: (input: Record<string, unknown>) => {
      createCalls += 1;
      if (opts.failFirstCreate && createCalls === 1) throw new Error('db 挂了');
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
        is_operator: input.isOperator ? 1 : 0,
        priority: input.priority ?? 'P2',
        label: input.label ?? 'other',
        remark: input.remark ?? null,
        context_mode: input.contextMode ?? 'none',
        context_status: null,
        context_source_session_id: input.contextSourceSessionId ?? null,
        source_schedule_id: input.sourceScheduleId ?? null,
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

  return { db: db as unknown as TaskDbLike, rows: () => [...tasks.values()] };
}

const projectStub = {
  getProjectPath: (path: string) =>
    path === '/p'
      ? { project_id: 'p1', project_path: path, custom_project_name: null, isStarred: 0, isArchived: 0 }
      : null,
} as unknown as typeof projectsDb;

function build(opts: {
  generateTitle?: (input: { description: string | null }) => Promise<string | null>;
  titleBlockingMs?: number;
  dedupWindowMs?: number;
  failFirstCreate?: boolean;
} = {}) {
  const events: { kind: string; task?: StoredTask }[] = [];
  const stub = makeDbStub({ failFirstCreate: opts.failFirstCreate });
  const svc = createTasksService(stub.db, {
    broadcast: (e) => events.push(e as never),
    deps: { projectsDb: projectStub, generateTitle: opts.generateTitle },
    titleBlockingMs: opts.titleBlockingMs ?? 20,
    dedupWindowMs: opts.dedupWindowMs,
  });
  return { svc, events, rows: stub.rows };
}

const input = (over: Record<string, unknown> = {}) => ({
  projectPath: '/p',
  title: '',
  description: '把看板筛选做出来',
  dedupIdentical: true,
  ...over,
});

test('并发提交同一份意图只落一条任务，两个调用方拿到同一个 task_id', async () => {
  // 取名一直不返回 → 第一次创建停在阻塞窗口里，第二次提交正好落在「在途」。
  const { svc, rows } = build({ generateTitle: () => new Promise(() => {}) });

  const [a, b] = await Promise.all([svc.createTask(input()), svc.createTask(input())]);

  assert.equal(rows().length, 1, '重复提交不能建出第二条');
  assert.equal(a.task_id, b.task_id);
});

test('窗口内先后提交同一份意图只落一条任务', async () => {
  const { svc, rows } = build();

  const first = await svc.createTask(input());
  const second = await svc.createTask(input());

  assert.equal(rows().length, 1);
  assert.equal(second.task_id, first.task_id);
});

test('窗口内的命中返回当前行（改名后拿到新名字）', async () => {
  const { svc } = build();

  const first = await svc.createTask(input());
  await svc.updateTask(first.task_id, { title: '用户改过的名字' });
  const second = await svc.createTask(input());

  assert.equal(second.task_id, first.task_id);
  assert.equal(second.title, '用户改过的名字');
});

test('窗口过期后同一份意图可以再建一条', async () => {
  const { svc, rows } = build({ dedupWindowMs: 0 });

  const first = await svc.createTask(input());
  const second = await svc.createTask(input());

  assert.equal(rows().length, 2);
  assert.notEqual(second.task_id, first.task_id);
});

test('内容不同就是两份意图，各建一条', async () => {
  const { svc, rows } = build();

  await svc.createTask(input());
  await svc.createTask(input({ description: '换一个需求' }));

  assert.equal(rows().length, 2);
});

test('不带 dedupIdentical 的调用方（调度器 / 助手工具）不受影响', async () => {
  // 定时任务按 cron 反复建同名任务是正常行为，不能被合并掉。
  const { svc, rows } = build();
  const scheduled = { projectPath: '/p', title: '每日构建', description: '跑一次构建', sourceScheduleId: 'sch-1' };

  const first = await svc.createTask(scheduled);
  const second = await svc.createTask(scheduled);

  assert.equal(rows().length, 2);
  assert.notEqual(second.task_id, first.task_id);
});

test('校验失败不会被去重短路，也不会占住闸门', async () => {
  const { svc, rows } = build();

  await assert.rejects(svc.createTask(input({ status: 'bogus' })), /status/);
  await assert.rejects(svc.createTask(input({ status: 'bogus' })), /status/);
  assert.equal(rows().length, 0, '非法请求不能落库');

  const ok = await svc.createTask(input());
  assert.equal(rows().length, 1);
  assert.equal(ok.task_id, 't1');
});

test('落库失败不占住闸门：同一份意图可以重试成功', async () => {
  const { svc, rows } = build({ failFirstCreate: true });

  await assert.rejects(svc.createTask(input()), /db 挂了/);
  const ok = await svc.createTask(input());

  assert.equal(rows().length, 1, '重试必须真的再建，而不是被当成重复提交吞掉');
  assert.equal(ok.task_id, 't1');
});

test('合并掉的重复提交不会再广播一次 task_upserted', async () => {
  const { svc, events } = build();

  await svc.createTask(input());
  await svc.createTask(input());

  assert.equal(events.length, 1);
});
