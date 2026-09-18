/**
 * 建任务去重的整链路验证：真 sqlite + 真 service + 真 router + 真 HTTP。
 * 单测里 db / fetch 都是替身，这里走一遍真实接线，确认「重复提交只落一条任务」
 * 在生产那套组合下也成立。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

import { buildTasksRouter } from '../tasks.routes.js';
import { createTasksService } from '../services/tasks.service.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-create-dedup-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** 起一个只挂建任务路由的 app（生产那套 service + router 接线）。 */
function startServer(
  t: { after: (fn: () => void) => void },
  deps: { generateTitle?: (input: { description: string | null }) => Promise<string | null> } = {},
) {
  const app = express();
  app.use(express.json());
  const service = createTasksService(tasksDb, { broadcast: () => {}, deps });
  app.use('/api/tasks', buildTasksRouter(service, { createSession: () => 's1' }));
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/api/tasks`;
}

const body = JSON.stringify({ projectPath: '/p', title: '', description: '把看板筛选做出来' });

test('并发 POST 同一份需求只落一条任务', async (t) => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    // 取名卡住 50ms → 第二次请求一定落在第一次的「在途」里。
    const url = startServer(t, {
      generateTitle: async () => {
        await sleep(50);
        return '看板筛选';
      },
    });

    const [first, second] = await Promise.all([
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    ]);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal((await first.json()).task_id, (await second.json()).task_id);
    assert.equal(tasksDb.listTasks({}).length, 1);
  });
});

test('先后 POST 同一份需求（客户端重试）只落一条任务', async (t) => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    const url = startServer(t);

    const first = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
    const second = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();

    assert.equal(second.task_id, first.task_id);
    assert.equal(tasksDb.listTasks({}).length, 1);
  });
});

test('需求不同的两次 POST 各建一条', async (t) => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/p');
    const url = startServer(t);

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: '/p', title: '', description: '需求 A' }),
    });
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: '/p', title: '', description: '需求 B' }),
    });

    assert.equal(tasksDb.listTasks({}).length, 2);
  });
});
