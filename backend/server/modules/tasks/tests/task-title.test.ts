import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FALLBACK_TITLE,
  TITLE_MAX_UNITS,
  TITLE_PROMPT_UNITS,
  TITLE_PROMPT_MAX_CHARS,
  buildTitleUserPrompt,
  deriveFallbackTitle,
  raceTaskTitle,
  resolveGeneratedTitle,
  sanitizeGeneratedTitle,
  shouldApplyGeneratedTitle,
  truncateGraphemes,
  truncateTitleByUnits,
} from '@/modules/tasks/services/task-title.js';

// ---------------------------------------------------------------------------
// truncateGraphemes
// ---------------------------------------------------------------------------

test('truncateGraphemes leaves a short string untouched', () => {
  assert.equal(truncateGraphemes('修复登录超时', 10), '修复登录超时');
});

test('truncateGraphemes counts an emoji as one glyph', () => {
  assert.equal(truncateGraphemes('😀😀😀😀', 2), '😀😀');
});

test('truncateGraphemes never leaves a lone surrogate behind', () => {
  // 10 个 emoji 每个占 2 个 UTF-16 码元；按 slice 切会在第 5 个字符中间断开。
  const out = truncateGraphemes('😀😀😀😀😀😀😀😀😀😀', 5);
  assert.equal(out, '😀😀😀😀😀');
  assert.equal([...out].length, 5);
  assert.ok(!out.includes('�'));
});

test('truncateGraphemes keeps a combining mark attached to its base', () => {
  // é 作为 e + U+0301 组合序列时是一个字素，按码点切会切出裸组合符。
  const out = truncateGraphemes('ééé', 2);
  assert.equal(out, 'éé');
});

// ---------------------------------------------------------------------------
// truncateTitleByUnits —— 按「字/词」单元截断，落在词边界上
// ---------------------------------------------------------------------------

test('truncateTitleByUnits counts a Latin run as one word', () => {
  assert.equal(truncateTitleByUnits('审批 yMaaS OA', 10), '审批 yMaaS OA');
});

test('truncateTitleByUnits drops a whole word instead of splitting it', () => {
  assert.equal(truncateTitleByUnits('一二三四五六七八九十 ABC', 10), '一二三四五六七八九十');
});

test('truncateTitleByUnits counts each CJK char and punctuation as one unit', () => {
  assert.equal(truncateTitleByUnits('重构任务面板，筛选，排序', 10), '重构任务面板，筛选，');
});

// ---------------------------------------------------------------------------
// deriveFallbackTitle —— description 拿不到模型结果时的本地兜底
// ---------------------------------------------------------------------------

test('deriveFallbackTitle uses a single short line verbatim', () => {
  assert.equal(deriveFallbackTitle('修复登录页的报错'), '修复登录页的报错');
});

test('deriveFallbackTitle takes the first non-empty line and ignores the rest', () => {
  assert.equal(deriveFallbackTitle('\n\n  给看板加筛选  \n更多细节在后面'), '给看板加筛选');
});

test('deriveFallbackTitle collapses internal whitespace on the picked line', () => {
  assert.equal(deriveFallbackTitle('fix    the\tlogin\t bug'), 'fix the login bug');
});

test('deriveFallbackTitle truncates long lines to 50 glyphs with an ellipsis', () => {
  const out = deriveFallbackTitle('长'.repeat(80));
  assert.equal([...out].length, 51);
  assert.ok(out.endsWith('…'));
});

test('deriveFallbackTitle falls back to 未命名任务 for a blank description', () => {
  assert.equal(deriveFallbackTitle('   \n\t '), FALLBACK_TITLE);
  assert.equal(deriveFallbackTitle(''), FALLBACK_TITLE);
  assert.equal(deriveFallbackTitle(null), FALLBACK_TITLE);
  assert.equal(deriveFallbackTitle(undefined), FALLBACK_TITLE);
});

// ---------------------------------------------------------------------------
// buildTitleUserPrompt
// ---------------------------------------------------------------------------

test('buildTitleUserPrompt embeds the description and the length rule', () => {
  const prompt = buildTitleUserPrompt({ prompt: '把任务面板的筛选做成表格视图' });
  assert.match(prompt, /把任务面板的筛选做成表格视图/);
  assert.match(prompt, new RegExp(String(TITLE_PROMPT_UNITS)));
});

test('buildTitleUserPrompt caps the description at 2000 code points', () => {
  const prompt = buildTitleUserPrompt({ prompt: '长'.repeat(TITLE_PROMPT_MAX_CHARS + 500) });
  assert.equal(prompt.match(/长/g)?.length, TITLE_PROMPT_MAX_CHARS);
});

test('buildTitleUserPrompt truncates by code point, not UTF-16 unit', () => {
  // 2001 个 emoji：按 slice 会在第 2000 位留下孤立代理项（U+D83D）再送进提示词。
  const prompt = buildTitleUserPrompt({ prompt: '😀'.repeat(TITLE_PROMPT_MAX_CHARS + 1) });
  assert.equal(prompt.match(/😀/g)?.length, TITLE_PROMPT_MAX_CHARS);
  assert.ok(!prompt.includes('\uD83D\uD83D'));
});

test('buildTitleUserPrompt tolerates a missing description', () => {
  assert.equal(typeof buildTitleUserPrompt({}), 'string');
  assert.equal(typeof buildTitleUserPrompt({ prompt: null }), 'string');
});

// ---------------------------------------------------------------------------
// sanitizeGeneratedTitle —— 宽容清洗模型输出
// ---------------------------------------------------------------------------

test('sanitizeGeneratedTitle passes a clean title through', () => {
  assert.equal(sanitizeGeneratedTitle('修复登录超时'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips a three-line code fence', () => {
  assert.equal(sanitizeGeneratedTitle('```\n修复登录超时\n```'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips a language-tagged fence', () => {
  assert.equal(sanitizeGeneratedTitle('```text\n重构任务面板筛选\n```'), '重构任务面板筛选');
});

test('sanitizeGeneratedTitle strips a single-line fence', () => {
  assert.equal(sanitizeGeneratedTitle('```修复登录超时```'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips wrapping quotes', () => {
  assert.equal(sanitizeGeneratedTitle('"修复登录超时"'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('「修复登录超时」'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('“修复登录超时”'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('『修复登录超时』'), '修复登录超时');
});

test('sanitizeGeneratedTitle strips trailing punctuation', () => {
  assert.equal(sanitizeGeneratedTitle('修复登录超时。'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('修复登录超时！'), '修复登录超时');
  assert.equal(sanitizeGeneratedTitle('修复登录超时, '), '修复登录超时');
});

test('sanitizeGeneratedTitle keeps the first non-empty line only', () => {
  assert.equal(sanitizeGeneratedTitle('修复登录超时\n\n说明：因为超时配置错了'), '修复登录超时');
});

test('sanitizeGeneratedTitle collapses internal whitespace', () => {
  // 输入必须短于字素上限，否则截断会把「折叠空白」这件事盖掉。
  assert.equal(sanitizeGeneratedTitle('修复   登录\t超时'), '修复 登录 超时');
});

test('sanitizeGeneratedTitle truncates to the unit cap', () => {
  const out = sanitizeGeneratedTitle('修复登录超时并顺带重构整个任务面板的筛选逻辑');
  assert.equal([...out!].length, TITLE_MAX_UNITS);
  assert.equal(out, '修复登录超时并顺带重构整个任务');
});

test('sanitizeGeneratedTitle keeps a mixed Chinese+Latin title under the cap intact', () => {
  assert.equal(sanitizeGeneratedTitle('审批 yMaaS OA'), '审批 yMaaS OA');
});

test('sanitizeGeneratedTitle never splits a Latin word at the cap', () => {
  // "ABC" 是第 16 个单元，超限时整词丢弃，而不是把 "A" 留在末尾。
  assert.equal(sanitizeGeneratedTitle('一二三四五六七八九十一二三四五 ABC'), '一二三四五六七八九十一二三四五');
});

test('sanitizeGeneratedTitle strips punctuation newly exposed by truncation', () => {
  // 「…优先级、项目负责人…」截到 15 单元正好停在「、」上；先剥标点再截断会把它留下。
  assert.equal(sanitizeGeneratedTitle('重构任务面板的按状态、优先级、项目负责人和标签筛选'), '重构任务面板的按状态、优先级');
});

test('sanitizeGeneratedTitle rejects unusable output', () => {
  assert.equal(sanitizeGeneratedTitle(''), null);
  assert.equal(sanitizeGeneratedTitle('   \n\t '), null);
  assert.equal(sanitizeGeneratedTitle('""'), null);
  assert.equal(sanitizeGeneratedTitle('「」'), null);
  assert.equal(sanitizeGeneratedTitle('。。。'), null);
});

test('sanitizeGeneratedTitle rejects non-strings', () => {
  assert.equal(sanitizeGeneratedTitle(null), null);
  assert.equal(sanitizeGeneratedTitle(undefined), null);
  assert.equal(sanitizeGeneratedTitle(42), null);
  assert.equal(sanitizeGeneratedTitle({ title: 'x' }), null);
});

// ---------------------------------------------------------------------------
// raceTaskTitle —— 阻塞窗口 + 迟到结果留给后台
// ---------------------------------------------------------------------------

test('raceTaskTitle returns the model title when it beats the blocking window', async () => {
  const { title, background } = await raceTaskTitle(Promise.resolve('修复登录超时'), '首行兜底', 200);
  assert.equal(title, '修复登录超时');
  assert.equal(background, null);
});

test('raceTaskTitle falls back and hands the pending promise to the background', async () => {
  let resolveLate: (v: string | null) => void = () => {};
  const pending = new Promise<string | null>((resolve) => {
    resolveLate = resolve;
  });
  const { title, background } = await raceTaskTitle(pending, '首行兜底', 20);
  assert.equal(title, '首行兜底');
  assert.ok(background, 'timed out but the in-flight promise must be handed back');

  // 迟到回来的同一个 promise（不是重发一次请求）解析出模型标题。
  resolveLate('修复登录超时');
  assert.equal(await background, '修复登录超时');
});

test('raceTaskTitle falls back with no background when the model request fails fast', async () => {
  const { title, background } = await raceTaskTitle(Promise.reject(new Error('relay 挂了')), '首行兜底', 200);
  assert.equal(title, '首行兜底');
  assert.equal(background, null);
});

test('raceTaskTitle falls back with no background when the model returns nothing', async () => {
  const { title, background } = await raceTaskTitle(Promise.resolve(null), '首行兜底', 200);
  assert.equal(title, '首行兜底');
  assert.equal(background, null);
});

test('raceTaskTitle background may still reject without an unhandled rejection', async () => {
  let rejectLate: (e: Error) => void = () => {};
  const pending = new Promise<string | null>((_resolve, reject) => {
    rejectLate = reject;
  });
  const { title, background } = await raceTaskTitle(pending, '首行兜底', 20);
  assert.equal(title, '首行兜底');
  assert.ok(background);

  rejectLate(new Error('迟到的失败'));
  // 契约：raceTaskTitle 自己接管这个 reject，消费方拿到的是 null 而不是未捕获异常。
  assert.equal(await background, null);
});

// ---------------------------------------------------------------------------
// shouldApplyGeneratedTitle —— 回写 CAS
// ---------------------------------------------------------------------------

test('shouldApplyGeneratedTitle allows the write-back while the placeholder stands', () => {
  assert.equal(shouldApplyGeneratedTitle({ status: 'todo', title: '首行兜底' }, '首行兜底'), true);
});

test('shouldApplyGeneratedTitle yields when the user renamed the task meanwhile', () => {
  assert.equal(shouldApplyGeneratedTitle({ status: 'todo', title: '用户改的名字' }, '首行兜底'), false);
});

test('shouldApplyGeneratedTitle yields for an archived task', () => {
  assert.equal(shouldApplyGeneratedTitle({ status: 'archived', title: '首行兜底' }, '首行兜底'), false);
});

test('shouldApplyGeneratedTitle yields when the task is gone', () => {
  assert.equal(shouldApplyGeneratedTitle(null, '首行兜底'), false);
  assert.equal(shouldApplyGeneratedTitle(undefined, '首行兜底'), false);
});

// ---------------------------------------------------------------------------
// resolveGeneratedTitle —— tasks.service 与 scheduler.service 共用的骨架
// ---------------------------------------------------------------------------

// resolveGeneratedTitle 是 tasks.service 与 scheduler.service 共用的骨架：
// 「给了标题就不碰模型」是两条链路共同的前提，必须钉死。
test('resolveGeneratedTitle: a provided title never reaches the model', async () => {
  let calls = 0;
  const res = await resolveGeneratedTitle({
    title: '  手填的名字  ',
    description: '需求正文',
    generateTitle: async () => { calls += 1; return '模型取的名'; },
  });
  assert.equal(res.title, '  手填的名字  ');
  assert.equal(res.writeBack, null);
  assert.equal(calls, 0);
});

test('resolveGeneratedTitle: a blank description skips the model and falls back to the default name', async () => {
  let calls = 0;
  const res = await resolveGeneratedTitle({
    title: '',
    description: null,
    generateTitle: async () => { calls += 1; return '模型取的名'; },
  });
  assert.equal(res.title, '未命名任务');
  assert.equal(res.writeBack, null);
  assert.equal(calls, 0);
});

test('resolveGeneratedTitle: a model answer inside the window wins', async () => {
  const res = await resolveGeneratedTitle({
    title: '',
    description: '修复登录超时',
    generateTitle: async () => '修复登录超时',
    blockingMs: 50,
  });
  assert.equal(res.title, '修复登录超时');
  assert.equal(res.writeBack, null);
});

test('resolveGeneratedTitle: a model that misses the window yields the fallback plus a write-back', async () => {
  let release: (v: string | null) => void = () => {};
  const pending = new Promise<string | null>((r) => { release = r; });
  const res = await resolveGeneratedTitle({
    title: '',
    description: '每天早上汇总提交记录',
    generateTitle: () => pending,
    blockingMs: 10,
  });
  assert.equal(res.title, '每天早上汇总提交记录');
  assert.ok(res.writeBack, 'the in-flight request must be handed back for a later write-back');
  release('每日提交汇总');
  assert.equal(await res.writeBack, '每日提交汇总');
});

test('resolveGeneratedTitle: a generateTitle that throws synchronously survives', async () => {
  const res = await resolveGeneratedTitle({
    title: '',
    description: '修复登录超时',
    generateTitle: () => { throw new Error('mis-wired dep'); },
    blockingMs: 50,
  });
  assert.equal(res.title, '修复登录超时');
  assert.equal(res.writeBack, null);
});

test('resolveGeneratedTitle: a missing generateTitle dep falls back without throwing', async () => {
  const res = await resolveGeneratedTitle({ title: '', description: '修复登录超时', blockingMs: 50 });
  assert.equal(res.title, '修复登录超时');
  assert.equal(res.writeBack, null);
});
