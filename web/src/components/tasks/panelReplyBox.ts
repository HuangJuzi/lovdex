/**
 * 回复区里「什么情况下能发、Enter 该不该发、常用语给不给看」的判据。
 *
 * 纯函数，无 React 依赖。搬出组件的理由是 Task 4/5 已经踩过的那一条：本仓库的
 * web 测试是 `node:test` + `renderToStaticMarkup`（无 DOM、不能模拟点击、不能
 * 派发键盘事件）。逻辑若留在组件的 `onClick` / `onKeyDown` 闭包里，**任何**改法
 * 都测不到 —— 包括「没内容也能发」「Shift+Enter 也发」「输入法选字时把半成品发
 * 出去」「会话被清理了还给常用语」。这些在静态标记上完全看不出来。搬出后组件
 * 只剩接线，判据才有 node:test 钉着。
 */

import type { ReplyState } from './panelReply';

/** 发送键的事件形状（取 React 合成事件里我们真正用到的那几个字段）。 */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  /** 输入法组合态。中文优先的仓库里这一条是必守项，见 shouldSendOnEnter。 */
  isComposing: boolean;
}

/**
 * 现在能不能发。`value.trim()` 非空是核心：只判 `value.length > 0` 会让一串
 * 空格 / 换行也算「有内容」，用户按 Enter 就把空白发给模型了。
 *
 * 刻意**不**看 `willQueue`：排队不是禁止。会话在跑时后端以 `RUN_IN_PROGRESS`
 * 拒 `chat.send`、服务端没有队列，前端替它排队（见 `panelReply.ts` 文件头），
 * 所以「发送」在排队态下必须照常可用 —— 加个 `&& !willQueue` 就等于执行中的
 * 任务永远回不了话。
 */
export function canSendReply(replyState: ReplyState, value: string): boolean {
  return replyState.canType && value.trim().length > 0;
}

/**
 * 这一下按键**是不是**「要发送」的键（Enter、非 Shift、非组合态）。
 *
 * 与内容无关是刻意的：它的用途是决定要不要 `preventDefault`。组合态里**绝不能**
 * preventDefault，否则会打断输入法选字 —— 所以「有内容」这层闸门留给
 * `canSendReply`，这里只认键本身。
 *
 * 两个修饰键判据都对齐聊天页：`Shift+Enter` 换行（两处既有入口的文案与行为），
 * `isComposing` 时 Enter 是「确认候选词」而不是「发送」—— 少了它，中文输入法下
 * 敲「nihao」按 Enter 选词会把半成品候选串当成消息发出去。聊天页的两处发送入口
 * （`useChatComposerState` 与 `QuickRepliesMenu`）都做了同样的判断。
 */
export function isSendKey(event: SendKeyEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

/** 这一下按键应不应该真的把内容发出去：先是发送键，再是内容非空。 */
export function shouldSendOnEnter(replyState: ReplyState, value: string, event: SendKeyEvent): boolean {
  return isSendKey(event) && canSendReply(replyState, value);
}

/**
 * 常用语那一行给不给看。两个条件缺一不可：
 *  - 会话可用（`canType`）—— 给一个插不进去的片段，比什么都不给更糟；
 *  - 列表非空 —— 渲染一行空的 chip 容器是纯噪音（同一理由也用在 header 的
 *    「点一下填入」提示上）。
 */
export function showQuickReplies(replyState: ReplyState, count: number): boolean {
  return replyState.canType && count > 0;
}
