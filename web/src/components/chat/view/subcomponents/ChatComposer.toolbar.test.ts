import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 手机端 composer 工具栏的折行不变量。
 * 见 docs/superpowers/specs/2026-09-28-composer-toolbar-row-unify-design.md
 *
 * 为什么钉 className 而不是量布局：web 测试环境无 DOM，量不到像素。所以这里
 * 钉的是「让折行结果可预测」的那两处 class —— 它们是折行的充分条件，不是代理
 * 指标。真正的折行结论由该 spec §3 的 puppeteer 探针给出（那才量得到像素）。
 *
 * 读取方式是「按标记定位开标签、再取 className」。刻意只匹配**单个 class 成员**
 * （`min-w-12` / `max-w-20`），不做结构匹配、不数括号、不比对整条 className 字符串
 * —— 多行书写或格式化不会误红。仓库对「读源码断言结构」有过一次教训
 * （MessageComponent.test.tsx 顶部注释：多行书写会误红、路由写反却全绿）。
 */
const SOURCE = fileURLToPath(new URL('./ChatComposer.tsx', import.meta.url));

/** 取源码里包含 `marker` 的那个 JSX 开标签的整段文本。 */
function openingTagContaining(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `ChatComposer.tsx 里找不到 ${marker}（改动后标记变了？）`);
  const open = source.lastIndexOf('<', at);
  const close = source.indexOf('>', at);
  assert.ok(open !== -1 && close > at, `${marker} 所在的标签读不出来`);
  return source.slice(open, close + 1);
}

/** 开标签上的 class 成员列表；顺序无关。 */
function classNamesOf(tag: string): string[] {
  const match = /className="([^"]*)"/.exec(tag);
  assert.ok(match, `标签上没有 className 字面量（改成了表达式？）：${tag}`);
  return match[1].split(/\s+/).filter(Boolean);
}

const source = readFileSync(SOURCE, 'utf8');
const shortLabelTag = openingTagContaining(source, 'modeLabelKeys.shortKey');
const modelLabelTag = openingTagContaining(source, '{modelLabel}');

// 六种模式的短标签宽度不同（Approve 80px vs Plan 58px），这就是 bug 的全部原因：
// 模式按钮内容自适应 ⇒「哪一档视口宽度折行」因模式而异。给短标签一个最小宽度，
// 六个模式的按钮占位就按构造相同，折行结果必然一致 —— 不再靠调宽度碰运气。
//
// 钉的是「六者相等」这条不变量，不是「都等于 82px」：min-w 是下限，将来往
// modesShort 里加更长（例如中文）的标签时按钮仍会变宽，届时这条会红，逼人回来重算。
// 长度预算那条测试（permissionModeLabels.i18n.test.ts）拦不住这件事 —— 字符数与
// 像素宽不是一回事，正是本 bug 的成因。
test('the short mode label reserves a fixed minimum width', () => {
  const classes = classNamesOf(shortLabelTag);
  assert.ok(
    classes.includes('min-w-12'),
    `短标签需要固定最小宽度 48px（min-w-12）；实际 class：${classes.join(' ')}`,
  );
  assert.ok(
    classes.includes('text-center'),
    `窄标签要在固定宽度里居中，圆点才会与其它模式对齐；实际 class：${classes.join(' ')}`,
  );
});

// 模型名上限与上一项合起来决定「2 行」的宽度门槛。只钉标签不收紧模型名时，
// 358–373px 这批机器会从「2 行 / 3 行混杂」变成「统一 3 行」—— 差异是没了，
// 但方向反了（spec §2.2 的实测：门槛 374px vs 358px）。
test('the model label keeps the narrower mobile cap', () => {
  const classes = classNamesOf(modelLabelTag);
  assert.ok(
    classes.includes('max-w-20'),
    `手机端模型名上限应为 80px（max-w-20）；实际 class：${classes.join(' ')}`,
  );
  assert.ok(
    !classes.includes('max-w-24'),
    '手机端上限不能退回 96px（max-w-24）—— 那会把「2 行」的门槛推回 374px',
  );
  assert.ok(
    classes.includes('sm:max-w-32'),
    `桌面端上限 128px 保持不变；实际 class：${classes.join(' ')}`,
  );
});

// 两处断言必须落在不同的标签上。抽错标记（比如两个 marker 撞到同一个开标签）时，
// 前两条会对着同一段文本重复断言，看着全绿却漏掉另一半。
test('the two assertions land on different tags', () => {
  assert.notEqual(shortLabelTag, modelLabelTag, '两处断言落到了同一个标签上，抽取标记写错了');
});
