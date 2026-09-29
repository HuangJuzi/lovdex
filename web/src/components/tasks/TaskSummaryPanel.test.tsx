import test from 'node:test';
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Task } from '../../types/app';

import { TaskSummaryPanel } from './TaskSummaryPanel';

/**
 * 「现在」刻意放在 updated_at 之后（而不是计划稿里的 1_700_000_000_000 ——
 * 那是 2023 年，比夹具里的时间戳还早，相对时间会一律读成「刚刚」，夹具自相矛盾）。
 */
const NOW = Date.parse('2026-09-28T06:25:00.000Z');

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    task_id: 't1',
    title: '修复导出 CSV 时表头错位',
    description: '导出大于 1000 行时表头会重复出现',
    status: 'in_progress',
    sub_status: 'waiting_answer',
    priority: 'P1',
    label: 'bug',
    project_id: 'p1',
    session_id: 's1',
    ai_summary: '已定位到 csv-export.ts:88 的分页边界判断，正在补测试。',
    executor_provider: 'claude',
    executor_model: 'claude-sonnet-4-6',
    created_at: '2026-09-28T06:02:00.000Z',
    updated_at: '2026-09-28T06:20:00.000Z',
    ...over,
  }) as Task;

const render = (over: Partial<Parameters<typeof TaskSummaryPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    <TaskSummaryPanel
      task={baseTask()}
      isProcessing={false}
      pendingRequests={[]}
      nowMs={NOW}
      timeoutMs={60_000}
      resultText=""
      replyValue=""
      onReplyChange={() => {}}
      onReplySend={() => {}}
      quickReplies={[]}
      onInsertQuickReply={() => {}}
      onRespond={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
      onOpenDetail={() => {}}
      {...over}
    />,
  );

/**
 * 取某个按钮的**开标签原文**。
 *
 * 为什么不能直接 `assert.doesNotMatch(html, /disabled/)`：Tailwind 的
 * `disabled:opacity-40` 在**每次**渲染里都含这个子串，那种断言恒真（Task 6 已踩过）。
 * 也不能对整段 html 找 `\bdisabled\b` —— 类名里的 `disabled:` 同样命中。
 * 只有把范围收窄到这一个元素、并认 React 输出的布尔属性原文（`disabled=""`）
 * 才分得出「禁用」与「没禁用」。
 */
function openTagOf(html: string, label: string): string {
  const end = html.indexOf(`>${label}</button>`);
  assert.ok(end >= 0, `未找到按钮「${label}」`);
  return html.slice(html.lastIndexOf('<button', end), end + 1);
}

test('头部：标题与关闭按钮', () => {
  const html = render();
  assert.match(html, /修复导出 CSV 时表头错位/);
  assert.match(html, /aria-label="关闭面板"/);
});

test('状态 chip 用 sub_status 的细标签，不是 status 的粗标签', () => {
  const html = render();
  // SUB_STATUS_META.waiting_answer 的 label 是「等你回答」。
  assert.match(html, /等你回答/);
  // 粗标签「进行中」（STATUS_META.in_progress）不该出现 —— 细标签可用时它必须让位。
  assert.doesNotMatch(html, /进行中/);
});

test('sub_status 为空时回退到 status 的粗标签（todo / done 列的常态）', () => {
  const html = render({ task: baseTask({ sub_status: null, status: 'todo' }) });
  assert.match(html, /待办/);
  // 计划稿的 `sub_status ?? 'running'` 会在这里写出「会话运行中」—— 一条待办任务。
  assert.doesNotMatch(html, /会话运行中/);
});

test('优先级与标签 chip 用 META 的中文文案，不是枚举原文', () => {
  const html = render();
  assert.match(html, /P1 高/);
  assert.match(html, /BUG/);
  // 原始枚举值「bug」不该以独立 chip 形态出现（LABEL_META.bug.label 是「BUG」）。
  assert.doesNotMatch(html, />bug</);
});

test('有待办时渲染待办区', () => {
  const html = render({
    pendingRequests: [
      {
        requestId: 'r1',
        toolName: 'Bash',
        receivedAt: new Date(NOW),
        input: { command: 'git commit -m "fix"' },
      },
    ],
  });
  assert.match(html, /git commit/);
  assert.match(html, /需要授权/);
});

test('无待办时不渲染待办区（auto 模式 / 无人值守任务的常态）', () => {
  const html = render({ pendingRequests: [] });
  assert.doesNotMatch(html, /需要授权/);
  assert.doesNotMatch(html, /需要选择/);
  assert.doesNotMatch(html, /不会超时/);
});

test('无 ai_summary 时不渲染完成度区块', () => {
  assert.match(render(), /完成度/);
  assert.doesNotMatch(render({ task: baseTask({ ai_summary: null }) }), /完成度/);
});

test('有结果文本时渲染最近结果，默认折叠（因此显示「展开全部 ↓」）', () => {
  const html = render({ resultText: '修复了分页边界的 off-by-one，单测覆盖 1500 行场景。' });
  assert.match(html, /最近结果/);
  assert.match(html, /off-by-one/);
  assert.match(html, /展开全部 ↓/);
});

test('无结果文本时不渲染最近结果', () => {
  const html = render({ resultText: '' });
  assert.doesNotMatch(html, /最近结果/);
  assert.doesNotMatch(html, /展开全部/);
});

test('属性行：引擎带模型、创建与活动各自成行', () => {
  const html = render();
  assert.match(html, /引擎/);
  assert.match(html, /claude · claude-sonnet-4-6/);
  assert.match(html, /创建/);
  assert.match(html, /活动/);
  // updated_at 距 NOW 恰好 5 分钟 —— 绝对时差，与时区无关。
  assert.match(html, /5 分钟前/);
});

test('底部两个动作都在', () => {
  const html = render();
  assert.match(html, /在会话里处理 →/);
  assert.match(html, /任务详情 →/);
});

test('会话可用时，「在会话里处理」可点，回复区可输入', () => {
  const html = render();
  assert.ok(!openTagOf(html, '在会话里处理 →').includes('disabled=""'));
  assert.match(html, /Enter 发送/);
});

test('会话被清理的任务：回复区禁用、提示不可回复，底部入口也禁用', () => {
  // session_id 仍在、但指向被硬删的会话行（后端置 session_deleted）—— 与「没有
  // session_id」对用户是同一种「会话没了」，两个入口都必须一起关掉。
  const html = render({ task: baseTask({ session_deleted: true }) });
  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.ok(openTagOf(html, '在会话里处理 →').includes('disabled=""'));
  // 「任务详情 →」是唯一出口，任何情况下都不能被关掉。
  assert.ok(!openTagOf(html, '任务详情 →').includes('disabled=""'));
});

test('无 session_id 的任务：回复区禁用，但「任务详情 →」仍可点', () => {
  const html = render({ task: baseTask({ session_id: null }) });
  assert.match(html, /这个会话已被清理，无法再回复/);
  assert.ok(openTagOf(html, '在会话里处理 →').includes('disabled=""'));
  assert.ok(!openTagOf(html, '任务详情 →').includes('disabled=""'));
});

test('执行中：回复区说明消息会排队，但输入框仍可编辑', () => {
  const html = render({ isProcessing: true });
  assert.match(html, /排队发送/);
  // 排队不等于禁止 —— 输入框必须还能敲（它没有 disabled=""）。
  const areaEnd = html.indexOf('placeholder=');
  const areaStart = html.lastIndexOf('<textarea', areaEnd);
  assert.ok(!html.slice(areaStart, areaEnd).includes('disabled=""'));
});

test('常用语仅在会话可用时给到回复区', () => {
  const quickReplies = [{ quick_reply_id: 'q1', content: '好的，继续' }];
  assert.match(render({ quickReplies }), /好的，继续/);
  // 会话被清理：给一个插不进去的片段比不给更糟，回复区自己会收起这一行。
  assert.doesNotMatch(render({ quickReplies, task: baseTask({ session_id: null }) }), /好的，继续/);
});
