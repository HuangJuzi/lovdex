import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { subscribeInbox, getUnreadCount, getUnreadTone } from '../../../../stores/inboxStore';
import type { InboxSeverity } from '../../../../stores/inboxStore.pure';
import { isInboxPath } from '../../../app/inboxRouteMatch';

/** 角标配色：按未读里的最高严重度。info 与收件箱列表的 info 图标色块同款 token。 */
const TONE_CLASS: Record<InboxSeverity, string> = {
  critical: 'bg-destructive text-destructive-foreground',
  warning: 'bg-warning text-warning-foreground',
  info: 'border border-border bg-muted text-muted-foreground',
};

type InboxEntryViewProps = {
  unread: number;
  tone: InboxSeverity | null;
};

/**
 * 「收件箱」侧边栏整行入口，置于「定时任务」之后。点击跳 /inbox。
 * 未读数用数字角标显示，配色按未读里的最高严重度：critical 红、warning 琥珀、
 * info 中性灰。
 *
 * `InboxEntryView` 只承接纯展示、参数即快照，因此可以在 `renderToStaticMarkup`
 * 下被直接测到 —— 那个渲染路径走的是 `useSyncExternalStore` 的 getServerSnapshot
 * （本组件里是 `() => 0` / `() => null`），读不到模块级 store 的真实状态。
 * 真实入口 `SidebarInboxEntry` 保持无 props，只负责把 store 快照接上。
 */
export function InboxEntryView({ unread, tone }: InboxEntryViewProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = isInboxPath(pathname);
  return (
    <div className="flex-shrink-0 px-2 pt-1.5 md:px-1.5">
      <Button
        variant="ghost"
        data-active={active ? 'true' : 'false'}
        className={cn(
          'flex w-full justify-between p-2 h-auto font-normal hover:bg-muted',
          unread > 0 && 'bg-primary/5',
          active && 'bg-primary/10',
        )}
        onClick={() => navigate('/inbox')}
        title="收件箱"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Inbox className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">收件箱</span>
        </div>
        {unread > 0 && tone ? (
          <span
            data-tone={tone}
            className={cn(
              'ml-2 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold',
              TONE_CLASS[tone],
            )}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
    </div>
  );
}

export default function SidebarInboxEntry() {
  // 两个订阅各自返回原始值（number / string|null），不用一个返回 {unread, tone}
  // 新对象的订阅 —— 后者每次 getSnapshot 都是新引用，会触发无限重渲染。
  const unread = useSyncExternalStore(subscribeInbox, getUnreadCount, () => 0);
  const tone = useSyncExternalStore(subscribeInbox, getUnreadTone, () => null);
  return <InboxEntryView unread={unread} tone={tone} />;
}
