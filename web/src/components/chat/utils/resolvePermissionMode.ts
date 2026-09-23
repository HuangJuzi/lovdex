/**
 * Which permission mode a send should actually use.
 *
 * Order: the session's own choice, then the linked task's, then the provider's
 * last-used memory, then the provider default.
 *
 * The task sitting above the provider memory is what makes "follow the task"
 * work: opening a task session starts in the task's mode. It is a *starting
 * point*, not a lock — the moment the user cycles the mode, the choice lands in
 * the session key and outranks the task for good.
 *
 * Pure: no localStorage, no React. Callers own the storage reads, so both the
 * composer and the task board's run button can share one definition of "this
 * session's mode".
 */
export function resolvePermissionMode(input: {
  sessionMode: string | null | undefined;
  taskMode: string | null | undefined;
  providerLastMode: string | null | undefined;
  providerDefault: string;
  validModes: readonly string[];
}): string {
  const { sessionMode, taskMode, providerLastMode, providerDefault, validModes } = input;
  const candidates = [sessionMode, taskMode, providerLastMode, providerDefault];
  const found = candidates.find(
    (mode): mode is string => typeof mode === 'string' && validModes.includes(mode),
  );
  // providerDefault 也可能不在 validModes 里（能力表拉到的列表变了），
  // 那种情况下退回字面量 'default'，与后端的归一化兜底同向。
  return found ?? 'default';
}
