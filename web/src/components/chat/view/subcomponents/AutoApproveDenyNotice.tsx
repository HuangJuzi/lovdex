import { type AutoApproveDenyKind, interactionNoticeCopy } from '../../utils/autoApproveDeny';

/**
 * props 用判别联合而不是「一堆可选字段」：`blocked` 的理由是必填的。
 * 写成 `reason?: string` 时 TS 允许调用处漏传，渲染出来就是「已自动拒绝」
 * 标题底下一个空盒子 —— 一个类型层面就能禁掉的残缺 UI。
 *
 * 用 `Extract<…>` 而不是直接写 `'interaction'` / `'blocked'` 字面量：kind 的
 * 字面量在前端只有 `utils/autoApproveDeny.ts` 那一份（见那里的模块注释）。
 */
type AutoApproveDenyNoticeProps =
  | { kind: Extract<AutoApproveDenyKind, 'interaction'>; toolName?: string; toolId?: string }
  | { kind: Extract<AutoApproveDenyKind, 'blocked'>; reason: string; toolId?: string };

/**
 * 被自动审批按策略拒绝的 tool_result 的渲染。
 *
 * 这类结果在 transcript 里是 `is_error: true` —— SDK 把 `canUseTool` 的 deny
 * message 原样写成了工具报错。但它不是故障：策略按预期工作。所以不能走
 * `MessageComponent` 那个红框 Error 分支。
 *
 * 与 `AutoApproveNotice` 一样是「留痕但不打扰」，不带头像/名称/时间戳的消息
 * 外壳，因此交互型那一行自带 `px-3 sm:px-0` 的横向内缩（与消息外壳一致）。
 *
 * 两个变体都产出 `#tool-result-<toolId>` 锚点（与红框分支一致）：被自动拒绝的
 * 结果同样可能被 `jump-to-results` 指过来，让锚点在这里断掉会是个隐蔽的回归。
 * 目前没有工具同时配置 `jump-to-results` 与交互型，但保持同一条 DOM 契约比
 * 事后补一个「为什么这里没有 id」的注释便宜。
 */
export function AutoApproveDenyNotice(props: AutoApproveDenyNoticeProps) {
  const anchorId = props.toolId ? `tool-result-${props.toolId}` : undefined;

  // 交互型：没人可问是预期内结果，一行灰字带过。
  //
  // 刻意不复用 deny 的理由：它的后半句「请基于现有信息自行判断并继续，不要
  // 再次请求确认」是写给**模型**的协议指令，不是 UI 文案。而 `'拒绝：…'` 那
  // 几条本来就是面向用户的，所以下面那个分支直接展示原文。
  if (props.kind === 'interaction') {
    return (
      <div
        id={anchorId}
        className="my-1 flex scroll-mt-4 items-start gap-2 px-3 text-xs text-muted-foreground sm:px-0"
      >
        <span aria-hidden="true">⚡</span>
        <span>{interactionNoticeCopy(props.toolName)}</span>
      </div>
    );
  }

  // 危险操作被拦：值得人看一眼，所以保留框体，但标题不是 Error、配色不是红。
  return (
    <div
      id={anchorId}
      className="relative mt-2 scroll-mt-4 rounded border border-warning/30 bg-warning/10 p-3"
    >
      <div className="relative mb-2 flex items-center gap-1.5">
        <span aria-hidden="true">⚡</span>
        <span className="text-xs font-medium text-warning">已自动拒绝</span>
      </div>
      <div className="relative text-sm text-warning">{props.reason}</div>
    </div>
  );
}
