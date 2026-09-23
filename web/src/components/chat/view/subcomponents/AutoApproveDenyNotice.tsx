import type { AutoApproveDenyKind } from '../../utils/autoApproveDeny';

/**
 * 一条 tool_result 该走哪种渲染。
 *
 * 抽成纯函数是为了能在无 DOM 环境下测「接线」——只渲染叶组件的话，
 * 把 MessageComponent 里的分支删掉测试仍会绿。
 *
 * 优先级：带 autoApproveDeny 标记的结果即使 isError 也走 'auto-denied'，
 * 这正是本功能的核心语义（它不是错误，是策略决定）。
 */
// 纯函数与组件同文件导出是本特性刻意的取舍：接线测试要同时拿到两者
// （见 AutoApproveDenyNotice.test.tsx）。它会触发 react-refresh 的
// only-export-components；这里显式抑制而不是另开一个文件，是为了让
// 「组件 + 判定」始终一起被搬动 —— 拆开正是漏测接线的温床。
// eslint-disable-next-line react-refresh/only-export-components
export function resolveToolResultVariant(
  toolResult: { isError?: boolean; autoApproveDeny?: AutoApproveDenyKind } | null | undefined,
): 'auto-denied' | 'error' | 'result' {
  if (toolResult?.autoApproveDeny) return 'auto-denied';
  if (toolResult?.isError) return 'error';
  return 'result';
}

/**
 * 被自动审批按策略拒绝的 tool_result 的渲染。
 *
 * 这类结果在 transcript 里是 `is_error: true` —— SDK 把 `canUseTool` 的 deny
 * message 原样写成了工具报错。但它不是故障：策略按预期工作。所以不能走
 * `MessageComponent` 那个红框 Error 分支。
 *
 * 与 `AutoApproveNotice` 一样是「留痕但不打扰」，不带头像/名称/时间戳的消息
 * 外壳，因此交互型那一行自带 `px-3 sm:px-0` 的横向内缩（与消息外壳一致）。
 */
export function AutoApproveDenyNotice({
  kind,
  toolName,
  reason,
  toolId,
}: {
  kind: AutoApproveDenyKind;
  toolName?: string;
  reason?: string;
  toolId?: string;
}) {
  // 交互型：没人可问是预期内结果，一行灰字带过。
  //
  // 刻意不复用 `reason`：它的后半句「请基于现有信息自行判断并继续，不要再次
  // 请求确认」是写给**模型**的协议指令，不是 UI 文案。而 `'拒绝：…'` 那几条
  // 本来就是面向用户的，所以下面那个分支直接展示原文。
  if (kind === 'interaction') {
    return (
      <div className="my-1 flex items-start gap-2 px-3 text-xs text-muted-foreground sm:px-0">
        <span aria-hidden="true">⚡</span>
        <span>{`无人值守，无人可应答 — 已自动跳过 ${toolName || '提问'}`}</span>
      </div>
    );
  }

  // 危险操作被拦：值得人看一眼，所以保留框体，但标题不是 Error、配色不是红。
  return (
    <div
      id={toolId ? `tool-result-${toolId}` : undefined}
      className="relative mt-2 scroll-mt-4 rounded border border-warning/30 bg-warning/10 p-3"
    >
      <div className="relative mb-2 flex items-center gap-1.5">
        <span aria-hidden="true">⚡</span>
        <span className="text-xs font-medium text-warning">已自动拒绝</span>
      </div>
      <div className="relative text-sm text-warning">{reason}</div>
    </div>
  );
}
