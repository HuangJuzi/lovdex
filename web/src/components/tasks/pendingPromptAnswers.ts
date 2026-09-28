import type { Question } from '../chat/types/types';

/**
 * 提问卡片的「点一下之后」全部语义。纯函数，无 React 依赖。
 *
 * 为什么要搬出组件：本仓库的 web 测试是 `node:test` + `renderToStaticMarkup`
 * （无 DOM、不能模拟点击）。点击语义若留在组件的 `onClick` 闭包里，**任何**
 * 改法都测不到 —— 包括把「单选替换」误写成「切换」、把「多选等确认」误写成
 * 「一击即发」、把「答满全部题目才提交」整个删掉。这三种错法在静态标记上都
 * 看不出来（按钮还在、文案还在），但它们会改变**发给模型的答案**。所以这里
 * 把「点一下会发生什么」整体收进可测的纯函数，组件只剩接线。
 *
 * 形状对齐聊天页 `AskUserQuestionPanel`：那边每问题一个 `Set<string>`，单选
 * `clear()` 后 `add()`，多选 `has ? delete : add`；迭代序即插入序；提交时
 * `Array.from(set).join(', ')` 塞进 `answers[question]`。这里的函数就是那条
 * 链路的等价物。
 */

/** 选择状态：题目原文 → 已选 label（保点击顺序）。 */
export type PickedState = Record<string, string[]>;

function pickLabels(question: Question, picked: PickedState): string[] {
  return picked[question.question] ?? [];
}

/**
 * 点一个选项后的新选择集，返回新数组。
 *
 * 多选 → 切换（已在里面就移除，否则追加）。
 * 单选 → **替换**成只含这一个。这是这张卡片的语义核心：单选点第二下是
 * 「改主意」，多选点第二下是「加一个」。单选若误走切换，界面照样高亮，
 * 但发出去的答案会多出一项 —— 模型拿到用户并没想要的组合。
 *
 * 模式判据是严格 `=== true`：模型传下来的 input 不受本仓库类型约束，
 * 一个真值（`1`、`'true'`）不该把单选的答案形状带偏。
 *
 * **不排序**：聊天页的 `Set` 按插入序迭代，先点「工具栏」再点「弹窗」，
 * 发出去的就必须是「工具栏, 弹窗」。排序看着整齐，但那是替用户重排他的
 * 选择 —— 多选问答里顺序本身可能带倾向性（先选的往往是首选）。
 */
export function applyPick(picks: readonly string[], label: string, question: Question): string[] {
  if (question.multiSelect !== true) {
    return [label];
  }
  return picks.includes(label) ? picks.filter((pick) => pick !== label) : [...picks, label];
}

/**
 * 点某一题的某个选项的**完整结果**：新状态，以及「现在该不该提交」。
 *
 * `submit` 的判据有两条，缺一不可：
 *  - 这一题是单选 —— 单选用聊天页的手感「最后一题选完即发」；多选必须等用户
 *    按确认按钮，否则多选就退化成单选的一击即发（用户本可以再点几个）。
 *  - 全部题目都已有选择 —— 提前提交会让后端拿到一份缺项的答案，模型的提问
 *    就等于被吞了。
 */
export function nextSelection(
  picked: PickedState,
  questions: readonly Question[],
  questionIndex: number,
  label: string,
): { picked: PickedState; submit: boolean } {
  const question = questions[questionIndex];
  if (!question) {
    return { picked, submit: false };
  }

  const next: PickedState = {
    ...picked,
    [question.question]: applyPick(pickLabels(question, picked), label, question),
  };

  const allAnswered = questions.every((item) => (next[item.question] ?? []).length > 0);
  return { picked: next, submit: allAnswered && question.multiSelect !== true };
}

/**
 * 状态 → 提交给后端的 `answers`：题目原文 → 答案串。
 *
 * 连接符必须是 `', '`，与聊天页的 `join(', ')` 逐字一致 —— 模型读的是这个串。
 * 单选是它的退化情形（单元素数组），两条路共用同一个形状，避免单选/多选发出
 * 去的答案在结构上分叉。
 *
 * **没有作答的题目不写进结果**：`answers` 里缺一个 key 与被写进空串不是一回事。
 * 混合卡（A 单选未答 + B 多选）里 B 的「提交选择」是静态可点的，如果这里把 A
 * 写成 `''`，「答满全部题目才提交」那条原则就只守住了单选的路 —— 先答多选、
 * 后答单选时仍会发出一份缺项的答案。
 */
export function formatAnswers(picked: PickedState, questions: readonly Question[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const labels = pickLabels(question, picked);
    if (labels.length > 0) {
      answers[question.question] = labels.join(', ');
    }
  }
  return answers;
}
