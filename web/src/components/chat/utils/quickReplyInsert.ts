/**
 * 点一条常用语之后输入框应有的内容：空则直接填入，非空则追加到末尾。
 *
 * 两边都 trim：既判断「空」，也保证拼接处只有一个空格（用户草稿可能带尾随空白）。
 * 抽成独立纯函数是为了可测——前端测试没有 DOM 环境，只有纯函数能被 node:test 直接覆盖。
 */
export function buildQuickReplyInput(current: string, content: string): string {
  const base = current.trim();
  return base ? `${base} ${content}` : content;
}
