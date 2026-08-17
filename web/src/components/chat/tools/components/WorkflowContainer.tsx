import React from 'react';

import type { WorkflowAgentNode, WorkflowState, WorkflowUsage } from '../workflowState';

import { ToolStatusBadge } from './ToolStatusBadge';
import type { ToolStatus } from './ToolStatusBadge';

interface WorkflowContainerProps {
  toolInput: any;
  toolResult?: any;
  workflowState?: WorkflowState;
  /** scriptPath for re-run/edit. May be empty (e.g. inline `script` only). */
  scriptPath?: string;
  /** runId for resume. */
  runId?: string;
  onEdit?: (scriptPath: string) => void;
  onRerun?: (scriptPath: string) => void;
  onResume?: (scriptPath: string, runId: string) => void;
}

/**
 * Map a workflow status (WorkflowState.status / WorkflowOutput.status) to the
 * ToolStatusBadge vocabulary. async_launched / remote_launched mean the script
 * was handed off (still "running" from the user's perspective); stopped maps to
 * denied (orange) to keep it visually distinct from a hard error.
 */
function mapStatus(raw: string | undefined): ToolStatus {
  switch (raw) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'denied';
    case 'running':
    case 'async_launched':
    case 'remote_launched':
    case undefined:
    default:
      return 'running';
  }
}

function formatUsage(usage: WorkflowUsage | undefined): string | null {
  if (!usage) return null;
  const seconds = (usage.duration_ms / 1000).toFixed(1);
  return `${usage.total_tokens} tokens · ${usage.tool_uses} tools · ${seconds}s`;
}

const BUTTON_BASE =
  'rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-100 ' +
  'dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700';
const BUTTON_DISABLED = ' disabled:opacity-40 disabled:cursor-not-allowed';

export const WorkflowContainer: React.FC<WorkflowContainerProps> = ({
  toolInput,
  toolResult,
  workflowState,
  scriptPath,
  runId,
  onEdit,
  onRerun,
  onResume,
}) => {
  const basename = scriptPath ? scriptPath.split('/').pop() : null;

  const name = workflowState?.workflowName
    || toolInput?.name
    || toolResult?.toolUseResult?.workflowName
    || toolResult?.workflowName
    || basename
    || 'workflow';

  const terminalStatuses = ['completed', 'failed', 'stopped'];
  const carriedStatus = toolResult?.status
    || toolResult?.toolUseResult?.status
    || toolInput?.status
    || toolInput?.toolUseResult?.status;

  // Prefer the live workflowState status; otherwise trust a terminal status
  // carried by toolResult/toolInput (WorkflowOutput terminal statuses). Only
  // default to 'running' when truly unknown — avoids showing a misleading
  // "Running" badge on a result-only view of a completed/failed run.
  const rawStatus = workflowState?.status
    || (carriedStatus && terminalStatuses.includes(carriedStatus) ? carriedStatus : undefined)
    || 'running';
  const status = mapStatus(rawStatus);

  const agents: WorkflowAgentNode[] = workflowState?.agents || [];
  const notification = workflowState?.notification;

  const notificationSummary = notification?.summary
    || toolResult?.toolUseResult?.summary
    || toolResult?.summary
    || toolInput?.summary;
  const notificationUsage = notification?.usage
    || toolResult?.toolUseResult?.usage
    || toolResult?.usage
    || toolInput?.usage;
  const notificationUsageText = formatUsage(notificationUsage);

  const canRerun = Boolean(scriptPath);
  const canResume = Boolean(scriptPath) && Boolean(runId);

  const renderAgentUsage = (agent: WorkflowAgentNode) => {
    const usageText = formatUsage(agent.usage);
    if (!usageText) return null;
    return <span className="text-gray-500 dark:text-gray-400">· {usageText}</span>;
  };

  return (
    <div className="space-y-2">
      {/* Header: workflow name + status */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
          Workflow · {name}
        </span>
        <ToolStatusBadge status={status} />
      </div>

      {/* Agents tree */}
      {agents.length > 0 && (
        <div className="space-y-1.5">
          {agents.map((agent) => (
            <div key={agent.taskId} className="border-l-2 border-blue-500 pl-2 dark:border-blue-400">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  agent: {agent.subagentType || agent.description}
                </span>
                {agent.lastToolName && (
                  <span className="text-gray-500 dark:text-gray-400">· {agent.lastToolName}</span>
                )}
                {renderAgentUsage(agent)}
              </div>
              {agent.tools.length > 0 && (
                <div className="mt-0.5 space-y-0.5 pl-2 text-[11px] text-gray-500 dark:text-gray-400">
                  {agent.tools.map((tool) => (
                    <div key={tool.toolUseId}>
                      {tool.toolName} · {tool.elapsedTimeSeconds}s
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Terminal summary */}
      {notificationSummary && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <span>{notificationSummary}</span>
          {notificationUsageText && (
            <span className="text-gray-500 dark:text-gray-400">· {notificationUsageText}</span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <button
          type="button"
          disabled={!canRerun}
          onClick={() => { if (canRerun && scriptPath) onEdit?.(scriptPath); }}
          className={BUTTON_BASE + (canRerun ? '' : BUTTON_DISABLED)}
        >
          编辑脚本
        </button>
        <button
          type="button"
          disabled={!canRerun}
          onClick={() => { if (canRerun && scriptPath) onRerun?.(scriptPath); }}
          className={BUTTON_BASE + (canRerun ? '' : BUTTON_DISABLED)}
        >
          以 {basename || 'scriptPath'} 重跑
        </button>
        <button
          type="button"
          disabled={!canResume}
          onClick={() => { if (canResume && scriptPath && runId) onResume?.(scriptPath, runId); }}
          className={BUTTON_BASE + (canResume ? '' : BUTTON_DISABLED)}
        >
          resume 续跑
        </button>
      </div>
    </div>
  );
};
