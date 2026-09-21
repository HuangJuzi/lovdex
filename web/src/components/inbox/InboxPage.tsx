import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck, Inbox as InboxIcon } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import MobileMenuButton from '../main-content/view/subcomponents/MobileMenuButton';
import { subscribeInbox, getInboxSnapshot, markReadLocal, markAllReadLocal } from '../../stores/inboxStore';
import type { InboxNotification, InboxSeverity } from '../../stores/inboxStore.pure';

import { InboxDetail } from './InboxDetail';
import { InboxList } from './InboxList';
import { severityLabel } from './inboxTarget';

type FilterKey = 'all' | 'unread' | 'critical';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'critical', label: '严重' },
];

const SEVERITY_ORDER: InboxSeverity[] = ['critical', 'warning', 'info'];

type InboxPageProps = {
  /** 窄屏下点菜单按钮要能拉出侧边栏抽屉，而抽屉由 AppContent 持有 —— 用回调传进来。 */
  onOpenSidebar?: () => void;
  /**
   * 是否渲染汉堡按钮。由 AppContent 传「抽屉是否激活」进来（它的断点是 768），
   * **不要**用本组件自己的 `isMobile`（1024，管的是两栏/sheet）—— 两者不是一回事，
   * 混用会在 768–1023px 渲染出一个点了没反应的死按钮。
   */
  showMenuButton?: boolean;
};

export default function InboxPage({ onOpenSidebar, showMenuButton = false }: InboxPageProps = {}) {
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);
  // 断点与 Tailwind 的 lg（1024px）对齐：>=lg 两栏，<lg 单列 + 全屏 sheet。
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 1024 });

  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // 这里**刻意不**自己拉取收件箱、也不自己订阅 WS：本组件现在只可能渲染在
  // AppContent 之内（见 App.tsx 的 /inbox 路由），而 AppContent 已经无条件做了
  // refreshInbox() + applyInboxEvent() 订阅。再来一套会让 /inbox 上每次
  // notification_updated / 重连都发两次全量 refetch，并让 created 事件进 reducer
  // 两遍。当前 inboxStore 的 created 按 id 去重、幂等所以没有可见危害，但那是
  // 巧合而非设计 —— 别把这份冗余加回来。

  // 相对时间每分钟重算一次，否则「2 分钟前」会一直停在挂载时的值。
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // 「全部」视图按严重度分组，严重在前；「未读」「严重」视图按时间倒序平铺。
  const visible = useMemo(() => {
    const items = snapshot.items;
    if (filter === 'unread') return items.filter((it) => !it.read_at);
    if (filter === 'critical') return items.filter((it) => it.severity === 'critical');
    return items;
  }, [snapshot.items, filter]);

  const grouped = useMemo(() => {
    if (filter !== 'all') return null;
    const by: Record<InboxSeverity, InboxNotification[]> = { critical: [], warning: [], info: [] };
    for (const it of visible) by[it.severity].push(it);
    return by;
  }, [visible, filter]);

  const unreadCount = useMemo(() => snapshot.items.filter((it) => !it.read_at).length, [snapshot.items]);
  const criticalCount = useMemo(
    () => snapshot.items.filter((it) => it.severity === 'critical' && !it.read_at).length,
    [snapshot.items],
  );

  // 选中项：默认第一条未读，没有未读则第一条；列表变化导致选中项消失时回落。
  useEffect(() => {
    if (selectedId && visible.some((it) => it.notification_id === selectedId)) return;
    const firstUnread = visible.find((it) => !it.read_at) ?? visible[0];
    setSelectedId(firstUnread ? firstUnread.notification_id : null);
  }, [visible, selectedId]);

  const selected = useMemo(
    () => visible.find((it) => it.notification_id === selectedId) ?? null,
    [visible, selectedId],
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    if (isMobile) setSheetOpen(true);
  };

  const filterLabel = (key: FilterKey) => {
    if (key === 'unread') return unreadCount > 0 ? `未读 ${unreadCount}` : '未读';
    if (key === 'critical') return criticalCount > 0 ? `严重 ${criticalCount}` : '严重';
    return '全部';
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col p-4">
      <div className="mb-4 flex items-center gap-2">
        {showMenuButton ? <MobileMenuButton onMenuClick={() => onOpenSidebar?.()} /> : null}
        <InboxIcon className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">收件箱</h1>
        {unreadCount > 0 ? (
          <span className="rounded-full bg-destructive px-2 py-0.5 text-2xs font-semibold text-destructive-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => markAllReadLocal()}>
          <CheckCheck className="mr-1 h-4 w-4" />全部已读
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={
              filter === f.key
                ? 'rounded-full bg-primary px-3 py-1 text-2xs font-semibold text-primary-foreground'
                : 'rounded-full border border-border px-3 py-1 text-2xs font-semibold text-muted-foreground hover:bg-muted'
            }
          >
            {filterLabel(f.key)}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-12">
        <div className="min-h-0 overflow-y-auto lg:col-span-5">
          {visible.length === 0 ? (
            // 空态必须在这里兜住：分组分支在 visible 为空时会渲染出零个 section，
            // 页面变成一片空白。
            <InboxList items={[]} selectedId={null} now={now} onSelect={handleSelect} />
          ) : grouped ? (
            SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((severity) => (
              <section key={severity} className="mb-4">
                <div className="mb-1.5 text-2xs font-semibold uppercase text-muted-foreground">
                  {severityLabel(severity)}
                </div>
                <InboxList
                  items={grouped[severity]}
                  selectedId={isMobile ? null : selectedId}
                  now={now}
                  onSelect={handleSelect}
                />
              </section>
            ))
          ) : (
            <InboxList
              items={visible}
              selectedId={isMobile ? null : selectedId}
              now={now}
              onSelect={handleSelect}
            />
          )}
        </div>

        {!isMobile ? (
          <div className="min-h-0 rounded-xl border border-border bg-card p-4 lg:col-span-7">
            <InboxDetail
              item={selected}
              now={now}
              onMarkRead={markReadLocal}
              onNavigate={(path) => navigate(path)}
            />
          </div>
        ) : null}
      </div>

      {isMobile ? (
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          {/* h-[85dvh] 是必须的：只给 max-h 的话容器高度仍是 auto，
              InboxDetail 里的 h-full 解析不出来，长正文会溢出圆角而不是滚动。 */}
          <DialogContent variant="sheet" className="flex h-[85dvh] flex-col p-4">
            <DialogTitle>{selected?.title ?? '通知详情'}</DialogTitle>
            <InboxDetail
              item={selected}
              now={now}
              onMarkRead={(id) => { markReadLocal(id); setSheetOpen(false); }}
              onNavigate={(path) => { setSheetOpen(false); navigate(path); }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
