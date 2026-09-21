/**
 * 「同一份创建意图」去重闸门。createTask 的 HTTP 入口用它把重复提交（双击 /
 * 两个标签页 / 网络重试 / 关掉弹窗再贴一次）收敛成一次落库。
 *
 * 两道防线的前端那道见 web/src/components/tasks/CreateTaskDialog.tsx（在途禁用
 * 确认按钮）—— 那道只在同一个弹窗实例里有效，这道兜住它管不到的情况。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskRow } from '@/shared/types.js';

import {
  createTaskDedupGate,
  taskCreateDedupKey,
  TASK_CREATE_DEDUP_WINDOW_MS,
} from '../services/task-create-dedup.js';

function row(taskId: string, title = '任务'): TaskRow {
  return { task_id: taskId, title } as unknown as TaskRow;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// --- 指纹 ---

test('taskCreateDedupKey 对同一份内容给出同一个 key', () => {
  const a = taskCreateDedupKey({ projectPath: '/p', title: '', description: '把看板筛选做出来' });
  const b = taskCreateDedupKey({ projectPath: '/p', title: '', description: '把看板筛选做出来' });
  assert.equal(a, b);
});

test('taskCreateDedupKey 把 undefined / null / 空串 / 首尾空白归一化', () => {
  const a = taskCreateDedupKey({ projectPath: '/p', title: '', description: '把看板筛选做出来' });
  const b = taskCreateDedupKey({ projectPath: '/p', title: '  ', description: '  把看板筛选做出来  ' });
  const c = taskCreateDedupKey({ projectPath: '/p', title: null, description: '把看板筛选做出来', remark: null });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('taskCreateDedupKey 对内容不同的请求给出不同的 key', () => {
  const base = { projectPath: '/p', title: '', description: '把看板筛选做出来' };
  // 逐字段验证：任一影响落库内容的字段不同，就不是同一份意图。
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, description: '换一个需求' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, projectPath: '/other' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, title: '我自己写的名字' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, executorProvider: 'codex' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, executorModel: 'gpt-5' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, priority: 'P0' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, label: 'bug' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, deadline: '2026-10-01' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, remark: '来自邮件' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, isOperator: true }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, sessionId: 's1' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, sourceSessionId: 's2' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, contextMode: 'raw' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, sourceScheduleId: 'sch-1' }));
  assert.notEqual(taskCreateDedupKey(base), taskCreateDedupKey({ ...base, autoApprove: true }));
});

test('taskCreateDedupKey 区分 autoApprove：改了开关就是另一份意图', () => {
  // 回归点：用户建完发现忘了勾「自动审批」，立刻再建一次 —— 两次提交只差这一个
  // 开关。若指纹不区分，第二次会被去重吞掉，用户静默拿到没勾的那条任务。
  const base = { projectPath: '/p', title: '', description: '把看板筛选做出来' };
  const on = taskCreateDedupKey({ ...base, autoApprove: true });
  const off = taskCreateDedupKey({ ...base, autoApprove: false });

  assert.notEqual(on, off);
  assert.notEqual(on, taskCreateDedupKey(base), 'true 与缺省必须不同');
});

test('taskCreateDedupKey 对同样勾了 autoApprove 的重复提交给出同一个 key', () => {
  // 双击 / 两个标签页都勾了开关时，去重仍要生效（不能因为多了一个字段就漏掉）。
  const base = { projectPath: '/p', title: '', description: '把看板筛选做出来', autoApprove: true };
  assert.equal(taskCreateDedupKey(base), taskCreateDedupKey({ ...base }));
  // false 与缺省都落库为 0，属同一份意图。
  assert.equal(
    taskCreateDedupKey({ ...base, autoApprove: false }),
    taskCreateDedupKey({ projectPath: '/p', title: '', description: '把看板筛选做出来' }),
  );
});

// --- 闸门 ---

test('在途的同 key 创建合并成一次，两个调用方拿到同一条任务', async () => {
  let resolveCreate: (v: TaskRow) => void = () => {};
  let calls = 0;
  const gate = createTaskDedupGate({ lookup: () => null });
  const create = () => {
    calls += 1;
    return new Promise<TaskRow>((resolve) => {
      resolveCreate = resolve;
    });
  };

  const first = gate.run('k', create);
  const second = gate.run('k', create);
  resolveCreate(row('t1'));

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, '第二次提交不能真的再建一条');
  assert.equal(a.task_id, 't1');
  assert.equal(b.task_id, 't1');
});

test('窗口内的重复提交复用已落库的任务，而不是新建', async () => {
  let calls = 0;
  let nowMs = 1_000;
  const gate = createTaskDedupGate({ now: () => nowMs, lookup: (id) => row(id) });
  const create = async () => {
    calls += 1;
    return row(`t${calls}`);
  };

  const first = await gate.run('k', create);
  nowMs += TASK_CREATE_DEDUP_WINDOW_MS - 1;
  const second = await gate.run('k', create);

  assert.equal(calls, 1);
  assert.equal(second.task_id, first.task_id);
});

test('窗口过期后同一份意图可以再次创建', async () => {
  let calls = 0;
  let nowMs = 1_000;
  const gate = createTaskDedupGate({ now: () => nowMs, lookup: (id) => row(id) });
  const create = async () => {
    calls += 1;
    return row(`t${calls}`);
  };

  await gate.run('k', create);
  nowMs += TASK_CREATE_DEDUP_WINDOW_MS;
  const second = await gate.run('k', create);

  assert.equal(calls, 2);
  assert.equal(second.task_id, 't2');
});

test('窗口内的命中返回 lookup 的当前行（改名后能拿到新名字）', async () => {
  let calls = 0;
  const gate = createTaskDedupGate({ lookup: (id) => row(id, '用户改过的名字') });
  const create = async () => {
    calls += 1;
    return row('t1', '旧名字');
  };

  await gate.run('k', create);
  const hit = await gate.run('k', create);

  assert.equal(calls, 1);
  assert.equal(hit.title, '用户改过的名字');
});

test('已落库的任务被删掉后，同一份意图允许重建', async () => {
  let calls = 0;
  const existing = new Map<string, TaskRow>();
  const gate = createTaskDedupGate({ lookup: (id) => existing.get(id) ?? null });
  const create = async () => {
    calls += 1;
    const created = row(`t${calls}`);
    existing.set(created.task_id, created);
    return created;
  };

  await gate.run('k', create);
  existing.clear();
  const second = await gate.run('k', create);

  assert.equal(calls, 2);
  assert.equal(second.task_id, 't2');
});

test('失败的创建不污染闸门：下一次提交会真的重试', async () => {
  let calls = 0;
  const gate = createTaskDedupGate({ lookup: (id) => row(id) });
  const create = async () => {
    calls += 1;
    if (calls === 1) throw new Error('db 挂了');
    return row('t2');
  };

  await assert.rejects(gate.run('k', create), /db 挂了/);
  const retried = await gate.run('k', create);

  assert.equal(calls, 2);
  assert.equal(retried.task_id, 't2');
});

test('并发但不同 key 的创建互不影响', async () => {
  let calls = 0;
  const gate = createTaskDedupGate({ lookup: (id) => row(id) });
  const create = async () => {
    calls += 1;
    return row(`t${calls}`);
  };

  const [a, b] = await Promise.all([gate.run('k1', create), gate.run('k2', create)]);

  assert.equal(calls, 2);
  assert.notEqual(a.task_id, b.task_id);
});

test('闸门不会把在途状态漏给下一个窗口（并发结束后立刻可再建）', async () => {
  let calls = 0;
  const gate = createTaskDedupGate({ windowMs: 0, lookup: (id) => row(id) });
  const create = async () => {
    calls += 1;
    return row(`t${calls}`);
  };

  await gate.run('k', create);
  await flush();
  await gate.run('k', create);

  assert.equal(calls, 2, 'windowMs=0 时只有「在途」被合并');
});

test('合并发生时回调 onHit，供日志留痕', async () => {
  const hits: [string, string][] = [];
  const gate = createTaskDedupGate({
    lookup: (id) => row(id),
    onHit: (key, taskId) => hits.push([key, taskId]),
  });
  const create = async () => row('t1');

  await gate.run('k', create);
  await gate.run('k', create); // 窗口内命中

  assert.deepEqual(hits, [['k', 't1']]);
});

test('在途合并也会回调 onHit（等第一次落库后带 taskId 回调）', async () => {
  const hits: [string, string][] = [];
  let resolveCreate: (v: TaskRow) => void = () => {};
  const gate = createTaskDedupGate({
    lookup: () => null,
    onHit: (key, taskId) => hits.push([key, taskId]),
  });
  const create = () => new Promise<TaskRow>((resolve) => { resolveCreate = resolve; });

  const first = gate.run('k', create);
  const second = gate.run('k', create);
  resolveCreate(row('t1'));
  await Promise.all([first, second]);

  assert.deepEqual(hits, [['k', 't1']]);
});
