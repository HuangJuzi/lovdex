import type { ReplyState } from './panelReply';
import { canSendReply, shouldSendOnEnter, showQuickReplies } from './panelReplyBox';

export interface QuickReplyItem {
  quick_reply_id: string;
  content: string;
}

export interface TaskPanelReplyBoxProps {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  quickReplies: QuickReplyItem[];
  replyState: ReplyState;
  /**
   * 点常用语：**只填入、不发送**。与聊天页的 `handleInsertQuickReply` 同一语义
   * （`web/src/components/chat/hooks/useChatComposerState.ts`，那里的注释写着
   * 「刻意不自动发送」）—— 片段是起点不是终稿，直接发出去等于替你按了回车。
   */
  onInsertQuickReply: (item: QuickReplyItem) => void;
}

/**
 * 面板内的回复区。
 *
 * 发送走的仍然是 `chat.send`（复用 `buildTaskChatSend`），与任务页「开始执行 /
 * 重试」同一条通道，所以这里没有新的协议概念 —— 只是把入口从会话页搬到了面板里。
 *
 * 本组件**不含**任何判断逻辑：「能不能发」「Enter 该不该发」「常用语给不给看」
 * 全在 `panelReplyBox.ts`（有 node:test 覆盖），文案由 `panelReply.ts` 的
 * `replyState` 拥有，这里只负责接线与样式。本仓库的 web 测试无 DOM（不能点、
 * 不能按键），留在 `onClick` / `onKeyDown` 闭包里的判断等于没有任何测试碰得到。
 */
export function TaskPanelReplyBox({
  value,
  onChange,
  onSend,
  quickReplies,
  replyState,
  onInsertQuickReply,
}: TaskPanelReplyBoxProps) {
  const disabled = !replyState.canType;
  const canSend = canSendReply(replyState, value);
  const chipsVisible = showQuickReplies(replyState, quickReplies.length);

  return (
    <div className="border-t border-border px-3.5 pb-3 pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span>↩ 快速回复</span>
        {chipsVisible ? (
          <span className="ml-auto text-3xs">点一下填入，不会直接发送</span>
        ) : null}
      </div>

      {chipsVisible ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {quickReplies.map((item) => (
            <button
              key={item.quick_reply_id}
              type="button"
              onClick={() => onInsertQuickReply(item)}
              className="rounded-full border border-dashed border-primary/45 bg-primary/5 px-2.5 py-0.5 text-2xs text-primary"
            >
              {item.content}
            </button>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
        <textarea
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送、Shift+Enter 换行；输入法组合态里的 Enter 是选字，
            // 既不发也不能 preventDefault（会打断输入法），判据见 shouldSendOnEnter。
            // `isComposing` 在 React 合成事件的 `nativeEvent` 上，不在顶层 —— 与
            // 聊天页两处发送入口（useChatComposerState / QuickRepliesMenu）一致。
            if (!shouldSendOnEnter(replyState, value, {
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            })) {
              return;
            }
            event.preventDefault();
            onSend();
          }}
          // 只说「做什么」，不写键位：键位由 panelReply.ts 的 hint 独家声明
          // （ready 态那句「Enter 发送 · Shift+Enter 换行」）。这里再写一遍就是第二份
          // 副本 —— 聊天页的发送键还是**可配置**的（useUiPreferences 的 sendByCtrlEnter，
          // 默认 Ctrl+Enter），面板此刻读不到那个偏好，写死某个键位只会更错。
          placeholder={disabled ? '无法回复' : '回复这个任务…'}
          className="w-full resize-none border-none bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <span className="mr-auto text-3xs text-muted-foreground">{replyState.hint}</span>
          <button
            type="button"
            disabled={!canSend}
            onClick={onSend}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-45"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

export default TaskPanelReplyBox;
