/**
 * 回复区形态的派生。纯函数，无 React 依赖。
 *
 * 待办与回复不是互斥的：待办是「从中选一个」，回复是「补充一句话」。所以
 * `hasPendingPrompt` 只影响排版与文案（待办区显示在回复区上方），不改变可输入性。
 *
 * 真正决定可发性的只有两件事 —— 会话是否存在，以及会话是否正在跑。会话在跑时
 * 后端会以 `RUN_IN_PROGRESS` 拒掉 `chat.send`
 * （见 `backend/server/modules/websocket/services/chat-websocket.service.ts`），
 * 服务端**没有**队列；前端只能替它排队（`queued_message_<sessionId>`，由
 * `useQueuedMessageAutoSend.ts` 冲刷）。所以要**提前**说清楚：发送不等于送达。
 */

import type { Task } from '../../types/app';

export type ReplyMode = 'no-session' | 'queued' | 'ready';

export interface ReplyState {
  mode: ReplyMode;
  /** 输入框是否可编辑。 */
  canType: boolean;
  /** 发送后是否只是排队（要等这一轮跑完才真正发出去）。 */
  willQueue: boolean;
  /** 输入区下方的说明文案。 */
  hint: string;
}

export interface ReplyStateInput {
  task: Task;
  /** 该会话当前是否有正在执行的 run。 */
  isProcessing: boolean;
  /** 是否有未答复的待办。 */
  hasPendingPrompt: boolean;
}

export function replyState({ task, isProcessing, hasPendingPrompt }: ReplyStateInput): ReplyState {
  if (!task.session_id) {
    return {
      mode: 'no-session',
      canType: false,
      willQueue: false,
      hint: '这个会话已被清理，无法再回复',
    };
  }

  if (isProcessing) {
    return {
      mode: 'queued',
      canType: true,
      willQueue: true,
      hint: hasPendingPrompt
        ? '正在等待你回答上面的问题 · 消息将排队发送'
        : '执行中 · 消息将排队发送，等这一轮结束',
    };
  }

  return {
    mode: 'ready',
    canType: true,
    willQueue: false,
    hint: hasPendingPrompt ? '也可以直接用一句话回复' : 'Enter 发送 · Shift+Enter 换行',
  };
}
