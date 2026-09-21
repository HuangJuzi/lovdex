import test from 'node:test';
import assert from 'node:assert/strict';

import type { Task } from '../../types/app';

import {
  deleteOutcomeMessage,
  selectableRuns,
  toggleSelectAll,
  type DeleteOutcome,
} from './runHistoryDelete';

const baseTask: Task = {
  task_id: 't1',
  project_path: '/proj',
  title: '每日巡检',
  description: null,
  status: 'done',
  executor_provider: 'claude',
  executor_model: null,
  position: 1,
  session_id: null,
  started_at: null,
  completed_at: null,
  ai_summary: null,
  sub_status: null,
  verdict_reason: null,
  verdict_at: null,
  priority: 'P2',
  deadline: null,
  is_operator: 0,
  label: 'other',
  remark: null,
  auto_approve: 0,
  context_summary: null,
  context_source_session_id: null,
  context_mode: 'none',
  context_status: null,
  context_raw: null,
  source_schedule_id: 's1',
  created_at: '2026-08-14T09:00:00.000Z',
  updated_at: '2026-08-14T09:00:00.000Z',
};

function task(taskId: string, status: Task['status']): Task {
  return { ...baseTask, task_id: taskId, status };
}

const failedRun = (taskId: string): DeleteOutcome['failed'][number] => ({ taskId, reason: 'x', running: true });
const failedOther = (taskId: string): DeleteOutcome['failed'][number] => ({ taskId, reason: 'y', running: false });

test('selectableRuns 滤掉运行中的运行', () => {
  const runs = [task('a', 'done'), task('b', 'in_progress'), task('c', 'archived')];
  assert.deepEqual(selectableRuns(runs).map((t) => t.task_id), ['a', 'c']);
});

test('selectableRuns 保留所有非运行中状态', () => {
  const runs = (['todo', 'in_review', 'done', 'archived'] as const).map((s) => task(s, s));
  assert.deepEqual(selectableRuns(runs).map((t) => t.status), ['todo', 'in_review', 'done', 'archived']);
});

test('selectableRuns 空数组还是空数组', () => {
  assert.deepEqual(selectableRuns([]), []);
});

test('toggleSelectAll 未全选时全选', () => {
  assert.deepEqual([...toggleSelectAll(new Set(['a']), ['a', 'b'])].sort(), ['a', 'b']);
});

test('toggleSelectAll 已全选时清空', () => {
  assert.equal(toggleSelectAll(new Set(['a', 'b']), ['a', 'b']).size, 0);
});

test('toggleSelectAll 只装传入的可选 id', () => {
  assert.deepEqual([...toggleSelectAll(new Set(), ['a'])], ['a']);
});

test('toggleSelectAll 没有可选项时返回空集', () => {
  assert.equal(toggleSelectAll(new Set(['a']), []).size, 0);
});

// deleteOutcomeMessage：spec §3.1 真值表的八条分支
test('deleteOutcomeMessage：什么都没发生 → null', () => {
  assert.equal(deleteOutcomeMessage({ deleted: [], failed: [] }), null);
});

test('deleteOutcomeMessage：全成功', () => {
  assert.equal(deleteOutcomeMessage({ deleted: ['a', 'b'], failed: [] }), '已删除 2 条');
});

test('deleteOutcomeMessage：成功 + 全部因运行中失败', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: ['a'], failed: [failedRun('b')] }),
    '已删除 1 条，1 条因运行中未能删除',
  );
});

test('deleteOutcomeMessage：一条没删掉且全因运行中 → 带可操作提示', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: [], failed: [failedRun('a')] }),
    '1 条未能删除：运行中的运行需先停止',
  );
});

test('deleteOutcomeMessage：成功 + 运行中与其它失败混合', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: ['a'], failed: [failedRun('b'), failedOther('c')] }),
    '已删除 1 条，1 条因运行中未能删除，1 条删除失败',
  );
});

test('deleteOutcomeMessage：成功 + 只有其它失败', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: ['a'], failed: [failedOther('b')] }),
    '已删除 1 条，1 条删除失败',
  );
});

test('deleteOutcomeMessage：没删掉 + 运行中与其它失败混合', () => {
  assert.equal(
    deleteOutcomeMessage({ deleted: [], failed: [failedRun('a'), failedOther('b')] }),
    '1 条因运行中未能删除，1 条删除失败',
  );
});

test('deleteOutcomeMessage：没删掉 + 只有其它失败', () => {
  assert.equal(deleteOutcomeMessage({ deleted: [], failed: [failedOther('a')] }), '1 条删除失败');
});
