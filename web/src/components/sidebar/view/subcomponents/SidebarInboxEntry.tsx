import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { subscribeInbox, getUnreadCount } from '../../../../stores/inboxStore';

/**
 * 「收件箱」侧边栏整行入口，置于「定时任务」之后。点击跳 /inbox。
 * 未读数用红点角标显示（订阅模块级 inboxStore，跨路由存活）。
 */
export default function SidebarInboxEntry() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const unread = useSyncExternalStore(subscribeInbox, getUnreadCount, () => 0);
  const active = pathname === '/inbox';
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
        {unread > 0 ? (
          <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
    </div>
  );
}
