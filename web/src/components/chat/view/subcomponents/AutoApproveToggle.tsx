/**
 * The composer's session-scoped auto-approval switch.
 *
 * Only rendered when the linked task has `auto_approve = 1` — the chat window may
 * turn unattended approval OFF (and back on), but may never GRANT it to a task
 * that does not already have it. Granting lives on the task page.
 *
 * Colour is deliberately the warning band (same as `bypassPermissions`): this
 * state means tool calls are being answered without you, so it should not look
 * like an ordinary toggle. The label does not change with state — if it vanished
 * when off there would be no way to turn it back on from here.
 *
 * The double span follows ChatComposer's permission-mode button (`sm:hidden` /
 * `sm:inline` are both display utilities at equal specificity, so merging them
 * onto one element would be resolved by CSS source order, not by breakpoint).
 */
export function AutoApproveToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const title = enabled
    ? '自动审批已开启：本会话手动发送的消息不再询问权限。仅影响你在此会话手动发送的消息；该任务的定时执行不受影响。'
    : '自动审批已关闭：本会话手动发送的消息会恢复权限询问。该任务的定时执行仍会自动批准。';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      title={title}
      aria-label={title}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-all duration-200 sm:px-2.5 ${
        enabled
          ? 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
          : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
      }`}
    >
      <span className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${enabled ? 'bg-warning' : 'bg-muted-foreground'}`} />
      <span className="whitespace-nowrap sm:hidden">自动审批</span>
      <span className="hidden whitespace-nowrap sm:inline">自动审批</span>
    </button>
  );
}
