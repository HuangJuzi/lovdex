/**
 * 判断当前路径是否是收件箱页。
 *
 * 不能直接 `pathname === '/inbox'`：react-router v6 匹配 `/inbox/` 时会命中同一条
 * Route，但 `location.pathname` 保留尾斜杠，直接比较会让 `/inbox/` 落到主界面空态。
 */
export function isInboxPath(pathname: string): boolean {
  const normalized = pathname.endsWith('/') && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  return normalized === '/inbox';
}
