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
  const denied = (message.content ?? '').startsWith('已自动拒绝');
  return (
    <div
      className={`my-1 flex items-start gap-2 px-3 text-xs sm:px-0 ${
        denied ? 'text-warning' : 'text-muted-foreground'
      }`}
    >
      <span aria-hidden="true">{denied ? '⚡' : '⚡'}</span>
      <span>{message.content}</span>
    </div>
  );
}
