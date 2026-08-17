import { MarkdownContent } from '../chat/tools/components/ContentRenderers/MarkdownContent';
import type { TaskResultState } from './taskResult';

interface TaskResultPanelProps {
  state: TaskResultState;
  content: string;
  onRefresh: () => void;
}

/**
 * Read-only "执行结果" card for the task detail page. The parent owns the
 * fetch state machine and passes it down; this component only renders.
 */
export function TaskResultPanel({ state, content, onRefresh }: TaskResultPanelProps) {
  const showRefresh = state === 'ready' || state === 'empty';
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs uppercase tracking-wide text-muted-foreground">执行结果</h4>
        {showRefresh && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
          >
            刷新
          </button>
        )}
      </div>
      {state === 'idle' && (
        <div className="text-sm text-muted-foreground">尚未开始执行</div>
      )}
      {state === 'loading' && (
        <div className="text-sm text-muted-foreground">加载中…</div>
      )}
      {state === 'empty' && (
        <div className="text-sm text-muted-foreground">agent 还没产出结论</div>
      )}
      {state === 'error' && (
        <div className="flex items-center gap-3">
          <div className="text-sm text-red-500">加载结果失败</div>
          <button
            className="rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500 hover:bg-red-500/20"
            onClick={onRefresh}
          >
            重试
          </button>
        </div>
      )}
      {state === 'ready' && content && <MarkdownContent content={content} />}
    </div>
  );
}
