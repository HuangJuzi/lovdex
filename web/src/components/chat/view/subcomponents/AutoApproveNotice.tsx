import type { ChatMessage } from '../../types/types';

/**
 * One compact line per automatic permission decision, so a transcript from an
 * unattended run is not a blank where the approvals should be. Deliberately
 * quiet — these are not errors and they are not the user's problem.
 *
 * Rendered as an early return from `MessageComponent` (no avatar / name /
 * timestamp chrome), so it carries the horizontal inset the message wrapper
 * used to apply — `px-3 sm:px-0` — instead of sitting inside that wrapper.
 */
export function AutoApproveNotice({ message }: { message: ChatMessage }) {
  // 判据是结构化字段，不是文案：交互型拒绝（没人可问）与放行一样是安静的，
  // 只有「危险操作被拦」才值得用 warning 色提一下。靠 startsWith 判文案会在
  // 后端改措辞时静默失效。
  const emphasized = message.autoApproveDenyKind === 'blocked';
  return (
    <div
      className={`my-1 flex items-start gap-2 px-3 text-xs sm:px-0 ${
        emphasized ? 'text-warning' : 'text-muted-foreground'
      }`}
    >
      <span aria-hidden="true">⚡</span>
      <span>{message.content}</span>
    </div>
  );
}
