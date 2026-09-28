export type TaskViewMode = 'board' | 'table';

/**
 * 电脑端默认表格。
 *
 * 看板四列在宽屏上横向拉得过开，一屏能看见的任务反而比表格少；表格的
 * 「截止 / 最近活动」两列也只在桌面排得下。手机端相反 —— 表格横向撑不开，
 * 所以那边强制看板（见 `effectiveTaskViewMode`）。
 *
 * **这个新默认值只对没存过偏好的用户生效。** `useLocalStorage` 是纯 `useState`、
 * 不跨实例同步，也不会去认旧值；已经手动选过看板的老用户在 localStorage 里存着
 * `'board'`，会一直保持看板。这是**有意为之**：他们表达过偏好，一次改版不该
 * 把它悄悄抹掉。所以不要在这里加「迁移」逻辑去把旧值改写成表格 —— 那会把
 * 「默认值变了」变成「你的选择被推翻了」。
 */
export const DEFAULT_TASK_VIEW_MODE: TaskViewMode = 'table';

/**
 * 决定实际渲染哪种视图。
 *
 * 分成「平台」与「存储偏好」两层：手机端不是「默认看板」而是**没有选择**
 * （表格按钮在 <640px 整个不渲染），所以那边无视存储值；桌面端才读偏好。
 */
export function effectiveTaskViewMode({
  isMobile,
  stored,
}: {
  isMobile: boolean;
  stored: TaskViewMode;
}): TaskViewMode {
  return isMobile ? 'board' : stored;
}
