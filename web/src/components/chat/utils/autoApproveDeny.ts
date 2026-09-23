/**
 * 前端关于「自动审批拒绝」的**全部**知识。
 *
 * 两个消费者，两种输入，别把它们混起来看：
 *  - `classifyAutoApproveNotice` —— 输入是 `permission_auto` 的**实时提示帧**
 *    （`type: 'notice'`）。那条帧不带分类，只能靠工具名自己算：交互型工具在
 *    无人值守时**必然**被拒（没人可应答），与「危险操作被拦」不是一回事，
 *    渲染强度也不同。
 *  - `resolveToolResultVariant` —— 输入是 transcript 里的 `tool_result`，分类
 *    已由后端标好（`NormalizedMessage.autoApproveDeny`），这里只负责决定它该
 *    走哪种渲染。
 *
 * 这个联合必须与后端 `backend/server/shared/types.ts` 的 `AutoApproveDenyKind`
 * 保持一致。web 与 backend 是两个独立的包，无法 import 共享，所以这里是
 * **唯一**一份前端副本 —— 其余前端文件一律从这里 import，不要再写第二份字面量。
 */
export type AutoApproveDenyKind = 'interaction' | 'blocked';

/**
 * 交互型工具：它们需要有人在对端回答问题，无人值守时必然被策略拒绝。
 *
 * 判据来源是后端策略模块的 `TOOLS_REQUIRING_INTERACTION`
 * （`backend/server/modules/permissions/auto-approve-policy.ts`）——**加名字时两处同步**。
 * `tools/configs/toolConfigs.ts` 里只是碰巧注册了同名工具，不是契约来源。
 */
export const AUTO_APPROVE_INTERACTION_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

/**
 * 由 `permission_auto` 帧的字段算出分类。放行返回 undefined。
 *
 * 判据是**工具名**，不是文案 —— 后端改措辞不该让这里失效。
 */
export function classifyAutoApproveNotice(
  toolName: string | undefined,
  behavior: 'allow' | 'deny' | undefined,
): AutoApproveDenyKind | undefined {
  if (behavior !== 'deny') return undefined;
  return AUTO_APPROVE_INTERACTION_TOOLS.has(toolName ?? '') ? 'interaction' : 'blocked';
}

/**
 * 交互型自动拒绝在 UI 上的那句短文案。
 *
 * 两处消费者（`useChatMessages` 的 `permission_auto` 分支、`AutoApproveDenyNotice`
 * 组件）必须说同一句话 —— 分头写字面量会静默漂开，而这次改动要根除的正是
 * 对文案的隐式依赖。
 *
 * 刻意不复用后端理由原文：它的后半句「请基于现有信息自行判断并继续，不要再次
 * 请求确认」是写给**模型**的协议指令，不是 UI 文案。
 *
 * 放这里而不是组件文件：视图文件加普通导出会触发
 * `react-refresh/only-export-components`（见 `resolveToolResultVariant` 的注释）。
 */
export function interactionNoticeCopy(toolName?: string): string {
  return `无人值守，无人可应答 — 已自动跳过 ${toolName || '提问'}`;
}

/**
 * 一条 tool_result 该走哪种渲染。
 *
 * 放在这里而不是 `AutoApproveDenyNotice.tsx`：视图文件里加普通导出会触发
 * `react-refresh/only-export-components`（与 `tasks/scheduleRunNow.ts` 同款分工）。
 * 而且 web 测试是 `node:test` + `renderToStaticMarkup`（无 DOM），判定逻辑
 * 只有离开组件才测得到。
 *
 * 优先级：带 autoApproveDeny 标记的结果即使 isError 也返回它自己的 kind，
 * 这正是本功能的核心语义（它不是错误，是策略决定）。
 *
 * 返回值**原样带出 kind**（而不是笼统的 `'auto-denied'`）：调用处要拿它去选
 * 渲染强度，收窄后即可直接用，不必再读一次 `toolResult.autoApproveDeny` 或写
 * 非空断言 —— 那种写法把「第一分支 ⇔ 字段非空」变成一条跨文件的隐式耦合。
 */
export function resolveToolResultVariant(
  toolResult: { isError?: boolean; autoApproveDeny?: AutoApproveDenyKind } | null | undefined,
): AutoApproveDenyKind | 'error' | 'result' {
  if (toolResult?.autoApproveDeny) return toolResult.autoApproveDeny;
  if (toolResult?.isError) return 'error';
  return 'result';
}
