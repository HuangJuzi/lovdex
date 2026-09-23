/**
 * 自动审批在**前端**侧的分类。
 *
 * 后端已经把「被自动拒绝的 tool_result」标好了（`NormalizedMessage.autoApproveDeny`），
 * 前端渲染直接读那个字段。这里只补一件事：`permission_auto` 那条实时提示帧
 * 不带分类，得靠工具名自己算 —— 交互型工具在无人值守时**必然**被拒（没人可应答），
 * 与「危险操作被拦」不是一回事，渲染强度也不同。
 *
 * 这个联合必须与后端 `backend/server/shared/types.ts` 的 `AutoApproveDenyKind`
 * 保持一致。web 与 backend 是两个独立的包，无法 import 共享，所以这里是
 * **唯一**一份前端副本 —— 其余前端文件一律从这里 import，不要再写第二份字面量。
 */
export type AutoApproveDenyKind = 'interaction' | 'blocked';

/**
 * 交互型工具：它们需要有人在对端回答问题，无人值守时必然被策略拒绝。
 * 与 `tools/configs/toolConfigs.ts` 里注册的 `AskUserQuestion` / `ExitPlanMode` 同名。
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
  behavior: string | undefined,
): AutoApproveDenyKind | undefined {
  if (behavior !== 'deny') return undefined;
  return AUTO_APPROVE_INTERACTION_TOOLS.has(toolName ?? '') ? 'interaction' : 'blocked';
}
