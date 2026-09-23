import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { STATUS_ORDER } from './taskStatus';
import { TaskTableView } from './TaskTableView';

/**
 * 渲染辅助：把 `statusFilter` / `onStatusFilterChange` 这两个必填 prop 的默认值收在一处，
 * 免得 15 个用例各写一遍。`showStatusFilter` 有默认值 `true`，不传即展开态。
 */
const renderTable = (props: Partial<React.ComponentProps<typeof TaskTableView>> = {}) =>
  renderToStaticMarkup(
    React.createElement(TaskTableView, {
      tasks: [],
      projectOptions: [],
      statusFilter: [...STATUS_ORDER],
      onStatusFilterChange: () => {},
      ...props,
    }),
  );

const mkTask = (over: Partial<Task> & { task_id: string }): Task => ({
  project_path: '/home/user/proj',
  title: '测试任务',
  description: null,
  status: 'todo',
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
  permission_mode: 'default',
  context_summary: null,
  context_source_session_id: null,
  context_mode: 'none',
  context_status: null,
  context_raw: null,
  source_schedule_id: null,
  created_at: '2026-08-11T00:00:00.000Z',
  updated_at: '2026-08-11T00:00:00.000Z',
  ...over,
});

test('table renders status group header and task title', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
  });
  assert.match(html, /待办/);
  assert.match(html, /表格任务/);
  assert.match(html, /创建时间/);
  assert.match(html, /操作/);
});

test('table shows empty state when no tasks', () => {
  const html = renderTable({ tasks: [], projectOptions: [] });
  assert.match(html, /暂无任务/);
});

test('table renders exactly one open-session button for in_review with needs_review + session', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 'r1', status: 'in_review', sub_status: 'needs_review', session_id: 's1' })],
    projectOptions: [],
    onOpenSession: () => {},
    onStatusChange: () => {},
  });
  assert.match(html, /标记完成/);
  assert.equal((html.match(/打开会话/g) || []).length, 1);
});

test('table renders exactly one open-session button for in_progress with only_plan + session', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 'p1', status: 'in_progress', sub_status: 'only_plan', session_id: 's1' })],
    projectOptions: [],
    onOpenSession: () => {},
  });
  assert.equal((html.match(/打开会话/g) || []).length, 1);
});

// 「已归档」pill 与看板列语义对齐：showArchived=false（默认）时归档任务被共享筛选
// 排除，pill 永显 0 是误导；仅在开开关（showArchived=true）时才渲染该状态的行与计数。
test('table hides 已归档 pill when showArchived is off', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 'a1', status: 'archived' })],
    projectOptions: [],
  });
  assert.doesNotMatch(html, /已归档/);
});

test('table shows 已归档 pill with real row when showArchived is on', () => {
  const html = renderTable({
    tasks: [
      mkTask({ task_id: 'a1', status: 'archived' }),
      mkTask({ task_id: 'd1', status: 'done' }),
    ],
    projectOptions: [],
    showArchived: true,
  });
  assert.match(html, /已归档/);
  // archived 任务行也出现在表格分组里（不是只有 pill 文案）
  assert.match(html, /测试任务/);
});

test('table shows 会话被清理 instead of a dead 打开会话 for a cleaned session', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 'd1', status: 'in_progress', session_id: 's1', session_deleted: true })],
    projectOptions: [],
    onOpenSession: () => {},
    onStart: () => {},
  });
  assert.match(html, /会话被清理/);
  assert.doesNotMatch(html, /打开会话/);
});

test('table renders status filter row with 全部 reset pill', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
  });
  assert.match(html, /data-testid="status-filter"/);
  assert.match(html, /全部/);
});

test('table renders a select-all checkbox when selection is wired', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
    selected: new Set(['t1']),
    onToggleSelect: () => {},
    onToggleSelectAll: () => {},
  });
  assert.match(html, /全选/);
  assert.match(html, /选择任务/);
});

/**
 * 小屏适配（1280–1536px 视口）。
 *
 * 局限说明：本文件的测试跑在 `node:test` + `renderToStaticMarkup` 下，**没有 DOM、
 * 没有排版引擎**。下面这些用例只能证明「实现修复的类名确实被渲染出来了」，
 * 不能证明表格 min-content 真的降到约 916px、`sticky right-0` 真的吸附住、
 * 或 `overflow-wrap:anywhere` 真的降低了固有宽度。那几件事只能在浏览器里量测。
 */
test('操作列在表头与行单元格上都输出 sticky，恰好两次', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
  });
  // 核心守卫：表头或行单元格任一端丢了 sticky，窄屏下按钮就会再次够不着。
  assert.equal((html.match(/sticky right-0/g) || []).length, 2);
  assert.match(html, /text-right sticky right-0 z-10 bg-card/);
  assert.match(html, /sticky right-0 z-10 whitespace-nowrap rounded-r-lg/);
});

test('打开勾选列时 sticky 仍然是两次（勾选列不得被标成吸附）', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
    selected: new Set(['t1']),
    onToggleSelect: () => {},
    onToggleSelectAll: () => {},
  });
  assert.equal((html.match(/sticky right-0/g) || []).length, 2);
});

test('非 todo 行的长项目路径被截断，且全路径保留在 title 里', () => {
  const path = '/home/zhijuhuang/work/a-very-long-project-directory';
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', status: 'in_progress', project_path: path })],
    projectOptions: [],
  });
  // 两个断言都要：既证明封顶生效，又证明信息没丢（截断不等于丢数据）。
  assert.match(html, /block max-w-40 truncate/);
  assert.match(html, new RegExp(`title="${path}"`));
});

test('标题单元格容忍不可断行的长 token（anywhere 而非 break-words）', () => {
  const title = 'https://github.com/zzttzzmyswy/llm-project-with-a-long-name';
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title })],
    projectOptions: [],
  });
  assert.match(html, /\[overflow-wrap:anywhere\]/);
  assert.match(html, /line-clamp-2 min-w-40/);
  assert.match(html, new RegExp(`title="${title}"`));
  // break-word 按规范不参与 min-content 计算，长 URL 仍会把列撑到 335px，等于没修。
  assert.doesNotMatch(html, /break-words/);
});

test('表格 min-w 地板必须低于内容 min-content，否则会硬撑出横向滚动', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
  });
  // 实测：隐藏时间列后内容 min-content = 921px。min-w 高过它就会变成「真实地板」，
  // 1024 视口下曾被硬撑到 1080（多溢出 90px）。
  assert.doesNotMatch(html, /min-w-\[1080px\]/);
  assert.match(html, /min-w-\[900px\]/);
});

test('两个时间列带 xl 隐藏类（2 个表头 + 1 行 × 2 个单元格）', () => {
  const html = renderTable({
    tasks: [mkTask({ task_id: 't1', title: '表格任务' })],
    projectOptions: [],
  });
  // 断言按「类名集合」而非类名顺序 —— eslint 的 tailwindcss/classnames-order
  // 会把变体类排到末尾（`hidden … xl:table-cell`），钉死顺序会无谓地脆。
  assert.equal((html.match(/xl:table-cell/g) || []).length, 4);
  const hiddenCells = [...html.matchAll(/<(?:td|th) class="([^"]*xl:table-cell[^"]*)"/g)].map((m) =>
    m[1].split(/\s+/),
  );
  assert.equal(hiddenCells.length, 4);
  for (const classes of hiddenCells) {
    // 必须是裸 `hidden`，不能是 `sm:hidden` 这种别的变体
    assert.ok(classes.includes('hidden'), `期望有裸 hidden 类，实际：${classes.join(' ')}`);
  }
  // 列仍在 DOM 里（只是窄屏不显示），宽屏 ≥1280 要看得到。
  assert.match(html, /创建时间/);
  assert.match(html, /最近活动/);
});

/** 取出表格滚动区的类名集合（顺序无关：eslint 的 tailwindcss/classnames-order 会重排）。 */
const scrollerClasses = (html: string): string[] => {
  const m = html.match(/<div class="([^"]*overflow-x-auto[^"]*)"/);
  assert.ok(m, '未找到表格滚动区');
  return m[1].split(/\s+/);
};

test('状态筛选行可折叠：showStatusFilter=false 时整行不渲染，但状态筛选仍然生效', () => {
  const html = renderTable({
    tasks: [
      mkTask({ task_id: 't1', title: '待办任务', status: 'todo' }),
      mkTask({ task_id: 't2', title: '进行中任务', status: 'in_progress' }),
    ],
    statusFilter: ['in_progress'],
    showStatusFilter: false,
  });
  assert.doesNotMatch(html, /data-testid="status-filter"/);
  // 行没了、筛选还在：只有 in_progress 分组被渲染出来。
  assert.match(html, /进行中任务/);
  assert.doesNotMatch(html, /待办任务/);
});

test('状态筛选行收起的替代间距：showStatusFilter=false 时滚动区补 pt-3', () => {
  // 展开时状态行的 py-2.5 提供了表头与卡片上沿之间的间距；行没了就得补回来。
  // 滚动区只在有任务（非空态）时渲染，因此这里带一条任务。
  const tasks = [mkTask({ task_id: 't1', title: '表格任务' })];
  assert.match(renderTable({ tasks, showStatusFilter: true }), /data-testid="status-filter"/);
  assert.ok(!scrollerClasses(renderTable({ tasks, showStatusFilter: true })).includes('pt-3'));
  assert.ok(scrollerClasses(renderTable({ tasks, showStatusFilter: false })).includes('pt-3'));
});

test('状态筛选行展开时（默认）筛选照常生效', () => {
  // 上一条只覆盖了收起态；这条守住展开分支 —— `visibleStatuses` 的过滤逻辑
  // 若哪天被改坏而只在展开路径上暴露，收起态的用例是抓不到的。
  const html = renderTable({
    tasks: [
      mkTask({ task_id: 't1', title: '待办任务', status: 'todo' }),
      mkTask({ task_id: 't2', title: '进行中任务', status: 'in_progress' }),
    ],
    statusFilter: ['in_progress'],
    showStatusFilter: true,
  });
  assert.match(html, /data-testid="status-filter"/);
  assert.match(html, /进行中任务/);
  assert.doesNotMatch(html, /待办任务/);
});
