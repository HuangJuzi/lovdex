import type { PendingPermissionRequest } from '../chat/types/types';

import { PendingPromptCard } from './PendingPromptCard';
import { pendingQueueView, pendingTimeText, summarizePendingRequest } from './pendingPromptQueue';
import type { PendingDecision } from './useSessionPendingRequests';

export interface PendingPromptListProps {
  requests: PendingPermissionRequest[];
  nowMs: number;
  timeoutMs: number;
  onRespond: (requestId: string, decision: PendingDecision) => void;
}

/**
 * 待办区：一个会话的待办队列。
 *
 * 为什么是队列、一次只完整显示一条：一个任务对应一个会话，而后端的
 * `canUseTool` 本就要等这一条答复完才会走到下一个工具（见 `panelPermission.ts`
 * 文件头），所以实际几乎总是只有一条。真出现并发时排成一队逐个答，既不会
 * 挤满 428px 面板，也不会漏掉任何一条。
 *
 * 排序键是「超时时刻」——会超时的（普通工具，60 秒后自动拒绝）排在永远等的
 * （AskUserQuestion / ExitPlanMode）前面，因为只有前者会自己消失。
 *
 * **本组件不含任何决定逻辑**：谁是当前、要不要画队列条、每行写什么，全在
 * `pendingPromptQueue.ts`（有 node:test 覆盖）。本仓库的 web 测试没有 DOM、
 * 不能模拟点击也没法驱动重渲染，任何留在组件状态里的「哪条是当前」都测不到。
 * 组件只负责接线与样式，这也是它能被 `renderToStaticMarkup` 完全钉住的原因。
 */
export function PendingPromptList({ requests, nowMs, timeoutMs, onRespond }: PendingPromptListProps) {
  const { sorted, current, showQueue } = pendingQueueView(requests, timeoutMs);

  if (!current) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {showQueue ? (
        <div className="overflow-hidden rounded-lg border border-warning/40 bg-warning/5">
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/25 px-2.5 py-1.5 text-2xs font-semibold text-warning">
            <span>{`还有 ${sorted.length} 件事等你`}</span>
            <span className="ml-auto font-normal text-muted-foreground">先处理会超时的</span>
          </div>
          {sorted.map((request, i) => (
            <div
              key={request.requestId}
              className={`flex items-center gap-2 px-2.5 py-1.5 text-2xs ${
                i === 0 ? 'bg-warning/10 font-medium text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-secondary text-3xs font-semibold">
                {i + 1}
              </span>
              <span className="min-w-0 truncate">{summarizePendingRequest(request)}</span>
              <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                {pendingTimeText(request, nowMs, timeoutMs)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* key 认 requestId：两条 AskUserQuestion 前后替补时，卡片位置会复用同一个
          组件实例，选中态（PendingPromptCard 里的 picked）会从上一题漏到下一题，
          渲染出一个用户没选过的勾。换 key 强制重挂载即可。 */}
      <PendingPromptCard
        key={current.requestId}
        request={current}
        nowMs={nowMs}
        timeoutMs={timeoutMs}
        onRespond={onRespond}
      />
    </div>
  );
}

export default PendingPromptList;
