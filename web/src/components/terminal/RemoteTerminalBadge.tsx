/** Corner badge shown on the terminal pane so it is obvious the shell is
 *  running on a remote host (not the local machine). Hidden when local. */
export function RemoteTerminalBadge({ hostName }: { hostName?: string | null }) {
  if (!hostName) return null;
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-indigo-300/40 bg-indigo-950/80 px-2 py-0.5 text-[11px] font-medium text-indigo-200">
      <span aria-hidden>SSH</span>
      <span className="truncate max-w-[160px]">: {hostName}</span>
    </div>
  );
}
